"use client"

// A dedicated "annotate" tool, built on Excalidraw's public API.
//
// The interaction: pick 「标注」, drag once, type immediately. The label lands
// at the arrow's *tail* — away from whatever the arrow points at — and the tool
// re-arms so the next annotation is one drag away.
//
// Three things rule out doing this with Excalidraw's own pieces:
//
//   - A label typed onto an arrow is *bound* to it, and a bound label always
//     renders at the container's midpoint, right on top of the thing being
//     pointed at. There is no `labelPosition` equivalent. So the label here is
//     a standalone text element placed at the tail and kept attached by putting
//     both in the same group.
//   - Its text editor can only be opened by Enter or a double-click, both of
//     which act on the current selection and need Excalidraw's root to hold
//     focus. Driving that programmatically proved unreliable: the selection
//     lands a frame or two late, and focus is pulled back to <body> by the next
//     re-render. So typing happens in our own textarea, and the finished text
//     is written into the scene.
//   - `UIOptions.tools` only toggles the image tool, so a custom entry cannot
//     be added to the toolbar. The button below is ours, portalled into
//     Excalidraw's toolbar row so it reads as part of it.

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { convertToExcalidrawElements, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw"
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"

export const ANNOTATION_COLOR = "#e03131"

// Below this the drag was a stray click, not an annotation.
const MIN_ARROW_LENGTH = 12
// Excalidraw pulls focus back to its own root for a while after a drag, so
// the label input has to keep claiming it rather than asking once.
const FOCUS_CLAIM_FRAMES = 45
const FOCUS_HELD_FRAMES = 3
// Gap between the arrow's tail and the label, in scene units.
const LABEL_GAP = 14
const LABEL_FONT_SIZE = 20
// Excalidraw's hand-drawn face, matching the rest of the markup.
const LABEL_FONT_FAMILY = 5
// Proportion of the arrow's length used as the bow, clamped so short arrows
// still visibly curve and long ones don't loop.
const BEND_RATIO = 0.12
const MIN_BEND = 16
const MAX_BEND = 48

type Point = { x: number; y: number }

type Composer = {
  arrowId: string
  groupId: string
  /** Where to put the input, relative to Excalidraw's own top-left corner. */
  left: number
  top: number
  /** True when the label grows leftwards, so the box is right-aligned instead. */
  flipped: boolean
  /** The arrow's own colour, which the label inherits. */
  color: string
  zoom: number
}

function arrowEnds(arrow: ExcalidrawElement) {
  const points = (arrow as { points?: readonly (readonly number[])[] }).points ?? []

  if (points.length < 2) {
    return null
  }

  const first = points[0]
  const last = points[points.length - 1]

  return {
    tail: { x: arrow.x + first[0], y: arrow.y + first[1] } satisfies Point,
    head: { x: arrow.x + last[0], y: arrow.y + last[1] } satisfies Point,
  }
}

/** Unit vector pointing from the head back past the tail. */
function outwardDirection({ tail, head }: { tail: Point; head: Point }) {
  const dx = tail.x - head.x
  const dy = tail.y - head.y
  const length = Math.hypot(dx, dy) || 1

  return { x: dx / length, y: dy / length }
}

/**
 * Where the label should sit so it hangs off the tail rather than overlapping
 * the arrow. The edge facing the arrow is what gets anchored, so a leftward
 * arrow puts the text to the left of its tail and vice versa.
 */
function labelPosition(arrow: ExcalidrawElement, width: number, height: number) {
  const ends = arrowEnds(arrow)

  if (!ends) {
    return { x: arrow.x, y: arrow.y }
  }

  const direction = outwardDirection(ends)

  return {
    x: ends.tail.x + direction.x * LABEL_GAP - (direction.x < 0 ? width : 0),
    y: ends.tail.y + direction.y * LABEL_GAP - height / 2,
  }
}

/**
 * Bow a straight drag into a curved callout.
 *
 * Excalidraw's `round` arrow type only smooths the corners of a multi-point
 * line — a two-point arrow stays dead straight no matter what. So insert a
 * control point offset perpendicular to the drag and let the roundness do the
 * rest. The offset follows the drag's dominant axis, which keeps the bow on the
 * outside of the gesture rather than folding it across.
 */
function curveArrow(arrow: ExcalidrawElement) {
  const points = (arrow as { points?: readonly (readonly number[])[] }).points ?? []

  // Only a plain drag gets bowed; a hand-placed multi-point arrow is left alone.
  if (points.length !== 2) {
    return arrow
  }

  const [dx, dy] = points[1]
  const length = Math.hypot(dx, dy)

  if (length < MIN_ARROW_LENGTH) {
    return arrow
  }

  const bend = Math.min(Math.max(length * BEND_RATIO, MIN_BEND), MAX_BEND)
  const sign = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? -1 : 1) : 1
  const offset = { x: (-dy / length) * bend * sign, y: (dx / length) * bend * sign }

  return {
    ...arrow,
    points: [
      [0, 0],
      [dx / 2 + offset.x, dy / 2 + offset.y],
      [dx, dy],
    ],
    roundness: { type: 2 },
  } as unknown as ExcalidrawElement
}

