"use client"

// Full-screen detail editor for a single studio image.
//
// The mental model is "one image, opened up": the board holds exactly one image
// element, the user marks it up, and generating a revision *replaces that image
// in place* rather than adding a second one. Each revision is pushed onto a
// version stack so the user can flip back, and applying hands the chosen
// version to the studio as the next generation of the same lineage.
//
// Built on Excalidraw (MIT). The previous implementation used tldraw, whose SDK
// licence requires payment for production use; it also measured text at half
// size in this app, which forced an elaborate workaround where every label was
// swapped for a numbered badge before export. Excalidraw measures correctly, so
// markup text is simply rendered into the reference image as-is.

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw"
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types"
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types"
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { showLastReference } from "@/lib/canvas/debug-reference"
import { editImage, ensureDataUrl, measureDataUrl } from "@/lib/canvas/image-provider"
import {
  ANNOTATION_COLOR,
  AnnotationComposer,
  AnnotationToolbarButton,
  useAnnotationTool,
} from "@/components/canvas/annotation-tool"
import { describeStrokeColors, readMarkupText } from "@/lib/canvas/markup"
import { DEFAULT_LOCALE, t, type Locale } from "@/lib/i18n"
import type { GeneratedImage } from "@/lib/image-request"

import "@excalidraw/excalidraw/index.css"
import "./canvas-editor.css"

// Markup is thin strokes and small text; exporting at 2x keeps it legible for
// the image model. The provider shrinks the PNG if it exceeds the upload cap,
// so this is safe to leave high.
const EXPORT_SCALE = 2
// Enough that a stroke drawn hard against the artwork's edge is not clipped.
const EXPORT_PADDING = 16
const IMAGE_ELEMENT_ID = "imgx-source-image"

export type CanvasEditorSource = {
  background: string
  model: string
  outputFormat: string
  prompt: string
  quality: string
}

type Version = {
  // Every version owns its own Excalidraw file entry; switching versions swaps
  // the image element's `fileId`.
  fileId: FileId
  dataUrl: string
  width: number
  height: number
  mimeType: string
  prompt: string
}

// Excalidraw's image element needs every schema field present, and
// convertToExcalidrawElements does not accept `locked`. Build it by hand.
function buildImageElement(fileId: FileId, width: number, height: number) {
  return {
    id: IMAGE_ELEMENT_ID,
    type: "image",
    x: 0,
    y: 0,
    width,
    height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    // The source image is the canvas, not a movable object: locking it means
    // drags always draw markup instead of nudging the artwork.
    locked: true,
    status: "saved",
    fileId,
    scale: [1, 1],
    crop: null,
  } as unknown as ExcalidrawElement
}

/**
 * Build the board's starting scene.
 *
 * The board is seeded through `initialData` rather than imperatively from the
 * excalidrawAPI callback. That callback fires while Excalidraw's own async
 * scene initialisation is still in flight, and calling updateScene there races
 * it: the app stays stuck at `isLoading: true` and never paints a single frame
 * — no image, not even a plain rectangle. Handing it a promise lets it finish
 * initialising with our content already in place.
 */
async function loadInitialScene(src: string) {
  const dataUrl = await ensureDataUrl(src)
  const size = await measureDataUrl(dataUrl)
  const fileId = "imgx-v0" as FileId

  return {
    fileId,
    dataUrl,
    width: size.width,
    height: size.height,
    elements: [buildImageElement(fileId, size.width, size.height)],
    files: {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: dataUrl as DataURL,
        created: Date.now(),
      } satisfies BinaryFileData,
    },
    appState: {
      currentItemStrokeColor: ANNOTATION_COLOR,
      // Pointing at a region is the most common thing to do here; this replaces
      // the dedicated annotation tool the previous build had.
      activeTool: {
        type: "arrow" as const,
        customType: null,
        locked: false,
        lastActiveTool: null,
      },
    },
    scrollToContent: true,
  }
}

