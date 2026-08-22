// Local history persistence for the studio canvases.
//
// IndexedDB rather than localStorage: results are images. localStorage caps at
// ~5MB and only holds strings, so base64 payloads blow the quota after a couple
// of canvases. IndexedDB stores Blob/File through the structured clone
// algorithm, which skips the ~33% base64 tax entirely and is bounded by disk
// quota instead. Everything here is same-origin browser storage — no network.
//
// Every call fails soft: hardened/private browsing contexts can refuse to open
// a database, and the studio must keep working in memory when that happens.

const DATABASE_NAME = "imgx.history"
const DATABASE_VERSION = 1
const CANVAS_STORE = "canvases"
const SESSION_STORE = "session"
const SESSION_KEY = "current"

/** Runtime shape used by the studio: `src` is a data: or blob: URL. */
export type HistoryImage = {
  revisedPrompt?: string
  src: string
}

export type HistoryCanvas = {
  background: string
  createdAt: number
  generation: number
  id: string
  images: HistoryImage[]
  isMock: boolean
  model: string
  outputFormat: string
  prompt: string
  quality: string
  requestedCount: number
  serial: number
  size: string
  sourceLabel?: string
}

export type HistoryUpload = {
  file: File
  id: string
}

export type HistorySession = {
  activeCanvasId: string | null
  activeSource: {
    file: File
    id: string
    label: string
    promptSnapshot: string
    round: number
  } | null
  uploads: HistoryUpload[]
}

/** What actually lands on disk: images as Blobs, no object URLs. */
type StoredCanvas = Omit<HistoryCanvas, "images"> & {
  images: { blob: Blob; revisedPrompt?: string }[]
}

let databasePromise: Promise<IDBDatabase | null> | null = null

function openDatabase() {
  if (databasePromise) {
    return databasePromise
  }

  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null)
        return
      }

      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result

        if (!database.objectStoreNames.contains(CANVAS_STORE)) {
          const store = database.createObjectStore(CANVAS_STORE, { keyPath: "id" })
          store.createIndex("serial", "serial")
        }

        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE)
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })

  return databasePromise
}

function promisifyRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T
): Promise<T | null> {
  const database = await openDatabase()

  if (!database) {
    return null
  }

  try {
    const transaction = database.transaction(storeName, mode)
    const result = await run(transaction.objectStore(storeName))

    if (mode === "readwrite") {
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      })
    }

    return result
  } catch (error) {
    console.warn("[history-store] operation failed", error)
    return null
  }
}

/** `fetch` reads data: and blob: URLs alike, so one path covers both. */
async function urlToBlob(src: string) {
  const response = await fetch(src)
  return response.blob()
}

async function toStoredCanvas(canvas: HistoryCanvas): Promise<StoredCanvas> {
  const images = await Promise.all(
    canvas.images.map(async (image) => ({
      blob: await urlToBlob(image.src),
      revisedPrompt: image.revisedPrompt,
    }))
  )

  return { ...canvas, images }
}

function toHistoryCanvas(stored: StoredCanvas): HistoryCanvas {
  return {
    ...stored,
    images: stored.images.map((image) => ({
      revisedPrompt: image.revisedPrompt,
      src: URL.createObjectURL(image.blob),
    })),
  }
}

/**
 * Newest-first canvases plus the working session. Object URLs are minted here;
 * the caller owns revoking them when a canvas leaves memory.
 */
export async function readHistory(limit: number) {
  const stored = await withStore(CANVAS_STORE, "readonly", (store) =>
    promisifyRequest<StoredCanvas[]>(store.getAll() as IDBRequest<StoredCanvas[]>)
  )

  if (!stored) {
    return null
  }

  const canvases = stored
    .sort((left, right) => right.serial - left.serial)
    .slice(0, limit)
    .map(toHistoryCanvas)

  const session = await withStore(SESSION_STORE, "readonly", (store) =>
    promisifyRequest<HistorySession | undefined>(
      store.get(SESSION_KEY) as IDBRequest<HistorySession | undefined>
    )
  )

  return { canvases, session: session || null }
}

export async function saveCanvas(canvas: HistoryCanvas) {
  const stored = await toStoredCanvas(canvas)
  const written = await withStore(CANVAS_STORE, "readwrite", (store) =>
    promisifyRequest(store.put(stored))
  )

  if (written !== null) {
    return true
  }

  // Most likely QuotaExceededError. Drop the oldest canvas and try once more so
  // a full disk degrades into a shorter history instead of a silent failure.
  const oldestId = await withStore(CANVAS_STORE, "readonly", async (store) => {
    const all = await promisifyRequest<StoredCanvas[]>(store.getAll() as IDBRequest<StoredCanvas[]>)
    return all.sort((left, right) => left.serial - right.serial)[0]?.id
  })

  if (!oldestId || oldestId === canvas.id) {
    return false
  }

  await deleteCanvas(oldestId)

  const retried = await withStore(CANVAS_STORE, "readwrite", (store) =>
    promisifyRequest(store.put(stored))
  )

  return retried !== null
}

export async function deleteCanvas(canvasId: string) {
  await withStore(CANVAS_STORE, "readwrite", (store) => promisifyRequest(store.delete(canvasId)))
}

export async function clearCanvases() {
  await withStore(CANVAS_STORE, "readwrite", (store) => promisifyRequest(store.clear()))
}

export async function saveSession(session: HistorySession) {
  await withStore(SESSION_STORE, "readwrite", (store) =>
    promisifyRequest(store.put(session, SESSION_KEY))
  )
}

/** Bytes used by this origin, or null when the browser will not say. */
export async function estimateUsage() {
  try {
    const estimate = await navigator.storage?.estimate?.()
    return typeof estimate?.usage === "number" ? estimate.usage : null
  } catch {
    return null
  }
}

/**
 * Ask the browser to exempt this origin from storage eviction. Chrome decides
 * silently from engagement signals, Firefox prompts; both are best-effort, so
 * the result only matters for logging.
 */
export async function requestPersistence() {
  try {
    if (await navigator.storage?.persisted?.()) {
      return true
    }

    return (await navigator.storage?.persist?.()) === true
  } catch {
    return false
  }
}
