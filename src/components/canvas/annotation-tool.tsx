"use client"

// The annotation tool: drag to draw a curved arrow, then type the instruction
// at its tail. Ported from the Cowart canvas project (src/App.jsx). It is a
// tldraw StateNode rather than a custom shape — an annotation is just an arrow
// shape tagged with meta.imgxAnnotationArrow, so it exports, styles and erases
// like any other arrow.
//
// Why the tool exists at all: the image model reads the annotations as pixels.
// We rasterize the image *with* its arrows and labels and send that as the edit
// reference, which is far more precise than describing the change in prose.

import {
  DefaultColorStyle,
  StateNode,
  TldrawUiMenuToolItem,
  createShapeId,
  renderPlaintextFromRichText,
  startEditingShapeWithRichText,
  toRichText,
  useEditor,
  useValue,
  type Editor,
  type TLArrowShapeProps,
  type TLRichText,
  type TLShapeId,
  type TLUiOverrides,
} from "tldraw"
import { AllSelection } from "@tiptap/pm/state"

export const ANNOTATION_TOOL_ID = "imgx-annotation"
export const ANNOTATION_ARROW_META_KEY = "imgxAnnotationArrow"

const ANNOTATION_DEFAULT_COLOR = "red"
const ANNOTATION_MIN_LENGTH = 8
const ANNOTATION_BEND_RATIO = 0.12
const ANNOTATION_MIN_BEND = 16
const ANNOTATION_MAX_BEND = 48
// 0 pins the label to the arrow's tail, i.e. where the user started dragging,
// so the text never lands on top of the thing being pointed at.
const ANNOTATION_LABEL_POSITION = 0
const ANNOTATION_SELECT_TEXT_MAX_ATTEMPTS = 8
const ANNOTATION_SELECT_TEXT_SETTLE_ATTEMPTS = 4

const annotationToolIconSvg = `<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M26 25C26.5523 25 27 25.4477 27 26C27 26.5523 26.5523 27 26 27H4C3.44772 27 3 26.5523 3 26C3.00001 25.4477 3.44772 25 4 25H26ZM16.5 20C17.0523 20 17.5 20.4477 17.5 21C17.5 21.5523 17.0523 22 16.5 22H4C3.44772 22 3 21.5523 3 21C3.00001 20.4477 3.44772 20 4 20H16.5ZM8.86719 1.72558C9.29463 1.37629 9.92482 1.43989 10.2744 1.86718C10.6237 2.29461 10.5601 2.92481 10.1328 3.2744L6.92676 5.89647C17.2981 6.07361 25.0096 12.0285 25.9941 20.8896C26.0551 21.4385 25.6592 21.9331 25.1104 21.9941C24.5615 22.0551 24.0668 21.6592 24.0059 21.1103C23.1461 13.3732 16.2564 7.82427 6.30567 7.89159L9.70703 11.293C10.0976 11.6835 10.0976 12.3165 9.70703 12.707C9.31651 13.0975 8.6835 13.0975 8.29297 12.707L3.29297 7.70702C3.0932 7.50725 2.98691 7.23236 3.00098 6.95018C3.01505 6.66801 3.14852 6.40448 3.36719 6.22558L8.86719 1.72558Z" fill="currentColor"/></svg>`

export function AnnotationToolIcon() {
  return (
    <div className="imgx-annotation-tool-icon" dangerouslySetInnerHTML={{ __html: annotationToolIconSvg }} />
  )
}

export function isAnnotationShapeId(editor: Editor, id: TLShapeId) {
  return editor.getShape(id)?.meta?.[ANNOTATION_ARROW_META_KEY] === true
}

export function getAnnotationShapeIds(editor: Editor) {
  return Array.from(editor.getCurrentPageShapeIds()).filter((id) => isAnnotationShapeId(editor, id))
}

export function getAnnotationText(editor: Editor, id: TLShapeId) {
  const richText = (editor.getShape(id)?.props as { richText?: TLRichText } | undefined)?.richText

  return richText ? renderPlaintextFromRichText(editor, richText).trim() : ""
}

