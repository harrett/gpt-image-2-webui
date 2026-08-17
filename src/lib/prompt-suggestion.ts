// Reading a moderation refusal for the replacement prompts it offers.
//
// When an image model turns a prompt down it usually proposes something it
// would accept, but there is no structured field for it: the whole thing
// arrives as one prose string in `error`. Observed in the wild, it comes in two
// shapes:
//
//   1. One labelled rewrite — "…比如这个版本：**替代提示词：** 一位成年女性的…"
//   2. A menu of directions — "我可以改成以下安全版本：- **高级时尚 editorial
//      人像**：… - **胶片质感**：…"
//
// Both are handled; anything else yields nothing and the user just reads the
// refusal. Nothing here is applied automatically — the caller offers what it
// finds and the user decides.

// One class covering the scripts that do not use spaces between characters.
const CJK = "\\u1100-\\u11ff\\u2e80-\\u303f\\u3040-\\u9fff\\uac00-\\ud7ff\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uffef"
const CJK_SPACING = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g")
// Fullwidth punctuation already carries its own trailing space in the glyph, so
// "，35mm" reads correctly while "， 35mm" does not — this catches the gap the
// rule above leaves when a Latin character follows CJK punctuation.
const CJK_PUNCTUATION_SPACING = /([　-〿！-／：-＠［-｀｛-･])[ \t]+/g
// A list that lost its newlines somewhere upstream, e.g. "生成： - 高级时尚…
// - 胶片质感…". Only a dash with space on both sides counts, so hyphenated
// words and ranges ("35-50mm") are left alone.
const INLINE_LIST_MARKER = /\s+[-•·]\s+/g

// Labels announcing a single rewrite, matched case-insensitively.
const SUGGESTION_LABELS = [
  "替代提示词",
  "替代提示詞",
  "建议提示词",
  "建議提示詞",
  "参考提示词",
  "參考提示詞",
  "替代版本",
  "代替プロンプト",
  "代替案",
  "대체 프롬프트",
  "alternative prompt",
  "alternate prompt",
  "suggested prompt",
  "revised prompt",
  "prompt alternative",
  "prompt alternativo",
  "prompt alternatif",
  "alternativer prompt",
  "alternativ-prompt",
]

// A list is only read as a menu of rewrites when the refusal said it was
// offering one. Without this a refusal that merely lists what it objected to
// would be turned into prompt suggestions.
const OFFER_CUES = [
  "我可以",
  "可以改成",
  "改成",
  "换成",
  "換成",
  "安全版本",
  "以下",
  "帮你生成",
  "幫你生成",
  "建议",
  "建議",
  "替代",
  "代替",
  "如果你愿意",
  "如果你願意",
  "できます",
  "代わりに",
  "가능합니다",
  "대신",
  "instead",
  "how about",
  "i can",
  "try",
  "alternative",
  "suggest",
  "puedo",
  "alternativa",
  "je peux",
  "ich kann",
  "posso",
]

// The sentence that closes the offer ("如果你想，我可以立刻按这个方向出图。").
// When the newline before it was lost upstream it lands glued to the last
// bullet, where it would be pasted into the prompt as if it described the
// image, so it is cut off.
const CLOSING_CUES = [
  "如果你想",
  "如果你愿意",
  "如果你願意",
  "如果需要",
  "需要我",
  "要我",
  "告诉我",
  "告訴我",
  "希望なら",
  "教えてください",
  "원하시면",
  "알려주세요",
  "if you want",
  "if you'd like",
  "if you like",
  "let me know",
  "tell me",
  "si quieres",
  "si tu veux",
  "wenn du",
  "se você",
]

const LIST_ITEM = /^\s*(?:[-*•·]|\d+[.)])\s*(.+)$/
const MAX_SUGGESTION_LENGTH = 2000
const MAX_SUGGESTIONS = 5
const MIN_SUGGESTION_LENGTH = 8

/**
 * Some upstreams cut the message mid-character, leaving a replacement glyph and
 * a half-sentence — the tail is noise, so it is dropped back to the last
 * sentence that completed.
 */
