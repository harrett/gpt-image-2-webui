#!/usr/bin/env node
// Path-rewriting reverse proxy for upstreams that expose an OpenAI-compatible
// API *without* a `/v1` path segment.
//
// Why this exists: sub2api builds its upstream URL by appending the canonical
// endpoint (`/v1/images/generations`) to the channel's base URL, and only skips
// the `/v1` part when the base URL's last segment already looks like a version
// (`v1`, `v1beta`, …). An upstream served from e.g. `https://host/api-proxy`
// therefore gets `https://host/api-proxy/v1/images/generations`, which 404s.
// No base URL spelling can fix that — the `/v1` has to be *removed*, not moved.
//
// This proxy sits between the gateway and that upstream and does exactly one
// thing: strip a configured prefix off the request path, then forward
// everything else verbatim.
//
//     sub2api channel base URL:  http://127.0.0.1:9090
//     incoming:  POST /v1/images/generations
//     forwarded: POST https://image.aigw.store/api-proxy/images/generations
//
// Deliberate properties:
//   - Never holds a credential. `Authorization` is forwarded from the incoming
//     request untouched; this process has no key of its own to leak.
//   - Never buffers. Request and response bodies are piped, so multipart
//     uploads and any future SSE/`partial_images` streaming pass through
//     without being accumulated in memory or delayed until completion.
//   - Not an open proxy. Binds loopback by default and refuses any path outside
//     the configured prefix.

import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

const HOST = process.env.HOST || "127.0.0.1"
const PORT = Number(process.env.PORT || 9090)
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || "").trim()
const STRIP_PREFIX = normalizePrefix(process.env.STRIP_PREFIX || "/v1")
// Image generation regularly runs 30-120s upstream; the default Node socket
// behaviour would give up long before a slow model finishes.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600_000)

// Connection-level headers are meaningless to the next hop and actively
// harmful to forward: `transfer-encoding` in particular would conflict with
// the framing Node applies to the outgoing request.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function normalizePrefix(value) {
  const trimmed = value.trim().replace(/\/+$/, "")

  if (!trimmed) {
    return ""
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function parseUpstream() {
  if (!UPSTREAM_BASE_URL) {
    throw new Error("UPSTREAM_BASE_URL is required, e.g. https://image.aigw.store/api-proxy")
  }

  const url = new URL(UPSTREAM_BASE_URL)

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`UPSTREAM_BASE_URL must be http(s), got ${url.protocol}`)
  }

  return {
    isSecure: url.protocol === "https:",
    host: url.host,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
    // Trailing slash stripped so joining a rewritten path never doubles it.
    basePath: url.pathname.replace(/\/+$/, ""),
  }
}

/**
 * Strip the configured prefix off the incoming path.
 *
 * Returns null when the path is outside the prefix, which the caller answers
 * with a 404 — this is what keeps the process from acting as an open proxy for
 * arbitrary upstream paths.
 */
function rewritePath(rawUrl, upstream) {
  const queryStart = rawUrl.indexOf("?")
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart)
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart)

  if (STRIP_PREFIX && pathname !== STRIP_PREFIX && !pathname.startsWith(`${STRIP_PREFIX}/`)) {
    return null
  }

  const remainder = STRIP_PREFIX ? pathname.slice(STRIP_PREFIX.length) : pathname

  return `${upstream.basePath}${remainder || "/"}${search}`
}

function buildForwardHeaders(incomingHeaders, upstream) {
  const headers = {}

  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue
    }

    headers[name] = value
  }

  // The upstream routes on Host; forwarding the proxy's own would land on the
  // wrong vhost (and on a shared host, on someone else's site entirely).
  headers.host = upstream.host

  return headers
}

function buildResponseHeaders(upstreamHeaders) {
  const headers = {}

  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue
    }

    headers[name] = value
  }

  return headers
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.destroy()
    return
  }

  const body = JSON.stringify(payload)

  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

function log(...parts) {
  // Never log headers: Authorization passes through this process and must not
  // end up in a log file.
  console.log(`[upstream-path-proxy]`, ...parts)
}

const upstream = parseUpstream()

const server = createServer((request, response) => {
  const startedAt = Date.now()

  if (request.url === "/healthz") {
    sendJson(response, 200, { ok: true, upstream: `${upstream.host}${upstream.basePath}` })
    return
  }

  const targetPath = rewritePath(request.url || "/", upstream)

  if (targetPath === null) {
    log(`${request.method} ${request.url} -> 404 (outside ${STRIP_PREFIX || "/"})`)
    sendJson(response, 404, {
      error: {
        message: `Path is outside the proxied prefix ${STRIP_PREFIX || "/"}`,
        type: "invalid_request_error",
      },
    })
    return
  }

  const requestFn = upstream.isSecure ? httpsRequest : httpRequest
  const upstreamRequest = requestFn(
    {
      protocol: upstream.isSecure ? "https:" : "http:",
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: targetPath,
      headers: buildForwardHeaders(request.headers, upstream),
    },
    (upstreamResponse) => {
      log(
        `${request.method} ${request.url} -> ${upstream.host}${targetPath}`,
        `${upstreamResponse.statusCode} ${Date.now() - startedAt}ms`
      )
      response.writeHead(upstreamResponse.statusCode || 502, buildResponseHeaders(upstreamResponse.headers))
      // Piped, not buffered: a streaming response reaches the caller as it
      // arrives rather than being held until the upstream finishes.
      upstreamResponse.pipe(response)
    }
  )

  upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    log(`${request.method} ${request.url} -> upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`)
    upstreamRequest.destroy(new Error("upstream timeout"))
  })

  upstreamRequest.on("error", (error) => {
    log(`${request.method} ${request.url} -> upstream error: ${error.message}`)
    sendJson(response, 502, {
      error: {
        message: `Upstream request failed: ${error.message}`,
        type: "api_error",
      },
    })
  })

  // A caller that hangs up mid-upload should not leave the upstream request
  // open, still consuming a connection and (for a generation) still billing.
  request.on("aborted", () => upstreamRequest.destroy())
  request.pipe(upstreamRequest)
})

// Node caps how long a request may take to arrive; an unbounded multipart
// upload over a slow link would otherwise be cut off mid-body.
server.requestTimeout = UPSTREAM_TIMEOUT_MS
server.headersTimeout = 60_000

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`)
  log(`${STRIP_PREFIX || "/"}/* -> ${UPSTREAM_BASE_URL.replace(/\/+$/, "")}/*`)
})
