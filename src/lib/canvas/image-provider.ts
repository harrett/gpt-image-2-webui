// Image provider for the infinite canvas.
//
// This is the canvas counterpart of the upstream Cowart project's
// `models/imageAdapters.js`, with one deliberate difference: there is no
// per-provider endpoint, no API key per provider, and no CORS proxy. Every call
// goes to the same same-origin `/api/images` route the image studio uses, which
// forwards to the server-only INTERNAL_IMAGE_API_BASE_URL. Consequences worth
// knowing:
//
//   - The browser never learns the upstream address, so the canvas inherits the
//     studio's lockdown for free.
//   - Same-origin means CORS cannot fail, so none of the upstream project's
//     proxyUrl / "Failed to fetch means CORS" machinery is needed.
//   - IMAGE_API_MOCK works here too: the canvas gets placeholder images with no
//     API key, same as the studio.
//
// The exported signatures intentionally mirror the upstream adapter contract
// (generateImage / editImage returning { dataUrl, width, height, mimeType }) so
// canvas code ported later needs no rewrite.

import { getStoredApiKey } from "@/lib/connection-preferences"
import { DEFAULT_LOCALE, resolveLocale, t, type Locale } from "@/lib/i18n"
import type { GeneratedImage } from "@/lib/image-request"
import { sizeForCanvasBox } from "@/lib/image-size"

export const DEFAULT_CANVAS_MODEL = "gpt-image-2"

// Mirrors MAX_IMAGE_BYTES in src/app/api/images/route.ts. Reference images over
// this are rejected server-side with a 400, so we shrink before sending.
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
// Also mirrors the route's SUPPORTED_IMAGE_TYPES.
const SUPPORTED_REFERENCE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"])
const REFERENCE_SHRINK_STEPS = 4

export type CanvasImageResult = {
  dataUrl: string
  width: number
  height: number
  mimeType: string
  revisedPrompt?: string
  mock: boolean
}

type CanvasImageRequest = {
  prompt: string
  /** Target width in canvas units; clamped to the route's 64-8192 range. */
  width?: number
  height?: number
  /** Reference/source image as a data URL. Present => the route runs an edit. */
  referenceDataUrl?: string
  model?: string
  quality?: string
  outputFormat?: string
  background?: string
  locale?: Locale
  signal?: AbortSignal
}

function currentLocale(locale?: Locale) {
  if (locale) {
    return locale
  }

  if (typeof document === "undefined") {
    return DEFAULT_LOCALE
  }

  return resolveLocale(document.documentElement.lang)
}

function mimeTypeForDataUrl(dataUrl: string) {
  return /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/png"
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl)
  return response.blob()
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Guarantee a data URL. Studio results can still carry a hosted `url` when the
 * upstream returned one and inlining was not requested — and a remote image on
 * a tldraw canvas taints the export canvas, which breaks `toImageDataUrl`.
 */
export async function ensureDataUrl(src: string) {
  if (src.startsWith("data:")) {
    return src
  }

  return blobToDataUrl(await (await fetch(src)).blob())
}

/**
 * Real pixel dimensions of a data URL.
 *
 * The upstream project's equivalent never worked: `imageResult()` spread an
 * un-awaited promise (so width/height came back undefined) and its byte-header
 * parser was handed a data URL *string* rather than a Blob, which throws — so
 * every inserted image silently fell back to 1024x1024. Decoding through
 * createImageBitmap is both correct and shorter.
 */
export async function measureDataUrl(dataUrl: string) {
  const blob = await dataUrlToBlob(dataUrl)
  const bitmap = await createImageBitmap(blob)
  const size = { width: bitmap.width, height: bitmap.height }

  bitmap.close()

  return size
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed."))),
      type,
      quality
    )
  })
}

/**
 * Make a reference image acceptable to /api/images: a supported MIME type and
 * under the 10MB cap. tldraw exports selections at `pixelRatio: 2` PNG, which
 * blows past 10MB on anything large, so shrink by halving the long edge until
 * it fits rather than failing the request.
 */
