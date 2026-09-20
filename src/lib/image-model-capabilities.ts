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

// Measured against the channel behind these ids, not assumed: a generation
// asking for size 1024x1024 (and again for 1536x1024), output_format webp,
// output_compression 80 and response_format b64_json answered HTTP 200 without
// complaint and returned, both times, a 2880x2880 PNG of ~17MB at a hosted URL.
// The channel takes every one of those parameters and honours none of them, so
// the user gets no say and the UI says so by omission.
//
// Only `prompt`, `model` and `n` are left, which is the whole reason this table
// exists: nothing about that is visible from the request alone.
const IMAGE2PRO_CAPABILITIES: ImageModelCapabilities = {
  backgrounds: [],
  editQualities: [],
  editSizes: [],
  generateQualities: [],
  generateSizes: [],
  outputCompression: false,
  outputFormats: [],
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

const CAPABILITIES_BY_MODEL: Record<string, ImageModelCapabilities> = {
  "gpt-image-2": IMAGE2PRO_CAPABILITIES,
  "gpt-image-2.5": IMAGE2PRO_CAPABILITIES,
}

// Unknown ids reach here from restored history: a canvas generated before a
// model was renamed still carries the old id, and its revisions re-send it.
// Falling back to the conservative set keeps those revisions working.
export function getModelCapabilities(model: string): ImageModelCapabilities {
  return CAPABILITIES_BY_MODEL[model] ?? IMAGE2PRO_CAPABILITIES
}

export function getSupportedSizes(model: string, isEdit: boolean) {
  const capabilities = getModelCapabilities(model)

  return isEdit ? capabilities.editSizes : capabilities.generateSizes
}

export function getSupportedQualities(model: string, isEdit: boolean) {
  const capabilities = getModelCapabilities(model)

  return isEdit ? capabilities.editQualities : capabilities.generateQualities
}
