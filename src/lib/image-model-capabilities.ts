// What each model's image endpoint actually honours, in one table read by both
// the client (which controls to show) and the route (which parameters to send).
// Keeping the two in sync used to mean editing two hand-maintained allow-lists.
//
// An empty list means "this model gives the user no say": the parameter is left
// out of the upstream request and its control is left out of the UI. That is a
// stronger statement than "the upstream rejects it" — a channel that accepts a
// parameter with HTTP 200 and then ignores it is worse than one that refuses,
// because the UI would go on promising control it does not have.
//
// Traffic reaches a model through the sub2api gateway, which maps these ids
// onto whatever the configured channel calls them upstream and forwards the
// body otherwise untouched, so what lands here is what the channel sees.

export type ImageModelCapabilities = {
  /** Honoured `background` values; empty omits the parameter and hides the control. */
  backgrounds: readonly string[]
  /** Honoured `quality` values for edits; empty omits and hides. */
  editQualities: readonly string[]
  /** Honoured `size` values for edits; empty omits and hides. */
  editSizes: readonly string[]
  /** Honoured `quality` values for generation; empty omits and hides. */
  generateQualities: readonly string[]
  /** Honoured `size` values for generation; empty omits and hides. */
  generateSizes: readonly string[]
  /** Whether the upstream honours `output_compression`. */
  outputCompression: boolean
  /** Honoured `output_format` values; empty omits and hides. */
  outputFormats: readonly string[]
}

// The id the picker sends. The gateway redirects it to the channel's own model
// name, which carries per-image pricing in its text and therefore must not be
// hardcoded here — it changes whenever the channel is repriced.
export const DEFAULT_MODEL = "gpt-image-2.5"

const GENERATE_SIZES = [
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
] as const

// No 1792x1024 / 1024x1792: the edit endpoint rejects them.
const EDIT_SIZES = [
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
] as const

const GENERATE_QUALITIES = ["auto", "low", "medium", "high", "standard", "hd"] as const
const EDIT_QUALITIES = ["auto", "low", "medium", "high", "standard"] as const
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const

// Every model on this channel takes all five parameters, answers HTTP 200, and
// then decides for itself. None of them is rejected, so nothing about this is
// visible from the request alone — each entry below is measured.
const NO_SAY: ImageModelCapabilities = {
  backgrounds: [],
  editQualities: [],
  editSizes: [],
  generateQualities: [],
  generateSizes: [],
  outputCompression: false,
  outputFormats: [],
}

// Banana is the exception worth the whole table: it ignores the *resolution* in
// `size` but follows its aspect ratio. 1536x1024 came back 5056x3392 and
// 1024x1536 came back 3392x5056, while omitting size gave a 4096x4096 square.
// So the aspect control stays, and only ratios distinct from one another are
// offered — 1920x1080 and 3840x2160 would be the same request to this model.
const BANANA_ASPECT_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1920x1080",
  "1080x1920",
] as const

const BANANA_CAPABILITIES: ImageModelCapabilities = {
  ...NO_SAY,
  editSizes: BANANA_ASPECT_SIZES,
  generateSizes: BANANA_ASPECT_SIZES,
}

// The shape a channel that *does* honour these parameters takes — the full
// OpenAI image parameter surface. Nothing routes here today; it is exported so
// that adding such a channel is a one-line table entry rather than a rebuild of
// the allow-lists from scratch.
export const OPENAI_NATIVE_CAPABILITIES: ImageModelCapabilities = {
  backgrounds: BACKGROUNDS,
  editQualities: EDIT_QUALITIES,
  editSizes: EDIT_SIZES,
  generateQualities: GENERATE_QUALITIES,
  generateSizes: GENERATE_SIZES,
  outputCompression: true,
  outputFormats: OUTPUT_FORMATS,
}

// Measured per model, all on the same channel and all returning a hosted URL
// rather than base64:
//
//   gpt-image-2.5   1024x1024 and 1536x1024 both -> 2880x2880 PNG, 3/3 runs
//   gpt-image-2     does not settle: four identical requests for 1536x1024
//                   returned that exact size as base64 PNG three times and a
//                   2880x2880 JPEG at a URL once. It is the one model here
//                   whose behaviour varies run to run, so it promises nothing
//                   — do not give it a size control on the strength of the
//                   runs where size happens to work.
//   banana-2-pro    aspect followed, resolution not -> 3392x5056 / 5056x3392
//                   JPEG, 4/4 runs, which is what makes its control honest
//   grok-image-2.0  2048x2048 PNG whatever is asked for, 2/2 runs
//   z-image         ignores size outright; 624x624 with a size, 768x512 without
//
// All four accept reference images and visibly work from them, so the edit
// path — and with it the canvas revision flow — is live on every one.
const CAPABILITIES_BY_MODEL: Record<string, ImageModelCapabilities> = {
  "banana-2-pro": BANANA_CAPABILITIES,
  "gpt-image-2": NO_SAY,
  "gpt-image-2.5": NO_SAY,
  "grok-image-2.0": NO_SAY,
  "z-image": NO_SAY,
}

// Unknown ids reach here from restored history: a canvas generated before a
// model was renamed still carries the old id, and its revisions re-send it.
// Falling back to the set that claims nothing keeps those revisions working
// without inventing control the model may not have.
export function getModelCapabilities(model: string): ImageModelCapabilities {
  return CAPABILITIES_BY_MODEL[model] ?? NO_SAY
}

export function getSupportedSizes(model: string, isEdit: boolean) {
  const capabilities = getModelCapabilities(model)

  return isEdit ? capabilities.editSizes : capabilities.generateSizes
}

export function getSupportedQualities(model: string, isEdit: boolean) {
  const capabilities = getModelCapabilities(model)

  return isEdit ? capabilities.editQualities : capabilities.generateQualities
}