async function prepareReferenceFile(dataUrl: string) {
  const blob = await dataUrlToBlob(dataUrl)
  const type = blob.type || mimeTypeForDataUrl(dataUrl)

  if (SUPPORTED_REFERENCE_TYPES.has(type) && blob.size <= MAX_REFERENCE_BYTES) {
    return new File([blob], `reference.${type === "image/webp" ? "webp" : type === "image/png" ? "png" : "jpg"}`, {
      type,
    })
  }

  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")

  if (!context) {
    bitmap.close()
    throw new Error("Canvas 2D context unavailable.")
  }

  try {
    let scale = 1

    for (let attempt = 0; attempt <= REFERENCE_SHRINK_STEPS; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      const encoded = await canvasToBlob(canvas, "image/png")

      if (encoded.size <= MAX_REFERENCE_BYTES) {
        return new File([encoded], "reference.png", { type: "image/png" })
      }

      scale *= 0.7
    }

    // Last resort: JPEG drops the alpha channel but is far smaller.
    const fallback = await canvasToBlob(canvas, "image/jpeg", 0.85)
    return new File([fallback], "reference.jpg", { type: "image/jpeg" })
  } finally {
    bitmap.close()
  }
}

async function requestImage({
  prompt,
  width,
  height,
  referenceDataUrl,
  model = DEFAULT_CANVAS_MODEL,
  quality = "auto",
  outputFormat = "png",
  background = "auto",
  locale,
  signal,
}: CanvasImageRequest): Promise<CanvasImageResult> {
  const activeLocale = currentLocale(locale)
  const formData = new FormData()

  formData.append("apiKey", getStoredApiKey())
  formData.append("background", background)
  formData.append("imageCount", "1")
  // Ask the route to inline any hosted image URL as a data URL: the canvas
  // persists its snapshot (assets included) in IndexedDB, where an expiring
  // remote link would break the drawing on reload.
  formData.append("inlineRemoteImages", "1")
  formData.append("locale", activeLocale)
  formData.append("model", model)
  formData.append("outputFormat", outputFormat)
  formData.append("prompt", prompt)
  formData.append("quality", quality)

  if (width && height) {
    formData.append("size", sizeForCanvasBox(width, height))
  }

  if (referenceDataUrl) {
    const reference = await prepareReferenceFile(referenceDataUrl)
    formData.append("images", reference, reference.name)
  }

  const response = await fetch("/api/images", {
    method: "POST",
    body: formData,
    signal,
  })
  const payload = (await response.json()) as {
    error?: string
    images?: GeneratedImage[]
    mock?: boolean
  }

  if (!response.ok) {
    // The route already scrubs upstream URLs out of error text, so this is safe
    // to surface verbatim.
    throw new Error(payload.error || t(activeLocale, "requestFailedStatus", { status: response.status }))
  }

  const image = payload.images?.[0]

  if (!image?.src) {
    throw new Error(t(activeLocale, "noImageInPayload"))
  }

  const dataUrl = await ensureDataUrl(image.src)
  const dimensions = await measureDataUrl(dataUrl).catch(() => ({
    width: width || 1024,
    height: height || 1024,
  }))

  return {
    dataUrl,
    width: dimensions.width,
    height: dimensions.height,
    mimeType: mimeTypeForDataUrl(dataUrl),
    revisedPrompt: image.revisedPrompt,
    mock: payload.mock === true,
  }
}

/**
 * Generate an image sized for a canvas box. Passing `referenceDataUrl` routes
 * the call through the upstream edit endpoint automatically (the route picks
 * edit vs. generate purely on whether files are attached).
 */
export function generateImage(request: CanvasImageRequest) {
  return requestImage(request)
}

/** Edit an existing canvas image. Same wire call, reference image required. */
export function editImage({
  imageDataUrl,
  ...request
}: Omit<CanvasImageRequest, "referenceDataUrl"> & { imageDataUrl: string }) {
  return requestImage({ ...request, referenceDataUrl: imageDataUrl })
}
