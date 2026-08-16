// Generated images come back inline as base64 data URLs, so one response body
// is routinely 5-30 MB. On a thin link the body transfer takes *longer* than
// the upstream generation that produced it, and a single "generating…" spinner
// makes that look like the model is slow. These helpers split a request into
// the two phases the browser can actually observe — waiting for the first byte
// (server-side generation) and streaming the body (download) — so the UI can
// show where the minutes go.

export const PAYLOAD_BYTES_HEADER = "x-payload-bytes"

export type TransferPhase = "waiting" | "downloading" | "done"

export type TransferSlot = {
  finishedAt: number | null
  firstByteAt: number | null
  id: string
  phase: TransferPhase
  receivedBytes: number
  startedAt: number
  totalBytes: number | null
}

export type TransferSummary = {
  bytesPerSecond: number | null
  downloadElapsedMs: number
  downloadPercent: number
  downloadingCount: number
  etaMs: number | null
  hasStarted: boolean
  isTotalEstimated: boolean
  percent: number
  receivedBytes: number
  totalBytes: number | null
  waitElapsedMs: number
  waitingCount: number
}

// The waiting phase gets the first slice of the bar and the download the rest.
// The split is deliberately download-heavy: on the connections this exists for,
// the download is the longer leg.
const WAIT_PROGRESS_CEILING = 0.35
// Wall-clock constant of the asymptotic creep while waiting for the first byte.
// Asymptotic (never reaches the ceiling) so a slow upstream can't push the bar
// into the download segment before a single byte has landed.
const WAIT_PROGRESS_SCALE_MS = 45_000
// Fallback curve when the response never declared its size.
const UNKNOWN_SIZE_SCALE_BYTES = 8 * 1024 * 1024
// Chunks arrive every few KB; repainting the studio on each one is wasteful.
const PROGRESS_REPORT_INTERVAL_MS = 120

export function createTransferSlot(id: string, startedAt = Date.now()): TransferSlot {
  return {
    finishedAt: null,
    firstByteAt: null,
    id,
    phase: "waiting",
    receivedBytes: 0,
    startedAt,
    totalBytes: null,
  }
}

export function updateTransferSlot(
  slots: TransferSlot[],
  id: string,
  update: (slot: TransferSlot) => TransferSlot
) {
  return slots.map((slot) => (slot.id === id ? update(slot) : slot))
}

// A stream reader counts *decoded* bytes, so `Content-Length` (the compressed
// size on the wire) is the wrong denominator whenever the response was gzipped.
// The route publishes its uncompressed byte length instead; Content-Length is
// only trusted when nothing re-encoded the body.
export function readPayloadBytes(headers: Headers) {
  const declared = Number(headers.get(PAYLOAD_BYTES_HEADER))

  if (Number.isFinite(declared) && declared > 0) {
    return declared
  }

  if (headers.get("content-encoding")) {
    return null
  }

  const contentLength = Number(headers.get("content-length"))

  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
}

export async function readTextWithProgress(
  response: Response,
  onProgress: (receivedBytes: number) => void
) {
  if (!response.body) {
    const text = await response.text()

    onProgress(text.length)

    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let receivedBytes = 0
  let reportedAt = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    receivedBytes += value.byteLength
    text += decoder.decode(value, { stream: true })

    const now = Date.now()

    if (now - reportedAt >= PROGRESS_REPORT_INTERVAL_MS) {
      reportedAt = now
      onProgress(receivedBytes)
    }
  }

  onProgress(receivedBytes)

  return text + decoder.decode()
}

function getSlotProgress(slot: TransferSlot, now: number) {
  if (slot.phase === "done") {
    return 1
  }

  if (slot.phase === "downloading") {
    const fraction = slot.totalBytes
      ? Math.min(slot.receivedBytes / slot.totalBytes, 1)
      : slot.receivedBytes / (slot.receivedBytes + UNKNOWN_SIZE_SCALE_BYTES)

    return WAIT_PROGRESS_CEILING + (1 - WAIT_PROGRESS_CEILING) * fraction
  }

  const waited = Math.max(now - slot.startedAt, 0)

  return WAIT_PROGRESS_CEILING * (waited / (waited + WAIT_PROGRESS_SCALE_MS))
}

export function summarizeTransfers(
  slots: TransferSlot[],
  expectedSlots: number,
  now: number
): TransferSummary {
  if (!slots.length) {
    return {
      bytesPerSecond: null,
      downloadElapsedMs: 0,
      downloadPercent: 0,
      downloadingCount: 0,
      etaMs: null,
      hasStarted: false,
      isTotalEstimated: false,
      percent: 0,
      receivedBytes: 0,
      totalBytes: null,
      waitElapsedMs: 0,
      waitingCount: 0,
    }
  }

  const runStartedAt = Math.min(...slots.map((slot) => slot.startedAt))
  // The caller's clock is a heartbeat sample, so it can trail a slot that was
  // just registered. Never let that read as negative elapsed time.
  now = Math.max(now, runStartedAt)
  const firstByteTimes = slots
    .map((slot) => slot.firstByteAt)
    .filter((value): value is number => value !== null)
  const firstByteAt = firstByteTimes.length ? Math.min(...firstByteTimes) : null
  const waitingCount = slots.filter((slot) => slot.phase === "waiting").length
  const downloadingCount = slots.filter((slot) => slot.phase === "downloading").length
  const receivedBytes = slots.reduce((sum, slot) => sum + slot.receivedBytes, 0)
  const knownTotals = slots
    .map((slot) => slot.totalBytes)
    .filter((value): value is number => value !== null)

  // Slots still waiting have not announced a size yet. Rather than showing a
  // total that grows as each response lands, project the missing ones from the
  // sizes already known — same prompt and settings, so they land close.
  const slotCount = Math.max(slots.length, expectedSlots, 1)
  const isTotalEstimated = Boolean(knownTotals.length) && knownTotals.length < slotCount
  const totalBytes = knownTotals.length
    ? Math.round((knownTotals.reduce((sum, value) => sum + value, 0) / knownTotals.length) * slotCount)
    : null

  const downloadElapsedMs = firstByteAt
    ? Math.max((downloadingCount ? now : Math.max(...slots.map((slot) => slot.finishedAt ?? now))) - firstByteAt, 0)
    : 0
  const bytesPerSecond =
    downloadElapsedMs > 500 && receivedBytes > 0
      ? (receivedBytes / downloadElapsedMs) * 1000
      : null
  const etaMs =
    bytesPerSecond && totalBytes && totalBytes > receivedBytes
      ? ((totalBytes - receivedBytes) / bytesPerSecond) * 1000
      : null

  const progress =
    slots.reduce((sum, slot) => sum + getSlotProgress(slot, now), 0) / slotCount

  return {
    bytesPerSecond,
    downloadElapsedMs,
    downloadPercent: totalBytes
      ? Math.min(Math.round((receivedBytes / totalBytes) * 100), 100)
      : 0,
    downloadingCount,
    etaMs,
    hasStarted: true,
    isTotalEstimated,
    percent: Math.min(Math.round(progress * 100), 100),
    receivedBytes,
    totalBytes,
    waitElapsedMs: (firstByteAt ?? now) - runStartedAt,
    waitingCount,
  }
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"]

export function formatBytes(bytes: number) {
  let value = Math.max(bytes, 0)
  let unitIndex = 0

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : value >= 100 ? 0 : 1)} ${BYTE_UNITS[unitIndex]}`
}

export function formatTransferRate(bytesPerSecond: number) {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
