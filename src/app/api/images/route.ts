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
import { normalizeCustomSize } from "@/lib/image-size"
import { PAYLOAD_BYTES_HEADER } from "@/lib/transfer-progress"
import {
  createMockImagePayload,
  isMockImageApiEnabled,
  shouldFailMockRequest,
} from "@/lib/mock-image"

export const runtime = "nodejs"
export const maxDuration = 180

// Security: upstream base URL is server-controlled and read from a
// server-only env var. Never prefix it with NEXT_PUBLIC_, never read it
// in client code, never return its value to the browser. Do not accept
// endpoint/baseUrl/baseURL/apiUrl fields from client requests.
const INTERNAL_IMAGE_API_BASE_URL = process.env.INTERNAL_IMAGE_API_BASE_URL

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
// Results travel back to the browser inline as base64 inside the JSON body, so
// the encoded size *is* the download the user waits through. WebP at a sane
// compression level is several times smaller than the PNG this used to default
// to, which is the single biggest lever on perceived generation time.
const DEFAULT_OUTPUT_FORMAT = "webp"
const DEFAULT_OUTPUT_COMPRESSION = 80
const GENERATE_SIZE_VALUES = new Set([
  "auto",
  "256x256",
  "512x512",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1792x1024",
  "1024x1792",
  "1920x1080",
  "1080x1920",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
])
const EDIT_SIZE_VALUES = new Set([
  "auto",
  "256x256",
  "512x512",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1920x1080",
  "1080x1920",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
])
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

function getBackground(formData: FormData) {
  const value = getText(formData, "background", "auto")
  return value === "transparent" || value === "opaque" || value === "auto" ? value : "auto"
}

function getOutputFormat(formData: FormData) {
  const value = getText(formData, "outputFormat", DEFAULT_OUTPUT_FORMAT)
  return value === "jpeg" || value === "webp" || value === "png" ? value : DEFAULT_OUTPUT_FORMAT
}

// WebP and JPEG both default to `output_compression: 100` upstream — i.e. as
// close to lossless as the container allows, which for photographic content
// lands within spitting distance of the PNG it replaced. Asking for WebP alone
// therefore buys much less than it looks like; the compression level is what
// turns a ~1.7MB image into a ~300-500KB one. PNG ignores the parameter.
//
// Set IMAGE_OUTPUT_COMPRESSION to a 0-100 value to tune, or to "off" for
// upstreams that reject the parameter outright.
function getOutputCompression(outputFormat: string) {
  if (outputFormat === "png") {
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

function getGenerateQuality(formData: FormData) {
  const value = getText(formData, "quality", "auto")
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "standard" || value === "hd"
    ? value
    : "auto"
}

function getSize(formData: FormData, supportedSizes: Set<string>) {
  const value = getText(formData, "size", "1024x1024")
  const normalizedCustomSize = normalizeCustomSize(value)

  if (supportedSizes.has(value)) {
    return value
  }

  return normalizedCustomSize || "1024x1024"
}

function getEditQuality(formData: FormData) {
  const value = getText(formData, "quality", "auto")
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "standard"
    ? value
    : "auto"
}

function getGenerateSize(formData: FormData) {
  return getSize(formData, GENERATE_SIZE_VALUES)
}

function getEditSize(formData: FormData) {
  return getSize(formData, EDIT_SIZE_VALUES)
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
async function inlineRemoteImage(image: GeneratedImage): Promise<GeneratedImage> {
  if (!/^https?:\/\//i.test(image.src)) {
    return image
  }

  try {
    const response = await fetch(image.src)

    if (!response.ok) {
      return image
    }

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim()

    if (!contentType.startsWith("image/")) {
      return image
    }

    const buffer = await response.arrayBuffer()

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return image
    }

    return {
      ...image,
      src: `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`,
    }
  } catch {
    // Best effort only: fall back to the original URL and let the client cope.
    return image
  }
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

      if (image.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: t(locale, "proxyImageTooLarge", { name: image.name }) },
          { status: 400 }
        )
      }
    }

    const model = getText(incomingFormData, "model", "gpt-image-2")
    const outputFormat = getOutputFormat(incomingFormData)
    const outputCompression = getOutputCompression(outputFormat)
    const imageCount = Number(getText(incomingFormData, "imageCount", "1"))
    const background = getBackground(incomingFormData)
    const n = Math.min(Math.max(imageCount, 1), 4)
    let payload: unknown
    let requestQuality = "auto"
    let requestSize = "1024x1024"

    if (mock) {
      if (shouldFailMockRequest()) {
        return NextResponse.json(
          { error: t(locale, "proxyRequestFailed", { status: 502 }) },
          { status: 502 }
        )
      }

      const quality = images.length
        ? getEditQuality(incomingFormData)
        : getGenerateQuality(incomingFormData)
      const size = images.length ? getEditSize(incomingFormData) : getGenerateSize(incomingFormData)

      requestQuality = quality
      requestSize = size
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

      if (images.length) {
        const quality = getEditQuality(incomingFormData)
        const size = getEditSize(incomingFormData)

        requestQuality = quality
        requestSize = size
        payload = await client.images.edit({
          background,
          image: images.length === 1 ? images[0] : images,
          model,
          n,
          // Omitted entirely for PNG and when disabled: some OpenAI-compatible
          // providers reject parameters they do not implement.
          ...(outputCompression === undefined ? {} : { output_compression: outputCompression }),
          output_format: outputFormat,
          prompt,
          quality,
          size: size as OpenAI.Images.ImageEditParams["size"],
        })
      } else {
        const quality = getGenerateQuality(incomingFormData)
        const size = getGenerateSize(incomingFormData)

        requestQuality = quality
        requestSize = size
        payload = await client.images.generate({
          background,
          model,
          n,
          ...(outputCompression === undefined ? {} : { output_compression: outputCompression }),
          output_format: outputFormat,
          prompt,
          quality,
          size: size as OpenAI.Images.ImageGenerateParams["size"],
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
      outputFormat,
      quality: getPayloadField(payload, "quality") || requestQuality,
      size: getPayloadField(payload, "size") || requestSize,
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
