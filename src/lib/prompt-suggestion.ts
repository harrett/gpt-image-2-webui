// Reading a moderation refusal for the replacement prompt it offers.
//
// When an image model turns a prompt down it often proposes a version it would
// accept, but there is no structured field for it: the whole thing arrives as
// one prose string in `error`. What it does have is a label — "替代提示词:",
// "Alternative prompt:", "代替プロンプト:" — with the prompt running from there
// to the end of the message. That label is the entire contract this module
// relies on, so a refusal without one simply yields nothing and the user is
// shown the refusal text alone.

// One class covering the scripts that do not use spaces between characters.
const CJK = "\\u1100-\\u11ff\\u2e80-\\u303f\\u3040-\\u9fff\\uac00-\\ud7ff\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uffef"
const CJK_SPACING = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g")
// Fullwidth punctuation already carries its own trailing space in the glyph, so
// "，35mm" reads correctly while "， 35mm" does not — this catches the gap the
// rule above leaves when a Latin character follows CJK punctuation.
const CJK_PUNCTUATION_SPACING = /([　-〿！-／：-＠［-｀｛-･])[ \t]+/g

// Labels are matched case-insensitively against the collapsed text, longest
// first so "替代提示词" wins over a bare "提示词".
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
  "대체 프롬프트 예시",
  "alternative prompt",
  "alternate prompt",
  "suggested prompt",
  "revised prompt",
  "prompt alternative",
  "prompt alternativo",
  "prompt alternatif",
  "alternativer prompt",
  "alternativ-prompt",
  "vorschlag",
]

const MAX_SUGGESTION_LENGTH = 2000
const MIN_SUGGESTION_LENGTH = 8

/**
 * Makes a refusal readable.
 *
 * Some providers stream the refusal token by token and join the pieces with
 * spaces, so Chinese arrives as "替 代 提 示 词". Latin words need their spaces
 * and CJK never does, so only the spaces sitting between two CJK characters are
 * dropped. Markdown emphasis is stripped because it is rendered as plain text.
 */
export function normalizeRefusalText(message: string) {
  return message
    .replace(/\*\*/g, "")
    .replace(CJK_SPACING, "$1")
    .replace(CJK_PUNCTUATION_SPACING, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/**
 * The replacement prompt a refusal offers, or `null` when it offers none.
 */
export function extractSuggestedPrompt(message: string) {
  const text = normalizeRefusalText(message)
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

  const suggestion = text
    .slice(bestIndex + bestLabelLength)
    // Whatever punctuation joins the label to the prompt.
    .replace(/^[\s:：,，.。、\-—*"'“”「」]+/, "")
    .replace(/[\s*"'“”「」]+$/, "")
    .slice(0, MAX_SUGGESTION_LENGTH)
    .trim()

  return suggestion.length >= MIN_SUGGESTION_LENGTH ? suggestion : null
}
