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
  getAnnotationShapeIds,
} from "@/components/canvas/annotation-tool"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
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
  dataUrl: string
  width: number
  height: number
  mimeType: string
  prompt: string
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
  const assetIdRef = useRef<TLAssetId | null>(null)
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
    const assetId = assetIdRef.current
    const shapeId = shapeIdRef.current
    const version = list[index]

    setVersionIndex(index)

    if (!editor || !assetId || !shapeId || !version) {
      return
    }

    const shape = editor.getShape(shapeId)
    const displayWidth = (shape?.props as { w?: number } | undefined)?.w ?? version.width

    // updateAssets only spreads at the record level, so a partial `props` wipes
    // the fields it omits and fails validation. Always pass the whole object.
    editor.updateAssets([
      {
        id: assetId,
        type: "image",
        props: {
          name: "source.png",
          src: version.dataUrl,
          w: version.width,
          h: version.height,
          mimeType: version.mimeType,
          isAnimated: false,
        },
      },
    ])
    // Keep the on-canvas width stable so swapping versions doesn't make the
    // image jump; only the height follows the new aspect ratio.
    editor.updateShape({
      id: shapeId,
      type: "image",
      props: { h: (displayWidth * version.height) / version.width },
    })
  }, [])

  const seedBoard = useCallback(
    async (editor: Editor) => {
      try {
        const dataUrl = await ensureDataUrl(image.src)
        const size = await measureDataUrl(dataUrl)
        const assetId = AssetRecordType.createId()
        const shapeId = createShapeId()

        assetIdRef.current = assetId
        shapeIdRef.current = shapeId

        const asset: TLImageAsset = {
          id: assetId,
          typeName: "asset",
          type: "image",
          meta: {},
          props: {
            name: "source.png",
            src: dataUrl,
            w: size.width,
            h: size.height,
            mimeType: "image/png",
            isAnimated: false,
          },
        }

        editor.createAssets([asset])
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
      void seedBoard(editor)
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

    const annotationIds = getAnnotationShapeIds(editor)

    if (!instruction.trim() && !annotationIds.length) {
      toast.error(t(locale, "canvasInstructionRequired"))
      return
    }

    setIsGenerating(true)

    try {
      const bounds = editor.getShapePageBounds(shapeId)

      if (!bounds) {
        throw new Error(t(locale, "proxyGenerationFailed"))
      }

      // Export exactly the image's box so the reference keeps the original
      // aspect ratio, even when an arrow's label overhangs the artwork.
      const exported = await editor.toImageDataUrl([shapeId, ...annotationIds], {
        format: "png",
        background: true,
        bounds,
        padding: 0,
        pixelRatio: EXPORT_PIXEL_RATIO,
      })

      const revisionPrompt = buildRevisionPrompt(instruction, source.prompt)
      const result = await editImage({
        prompt: revisionPrompt,
        imageDataUrl: exported.url,
        width: current.width,
        height: current.height,
        model: source.model,
        outputFormat: source.outputFormat,
        background: source.background,
        quality: source.quality,
        locale,
      })

      // Annotations described *this* revision; leaving them on the board would
      // bake them into the next one twice.
      if (annotationIds.length) {
        editor.deleteShapes(annotationIds)
      }

      // Branching from an older version drops the ones after it, the way an
      // undo-then-edit does — the visible version is always the newest.
      const nextVersions = [
        ...versionsRef.current.slice(0, versionIndex + 1),
        {
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
          prompt: revisionPrompt,
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
      // Only bail out on Escape when the canvas isn't busy with a text label or
      // an in-flight request, so it never discards work mid-edit.
      if (event.key === "Escape" && !isGenerating && !editorRef.current?.getEditingShapeId()) {
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isGenerating, onClose])

  const hasRevisions = versions.length > 1

  return createPortal(
    <div className="imgx-canvas-editor fixed inset-0 z-100 flex flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm font-medium">{t(locale, "canvasEditorTitle")}</p>
          <p className="truncate text-xs text-muted-foreground">{t(locale, "canvasEditorHint")}</p>
        </div>

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

// Give the model the original intent as context, then the change. Without the
// original prompt an edit tends to drift away from the image's style.
function buildRevisionPrompt(instruction: string, originalPrompt: string) {
  const change = instruction.trim()

  if (!change) {
    return originalPrompt
  }

  if (!originalPrompt.trim()) {
    return change
  }

  return `${originalPrompt.trim()}\n\n${change}`
}

export { ToolbarItem }