const LABEL_LAYOUT_MAX_FRAMES = 20
const LABEL_LAYOUT_MIN_FRAMES = 3
const LABEL_LAYOUT_FRAME_TIMEOUT_MS = 120

// Plain rAF with a timeout, not editor.timers.requestAnimationFrame: the
// editor's wrapper does not fire reliably here (measured zero callbacks over
// three seconds), and a promise that never settles would leave the generate
// button spinning forever.
function nextFrame() {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, LABEL_LAYOUT_FRAME_TIMEOUT_MS)

    window.requestAnimationFrame(() => {
      window.clearTimeout(timeout)
      resolve()
    })
  })
}

// Settles on *stability*, not on "changed at all". Adding the number can widen
// the label and then, a frame later, wrap it onto another line and make it
// taller. Returning as soon as either dimension moved exported the two-line
// text inside a one-line box, slicing the glyphs top and bottom.
async function waitForLabelLayout(editor: Editor, ids: TLShapeId[]) {
  const read = () =>
    ids.map((id) => {
      const bounds = editor.getShapeGeometry(id).bounds
      return `${bounds.w}x${bounds.h}`
    })

  let previous = read()

  for (let frame = 0; frame < LABEL_LAYOUT_MAX_FRAMES; frame += 1) {
    await nextFrame()

    const current = read()
    const stable = current.every((value, index) => value === previous[index])

    previous = current

    if (frame >= LABEL_LAYOUT_MIN_FRAMES && stable) {
      return
    }
  }
}

/**
 * Drop a numbered badge next to each labelled annotation, so the numbers in the
 * prompt ("1. change the logo") map onto something visible in the reference
 * image. Without them, two or more annotations are ambiguous: the model reads a
 * numbered list of instructions and several unnumbered arrows, with no way to
 * pair them.
 *
 * The instruction *text* is deliberately not rendered into the export. tldraw
 * lays text out in the SVG export using different metrics than it measured the
 * box with, so any multi-character label comes out wrapped differently and
 * sliced through the glyphs, top and bottom — measured with Latin and CJK, at
 * every font and size, and with a standalone text shape instead of the arrow's
 * label. A single digit is the one thing that cannot wrap, so the badge is
 * reliable where a sentence is not.
 *
 * So the split is: pixels carry *where* (arrow + badge), the prompt carries
 * *what* (the same numbers, with the user's text verbatim). The arrow's own
 * label is blanked for the duration of the export, which also keeps mangled
 * glyphs out of the reference image.
 *
 * Only labelled arrows get a badge. A bare arrow carries a location but no
 * instruction of its own, so numbering it would create a list entry with
 * nothing in it.
 *
 * Returns the numbered arrows in order, the badge ids to include in the export,
 * and a cleanup to run once the export is captured.
 */
