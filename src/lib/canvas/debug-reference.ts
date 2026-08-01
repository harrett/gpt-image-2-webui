// Development-only inspector for the reference image the canvas uploads.
//
// DevTools cannot preview a binary part inside a multipart/form-data body — the
// Payload tab just says "(binary)" — so there is no built-in way to check that
// the annotations, their numbers, and the artwork all made it into the pixels
// that were actually sent. This stashes the exact File and prints a clickable
// blob: URL, plus a one-call overlay.
//
// Every export is stripped from production builds by the NODE_ENV guard in
// `inspectReference`.

type DebugWindow = Window & {
  __imgxReference?: {
    file: File
    url: string
    width: number
    height: number
  }
  __imgxShowReference?: () => void
}

const OVERLAY_ID = "imgx-reference-overlay"

function showOverlay(url: string, caption: string, fileName: string) {
  document.getElementById(OVERLAY_ID)?.remove()

  const overlay = document.createElement("div")
  overlay.id = OVERLAY_ID
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#111c;display:grid;place-items:center;padding:24px;cursor:zoom-out"
  overlay.title = "Click to close"

  const figure = document.createElement("figure")
  figure.style.cssText = "margin:0;display:grid;gap:8px;justify-items:center;max-height:100%"

  const image = document.createElement("img")
  image.src = url
  // Checkerboard so a transparent background is visible rather than guessed at.
  image.style.cssText =
    "max-width:100%;max-height:calc(100vh - 96px);object-fit:contain;background:repeating-conic-gradient(#fff 0 25%,#ddd 0 50%) 50%/16px 16px"

  const figcaption = document.createElement("figcaption")
  figcaption.style.cssText =
    "color:#fff;font:500 12px ui-monospace,monospace;letter-spacing:.02em;display:flex;gap:12px;align-items:center"

  const text = document.createElement("span")
  text.textContent = caption

  const download = document.createElement("a")
  download.href = url
  download.download = fileName
  download.textContent = "download"
  download.style.cssText = "color:#7dd3fc;cursor:pointer"
  // The anchor is the only reliable way out to a file: Chrome's console
  // linkifier strips the `blob:` scheme off a logged URL, so clicking it there
  // navigates to a bare path and 404s.
  download.addEventListener("click", (event) => event.stopPropagation())

  figcaption.append(text, download)
  figure.append(image, figcaption)
  overlay.append(figure)
  overlay.addEventListener("click", () => overlay.remove())
  document.body.append(overlay)
}

/**
 * Keep the most recent reference upload reachable from the console:
 *
 *   __imgxShowReference()   full-size overlay, click to dismiss
 *   __imgxReference         the File, its blob: URL and pixel size
 */
export function inspectReference(file: File) {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
    return
  }

  const debugWindow = window as DebugWindow

  if (debugWindow.__imgxReference) {
    URL.revokeObjectURL(debugWindow.__imgxReference.url)
  }

  const url = URL.createObjectURL(file)
  const image = new Image()

  image.onload = () => {
    const caption = `${image.naturalWidth}x${image.naturalHeight} · ${file.type} · ${(
      file.size / 1024
    ).toFixed(0)} KB`

    debugWindow.__imgxReference = {
      file,
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
    debugWindow.__imgxShowReference = () => showOverlay(url, caption, file.name)

    // No URL in the message on purpose: Chrome's console linkifier drops the
    // `blob:` prefix, so the "link" it renders navigates to a bare path and
    // 404s. Use the toolbar button or __imgxShowReference() instead.
    console.info(`[canvas] reference sent — ${caption}. __imgxShowReference() to view.`)
  }

  image.src = url
}

/** Backs the dev-only "reference" button in the editor header. */
export function showLastReference() {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
    return
  }

  const show = (window as DebugWindow).__imgxShowReference

  if (show) {
    show()
    return
  }

  console.info("[canvas] no reference uploaded yet — generate a revision first.")
}
