// Reading the user's markup back out of an Excalidraw scene, so the prompt can
// repeat in words what the reference image shows in pixels.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"

// Excalidraw's default stroke palette. The prompt tells the model which colours
// to look for and, afterwards, to erase — naming a fixed colour would send it
// hunting for markup that is not there, since the user picks the colour in the
// style panel.
const STROKE_COLOR_NAMES: Record<string, string> = {
  "#1e1e1e": "black",
  "#343a40": "dark grey",
  "#495057": "grey",
  "#e03131": "red",
  "#c2255c": "pink",
  "#a61e4d": "dark pink",
  "#2f9e44": "green",
  "#099268": "teal",
  "#1971c2": "blue",
  "#1098ad": "cyan",
  "#f08c00": "orange",
  "#e8590c": "dark orange",
  "#846358": "brown",
  "#6741d9": "violet",
}

/**
 * Every piece of text the user wrote, in scene order. Covers standalone text
 * elements and labels bound to an arrow or shape — Excalidraw stores a bound
 * label as its own `text` element carrying a `containerId`, so both land here
 * without special-casing.
 */
export function readMarkupText(elements: readonly ExcalidrawElement[]) {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => (element as { text?: string }).text?.trim() ?? "")
    .filter(Boolean)
}

/** Human-readable names of the stroke colours actually present in the markup. */
export function describeStrokeColors(elements: readonly ExcalidrawElement[]) {
  const names = new Set<string>()

  for (const element of elements) {
    const color = element.strokeColor?.toLowerCase()

    if (!color || color === "transparent") {
      continue
    }

    // An unrecognised hex still tells the model something useful, so pass it
    // through rather than dropping the element from the description.
    names.add(STROKE_COLOR_NAMES[color] ?? color)
  }

  return Array.from(names)
}
