import { deflateSync } from "node:zlib"

// Local-only stand-in for the upstream image API. Enabled with IMAGE_API_MOCK=1
// so the whole UI flow (parallel slots, retries, progress, iteration, viewer)
// can be exercised without spending minutes on a real generation.

const DEFAULT_MOCK_DELAY_MS = 900
// A 8192x8192 custom size would need ~200MB of raw pixels; keep mock renders sane.
const MAX_MOCK_PIXELS = 12_000_000
const GRID_STEP = 64
const BORDER_WIDTH = 6

export function isMockImageApiEnabled() {
  const value = process.env.IMAGE_API_MOCK?.trim().toLowerCase()

  return value === "1" || value === "true"
}

export function shouldFailMockRequest() {
  const rate = Number(process.env.IMAGE_API_MOCK_FAIL_RATE)

  if (!Number.isFinite(rate) || rate <= 0) {
    return false
  }

  return Math.random() < Math.min(rate, 1)
}

function getMockDelay() {
  const configured = Number(process.env.IMAGE_API_MOCK_DELAY_MS)
  const base = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MOCK_DELAY_MS

  // Jitter so parallel slots resolve one by one, like a real batch does.
  return Math.round(base * (0.6 + Math.random() * 0.8))
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let value = index

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }

    table[index] = value >>> 0
  }

  return table
})()

function crc32(buffer: Buffer) {
  let crc = 0xffffffff

  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const typedData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typedData), 0)

  return Buffer.concat([length, typedData, checksum])
}

function encodePng(width: number, height: number, raw: Buffer) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(2, 9) // truecolor RGB
  header.writeUInt8(0, 10) // deflate
  header.writeUInt8(0, 11) // adaptive filtering
  header.writeUInt8(0, 12) // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function createSeed(value: string) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = lightness - chroma / 2
  const sector = Math.floor(hue / 60) % 6
  const [red, green, blue] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sector]

  return [
    Math.round((red + match) * 255),
    Math.round((green + match) * 255),
    Math.round((blue + match) * 255),
  ] as const
}

function resolveMockSize(size: string) {
  const [rawWidth, rawHeight] = size.split("x").map(Number)
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 1024
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 1024
  const pixels = width * height

  if (pixels <= MAX_MOCK_PIXELS) {
    return { height, width }
  }

  const scale = Math.sqrt(MAX_MOCK_PIXELS / pixels)

  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  }
}

function paintMockCanvas(width: number, height: number, seed: number) {
  const rowLength = width * 3 + 1
  const raw = Buffer.alloc(rowLength * height)
  const hue = seed % 360
  const [topR, topG, topB] = hslToRgb(hue, 0.62, 0.36)
  const [bottomR, bottomG, bottomB] = hslToRgb((hue + 42) % 360, 0.68, 0.16)
  const [gridR, gridG, gridB] = hslToRgb(hue, 0.4, 0.72)
  const detailSize = Math.round(Math.min(width, height) / 4)
  const detailLeft = Math.round((width - detailSize) / 2)
  const detailTop = Math.round((height - detailSize) / 2)
  const centerX = Math.round(width / 2)
  const centerY = Math.round(height / 2)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength
    raw[rowStart] = 0 // filter type: none

    const ratio = height === 1 ? 0 : y / (height - 1)
    const baseR = Math.round(topR + (bottomR - topR) * ratio)
    const baseG = Math.round(topG + (bottomG - topG) * ratio)
    const baseB = Math.round(topB + (bottomB - topB) * ratio)
    const isGridRow = y % GRID_STEP === 0
    const isCenterRow = y === centerY
    const isBorderRow = y < BORDER_WIDTH || y >= height - BORDER_WIDTH
    const isDetailRow = y >= detailTop && y < detailTop + detailSize

    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3
      let red = baseR
      let green = baseG
      let blue = baseB

      if (isDetailRow && x >= detailLeft && x < detailLeft + detailSize) {
        // 1px checkerboard: moirés when scaled down, crisp at 1:1 — an easy way
        // to eyeball the fit-to-screen vs actual-size modes of the viewer.
        const on = (x + y) % 2 === 0
        red = on ? 245 : 20
        green = on ? 245 : 20
        blue = on ? 245 : 20
      } else if (isBorderRow || x < BORDER_WIDTH || x >= width - BORDER_WIDTH) {
        red = 244
        green = 244
        blue = 244
      } else if (isGridRow || x % GRID_STEP === 0 || isCenterRow || x === centerX) {
        red = gridR
        green = gridG
        blue = gridB
      }

      raw[offset] = red
      raw[offset + 1] = green
      raw[offset + 2] = blue
    }
  }

  return raw
}

export async function createMockImagePayload({
  background,
  imageCount,
  outputFormat,
  prompt,
  quality,
  referenceCount,
  size,
}: {
  background: string
  imageCount: number
  outputFormat: string
  prompt: string
  quality: string
  referenceCount: number
  size: string
}) {
  const { height, width } = resolveMockSize(size)

  await delay(getMockDelay())

  const data = Array.from({ length: imageCount }, (_, index) => {
    const seed = createSeed(`${prompt}:${size}:${index}:${Math.random()}`)
    const png = encodePng(width, height, paintMockCanvas(width, height, seed))

    return {
      b64_json: png.toString("base64"),
      revised_prompt:
        `[mock] ${prompt} — rendered locally at ${width}x${height}, ` +
        `quality "${quality}", background "${background}", ` +
        `${referenceCount} reference image${referenceCount === 1 ? "" : "s"}. ` +
        "No upstream image API was called.",
    }
  })

  return {
    background,
    created: Math.floor(Date.now() / 1000),
    data,
    output_format: outputFormat,
    quality,
    size: `${width}x${height}`,
    usage: {
      input_tokens: prompt.length,
      output_tokens: 0,
      total_tokens: prompt.length,
    },
  }
}