function dropTruncatedTail(value: string) {
  const broken = value.indexOf("�")

  if (broken < 0) {
    return value
  }

  const kept = value.slice(0, broken)
  const lastStop = Math.max(
    kept.lastIndexOf("。"),
    kept.lastIndexOf("."),
    kept.lastIndexOf("！"),
    kept.lastIndexOf("!"),
    kept.lastIndexOf("\n")
  )

  return lastStop >= 0 ? kept.slice(0, lastStop + 1) : kept
}

/**
 * Makes a refusal readable.
 *
 * Some providers stream the refusal token by token and join the pieces with
 * spaces, so Chinese arrives as "替 代 提 示 词". Latin words need their spaces
 * and CJK never does, so only the spaces sitting between two CJK characters are
 * dropped. Markdown emphasis is stripped because it is rendered as plain text,
 * and a list that arrived as one run-on line gets its line breaks back.
 */
export function normalizeRefusalText(message: string) {
  return (
    dropTruncatedTail(message)
      .replace(/\*\*/g, "")
      .replace(CJK_SPACING, "$1")
      // Before the punctuation rule below, which would otherwise eat the space
      // that marks where the first bullet starts ("生成： - 高级时尚…").
      .replace(INLINE_LIST_MARKER, "\n- ")
      .replace(CJK_PUNCTUATION_SPACING, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  )
}

function dropClosingCue(value: string) {
  const lowered = value.toLowerCase()

  let cut = value.length

  for (const cue of CLOSING_CUES) {
    const index = lowered.indexOf(cue)

    // Only past the minimum, so a suggestion that *opens* with such a phrase is
    // not cut down to nothing.
    if (index >= MIN_SUGGESTION_LENGTH && index < cut) {
      cut = index
    }
  }

  return value.slice(0, cut)
}

function cleanSuggestion(value: string) {
  return dropClosingCue(value)
    // Whatever punctuation joins a label or bullet to the text after it.
    .replace(/^[\s:：,，.。、\-—*"'“”「」]+/, "")
    .replace(/[\s*"'“”「」、，,]+$/, "")
    .slice(0, MAX_SUGGESTION_LENGTH)
    .trim()
}

function extractLabelledSuggestion(text: string) {
  const haystack = text.toLowerCase()

  let bestIndex = -1
  let bestLabelLength = 0

  for (const label of SUGGESTION_LABELS) {
    // The label can appear twice — once announcing the offer, once heading the
    // prompt itself ("我可以改成…比如这个版本：替代提示词：…"). The last
    // occurrence is the one the prompt follows.
    const index = haystack.lastIndexOf(label)

    if (index > bestIndex || (index === bestIndex && label.length > bestLabelLength)) {
      bestIndex = index
      bestLabelLength = label.length
    }
  }

  if (bestIndex < 0) {
    return null
  }

  const suggestion = cleanSuggestion(text.slice(bestIndex + bestLabelLength))

  return suggestion.length >= MIN_SUGGESTION_LENGTH ? suggestion : null
}

function extractListedSuggestions(text: string) {
  const lines = text.split("\n")
  const items: string[] = []
  let sawOffer = false

  for (const line of lines) {
    const match = LIST_ITEM.exec(line)

    if (!match) {
      // Prose between items keeps the offer in force; it is usually the "if you
      // like, I can do any of these" sentence wrapping the list.
      const lowered = line.toLowerCase()

      sawOffer = sawOffer || OFFER_CUES.some((cue) => lowered.includes(cue))
      continue
    }

    if (!sawOffer) {
      continue
    }

    const item = cleanSuggestion(match[1])

    if (item.length >= MIN_SUGGESTION_LENGTH) {
      items.push(item)
    }
  }

  return items.slice(0, MAX_SUGGESTIONS)
}

/**
 * Every replacement prompt the refusal offers, best first. Empty when it offers
 * none.
 */
export function extractPromptSuggestions(message: string) {
  const text = normalizeRefusalText(message)
  const labelled = extractLabelledSuggestion(text)

  if (labelled) {
    return [labelled]
  }

  return extractListedSuggestions(text)
}
