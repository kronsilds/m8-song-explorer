// Scene colours from the device theme. The 13 theme roles come from the Theme View (exact),
// or from what any screen shows (background, titles, cursor), or from a fallback; the
// colours of each column come from the screens read while exploring when available.

import type { M8ThemeRole } from '@yam8d/m8-sdk'
import type { PhraseColumn, TableColumn } from '../model/columns'
import type { ObservedColors } from '../model/song'

export type ThemeColors = Record<M8ThemeRole, string>

/** Used until the device tells better. */
export const FALLBACK_THEME: ThemeColors = {
  background : '#000000',
  textEmpty  : '#30363c',
  textInfo   : '#6c7883',
  textDefault: '#b4bec7',
  textValue  : '#f3f6f8',
  textTitles : '#3cc8f0',
  playMarkers: '#40f08e',
  cursor     : '#ff4fa8',
  selection  : '#ffd447',
  scopeSlider: '#5d6c79',
  meterLow   : '#40f08e',
  meterMid   : '#f0d33c',
  meterPeak  : '#ff5050'
}

export interface CellColors {
  filled: string
  empty : string
}

export interface Palette {
  theme      : ThemeColors
  background : string
  panel      : string
  panelHeader: string
  rule       : string
  bracket    : string
  label      : string
  title      : string
  value      : string
  empty      : string
  link       : string
  tableLink  : string
  /** The selection. */
  hot        : string
  hover      : string
  /** Where the M8 cursor is, and the playheads. */
  device     : string
  phrase     : Record<PhraseColumn | 'rowIndex', CellColors>
  table      : Record<TableColumn | 'rowIndex', CellColors>
  chainLabel : string
  phraseLabel: string
  /** Chain transpose labels and the notes a transposed phrase plays. */
  transpose  : string
  /** A written note the scale moved by itself (no transpose): the note it plays. */
  quantized  : string
  /** Option names after their number on the instrument face ('01LOWPASS'). */
  option     : string
  /** The four modulator slots of an instrument, and the parameters they drive. */
  mods       : [string, string, string, string]
}

/** Contrast a colour needs against the background, and the softer one for empty cells. */
const MIN_CONTRAST       = 2.2
const MIN_EMPTY_CONTRAST = 1.5
const MIN_VALUE_CONTRAST = 4

function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return match ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)] : [0, 0, 0]
}

const toHex = (rgb: number[]): string =>
  `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** `from` toward `to` by `amount` (0..1). */
export function mix(from: string, to: string, amount: number): string {
  const start = parseHex(from)
  const end   = parseHex(to)
  return toHex(start.map((channel, i) => channel + (end[i] - channel) * amount))
}

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const [red, green, blue] = parseHex(hex).map((channel) => {
    const linear = channel / 255
    return linear <= 0.03928 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/** The colour unless it nearly disappears on the background; then pushed toward `toward`. */
function legible(color: string, background: string, toward: string, minContrast = MIN_CONTRAST): string {
  let adjusted = color
  for (let i = 0; i < 6 && contrast(adjusted, background) < minContrast; i += 1) adjusted = mix(adjusted, toward, 0.25)
  return adjusted
}

export function makePalette(theme: Partial<ThemeColors> | null, observed: ObservedColors = {}): Palette {
  const roles      : ThemeColors = { ...FALLBACK_THEME, ...(theme ?? {}) }
  const background = roles.background
  const value      = legible(roles.textValue, background, luminance(background) > 0.5 ? '#000000' : '#ffffff', MIN_VALUE_CONTRAST)
  const empty      = legible(roles.textEmpty, background, value, MIN_EMPTY_CONTRAST)
  const info       = legible(roles.textInfo, background, value)
  const plain      = legible(roles.textDefault, background, value)
  const readable   = (color: string) => legible(color, background, value)

  /** A column's colours: as seen on the device when learnt, else from the theme roles. */
  const cell       = (view: 'phrase' | 'table', key: string, filled: string): CellColors => ({
    filled: readable(observed[view]?.[key]?.filled ?? filled),
    empty : legible(observed[view]?.[key]?.empty ?? empty, background, value, MIN_EMPTY_CONTRAST)
  })

  return {
    theme      : roles,
    background,
    panel      : mix(background, plain, 0.06),
    panelHeader: mix(background, roles.textTitles, 0.22),
    rule       : mix(background, empty, 0.75),
    bracket    : mix(background, info, 0.55),
    label      : info,
    title      : readable(roles.textTitles),
    value,
    empty,
    link       : readable(roles.playMarkers),
    tableLink  : readable(roles.meterMid),
    hot        : readable(roles.cursor),
    hover      : readable(roles.selection),
    device     : readable(roles.playMarkers),
    phrase     : {
      rowIndex: cell('phrase', 'rowIndex', info),
      note    : cell('phrase', 'note', value),
      vel     : cell('phrase', 'vel', plain),
      inst    : cell('phrase', 'inst', plain),
      fx1cmd  : cell('phrase', 'fx1cmd', value),
      fx1val  : cell('phrase', 'fx1val', plain),
      fx2cmd  : cell('phrase', 'fx2cmd', value),
      fx2val  : cell('phrase', 'fx2val', plain),
      fx3cmd  : cell('phrase', 'fx3cmd', value),
      fx3val  : cell('phrase', 'fx3val', plain)
    },
    table      : {
      rowIndex : cell('table', 'rowIndex', info),
      transpose: cell('table', 'transpose', value),
      volume   : cell('table', 'volume', plain),
      fx1cmd   : cell('table', 'fx1cmd', value),
      fx1val   : cell('table', 'fx1val', plain),
      fx2cmd   : cell('table', 'fx2cmd', value),
      fx2val   : cell('table', 'fx2val', plain),
      fx3cmd   : cell('table', 'fx3cmd', value),
      fx3val   : cell('table', 'fx3val', plain)
    },
    chainLabel : readable(observed.song?.track1?.filled ?? roles.textTitles),
    phraseLabel: readable(observed.chain?.phrase?.filled ?? info),
    transpose  : readable(roles.meterMid),
    quantized  : readable(roles.meterPeak),
    option     : mix(value, info, 0.45),
    mods       : [readable(roles.playMarkers), readable(roles.meterMid), readable(roles.meterPeak), readable(roles.textTitles)]
  }
}
