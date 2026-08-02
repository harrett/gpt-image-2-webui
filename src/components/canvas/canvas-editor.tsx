"use client"

// Full-screen detail editor for a single studio image.
//
// The mental model is "one image, opened up": the board holds exactly one image
// shape, the user draws annotation arrows on it, and generating a revision
// *replaces that image in place* rather than adding a second one. Each revision
// is pushed onto a version stack so the user can flip back, and applying hands
// the chosen version to the studio as the next generation of the same lineage.

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  AssetRecordType,
  DefaultToolbar,
  DrawToolbarItem,
  EraserToolbarItem,
  HandToolbarItem,
  NoteToolbarItem,
  SelectToolbarItem,
  TextToolbarItem,
  Tldraw,
  createShapeId,
  type Editor,
  type TLAssetId,
  type TLComponents,
  type TLImageAsset,
  type TLShapeId,
} from "tldraw"
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AnnotationToolbarItem,
  AnnotationTool,
  ToolbarItem,
  createAnnotationUiOverrides,
  getMarkupColorNames,
  installAnnotationListeners,
  numberAnnotationsForExport,
} from "@/components/canvas/annotation-tool"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { showLastReference } from "@/lib/canvas/debug-reference"
import { editImage, ensureDataUrl, measureDataUrl } from "@/lib/canvas/image-provider"
import { DEFAULT_LOCALE, t, type Locale } from "@/lib/i18n"
import type { GeneratedImage } from "@/lib/image-request"

import "tldraw/tldraw.css"
import "./canvas-editor.css"

// Annotations are thin strokes and small text; exporting at 2x keeps them
// legible for the image model. The provider shrinks the PNG if it exceeds the
// upload cap, so this is safe to leave high.
const EXPORT_PIXEL_RATIO = 2

export type CanvasEditorSource = {
  background: string
  model: string
  outputFormat: string
  prompt: string
  quality: string
}

type Version = {
  // Every version owns an asset record. Mutating one asset's `src` instead
  // looks equivalent but does not repaint: tldraw's useImageOrVideoAsset only
  // re-resolves immediately when the *assetId* changes — a same-asset content
  // change is deferred behind a ~500ms tick debounce that never fires while the
  // editor sits idle, so switching versions from the header left the old
  // picture on screen.
  assetId: TLAssetId
  dataUrl: string
  width: number
  height: number
  mimeType: string
  prompt: string
}