/**
 * Drives the annotate interaction. Returns the mode, a toggle for the toolbar
 * button, and the composer state for the inline input.
 */
export function useAnnotationTool(api: ExcalidrawImperativeAPI | null) {
  const [isActive, setIsActive] = useState(false)
  const [composer, setComposer] = useState<Composer | null>(null)
  // Mirrors the flags for the change handler, which is subscribed once. Tying
  // the subscription to state instead tore it down mid-gesture, because
  // Excalidraw parks on the selection tool the instant a drag ends.
  const isActiveRef = useRef(false)
  const composerRef = useRef<Composer | null>(null)
  // Excalidraw's own "keep selected tool active" preference, saved while
  // annotate mode forces it on, so leaving the mode gives it back.
  const wasToolLockedRef = useRef(false)
  const defaultsSeededRef = useRef(false)

  const setActive = useCallback((next: boolean) => {
    isActiveRef.current = next
    setIsActive(next)
  }, [])

  const openComposer = useCallback((next: Composer | null) => {
    composerRef.current = next
    setComposer(next)
  }, [])

  // Picking the tool is all this does. Annotate mode *is* the arrow tool, and
  // the change handler below turns that into the mode's colours, lock and flag,
  // so the button cannot end up lit while some other tool is armed.
  const toggle = useCallback(() => {
    if (!api) {
      return
    }

    api.setActiveTool({ type: isActive ? "selection" : "arrow" })
  }, [api, isActive])

  /** Write the typed label into the scene, or drop it when left empty. */
  const commit = useCallback(
    (text: string) => {
      const pending = composerRef.current

      openComposer(null)

      if (!api || !pending) {
        return
      }

      const trimmed = text.trim()
      const arrow = trimmed
        ? api.getSceneElements().find((element) => element.id === pending.arrowId)
        : null

      if (arrow) {
        // convertToExcalidrawElements measures the text for us, so the label is
        // anchored using its real size rather than a guess.
        const [measured] = convertToExcalidrawElements([
          {
            type: "text",
            x: 0,
            y: 0,
            text: trimmed,
            fontSize: LABEL_FONT_SIZE,
            fontFamily: LABEL_FONT_FAMILY,
            // The label is part of the arrow, so it takes the arrow's colour
            // rather than the mode's default — otherwise a black arrow ends up
            // captioned in red.
            strokeColor: arrow.strokeColor,
          },
        ])
        const at = labelPosition(arrow, measured.width, measured.height)

        api.updateScene({
          elements: [
            ...api.getSceneElements(),
            { ...measured, x: at.x, y: at.y, groupIds: [pending.groupId] } as ExcalidrawElement,
          ],
        })
      }

      // Re-arm, so the next annotation is one drag away.
      if (isActiveRef.current) {
        api.setActiveTool({ type: "arrow" })
      }
    },
    [api, openComposer]
  )

  useEffect(() => {
    if (!api) {
      return
    }

    // Arrows already on the board, so a freshly committed one can be spotted by
    // difference. This hangs off `onChange` rather than the pointer callbacks:
    // `onPointerUp` never fires for programmatic input, which makes that path
    // impossible to test.
    let seenArrowIds = new Set(
      api
        .getSceneElements()
        .filter((element) => element.type === "arrow")
        .map((element) => element.id)
    )

    const rememberArrows = (elements: readonly ExcalidrawElement[]) => {
      seenArrowIds = new Set(
        elements.filter((element) => element.type === "arrow").map((element) => element.id)
      )
    }

    return api.onChange((elements, state) => {
      if (composerRef.current) {
        // The arrow can be undone or deleted while its label is still being
        // typed; without this the composer would sit there pointing at nothing
        // and block every later drag from being picked up.
        if (!elements.some((element) => element.id === composerRef.current?.arrowId)) {
          openComposer(null)
        }

        rememberArrows(elements)
        return
      }

      // Annotate mode is defined as "the arrow tool is armed", rather than
      // tracked alongside it. Anything else and the two drift apart: the button
      // stays lit next to a highlighted selection tool, and the next drag pulls
      // a marquee instead of an arrow. Being derived, it also picks up the A
      // and 5 shortcuts for free — they select the arrow tool, whose own
      // toolbar entry is hidden in favour of 「标注」.
      const isArrowTool = state.activeTool.type === "arrow"

      if (isArrowTool !== isActiveRef.current) {
        setActive(isArrowTool)

        if (isArrowTool) {
          // Only the first time in. Re-applying on every entry would undo the
          // colour or arrowheads the user picked in the style panel, snapping
          // annotations back to red the moment they re-armed the tool.
          if (!defaultsSeededRef.current) {
            defaultsSeededRef.current = true
            api.updateScene({
              appState: {
                currentItemStrokeColor: ANNOTATION_COLOR,
                currentItemStartArrowhead: null,
                currentItemEndArrowhead: "arrow",
              },
            })
          }

          wasToolLockedRef.current = state.activeTool.locked
          // Locked, because Excalidraw otherwise drops back to the selection
          // tool the moment a drag ends. Annotating is a repeated action.
          api.setActiveTool({ type: "arrow", locked: true })
        } else if (state.activeTool.locked !== wasToolLockedRef.current) {
          // Hand the lock back, so picking, say, the freehand tool does not
          // silently inherit "keep tool active". Set through updateScene rather
          // than setActiveTool, whose argument is a union the tool type read
          // back off the state cannot satisfy.
          api.updateScene({
            appState: { activeTool: { ...state.activeTool, locked: wasToolLockedRef.current } },
          })
        }
      }

      if (!isArrowTool) {
        rememberArrows(elements)
        return
      }

      // Mid-drag: nothing to pick up yet.
      if (state.newElement || state.editingTextElement) {
        return
      }

      const arrow = elements.find(
        (element) =>
          element.type === "arrow" &&
          !seenArrowIds.has(element.id) &&
          Math.hypot(element.width, element.height) >= MIN_ARROW_LENGTH
      )

      rememberArrows(elements)

      const ends = arrow ? arrowEnds(arrow) : null

      if (!arrow || !ends) {
        return
      }

      const groupId = `imgx-annotation-${arrow.id}`

      api.updateScene({
        elements: elements.map((element) =>
          element.id === arrow.id
            ? ({
                ...curveArrow(element),
                groupIds: [...element.groupIds, groupId],
                version: element.version + 1,
                versionNonce: Date.now(),
              } as ExcalidrawElement)
            : element
        ),
      })

      // Sit where the finished label will: one gap out along the arrow, away
      // from whatever it points at.
      const direction = outwardDirection(ends)
      const viewport = sceneCoordsToViewportCoords(
        {
          sceneX: ends.tail.x + direction.x * LABEL_GAP,
          sceneY: ends.tail.y + direction.y * LABEL_GAP,
        },
        state as AppState
      )

      openComposer({
        arrowId: arrow.id,
        groupId,
        // sceneCoordsToViewportCoords works in page coordinates — it adds the
        // canvas's own offset within the document. The input is positioned
        // against Excalidraw's box, so that offset has to come back off, or the
        // box lands one editor-header lower than the arrow.
        left: viewport.x - state.offsetLeft,
        top: viewport.y - state.offsetTop,
        flipped: direction.x < 0,
        color: arrow.strokeColor,
        zoom: state.zoom.value,
      })
    })
  }, [api, openComposer, setActive])

  return { isActive, toggle, composer, commit }
}

