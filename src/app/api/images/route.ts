import OpenAI from "openai"
import { NextResponse } from "next/server"

import { resolveLocale, t } from "@/lib/i18n"
import {
  extractGeneratedImages,
  getImageApiError,
  getPayloadField,
  normalizeOpenAIBaseURL,
  scrubUpstreamDetails,
  type GeneratedImage,
} from "@/lib/image-request"
import {
  DEFAULT_MODEL,
  getModelCapabilities,
  getSupportedQualities,
  getSupportedSizes,
} from "@/lib/image-model-capabilities"
import { normalizeCustomSize } from "@/lib/image-size"
import { PAYLOAD_BYTES_HEADER } from "@/lib/transfer-progress"
import {
  createMockImagePayload,
  isMockImageApiEnabled,
  shouldFailMockRequest,
} from "@/lib/mock-image"

export const runtime = "nodejs"
// Measured on the configured channel: 41-61s for a successful generation, plus
// one observed case that had not answered after 300s. A 180s ceiling would kill
// the request *after* the upstream generated and billed the image, so this sits
// at the platform maximum rather than at a number that looks tidy.
export const maxDuration = 300

// Security: upstream base URL is server-controlled and read from a
// server-only env var. Never prefix it with NEXT_PUBLIC_, never read it
// in client code, never return its value to the browser. Do not accept
// endpoint/baseUrl/baseURL/apiUrl fields from client requests.
const INTERNAL_IMAGE_API_BASE_URL = process.env.INTERNAL_IMAGE_API_BASE_URL

// What a user may upload as a reference.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
// What the route is willing to pull down and inline on the user's behalf. This
// is deliberately far larger than the upload limit: a channel that ignores
// output_format and output_compression answers with raw PNG, and a single
// 2880x2880 result measures 15-17MB across four observed generations. At the
// old shared 10MB limit those results fell through to the bare upstream URL,
// which is the one outcome inlineRemoteImage exists to prevent.
//
// The headroom matters more than the typical case: those four samples spanned
// 15.7-17.4MB on simple prompts, and a busier image compresses worse. 32MB
// keeps roughly a factor of two rather than the ~40% that 25MB left.
const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024
// Results travel back to the browser inline as base64 inside the JSON body, so
// the encoded size *is* the download the user waits through. WebP at a sane
// compression level is several times smaller than the PNG this used to default
// to, which is the single biggest lever on perceived generation time — on a
// channel that honours the request at all.
const DEFAULT_OUTPUT_FORMAT = "webp"
const DEFAULT_OUTPUT_COMPRESSION = 80
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
])

function getText(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key)

  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

// These stay concrete even for a model that accepts neither: the output format
// also decides how a bare base64 string is decoded downstream, and the mock
// generator needs a background to draw. Whether the parameter is *sent* is
// decided separately, from the same capability table — an empty allow-list
// there means the channel rejects the key, so it is omitted entirely.
function getBackground(formData: FormData, model: string) {
  const supported = getModelCapabilities(model).backgrounds
  const value = getText(formData, "background", "auto")

  return supported.includes(value) ? value : "auto"
}

function getOutputFormat(formData: FormData, model: string) {
  const supported = getModelCapabilities(model).outputFormats
  const value = getText(formData, "outputFormat", DEFAULT_OUTPUT_FORMAT)

  return supported.includes(value) ? value : DEFAULT_OUTPUT_FORMAT
}

// WebP and JPEG both default to `output_compression: 100` upstream — i.e. as
// close to lossless as the container allows, which for photographic content
// lands within spitting distance of the PNG it replaced. Asking for WebP alone
// therefore buys much less than it looks like; the compression level is what
// turns a ~1.7MB image into a ~300-500KB one. PNG ignores the parameter.
//
// Set IMAGE_OUTPUT_COMPRESSION to a 0-100 value to tune, or to "off" for
// upstreams that reject the parameter outright. Models whose channel is known
// not to implement it opt out in the capability table instead, so one
// deployment can mix a channel that takes it with one that does not.
function getOutputCompression(outputFormat: string, model: string) {
  if (outputFormat === "png" || !getModelCapabilities(model).outputCompression) {
    return undefined
  }

  const configured = process.env.IMAGE_OUTPUT_COMPRESSION?.trim()

  if (configured === "off") {
    return undefined
  }

  const parsed = configured ? Number(configured) : DEFAULT_OUTPUT_COMPRESSION

  if (!Number.isFinite(parsed)) {
    return DEFAULT_OUTPUT_COMPRESSION
  }

  return Math.min(Math.max(Math.round(parsed), 0), 100)
}