export async function numberAnnotationsForExport(editor: Editor, ids: TLShapeId[]) {
  const labelled = ids
    .map((id) => ({ id, text: getAnnotationText(editor, id) }))
    .filter((entry) => entry.text)

  if (!labelled.length) {
    return { labelled, badgeIds: [] as TLShapeId[], restore: () => {} }
  }

  // Read the anchors before blanking the labels — the label box collapses once
  // its text is gone.
  const anchors = labelled.map((entry) => getLabelBadgeAnchor(editor, entry.id))
  // Kept paired with its anchor: an arrow whose geometry we cannot read gets no
  // badge, and a bare id array would then be misaligned with `anchors`.
  const badges: { id: TLShapeId; anchor: { x: number; y: number } }[] = []

  // history: 'ignore' keeps this out of the undo stack — it is a render detail
  // of the export, not an edit the user made.
  editor.run(
    () => {
      editor.updateShapes(
        labelled.map((entry) => ({
          id: entry.id,
          type: "arrow" as const,
          props: { richText: toRichText("") },
        }))
      )

      labelled.forEach((entry, index) => {
        const anchor = anchors[index]

        if (!anchor) {
          return
        }

        const badgeId = createShapeId()
        badges.push({ id: badgeId, anchor })

        editor.createShape({
          id: badgeId,
          type: "text",
          x: anchor.x,
          y: anchor.y,
          props: {
            richText: toRichText(`${index + 1}`),
            color: ANNOTATION_DEFAULT_COLOR,
            font: "draw",
            size: "m",
            textAlign: "start",
            autoSize: true,
            scale: anchor.scale,
          },
        })
      })
    },
    { history: "ignore" }
  )

  const badgeIds = badges.map((badge) => badge.id)

  // Text shapes are measured in the DOM a frame or two after creation; export
  // before that and the badge renders inside a stale box.
  await waitForLabelLayout(editor, badgeIds)

  // Now that the badges have a real size, centre them on their anchor. A text
  // shape's x/y is its top-left corner, so this has to wait for the measure.
  editor.run(
    () => {
      for (const badge of badges) {
        const bounds = editor.getShapeGeometry(badge.id).bounds

        editor.updateShape({
          id: badge.id,
          type: "text",
          x: badge.anchor.x - bounds.w / 2,
          y: badge.anchor.y - bounds.h / 2,
        })
      }
    },
    { history: "ignore" }
  )

  return {
    labelled,
    badgeIds,
    restore: () => {
      editor.run(
        () => {
          if (badgeIds.length) {
            editor.deleteShapes(badgeIds)
          }

          editor.updateShapes(
            labelled.map((entry) => ({
              id: entry.id,
              type: "arrow" as const,
              props: { richText: toRichText(entry.text) },
            }))
          )
        },
        { history: "ignore" }
      )
    },
  }
}

const BADGE_GAP = 18

// Anchor the badge just behind the arrow's tail, pushed further out along the
// arrow's own axis. Anchoring to the label box instead put the number at the
// box's left edge — and a label box is as wide as its text, so the badge landed
// far away from the arrow it belonged to.
function getLabelBadgeAnchor(editor: Editor, arrowId: TLShapeId) {
  const shape = editor.getShape(arrowId)
  const transform = editor.getShapePageTransform(arrowId)
  const props = shape?.props as
    | { start?: { x: number; y: number }; end?: { x: number; y: number }; scale?: number }
    | undefined

  if (!transform || !props?.start || !props?.end) {
    return null
  }

  const scale = props.scale ?? 1
  const tail = transform.applyToPoint(props.start)
  const head = transform.applyToPoint(props.end)
  const dx = tail.x - head.x
  const dy = tail.y - head.y
  const length = Math.hypot(dx, dy) || 1

  return {
    // Centre point for the badge; the caller offsets by half the measured box
    // once tldraw has sized the text.
    x: tail.x + (dx / length) * BADGE_GAP * scale,
    y: tail.y + (dy / length) * BADGE_GAP * scale,
    scale,
  }
}

function unlockGlobalToolLock(editor: Editor) {
  if (!editor.getInstanceState().isToolLocked) return
  editor.updateInstanceState({ isToolLocked: false })
}

/**
 * Two store listeners the tool needs to stay usable. Ported from upstream
 * Cowart's onMount (src/App.jsx).
 *
 * 1. Re-arm: finishing a label drops tldraw back to the select tool, so drawing
 *    a second annotation would silently do nothing until the user clicked the
 *    toolbar again.
 * 2. Style sync: the style panel changes `color` but not `labelColor`, and
 *    tldraw drifts `labelPosition` back toward the arrow's midpoint. Without
 *    this the label ends up a different color from its arrow, sitting on top of
 *    whatever the arrow points at.
 *
 * Returns a single unsubscribe.
 */