/**
 * The inline label input, shown at the arrow's tail the moment a drag ends.
 * Ours rather than Excalidraw's, so focus is something we control outright.
 */
export function AnnotationComposer({
  composer,
  onCommit,
  placeholder,
}: {
  composer: { left: number; top: number; flipped: boolean; color: string; zoom: number } | null
  onCommit: (text: string) => void
  placeholder: string
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!composer) {
      return
    }

    // Excalidraw restores focus to its own root while it settles after a drag,
    // so a single focus() call on the next frame gets stolen. Keep claiming it
    // for a few frames, stopping as soon as it sticks. No state is touched, so
    // no cascading render.
    let frames = 0
    let held = 0
    let frame = 0

    const claimFocus = () => {
      const input = inputRef.current

      if (!input) {
        return
      }

      if (document.activeElement === input) {
        // Give up the loop only once focus has survived a couple of frames —
        // stopping at the first success handed it straight back.
        if (++held >= FOCUS_HELD_FRAMES) {
          return
        }
      } else {
        held = 0
        input.focus({ preventScroll: true })
      }

      if (frames++ < FOCUS_CLAIM_FRAMES) {
        frame = requestAnimationFrame(claimFocus)
      }
    }

    frame = requestAnimationFrame(claimFocus)

    return () => cancelAnimationFrame(frame)
  }, [composer])

  if (!composer) {
    return null
  }

  const commit = (element: HTMLTextAreaElement | null) => onCommit(element?.value ?? "")

  return (
    <textarea
      // Uncontrolled and keyed on the composer, so each new annotation gets a
      // freshly empty box without a state reset inside an effect.
      key={`${composer.left}:${composer.top}`}
      ref={inputRef}
      className="imgx-annotate-composer"
      style={{
        left: composer.left,
        top: composer.top,
        color: composer.color,
        fontSize: LABEL_FONT_SIZE * composer.zoom,
        // Centred on the tail vertically; grown away from the arrow
        // horizontally, so the box covers the same ground as the label will.
        transform: composer.flipped ? "translate(-100%, -50%)" : "translateY(-50%)",
      }}
      defaultValue=""
      placeholder={placeholder}
      rows={1}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        // Enter commits; Escape abandons the label.
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          commit(event.currentTarget)
        } else if (event.key === "Escape") {
          event.preventDefault()
          onCommit("")
        }

        // Excalidraw listens on window for single-key tool shortcuts; without
        // this, typing "r" or "1" would switch tools mid-sentence.
        event.stopPropagation()
      }}
    />
  )
}

