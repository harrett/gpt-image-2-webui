// Custom size parsing shared by the client (image studio, canvas) and the
// server route. Both sides must agree on what counts as a valid custom size —
// keeping one implementation here is what makes that guarantee cheap.

export const MIN_CUSTOM_DIMENSION = 64
export const MAX_CUSTOM_DIMENSION = 8192

export function normalizeCustomSize(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "").replace(/×/g, "x")
  const match = /^([1-9]\d{1,4})x([1-9]\d{1,4})$/.exec(normalized)

  if (!match) {
    return ""
  }

  const width = Number(match[1])
  const height = Number(match[2])

  if (
    width < MIN_CUSTOM_DIMENSION ||
    width > MAX_CUSTOM_DIMENSION ||
    height < MIN_CUSTOM_DIMENSION ||
    height > MAX_CUSTOM_DIMENSION
  ) {
    return ""
  }

  return `${width}x${height}`
}

export function getSizeDimensions(size: string) {
  const normalized = normalizeCustomSize(size)

  if (!normalized) {
    return null
  }

  const [width, height] = normalized.split("x").map(Number)
  return { height, width }
}

// Canvas boxes are arbitrary floats (a frame the user dragged out), so round
// and clamp them into a size string the route will accept. Unlike the upstream
// canvas project we don't snap to a handful of OpenAI presets: /api/images
// already validates any custom size in range, so the holder's real aspect
// ratio survives the round trip.
export function sizeForCanvasBox(width: number, height: number) {
  const clamp = (value: number) => {
    if (!Number.isFinite(value)) {
      return MIN_CUSTOM_DIMENSION
    }

    return Math.min(Math.max(Math.round(value), MIN_CUSTOM_DIMENSION), MAX_CUSTOM_DIMENSION)
  }

  return `${clamp(width)}x${clamp(height)}`
}