export function installAnnotationListeners(editor: Editor) {
  let isSyncing = false

  const unsubscribeReArm = editor.store.listen(
    ({ changes }) => {
      for (const [previous, next] of Object.values(changes.updated)) {
        if (previous?.typeName !== "instance_page_state") continue

        const wasEditing = (previous as { editingShapeId?: TLShapeId | null }).editingShapeId
        const isEditing = (next as { editingShapeId?: TLShapeId | null }).editingShapeId

        if (!wasEditing || isEditing) continue
        if (editor.getShape(wasEditing)?.meta?.[ANNOTATION_ARROW_META_KEY] !== true) continue

        editor.timers.requestAnimationFrame(() => {
          if (editor.getEditingShapeId()) return
          if (editor.getCurrentToolId() !== "select") return
          editor.setCurrentTool(ANNOTATION_TOOL_ID)
        })
      }
    },
    { source: "all", scope: "session" }
  )

  const unsubscribeStyleSync = editor.store.listen(
    ({ changes }) => {
      if (isSyncing) return

      const updates = []

      for (const [, next] of Object.values(changes.updated)) {
        if (next?.typeName !== "shape") continue
        if (next.type !== "arrow") continue
        if (next.meta?.[ANNOTATION_ARROW_META_KEY] !== true) continue

        const arrowProps = next.props as Partial<TLArrowShapeProps>
        const props: Partial<TLArrowShapeProps> = {}

        if (arrowProps.color !== arrowProps.labelColor) {
          props.labelColor = arrowProps.color
        }

        if (arrowProps.labelPosition !== ANNOTATION_LABEL_POSITION) {
          props.labelPosition = ANNOTATION_LABEL_POSITION
        }

        if (!Object.keys(props).length) continue

        updates.push({ id: next.id, type: "arrow" as const, props })
      }

      if (!updates.length) return

      isSyncing = true
      try {
        editor.updateShapes(updates)
      } finally {
        isSyncing = false
      }
    },
    { source: "all", scope: "document" }
  )

  return () => {
    unsubscribeReArm()
    unsubscribeStyleSync()
  }
}

function getAnnotationColor(editor: Editor) {
  const color = editor.getStyleForNextShape(DefaultColorStyle)
  return color === DefaultColorStyle.defaultValue ? ANNOTATION_DEFAULT_COLOR : color
}

// Arc arrows read as annotations rather than as diagram edges. Bend away from
// the dominant axis so the label clears the arrow body.
function getDefaultAnnotationArrowBend(dx: number, dy: number, scale: number) {
  const length = Math.hypot(dx, dy)
  if (length === 0) return 0

  const bend = Math.min(
    Math.max(length * ANNOTATION_BEND_RATIO, ANNOTATION_MIN_BEND * scale),
    ANNOTATION_MAX_BEND * scale
  )

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? -bend : bend
  }

  return bend
}

function getTextNodes(node: Node, textNodes: Text[] = []) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent) {
      textNodes.push(child as Text)
    } else {
      getTextNodes(child, textNodes)
    }
  }

  return textNodes
}

// tldraw mounts the label's contenteditable asynchronously, and the moment it
// appears it steals focus with an empty selection. Retrying until the selection
// sticks is what makes "draw arrow, immediately type" feel seamless.
function selectAnnotationTextRange(editor: Editor, arrowId: TLShapeId) {
  // getContainerDocument() is not part of tldraw's public API in this version;
  // derive the document from the container so this keeps working inside an
  // iframe or a popped-out window.
  const doc = editor.getContainer().ownerDocument
  const shapeElement = Array.from(doc.querySelectorAll("[data-shape-id]")).find(
    (element) => element.getAttribute("data-shape-id") === arrowId
  )
  const editable = shapeElement?.querySelector<HTMLElement>('[contenteditable="true"]')

  if (!editable || typeof editable.focus !== "function") {
    return false
  }

  editable.focus()

  const textNodes = getTextNodes(editable)
  if (textNodes.length === 0) {
    return doc.activeElement === editable || editable.contains(doc.activeElement)
  }

  const range = doc.createRange()
  const firstTextNode = textNodes[0]
  const lastTextNode = textNodes[textNodes.length - 1]
  range.setStart(firstTextNode, 0)
  range.setEnd(lastTextNode, lastTextNode.textContent?.length ?? 0)

  const selection = doc.getSelection()
  if (!selection) return false

  selection.removeAllRanges()
  selection.addRange(range)

  return selection.rangeCount > 0 && selection.toString() === editable.textContent
}