/**
 * The 「标注」 button. Portalled into Excalidraw's own toolbar row so it reads
 * as the first item of the toolbar rather than as a floating control.
 */
export function AnnotationToolbarButton({
  label,
  isActive,
  onToggle,
  containerRef,
}: {
  label: string
  isActive: boolean
  onToggle: () => void
  containerRef: React.RefObject<HTMLElement | null>
}) {
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const board = containerRef.current

    if (!board) {
      return
    }

    // The toolbar row mounts a frame or two after Excalidraw itself, and
    // Excalidraw replaces the node on some re-renders — a host captured once
    // goes stale and the portal ends up rendering into a detached element,
    // which looks exactly like the button never appearing. Re-resolve on every
    // mutation and keep the state pointed at whatever node is live.
    //
    // The host is the row holding the tools themselves, not the container
    // around it: 「标注」 stands in for the hidden arrow tool, so it belongs in
    // the arrow's slot, keeping the shortcut digits running 1-8 unbroken. CSS
    // `order` puts it there; the portal can only append.
    const resolve = () => {
      const node = board.querySelector<HTMLElement>(".App-toolbar > .Stack_horizontal")
      setHost((current) => (current === node ? current : node))
    }

    // Deferred: resolving synchronously here would setState during the effect
    // body and cascade a render.
    const frame = requestAnimationFrame(resolve)
    const observer = new MutationObserver(resolve)
    observer.observe(board, { childList: true, subtree: true })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [containerRef])

  if (!host) {
    return null
  }

  return createPortal(
    <button
      type="button"
      className="imgx-annotate-button"
      data-active={isActive ? "true" : undefined}
      aria-pressed={isActive}
      aria-keyshortcuts="A or 5"
      title={`${label} — A or 5`}
      onClick={() => {
        onToggle()
        // Excalidraw hands focus back to its canvas after a tool button is
        // clicked, but only for its own `.ToolIcon` buttons — it tests the
        // class name of `document.activeElement`. This button is not one, so
        // focus would stay here and every keyboard shortcut would go dead until
        // the user clicked the canvas. Same call it makes, made by hand.
        containerRef.current?.querySelector<HTMLElement>(".excalidraw-container")?.focus()
      }}
    >
      <AnnotationIcon />
      <span>{label}</span>
      {/* The arrow tool's own shortcuts, which now land here. */}
      <span className="imgx-annotate-keybinding">5</span>
    </button>,
    host
  )
}

function AnnotationIcon() {
  return (
    <svg viewBox="0 0 30 30" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M26 25a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2h22Zm-9.5-5a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2h12.5ZM8.867 1.726a1 1 0 0 1 1.266 1.548L6.927 5.896c10.371.178 18.083 6.133 19.067 14.994a1 1 0 0 1-1.988.22c-.86-7.737-7.75-13.286-17.7-13.219l3.401 3.402a1 1 0 0 1-1.414 1.414l-5-5a1 1 0 0 1 .073-1.482l5.5-4.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