function createVersionAsset(
  editor: Editor,
  { dataUrl, width, height, mimeType }: Omit<Version, "assetId" | "prompt">
) {
  const assetId = AssetRecordType.createId()
  const asset: TLImageAsset = {
    id: assetId,
    typeName: "asset",
    type: "image",
    meta: {},
    props: {
      name: "version.png",
      src: dataUrl,
      w: width,
      h: height,
      mimeType,
      isAnimated: false,
    },
  }

  editor.createAssets([asset])

  return assetId
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
  const editorRef = useRef<Editor | null>(null)
  const seededEditorRef = useRef<Editor | null>(null)
  const shapeIdRef = useRef<TLShapeId | null>(null)
  // Mirrors `versions` so board updates can read the list without going through
  // a state updater — mutating the editor from inside one runs during React's
  // render phase and crashes tldraw's store subscription.
  const versionsRef = useRef<Version[]>([])
  const [versions, setVersions] = useState<Version[]>([])
  const [versionIndex, setVersionIndex] = useState(0)
  const [instruction, setInstruction] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [isReady, setIsReady] = useState(false)

  const components: TLComponents = {
    Toolbar: (props) => (
      <DefaultToolbar {...props} maxItems={8}>
        <AnnotationToolbarItem label={t(locale, "canvasAnnotate")} />
        <div aria-orientation="vertical" className="imgx-toolbar-divider" role="separator" />
        <SelectToolbarItem />
        <HandToolbarItem />
        <DrawToolbarItem />
        <TextToolbarItem />
        <NoteToolbarItem />
        <EraserToolbarItem />
      </DefaultToolbar>
    ),
    // A single-image editor has no use for pages, and the main menu is all
    // file/export actions that belong to the studio instead.
    PageMenu: null,
    MainMenu: null,
  }

  const commitVersions = useCallback((next: Version[]) => {
    versionsRef.current = next
    setVersions(next)
  }, [])

  const showVersion = useCallback((index: number, list: Version[] = versionsRef.current) => {
    const editor = editorRef.current
    const shapeId = shapeIdRef.current
    const version = list[index]

    setVersionIndex(index)

    if (!editor || !shapeId || !version) {
      return
    }

    const shape = editor.getShape(shapeId)
    const displayWidth = (shape?.props as { w?: number } | undefined)?.w ?? version.width

    // Point the shape at that version's asset. Keep the on-canvas width stable
    // so swapping versions doesn't make the image jump; only the height follows
    // the new aspect ratio.
    //
    // ignoreShapeLock is required: the base image is locked so that dragging
    // draws annotations instead of moving the artwork, and updateShapes()
    // silently skips locked shapes — without this the swap is a no-op and the
    // previous version stays on screen.
    editor.run(
      () => {
        editor.updateShape({
          id: shapeId,
          type: "image",
          props: {
            assetId: version.assetId,
            h: (displayWidth * version.height) / version.width,
          },
        })
      },
      { ignoreShapeLock: true }
    )
  }, [])

  const seedBoard = useCallback(
    async (editor: Editor) => {
      try {
        const dataUrl = await ensureDataUrl(image.src)
        const size = await measureDataUrl(dataUrl)
        const shapeId = createShapeId()
        const assetId = createVersionAsset(editor, {
          dataUrl,
          width: size.width,
          height: size.height,
          mimeType: "image/png",
        })

        shapeIdRef.current = shapeId

        editor.createShape({
          id: shapeId,
          type: "image",
          x: 0,
          y: 0,
          props: { assetId, w: size.width, h: size.height },
        })
        editor.zoomToFit({ animation: { duration: 0 } })
        // The source image is the canvas, not a movable object: locking it
        // means drags always draw annotations instead of nudging the artwork.
        editor.toggleLock([shapeId])
        editor.setCurrentTool("imgx-annotation")

        commitVersions([
          {
            assetId,
            dataUrl,
            width: size.width,
            height: size.height,
            mimeType: "image/png",
            prompt: source.prompt,
          },
        ])
        setVersionIndex(0)
        setIsReady(true)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t(locale, "proxyGenerationFailed"))
      }
    },
    [commitVersions, image.src, locale, source.prompt]
  )

  // onMount must stay synchronous — tldraw treats its return value as a cleanup
  // function — so the async seeding runs as a detached task.
  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor

      // StrictMode (and Fast Refresh) re-run effects against the *same* editor,
      // so onMount fires more than once and we would stack a second copy of the
      // image on top of the first. The guard has to be synchronous: seedBoard
      // awaits before it creates anything, so two concurrent calls would both
      // sail past a check made inside it.
      if (seededEditorRef.current === editor) {
        return
      }

      seededEditorRef.current = editor

      if (process.env.NODE_ENV !== "production") {
        // Fastest way to inspect board state from the browser console.
        ;(window as unknown as { __imgxCanvas?: unknown }).__imgxCanvas = {
          editor,
          getVersions: () => versionsRef.current,
          getShapeId: () => shapeIdRef.current,
        }
      }

      void seedBoard(editor)

      // onMount's return value is tldraw's cleanup hook.
      return installAnnotationListeners(editor)
    },
    [seedBoard]
  )

  async function handleGenerate() {
    const editor = editorRef.current
    const shapeId = shapeIdRef.current
    const current = versions[versionIndex]

    if (!editor || !shapeId || !current) {
      return
    }

    // Everything the user put on the board counts as markup, not just the
    // annotation tool's arrows: freehand circles, text notes, sticky notes and
    // highlights are all ways of saying "change this bit".
    const markupIds = Array.from(editor.getCurrentPageShapeIds()).filter((id) => id !== shapeId)
    const generalInstruction = instruction.trim()

    if (!generalInstruction && !markupIds.length) {
      toast.error(t(locale, "canvasInstructionRequired"))
      return
    }

    setIsGenerating(true)

    let numbering: Awaited<ReturnType<typeof numberAnnotationsForExport>> | null = null
    let exportedUrl: string
    // Captured while the badges still exist — `restore()` deletes them.
    let colorNames: string[] = []

    try {
      // Stamp "1.", "2." onto the labels so the numbered list in the prompt has
      // a visible counterpart in the reference image. Restored in `finally` —
      // the user never sees the numbers on their own canvas. This lives inside
      // the try because anything thrown before `setIsGenerating(false)` runs
      // would leave the button spinning with no way out.
      numbering = await numberAnnotationsForExport(editor, markupIds)
      colorNames = getMarkupColorNames(editor, [...markupIds, ...numbering.badgeIds])

      // Rasterize the image *together with* everything drawn on top of it, over
      // the union of their bounds. This is the mechanism that makes a local
      // edit local: the model reads the markup as pixels and sees exactly which
      // region it refers to. Exporting only the image and the arrows would drop
      // the user's own circles and notes — they would draw markup that never
      // reached the model. Matches the upstream Cowart export, which rasterizes
      // the whole selection (lib/selectionExport.js).
      const exported = await editor.toImageDataUrl([shapeId, ...markupIds, ...numbering.badgeIds], {
        format: "png",
        background: true,
        padding: "auto",
        pixelRatio: EXPORT_PIXEL_RATIO,
      })

      exportedUrl = exported.url
    } catch (error) {
      setIsGenerating(false)
      toast.error(error instanceof Error ? error.message : t(locale, "proxyGenerationFailed"))
      return
    } finally {
      numbering?.restore()
    }

    // Every piece of markup that carried text now shows a number in the image
    // instead, so the list order here has to match the numbers exactly.
    const numberedChanges = numbering.labelled.map((entry: { text: string }) => entry.text)

    try {
      const result = await editImage({
        prompt: buildRevisionPrompt({
          annotationTexts: numberedChanges,
          otherInstructions: [generalInstruction],
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

      // The markup described *this* revision; leaving it on the board would
      // bake it into the next one twice.
      if (markupIds.length) {
        editor.deleteShapes(markupIds)
      }

      // Branching from an older version drops the ones after it, the way an
      // undo-then-edit does — the visible version is always the newest.
      const nextVersions = [
        ...versionsRef.current.slice(0, versionIndex + 1),
        {
          assetId: createVersionAsset(editor, {
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
            mimeType: result.mimeType,
          }),
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
          // The lineage prompt is what the studio shows for this generation, so
          // it reads as "original intent + what changed" rather than the
          // edit-only instruction we sent to the model.
          prompt: [current.prompt, ...numberedChanges, generalInstruction]
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

      const editor = editorRef.current

      // Escape belongs to tldraw first: it finishes a label, cancels a drag, or
      // clears the selection. Closing the whole editor is only the *idle*
      // meaning of the key, otherwise one Escape would discard the annotation
      // the user was still typing. The listener runs in the capture phase so
      // these checks see the state before tldraw resets it.
      if (editor?.getEditingShapeId() || editor?.getSelectedShapeIds().length) {
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

      <div className="relative flex-1">
        <Tldraw
          licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY}
          tools={[AnnotationTool]}
          overrides={createAnnotationUiOverrides(t(locale, "canvasAnnotate"))}
          components={components}
          onMount={handleMount}
        />
      </div>
    </div>,
    document.body
  )
}

// Wording follows upstream Cowart's buildEditPrompt: apply the instructions,
// preserve subject/composition/aspect/style, and strip the annotation artifacts
// so they don't survive into the output.
//
// Deliberately English and deliberately *not* in src/lib/i18n.ts. This is model
// scaffolding, not UI copy: image models follow English instructions most
// reliably, and a per-locale copy would be nine strings drifting apart. The
// user's own annotation text is passed through verbatim in whatever language
// they wrote it.
//
// The original prompt is also omitted. Passing it made the model treat the call
// as "render this scene again" — it rewrote the prompt into a fresh generation
// and returned a near-identical image. The reference image is the context an
// edit needs.
const REVISION_PROMPT_NUMBERING =
  "The number beside an arrow matches the numbered instruction below."

// Colours come from the shapes themselves — the user picks them in the style
// panel, so naming a fixed colour would send the model looking for markup that
// is not there.
function revisionPromptIntro(colorNames: string[]) {
  const colors = formatList(colorNames)
  const markup = colors ? `The ${colors} markup drawn on it` : "The markup drawn on it"

  return `Apply these edit instructions to the reference image. ${markup} — arrows, drawings, notes — points at the regions to change.`
}

function revisionPromptSuffix(colorNames: string[]) {
  const colors = formatList(colorNames)
  const artifacts = colors ? `every ${colors} arrow, drawing, number and label` : "all markup"

  return `Preserve the original subject, composition, aspect ratio, and style. Remove all annotation artifacts from the output: ${artifacts}, plus any selection outlines, resize handles and tool UI. Output only the clean revised image.`
}

function formatList(values: string[]) {
  if (values.length < 2) {
    return values[0] ?? ""
  }

  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`
}
// The numbered list matches the numbers stamped beside the arrows in the
// reference image, so keep the order and the indices identical. Unnumbered
// lines are instructions with no badge of their own: the free-text box, and
// text the user typed straight onto the canvas.
function buildRevisionPrompt({
  annotationTexts,
  otherInstructions,
  colorNames,
}: {
  annotationTexts: string[]
  otherInstructions: string[]
  colorNames: string[]
}) {
  const intro = revisionPromptIntro(colorNames)
  // Only mention the numbers when badges were actually drawn, otherwise the
  // model is told to look for markers that are not in the image.
  const lines = [
    annotationTexts.length > 1 ? `${intro} ${REVISION_PROMPT_NUMBERING}` : intro,
  ]

  lines.push(...annotationTexts.map((text, index) => `${index + 1}. ${text}`))
  lines.push(...otherInstructions.filter(Boolean))
  lines.push(revisionPromptSuffix(colorNames))

  return lines.join("\n")
}

export { ToolbarItem }