// Relay gateways commonly answer with a hosted image URL rather than base64.
// That URL would be handed straight to the browser, which leaks the upstream
// address this route deliberately hides, makes the browser fetch a third-party
// host (CORS, hotlink protection), and leaves the transfer progress bar
// measuring an almost-empty response body while the real download happens in an
// <img> tag we cannot observe. Asking upstream for base64 solves all three.
//
// OpenAI's own endpoint rejects the parameter for GPT image models ("always
// return base64-encoded images"), so this stays opt-in per deployment.
function shouldRequestB64Json() {
  return process.env.IMAGE_REQUEST_B64_JSON === "1"
}

function getQuality(formData: FormData, model: string, isEdit: boolean) {
  const supported = getSupportedQualities(model, isEdit)
  const value = getText(formData, "quality", "auto")

  return supported.includes(value) ? value : "auto"
}

// A size outside the model's preset list is still allowed when it parses as a
// custom size — the 64-8192 range normalizeCustomSize enforces is the same one
// the client validates against.
function getSize(formData: FormData, model: string, isEdit: boolean) {
  const value = getText(formData, "size", "1024x1024")

  if (getSupportedSizes(model, isEdit).includes(value)) {
    return value
  }

  return normalizeCustomSize(value) || "1024x1024"
}

// Some OpenAI-compatible providers answer with a hosted `url` instead of
// `b64_json`. The canvas keeps image bytes inline so a revision stays valid
// after the upstream link expires, and so the browser is never asked to
// re-fetch it cross-origin. Callers that need self-contained bytes opt in with
// `inlineRemoteImages`.
//
// Security note: the URL fetched here comes from the *upstream response*, never
// from the browser's request body — this does not widen the SSRF surface the
// way accepting a client-supplied endpoint would.
// The Cloudflare-fronted host these URLs point at is unreliable in two distinct
// ways, both observed on URLs that succeed moments later: it refuses the
// connection outright ("Connect Timeout", TLS handshake cut short), and it
// serves the body so slowly that a 17MB image outruns a 45s budget. Both cost
// the same thing — the image is already generated and billed, and falling
// through hands the browser the upstream URL this function exists to hide — so
// the whole download, headers *and* body, is one retryable unit.
const INLINE_FETCH_ATTEMPTS = 3
const INLINE_FETCH_TIMEOUT_MS = 60_000
// Ceiling on all attempts combined, so a sulking host cannot eat the route's
// whole maxDuration and take the generation down with it.
const INLINE_TOTAL_BUDGET_MS = 150_000

async function downloadUpstreamImage(src: string) {
  const deadline = Date.now() + INLINE_TOTAL_BUDGET_MS

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(src, { signal: AbortSignal.timeout(INLINE_FETCH_TIMEOUT_MS) })

      if (!response.ok) {
        return { status: response.status } as const
      }

      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim()
      // Read the body inside the attempt: an abort fires during the transfer at
      // least as often as during the connect, and a body that died half-read is
      // exactly the case worth retrying.
      const buffer = await response.arrayBuffer()

      return { buffer, contentType, status: response.status } as const
    } catch (error) {
      if (attempt >= INLINE_FETCH_ATTEMPTS || Date.now() >= deadline) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}