function selectAnnotationTextWhenReady(editor: Editor, arrowId: TLShapeId, attempt = 0) {
  editor.timers.setTimeout(() => {
    if (editor.getEditingShapeId() !== arrowId) return

    const textEditor = editor.getRichTextEditor()
    if (textEditor) {
      textEditor.view.focus()
      textEditor.view.dispatch(
        textEditor.state.tr.setSelection(new AllSelection(textEditor.state.doc)).scrollIntoView()
      )
    }

    const didSelectText = selectAnnotationTextRange(editor, arrowId)
    if (didSelectText && attempt >= ANNOTATION_SELECT_TEXT_SETTLE_ATTEMPTS) {
      return
    }

    if (attempt < ANNOTATION_SELECT_TEXT_MAX_ATTEMPTS) {
      selectAnnotationTextWhenReady(editor, arrowId, attempt + 1)
    }
  }, 16)
}

// tldraw recomputes labelPosition while the label is being edited, which drags
// the text toward the arrow's midpoint. Re-pin it for a few frames.
function pinAnnotationArrowLabelPosition(editor: Editor, arrowId: TLShapeId, attempt = 0) {
  editor.timers.setTimeout(() => {
    const shape = editor.getShape(arrowId)
    if (!shape || shape.meta?.[ANNOTATION_ARROW_META_KEY] !== true) return

    if ((shape.props as { labelPosition?: number }).labelPosition !== ANNOTATION_LABEL_POSITION) {
      editor.updateShapes([
        { id: arrowId, type: "arrow", props: { labelPosition: ANNOTATION_LABEL_POSITION } },
      ])
    }

    if (attempt < 2 && editor.getEditingShapeId() === arrowId) {
      pinAnnotationArrowLabelPosition(editor, arrowId, attempt + 1)
    }
  }, 16)
}

function startEditingAnnotationArrowLabel(editor: Editor, arrowId: TLShapeId) {
  const shape = editor.getShape(arrowId)
  if (!shape || !editor.canEditShape(shape)) {
    return
  }

  editor.select(arrowId)
  startEditingShapeWithRichText(editor, arrowId, { selectAll: true })
  pinAnnotationArrowLabelPosition(editor, arrowId)
  // Keep the toolbar showing the annotation tool while the label is edited, so
  // finishing the text returns to drawing arrows instead of the select tool.
  editor.getCurrentTool().setCurrentToolIdMask(ANNOTATION_TOOL_ID)
  selectAnnotationTextWhenReady(editor, arrowId)
}

class AnnotationIdle extends StateNode {
  static override id = "idle"

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 })
  }

  override onPointerDown() {
    this.parent.transition("pointing")
  }

  override onCancel() {
    this.editor.setCurrentTool("select")
  }
}

class AnnotationPointing extends StateNode {
  static override id = "pointing"

  private arrowId: TLShapeId | null = null
  private markId = ""
  private origin: { x: number; y: number } | null = null

  override onEnter() {
    const origin = this.editor.inputs.getOriginPagePoint()
    const scale = this.editor.getResizeScaleFactor()
    const color = getAnnotationColor(this.editor)
    const arrowId = createShapeId()

    this.arrowId = arrowId
    this.origin = { x: origin.x, y: origin.y }
    this.markId = this.editor.markHistoryStoppingPoint(`creating_annotation:${arrowId}`)

    this.editor.createShape({
      id: arrowId,
      type: "arrow",
      x: origin.x,
      y: origin.y,
      meta: { [ANNOTATION_ARROW_META_KEY]: true },
      props: {
        kind: "arc",
        dash: "draw",
        size: "m",
        fill: "none",
        color,
        labelColor: color,
        bend: 0,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        richText: toRichText(""),
        labelPosition: ANNOTATION_LABEL_POSITION,
        font: "draw",
        scale,
      },
    })
  }