export type CanvasEditorProps = {
  image: GeneratedImage
  source: CanvasEditorSource
  locale?: Locale
  onApply: (result: { dataUrl: string; prompt: string; revisionCount: number }) => void
  onClose: () => void
}

export function CanvasEditor({
  image,
  source,
  locale = DEFAULT_LOCALE,
  onApply,
  onClose,
}: CanvasEditorProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  // Mirrors `versions` so board updates can read the list without going through
  // a state updater.
  const versionsRef = useRef<Version[]>([])
  const [versions, setVersions] = useState<Version[]>([])
  const [versionIndex, setVersionIndex] = useState(0)
  const [instruction, setInstruction] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [isReady, setIsReady] = useState(false)

  const commitVersions = useCallback((next: Version[]) => {
    versionsRef.current = next
    setVersions(next)
  }, [])

  const showVersion = useCallback((index: number, list: Version[] = versionsRef.current) => {
    const api = apiRef.current
    const version = list[index]

    setVersionIndex(index)

    if (!api || !version) {
      return
    }

    const elements = api.getSceneElements()
    const current = elements.find((element) => element.id === IMAGE_ELEMENT_ID)
    // Keep the on-canvas width stable so swapping versions doesn't make the
    // image jump; only the height follows the new aspect ratio.
    const displayWidth = current?.width ?? version.width

    api.updateScene({
      elements: elements.map((element) =>
        element.id === IMAGE_ELEMENT_ID
          ? ({
              ...element,
              fileId: version.fileId,
              height: (displayWidth * version.height) / version.width,
              version: (element.version ?? 1) + 1,
              versionNonce: Date.now(),
            } as ExcalidrawElement)
          : element
      ),
    })
  }, [])

  // Started once, in a lazy state initialiser, so re-renders never reseed the
  // board and discard the user's markup.
  const [initialData] = useState(() => loadInitialScene(image.src))

  useEffect(() => {
    let cancelled = false

    initialData.then(
      (scene) => {
        if (cancelled || !scene) {
          return
        }

        commitVersions([
          {
            fileId: scene.fileId,
            dataUrl: scene.dataUrl,
            width: scene.width,
            height: scene.height,
            mimeType: "image/png",
            prompt: source.prompt,
          },
        ])
        setVersionIndex(0)
        setIsReady(true)
      },
      (error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : t(locale, "proxyGenerationFailed"))
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [commitVersions, initialData, locale, source.prompt])

  const handleApi = useCallback((next: ExcalidrawImperativeAPI) => {
    apiRef.current = next
    setApi(next)

    if (process.env.NODE_ENV !== "production") {
      // Fastest way to inspect board state from the browser console.
      ;(window as unknown as { __imgxCanvas?: unknown }).__imgxCanvas = {
        api: next,
        getVersions: () => versionsRef.current,
      }
    }
  }, [])

  // 「标注」: drag once, type at the arrow's tail, drag again.
  const annotation = useAnnotationTool(api)

  async function handleGenerate() {
    const api = apiRef.current
    const current = versions[versionIndex]

    if (!api || !current) {
      return
    }

    const elements = api.getSceneElements()
    // Everything the user put on the board counts as markup, not just arrows:
    // freehand circles, text notes and shapes are all ways of saying "change
    // this bit".
    const markup = elements.filter((element) => element.id !== IMAGE_ELEMENT_ID)
    const generalInstruction = instruction.trim()

    if (!generalInstruction && !markup.length) {
      toast.error(t(locale, "canvasInstructionRequired"))
      return
    }

    setIsGenerating(true)

    try {
      // Rasterize the image *together with* everything drawn on top of it, over
      // the union of their bounds. This is what makes a local edit local: the
      // model reads the markup as pixels and sees exactly which region it
      // refers to. Text is rendered as text — no badge substitution needed.
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          // Matches the board's own theme, so the export is what was drawn.
          exportWithDarkMode: false,
        },
        exportPadding: EXPORT_PADDING,
        mimeType: "image/png",
        getDimensions: (width: number, height: number) => ({
          width: width * EXPORT_SCALE,
          height: height * EXPORT_SCALE,
          scale: EXPORT_SCALE,
        }),
      })

      const exportedUrl = await blobToDataUrl(blob)
      const markupTexts = readMarkupText(markup)
      const colorNames = describeStrokeColors(markup)

      const result = await editImage({
        prompt: buildRevisionPrompt({
          markupTexts,
          generalInstruction,
          colorNames,
        }),
        imageDataUrl: exportedUrl,
        width: current.width,
        height: current.height,
        model: source.model,
        outputFormat: source.outputFormat,
        background: source.background,
        quality: source.quality,
        locale,
      })

      const fileId = `imgx-v${versionsRef.current.length}-${Date.now()}` as FileId

      api.addFiles([
        {
          id: fileId,
          mimeType: "image/png",
          dataURL: result.dataUrl as DataURL,
          created: Date.now(),
        } satisfies BinaryFileData,
      ])

      // The markup described *this* revision; leaving it on the board would
      // bake it into the next one twice.
      api.updateScene({ elements: elements.filter((el) => el.id === IMAGE_ELEMENT_ID) })

      // Branching from an older version drops the ones after it, the way an
      // undo-then-edit does — the visible version is always the newest.
      const nextVersions = [
        ...versionsRef.current.slice(0, versionIndex + 1),
        {
          fileId,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
          // The lineage prompt is what the studio shows for this generation, so
          // it reads as "original intent + what changed" rather than the
          // edit-only instruction we sent to the model.
          prompt: [current.prompt, ...markupTexts, generalInstruction]
            .filter(Boolean)
            .join("\n\n"),
        },
      ]

      commitVersions(nextVersions)
      setInstruction("")
      showVersion(nextVersions.length - 1, nextVersions)
      toast.success(t(locale, "generatedSuccess", { count: 1, suffix: "" }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(locale, "proxyGenerationFailed"))
    } finally {
      setIsGenerating(false)
    }
  }

  function handleApply() {
    const version = versions[versionIndex]

    if (!version) {
      return
    }

    onApply({
      dataUrl: version.dataUrl,
      prompt: version.prompt,
      // 0 means "opened but never revised" — the studio skips the write-back.
      revisionCount: versionIndex,
    })
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isGenerating) {
        return
      }

      const api = apiRef.current

      // Escape belongs to the canvas first: it finishes a label, cancels a
      // drag, or clears the selection. Closing the whole editor is only the
      // *idle* meaning of the key, otherwise one Escape would discard the
      // annotation the user was still typing.
      const appState = api?.getAppState()

      if (appState?.editingTextElement || Object.keys(appState?.selectedElementIds ?? {}).length) {
        return
      }

      onClose()
    }

    window.addEventListener("keydown", handleKeyDown, true)

    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isGenerating, onClose])

  const hasRevisions = versions.length > 1

  return createPortal(
    <div className="imgx-canvas-editor fixed inset-0 z-100 flex flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm font-medium">{t(locale, "canvasEditorTitle")}</p>
          <p className="truncate text-xs text-muted-foreground">{t(locale, "canvasEditorHint")}</p>
        </div>

        {process.env.NODE_ENV !== "production" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="font-mono text-xs"
            title="Dev only: view the reference image that was uploaded"
            onClick={showLastReference}
          >
            reference
          </Button>
        ) : null}

        {hasRevisions ? (
          <div className="flex items-center gap-1 rounded-md border px-1 py-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={versionIndex === 0}
              onClick={() => showVersion(versionIndex - 1)}
              aria-label={t(locale, "canvasPreviousVersion")}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="px-1 font-mono text-xs tabular-nums">
              {versionIndex + 1}/{versions.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={versionIndex === versions.length - 1}
              onClick={() => showVersion(versionIndex + 1)}
              aria-label={t(locale, "canvasNextVersion")}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        ) : null}

        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isGenerating}>
          <XIcon className="size-4" />
          {t(locale, "canvasCancel")}
        </Button>
        <Button type="button" size="sm" onClick={handleApply} disabled={!isReady || isGenerating}>
          {t(locale, "canvasApply")}
        </Button>
      </header>

      <div className="flex items-start gap-2 border-b px-4 py-2">
        <Textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t(locale, "canvasInstructionPlaceholder")}
          rows={1}
          className="min-h-9 resize-none text-sm"
          disabled={isGenerating}
        />
        <Button type="button" size="sm" onClick={handleGenerate} disabled={!isReady || isGenerating}>
          {isGenerating ? (
            <>
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t(locale, "generating")}
            </>
          ) : (
            t(locale, "canvasGenerateRevision")
          )}
        </Button>
      </div>

      <div className="relative flex-1" ref={boardRef}>
        <AnnotationToolbarButton
          label={t(locale, "canvasAnnotate")}
          isActive={annotation.isActive}
          onToggle={annotation.toggle}
          containerRef={boardRef}
        />
        <AnnotationComposer
          composer={annotation.composer}
          onCommit={annotation.commit}
          placeholder={t(locale, "canvasAnnotatePlaceholder")}
        />
        <Excalidraw
          excalidrawAPI={handleApi}
          // Light, despite the dark app shell. Excalidraw's dark theme is a CSS
          // filter over the canvas — `invert(93%) hue-rotate(180deg)` — not a
          // second palette, so the colour stored on an element is the *inverse*
          // of the one shown in the picker: the swatch that looks white stores
          // #1e1e1e. A PNG export cannot carry a CSS filter, so white markup
          // came out black, and the prompt, which reads the stored colour, then
          // told the model to look for black markup. Light theme applies no
          // filter, so picker, canvas, export and prompt all agree.
          theme="light"
          initialData={initialData}
          UIOptions={{
            canvasActions: {
              // Loading or saving .excalidraw files, and changing the canvas
              // background, belong to a whiteboard app — not to "edit this one
              // image and hand it back".
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              saveAsImage: false,
              changeViewBackgroundColor: false,
              clearCanvas: false,
            },
            // Adding *other* images does not fit "edit this one image".
            tools: { image: false },
          }}
        />
      </div>
    </div>,
    document.body
  )
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// Three jobs: apply the instructions, preserve subject/composition/aspect/style,
// and strip the annotation artifacts so they don't survive into the output.
//
// Deliberately English and deliberately *not* in src/lib/i18n.ts. This is model
// scaffolding, not UI copy: image models follow English instructions most
// reliably, and a per-locale copy would be nine strings drifting apart. The
// user's own markup text is passed through verbatim in whatever language they
// wrote it.
//
// The original prompt is also omitted. Passing it made the model treat the call
// as "render this scene again" — it rewrote the prompt into a fresh generation
// and returned a near-identical image. The reference image is the context an
// edit needs.
function buildRevisionPrompt({
  markupTexts,
  generalInstruction,
  colorNames,
}: {
  markupTexts: string[]
  generalInstruction: string
  colorNames: string[]
}) {
  const colors = formatList(colorNames)
  const markup = colors ? `The ${colors} markup drawn on it` : "The markup drawn on it"

  const lines = [
    `Apply these edit instructions to the reference image. ${markup} — arrows, drawings, notes — points at the regions to change, and any text written beside a mark is the instruction for that mark.`,
    ...markupTexts,
    generalInstruction,
    `Preserve the original subject, composition, aspect ratio, and style. Remove all annotation artifacts from the output: ${
      colors ? `every ${colors} arrow, drawing and label` : "all markup"
    }, plus any selection outlines, resize handles and tool UI. Output only the clean revised image.`,
  ]

  return lines.filter(Boolean).join("\n")
}

function formatList(values: string[]) {
  if (values.length < 2) {
    return values[0] ?? ""
  }

  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`
}