async function inlineRemoteImage(image: GeneratedImage): Promise<GeneratedImage> {
  if (!/^https?:\/\//i.test(image.src)) {
    return image
  }

  try {
    const { buffer, contentType, status } = await downloadUpstreamImage(image.src)

    if (!buffer) {
      console.warn(`[api/images] inline skipped: upstream image fetch returned ${status}`)
      return image
    }

    if (!contentType.startsWith("image/")) {
      console.warn(`[api/images] inline skipped: unexpected content-type ${contentType || "(none)"}`)
      return image
    }

    if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES) {
      // Every fall-through here hands the browser the upstream URL, which is
      // the leak this function exists to close. Silent is the wrong failure
      // mode: say so in the server log, where raising the cap is a decision
      // someone can actually make.
      console.warn(
        `[api/images] inline skipped: ${Math.round(buffer.byteLength / 1048576)}MB exceeds the ` +
          `${Math.round(MAX_INLINE_IMAGE_BYTES / 1048576)}MB cap — the browser will receive the upstream URL`
      )
      return image
    }

    return {
      ...image,
      src: `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`,
    }
  } catch (error) {
    // Best effort only: fall back to the original URL and let the client cope.
    console.warn(
      `[api/images] inline failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return image
  }
}

// The container the bytes actually came back in, read off the data URL — built
// either from the upstream response's content-type when inlineRemoteImage
// fetched it, or from the payload's own magic bytes when the upstream answered
// with base64 directly.
function getInlinedImageFormat(images: GeneratedImage[]) {
  const match = /^data:image\/([a-z0-9.+-]+)/i.exec(images[0]?.src || "")

  return match ? match[1].toLowerCase() : undefined
}

export async function POST(request: Request) {
  let locale = resolveLocale(request.headers.get("accept-language"))
  const mock = isMockImageApiEnabled()

  if (mock) {
    console.warn("[api/images] IMAGE_API_MOCK is on — returning generated placeholders, no upstream call")
  }

  if (!mock && !INTERNAL_IMAGE_API_BASE_URL) {
    console.error("[api/images] INTERNAL_IMAGE_API_BASE_URL is not configured")
    return NextResponse.json({ error: t(locale, "imageServiceUnavailable") }, { status: 500 })
  }

  try {
    const incomingFormData = await request.formData()
    locale = resolveLocale(
      ((): string => {
        const value = incomingFormData.get("locale")
        return typeof value === "string" && value.trim()
          ? value.trim()
          : request.headers.get("accept-language") || ""
      })()
    )
    const apiKey = getText(incomingFormData, "apiKey", process.env.OPENAI_API_KEY || "")
    const prompt = getText(incomingFormData, "prompt")

    if (!mock && !apiKey) {
      return NextResponse.json({ error: t(locale, "proxyApiKeyRequired") }, { status: 400 })
    }

    if (!prompt) {
      return NextResponse.json({ error: t(locale, "proxyPromptRequired") }, { status: 400 })
    }

    const images = incomingFormData
      .getAll("images")
      .filter((value): value is File => value instanceof File && value.size > 0)

    for (const image of images) {
      if (!SUPPORTED_IMAGE_TYPES.has(image.type)) {
        return NextResponse.json(
          { error: t(locale, "proxyUnsupportedImageFormat", { name: image.name }) },
          { status: 400 }
        )
      }

      if (image.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: t(locale, "proxyImageTooLarge", { name: image.name }) },
          { status: 400 }
        )
      }
    }

    const model = getText(incomingFormData, "model", DEFAULT_MODEL)
    const capabilities = getModelCapabilities(model)
    const outputFormat = getOutputFormat(incomingFormData, model)
    const outputCompression = getOutputCompression(outputFormat, model)
    const imageCount = Number(getText(incomingFormData, "imageCount", "1"))
    const background = getBackground(incomingFormData, model)
    const isEdit = images.length > 0
    const quality = getQuality(incomingFormData, model, isEdit)
    const size = getSize(incomingFormData, model, isEdit)
    const n = Math.min(Math.max(imageCount, 1), 4)
    const supportedSizes = getSupportedSizes(model, isEdit)
    // Only the keys the model actually honours travel upstream. Sending one it
    // ignores is not free: it makes the response look like it answered the
    // request, and the UI then reports a size or format the bytes do not have.
    // `quality` is cast to the edit union, the narrower of the two — generate
    // additionally accepts "hd", and the capability table decides whether that
    // value can reach here at all.
    const optionalParams = {
      ...(capabilities.backgrounds.length
        ? { background: background as OpenAI.Images.ImageGenerateParams["background"] }
        : {}),
      ...(outputCompression === undefined ? {} : { output_compression: outputCompression }),
      ...(capabilities.outputFormats.length
        ? { output_format: outputFormat as OpenAI.Images.ImageGenerateParams["output_format"] }
        : {}),
      ...(getSupportedQualities(model, isEdit).length
        ? { quality: quality as OpenAI.Images.ImageEditParams["quality"] }
        : {}),
      ...(supportedSizes.length
        ? { size: size as OpenAI.Images.ImageGenerateParams["size"] }
        : {}),
      ...(shouldRequestB64Json() ? { response_format: "b64_json" as const } : {}),
    }
    let payload: unknown

    if (mock) {
      if (shouldFailMockRequest()) {
        return NextResponse.json(
          { error: t(locale, "proxyRequestFailed", { status: 502 }) },
          { status: 502 }
        )
      }

      payload = await createMockImagePayload({
        background,
        imageCount: n,
        outputFormat,
        prompt,
        quality,
        referenceCount: images.length,
        size,
      })
    } else {
      const baseURL = normalizeOpenAIBaseURL(INTERNAL_IMAGE_API_BASE_URL ?? "", locale)
      const client = new OpenAI({
        apiKey,
        baseURL,
        maxRetries: 0,
      })

      if (isEdit) {
        payload = await client.images.edit({
          image: images.length === 1 ? images[0] : images,
          model,
          n,
          prompt,
          ...optionalParams,
        })
      } else {
        payload = await client.images.generate({
          model,
          n,
          prompt,
          ...optionalParams,
        })
      }
    }

    const extractedImages = extractGeneratedImages(payload, outputFormat)
    const generatedImages =
      getText(incomingFormData, "inlineRemoteImages") === "1"
        ? await Promise.all(extractedImages.map(inlineRemoteImage))
        : extractedImages

    if (!generatedImages.length) {
      return NextResponse.json(
        {
          error: t(locale, "proxyNoImageField"),
        },
        { status: 502 }
      )
    }

    const responseBody = JSON.stringify({
      background: getPayloadField(payload, "background"),
      created: getPayloadField(payload, "created"),
      images: generatedImages,
      mock,
      model,
      // Report what came back, not what was asked for. On a model that ignores
      // output_format the request said "webp" and the bytes are PNG; echoing
      // the request here would put that lie on the result badge.
      outputFormat: capabilities.outputFormats.length
        ? outputFormat
        : getInlinedImageFormat(generatedImages) || outputFormat,
      quality: getPayloadField(payload, "quality") ||
        (getSupportedQualities(model, isEdit).length ? quality : undefined),
      // Never echoed from the request, even for a model that takes a size: the
      // one that follows the aspect ratio still picks its own resolution, so
      // asking for 1024x1536 and reporting it would misstate a 3392x5056
      // result. Absent, the client measures the pixels it actually received.
      size: getPayloadField(payload, "size"),
      usage: getPayloadField(payload, "usage"),
    })

    // Images ride back as inline base64, so this body is routinely multi-MB and
    // its download can outlast the generation itself. The browser draws a
    // transfer progress bar from this header. Content-Length cannot serve that
    // role — it reports the compressed size on the wire while the client's
    // stream reader counts decoded bytes — so publish the uncompressed length.
    return new NextResponse(responseBody, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        [PAYLOAD_BYTES_HEADER]: String(Buffer.byteLength(responseBody)),
      },
    })
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      const upstreamMessage = getImageApiError(error.error)

      return NextResponse.json(
        {
          error: (upstreamMessage && scrubUpstreamDetails(upstreamMessage)) ||
            t(locale, "proxyRequestFailed", { status: error.status || 500 }),
        },
        { status: error.status || 500 }
      )
    }

    // Security: never forward the raw exception message here — network-level
    // failures (DNS, connection refused, timeouts) can embed the internal
    // upstream host/port in their message text.
    return NextResponse.json(
      {
        error: t(locale, "proxyGenerationFailed"),
      },
      { status: 500 }
    )
  }
}
