// Run with Node 22.18+: node scripts/test-image2pro-sizing.mjs
import assert from "node:assert/strict"
import { DEFAULT_MODEL, getImageSizingParams, getModelCapabilities, normalizeImageModel } from "../src/lib/image-model-capabilities.ts"

assert.equal(DEFAULT_MODEL, "gpt-image-2.5-flare")
for (const model of ["gpt-image-2.5", "GPT-Image-2.5 0.01/张", DEFAULT_MODEL]) {
  assert.equal(normalizeImageModel(model), DEFAULT_MODEL)
  assert.equal(getModelCapabilities(model), getModelCapabilities(DEFAULT_MODEL))
}
assert.equal(normalizeImageModel("gpt-image-2"), "gpt-image-2")

const form = new FormData()
assert.deepEqual(getImageSizingParams(DEFAULT_MODEL, form), {})
form.set("aspect_ratio", "3:2")
form.set("resolution", "2K")
assert.deepEqual(getImageSizingParams(DEFAULT_MODEL, form), { aspect_ratio: "3:2", resolution: "2K" })
for (const model of ["gpt-image-2", "banana-2-pro", "grok-image-2.0", "z-image", "unknown"]) {
  assert.deepEqual(getImageSizingParams(model, form), {})
  assert.equal(getModelCapabilities(model).aspectRatios, undefined)
}
for (const ratio of getModelCapabilities(DEFAULT_MODEL).aspectRatios) {
  form.set("aspect_ratio", ratio)
  assert.equal(getImageSizingParams(DEFAULT_MODEL, form).aspect_ratio, ratio)
}
for (const resolution of getModelCapabilities(DEFAULT_MODEL).resolutions) {
  form.set("resolution", resolution)
  assert.equal(getImageSizingParams(DEFAULT_MODEL, form).resolution, resolution)
}
form.set("aspect_ratio", "auto")
form.set("resolution", "auto")
assert.deepEqual(getImageSizingParams(DEFAULT_MODEL, form), {})
form.set("resolution", "invalid")
assert.throws(() => getImageSizingParams(DEFAULT_MODEL, form), /Invalid resolution/)
assert.deepEqual(getImageSizingParams("gpt-image-2", form), {})
form.set("resolution", "2K")
form.set("aspect_ratio", "invalid")
assert.throws(() => getImageSizingParams(DEFAULT_MODEL, form), /Invalid aspect_ratio/)
console.log("Image2Pro sizing checks passed")
