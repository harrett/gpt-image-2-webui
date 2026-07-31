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
  startEditingShapeWithRichText,
  toRichText,
  useEditor,
  useValue,
  type Editor,
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

function unlockGlobalToolLock(editor: Editor) {
  if (!editor.getInstanceState().isToolLocked) return
  editor.updateInstanceState({ isToolLocked: false })
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