  override onPointerMove() {
    this.updateArrowEnd()
  }

  override onPointerUp() {
    this.complete()
  }

  override onCancel() {
    this.cancel()
  }

  override onInterrupt() {
    this.cancel()
  }

  private updateArrowEnd() {
    if (!this.arrowId || !this.origin) return

    const point = this.editor.inputs.getCurrentPagePoint()
    this.editor.updateShapes([
      {
        id: this.arrowId,
        type: "arrow",
        props: { end: { x: point.x - this.origin.x, y: point.y - this.origin.y } },
      },
    ])
  }

  private complete() {
    if (!this.arrowId || !this.origin) {
      this.editor.setCurrentTool(ANNOTATION_TOOL_ID)
      return
    }

    this.updateArrowEnd()

    const point = this.editor.inputs.getCurrentPagePoint()
    const dx = point.x - this.origin.x
    const dy = point.y - this.origin.y
    const length = Math.hypot(dx, dy)

    // A click rather than a drag: discard it instead of leaving a stub arrow.
    if (length < ANNOTATION_MIN_LENGTH / this.editor.getZoomLevel()) {
      this.editor.bailToMark(this.markId)
      this.parent.transition("idle")
      return
    }

    this.editor.updateShapes([
      {
        id: this.arrowId,
        type: "arrow",
        props: { bend: getDefaultAnnotationArrowBend(dx, dy, this.editor.getResizeScaleFactor()) },
      },
    ])

    startEditingAnnotationArrowLabel(this.editor, this.arrowId)
  }

  private cancel() {
    if (this.arrowId) {
      this.editor.bailToMark(this.markId)
    }

    this.parent.transition("idle")
  }
}

export class AnnotationTool extends StateNode {
  static override id = ANNOTATION_TOOL_ID
  static override initial = "idle"

  static override children() {
    return [AnnotationIdle, AnnotationPointing]
  }

  override onEnter() {
    unlockGlobalToolLock(this.editor)
  }
}

export function createAnnotationUiOverrides(label: string): TLUiOverrides {
  return {
    tools(editor, tools) {
      return {
        ...tools,
        // Free up "c" and keep the stock arrow tool out of the annotation's way.
        arrow: { ...tools.arrow, kbd: undefined },
        [ANNOTATION_TOOL_ID]: {
          id: ANNOTATION_TOOL_ID,
          label,
          icon: "tool-arrow",
          kbd: "c",
          onSelect() {
            unlockGlobalToolLock(editor)
            editor.setCurrentTool(ANNOTATION_TOOL_ID)
          },
        },
      }
    },
  }
}

export function AnnotationToolbarItem({ label }: { label: string }) {
  const editor = useEditor()
  const isSelected = useValue(
    "is annotation selected",
    () => editor.getCurrentToolId() === ANNOTATION_TOOL_ID,
    [editor]
  )

  const select = () => {
    unlockGlobalToolLock(editor)
    editor.setCurrentTool(ANNOTATION_TOOL_ID)
  }

  return (
    <button
      aria-label={label}
      aria-pressed={isSelected ? "true" : "false"}
      className="tlui-button tlui-button__tool imgx-annotation-toolbar-button"
      data-testid={`tools.${ANNOTATION_TOOL_ID}`}
      data-value={ANNOTATION_TOOL_ID}
      draggable={false}
      onClick={select}
      onTouchStart={(event) => {
        event.preventDefault()
        select()
      }}
      title={label}
      type="button"
    >
      <AnnotationToolIcon />
      <span className="imgx-annotation-toolbar-label" draggable={false}>
        {label}
      </span>
    </button>
  )
}

export function ToolbarItem({ toolId }: { toolId: string }) {
  const editor = useEditor()
  const isSelected = useValue(
    `is ${toolId} selected`,
    () => editor.getCurrentToolId() === toolId,
    [editor, toolId]
  )

  return <TldrawUiMenuToolItem toolId={toolId} isSelected={isSelected} />
}
