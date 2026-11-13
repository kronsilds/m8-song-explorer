// Explorer-facing wording for the SDK's technical descriptions. The SDK keeps its own output unchanged;
// this module only removes repeated location/value text and makes the panel's explanations easier to scan.

import { describeContextParts, type M8DescriptionPart, type M8SemanticContext } from '@yam8d/m8-sdk'

const sentence = (text: string): string => {
  const trimmed     = text.trim()
  const capitalized = trimmed.replace(/^[a-z]/, (letter) => letter.toUpperCase())
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`
}

const withoutParentheses = (text: string): string => text.trim().replace(/^\((.*)\)$/, '$1')

function panelText(part: M8DescriptionPart): string {
  switch (part.kind) {
    case 'fxInfo':
      return sentence(withoutParentheses(part.text))
    case 'fxTarget': {
      // "for KIL (Kill: …)" scans better as a command name followed by its meaning.
      const match = /^for ([A-Z0-9]{3})(?: \((.*)\))?$/.exec(part.text)
      return match ? `${match[1]} · ${match[2] ?? ''}`.trim() : withoutParentheses(part.text)
    }
    case 'meaning':
      // The title already shows the selected command and value.
      return sentence(part.text.replace(/^value [0-9A-F]+: /i, ''))
    case 'fxLane':
    case 'relative':
    case 'optionInfo':
    case 'fieldInfo':
      return sentence(part.text)
    default:
      return part.text
  }
}

/** The SDK's technical reading, adapted for the Selection panel without changing its meaning. */
export function selectionParts(context: M8SemanticContext): M8DescriptionPart[] {
  return describeContextParts(context)
    .filter((part) => part.kind !== 'location')
    .map((part) => ({
      ...part,
      text: panelText(part)
    }))
}
