// Scene colours from the device theme. The 13 theme roles come from the Theme View (exact),
// or from what any screen shows (background, titles, cursor), or from a fallback; the
// colours of each column come from the screens read while exploring when available.

import type { M8ThemeRole } from '@yam8d/m8-sdk'
import type { PhraseColumn, TableColumn } from '../m8/device'
import type { ObservedColors } from '../model/song'

export type ThemeColors = Record<M8ThemeRole, string>

/** Used until the device tells better. */
export const FALLBACK_THEME: ThemeColors = {
  background: '#000000',
  textEmpty: '#30363c',
  textInfo: '#6c7883',
  textDefault: '#b4bec7',
  textValue: '#f3f6f8',
  textTitles: '#3cc8f0',
  playMarkers: '#40f08e',
  cursor: '#ff4fa8',
  selection: '#ffd447',
  scopeSlider: '#5d6c79',
  meterLow: '#40f08e',
  meterMid: '#f0d33c',
  meterPeak: '#ff5050',
}

export interface CellColors {
  filled: string
  empty: string
}

export interface Palette {
  theme: ThemeColors
  background: string
  panel: string
  panelHeader: string
  rule: string
  bracket: string
  label: string
  title: string
  value: string
  empty: string
  link: string
  tableLink: string
  hot: string
  hover: string
  device: string
  phrase: Record<PhraseColumn | 'rowIndex', CellColors>
  table: Record<TableColumn | 'rowIndex', CellColors>
  chainLabel: string
  phraseLabel: string
  /** Chain transpose labels and the notes a transposed phrase plays. */
  transpose: string
}

const parse = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0]
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`

/** a toward b by t (0..1). */
export const mix = (a: string, b: string, t: number): string => {
  const pa = parse(a)
  const pb = parse(b)
  return toHex(pa.map((v, i) => v + (pb[i] - v) * t))
}

export const luminance = (hex: string): number => {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The colour unless it nearly disappears on the background; then pushed toward `toward`. */
const legible = (color: string, background: string, toward: string, min = 2.2): string => {
  let c = color
  for (let i = 0; i < 6 && contrast(c, background) < min; i += 1) c = mix(c, toward, 0.25)
  return c
}

export function makePalette(theme: Partial<ThemeColors> | null, observed: ObservedColors = {}): Palette {
  const t: ThemeColors = { ...FALLBACK_THEME, ...(theme ?? {}) }
  const bg = t.background
  const fg = legible(t.textValue, bg, luminance(bg) > 0.5 ? '#000000' : '#ffffff', 4)
  const dimmest = legible(t.textEmpty, bg, fg, 1.5)

  const cell = (view: 'phrase' | 'table', key: string, filled: string, empty = dimmest): CellColors => ({
    filled: legible(observed[view]?.[key]?.filled ?? filled, bg, fg),
    empty: legible(observed[view]?.[key]?.empty ?? empty, bg, fg, 1.5),
  })

  const info = legible(t.textInfo, bg, fg)
  const def = legible(t.textDefault, bg, fg)
  return {
    theme: t,
    background: bg,
    panel: mix(bg, def, 0.06),
    panelHeader: mix(bg, t.textTitles, 0.22),
    rule: mix(bg, dimmest, 0.75),
    bracket: mix(bg, info, 0.55),
    label: info,
    title: legible(t.textTitles, bg, fg),
    value: fg,
    empty: dimmest,
    link: legible(t.playMarkers, bg, fg),
    tableLink: legible(t.meterMid, bg, fg),
    hot: legible(t.cursor, bg, fg),
    hover: legible(t.selection, bg, fg),
    device: legible(t.playMarkers, bg, fg),
    phrase: {
      rowIndex: cell('phrase', 'rowIndex', info),
      note: cell('phrase', 'note', fg),
      vel: cell('phrase', 'vel', def),
      inst: cell('phrase', 'inst', def),
      fx1cmd: cell('phrase', 'fx1cmd', fg),
      fx1val: cell('phrase', 'fx1val', def),
      fx2cmd: cell('phrase', 'fx2cmd', fg),
      fx2val: cell('phrase', 'fx2val', def),
      fx3cmd: cell('phrase', 'fx3cmd', fg),
      fx3val: cell('phrase', 'fx3val', def),
    },
    table: {
      rowIndex: cell('table', 'rowIndex', info),
      transpose: cell('table', 'transpose', fg),
      volume: cell('table', 'volume', def),
      fx1cmd: cell('table', 'fx1cmd', fg),
      fx1val: cell('table', 'fx1val', def),
      fx2cmd: cell('table', 'fx2cmd', fg),
      fx2val: cell('table', 'fx2val', def),
      fx3cmd: cell('table', 'fx3cmd', fg),
      fx3val: cell('table', 'fx3val', def),
    },
    chainLabel: legible(observed.song?.track1?.filled ?? t.textTitles, bg, fg),
    phraseLabel: legible(observed.chain?.phrase?.filled ?? info, bg, fg),
    transpose: legible(t.meterMid, bg, fg),
  }
}
