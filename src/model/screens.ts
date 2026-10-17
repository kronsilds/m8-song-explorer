// Screens drawn the way the M8 draws them (40 columns, a one-column margin, titles on
// row 3, content from row 5), so the SDK's semantic parser can read any cell of the
// model as if the device cursor were on it. The fake M8 in the tests uses them too.

import { SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { type Chain, type FxCell, type Groove, hex2, type Instrument, type Phrase, type Scale, type SongModel, type Table, TRACKS } from './song'

export const SCREEN_WIDTH = 40
export const SCREEN_HEIGHT = 24
export const TITLE_ROW = 3
/** Content starts on row 6; row 5 holds the column headers (seen on a Model:02, firmware 6.5). */
export const FIRST_CONTENT_ROW = 6
export const HEADER_ROW = 5
export const VISIBLE_SONG_ROWS = 16

/** Schema x (no margin) of every grid column the app draws or navigates to. */
export const COLUMNS = {
  song: { row: 0, track: (t: number) => 3 + 3 * t },
  chain: { row: 0, phrase: 2, transpose: 5 },
  phrase: { row: 0, note: 2, vel: 6, inst: 9, fx: [12, 18, 24] as const, fxVal: [15, 21, 27] as const },
  table: { row: 0, transpose: 2, volume: 5, fx: [8, 14, 20] as const, fxVal: [11, 17, 23] as const },
} as const

/** A screen row: the margin, then each text at its schema x. */
export function screenLine(cells: [number, string][], marker = ' '): string {
  const chars = Array.from({ length: SCREEN_WIDTH }, () => ' ')
  chars[0] = marker
  for (const [x, text] of cells) {
    for (let i = 0; i < text.length && x + SCREEN_MARGIN + i < SCREEN_WIDTH; i += 1) chars[x + SCREEN_MARGIN + i] = text[i]
  }
  return chars.join('').trimEnd()
}

const blankScreen = (title: string, header?: [number, string][]): string[] => {
  const lines = Array.from({ length: SCREEN_HEIGHT }, () => '')
  lines[TITLE_ROW] = screenLine([[0, title]])
  if (header) lines[HEADER_ROW] = screenLine(header)
  return lines
}

const fxText = (fx: FxCell | undefined): [string, string] =>
  fx?.cmd ? [fx.cmd, hex2(fx.val, '00')] : ['---', '00']

export function songScreen(model: SongModel, firstRow: number): string[] {
  const lines = blankScreen('SONG', Array.from({ length: TRACKS }, (_, t): [number, string] => [COLUMNS.song.track(t) + 1, String(t + 1)]))
  for (let i = 0; i < VISIBLE_SONG_ROWS; i += 1) {
    const r = firstRow + i
    if (r > 0xff) break
    const cells: [number, string][] = [[COLUMNS.song.row, hex2(r)]]
    for (let t = 0; t < TRACKS; t += 1) cells.push([COLUMNS.song.track(t), hex2(model.song[r]?.[t] ?? null)])
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  }
  return lines
}

export function chainScreen(chain: Chain): string[] {
  const lines = blankScreen(`CHAIN ${hex2(chain.id)}`, [[2, 'PH'], [5, 'TSP']])
  chain.rows.forEach((row, i) => {
    lines[FIRST_CONTENT_ROW + i] = screenLine([
      [COLUMNS.chain.row, i.toString(16).toUpperCase()],
      [COLUMNS.chain.phrase, hex2(row.phrase)],
      [COLUMNS.chain.transpose, hex2(row.transpose ?? 0)],
    ])
  })
  return lines
}

export function phraseScreen(phrase: Phrase): string[] {
  const lines = blankScreen(`PHRASE ${hex2(phrase.id)}`, [[2, 'N'], [6, 'V'], [9, 'I'], [12, 'FX1'], [18, 'FX2'], [24, 'FX3']])
  phrase.steps.forEach((step, i) => {
    const cells: [number, string][] = [
      [COLUMNS.phrase.row, i.toString(16).toUpperCase()],
      [COLUMNS.phrase.note, step.note ?? '---'],
      [COLUMNS.phrase.vel, hex2(step.vel)],
      [COLUMNS.phrase.inst, hex2(step.inst)],
    ]
    for (let l = 0; l < 3; l += 1) {
      const [cmd, val] = fxText(step.fx[l])
      cells.push([COLUMNS.phrase.fx[l], cmd], [COLUMNS.phrase.fxVal[l], val])
    }
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  })
  return lines
}

export function tableScreen(table: Table): string[] {
  const lines = blankScreen(`TABLE ${hex2(table.id)}`, [[2, 'N'], [5, 'V'], [8, 'FX1'], [14, 'FX2'], [20, 'FX3']])
  table.rows.forEach((row, i) => {
    const cells: [number, string][] = [
      [COLUMNS.table.row, i.toString(16).toUpperCase()],
      [COLUMNS.table.transpose, hex2(row.transpose ?? 0)],
      [COLUMNS.table.volume, hex2(row.volume)],
    ]
    for (let l = 0; l < 3; l += 1) {
      const [cmd, val] = fxText(row.fx[l])
      cells.push([COLUMNS.table.fx[l], cmd], [COLUMNS.table.fxVal[l], val])
    }
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  })
  return lines
}

/** The Project view rows the explorer reads (TEMPO, TRANSPOSE, GROOVE, SCALE, NAME), placed as the schema reads them. */
export function projectScreen(
  name: string | null,
  tempo: number | null,
  more: { transpose?: number | null; groove?: number | null; scale?: number | null; key?: number | null; scaleName?: string | null } = {},
): string[] {
  const lines = blankScreen('PROJECT')
  lines[FIRST_CONTENT_ROW] = screenLine([[0, 'TEMPO'], [13, (tempo ?? 120).toFixed(2).padStart(6, '0')]])
  lines[FIRST_CONTENT_ROW + 1] = screenLine([[0, 'TRANSPOSE'], [13, hex2(more.transpose ?? 0)]])
  lines[FIRST_CONTENT_ROW + 2] = screenLine([[0, 'GROOVE'], [13, `${hex2(more.groove ?? 0)}DEFAULT`]])
  lines[FIRST_CONTENT_ROW + 3] = screenLine([[0, 'SCALE'], [13, `${hex2(more.scale ?? 0)}${PITCH_NAMES[more.key ?? 0].padEnd(2)}${more.scaleName ?? 'CHROMATIC'}`]])
  lines[FIRST_CONTENT_ROW + 5] = screenLine([[0, 'MIDI'], [13, 'SETTINGS'], [22, 'MAPPINGS']])
  lines[FIRST_CONTENT_ROW + 6] = screenLine([[0, 'NAME'], [13, (name ?? '').padEnd(12, '-')]])
  return lines
}

/** The instrument screen header (TYPE, NAME) as the schema reads it. */
export function instrumentScreen(inst: Instrument): string[] {
  const lines = blankScreen(`INST. ${hex2(inst.id)}`)
  lines[FIRST_CONTENT_ROW] = screenLine([[0, 'TYPE'], [8, inst.type ?? 'NONE'], [22, 'LOAD'], [27, 'SAVE']])
  lines[FIRST_CONTENT_ROW + 1] = screenLine([[0, 'NAME'], [8, (inst.name ?? '').padEnd(12, '-')]])
  lines[FIRST_CONTENT_ROW + 2] = screenLine([[0, 'TRANSP.'], [8, 'ON'], [13, 'TBL. TIC'], [21, '01'], [26, 'EQ'], [29, '--']])
  return lines
}

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * The Scale view as the device draws it (Model:02, fw 6.5): KEY under the title, the column
 * headers, the 12 interval rows ('C  ON 00.00', a note out of the scale 'C# -- -- --'), then
 * TUNE, NAME and LOAD / SAVE.
 */
export function scaleScreen(scale: Scale): string[] {
  const lines = blankScreen(`SCALE ${hex2(scale.id)}`)
  lines[HEADER_ROW] = screenLine([[0, 'KEY'], [6, PITCH_NAMES[scale.key ?? 0]]])
  lines[FIRST_CONTENT_ROW] = screenLine([[3, 'EN'], [6, 'OFFSET']])
  scale.notes.forEach((n, i) => {
    const off = n.offset ?? 0
    const offset = `${off < 0 ? '-' : ''}${Math.abs(off).toFixed(2).padStart(5, '0')}`
    const cells: [number, string][] = n.enabled ? [[3, 'ON'], [6, offset]] : [[3, '--'], [6, '-- --']]
    lines[FIRST_CONTENT_ROW + 1 + i] = screenLine([[0, PITCH_NAMES[i]], ...cells])
  })
  lines[FIRST_CONTENT_ROW + 13] = screenLine([[0, 'TUNE'], [6, '440.00']])
  lines[FIRST_CONTENT_ROW + 14] = screenLine([[0, 'NAME'], [6, (scale.name ?? '').padEnd(16, '-')]])
  lines[FIRST_CONTENT_ROW + 15] = screenLine([[6, 'LOAD'], [11, 'SAVE']])
  return lines
}

/**
 * The Groove view after the SDK's view map (not yet checked on the device): rows 0-F with the
 * ticks of each step at x 2 ('--' ends the loop), the PPQ on row 0 at x 6, and the swing of
 * each pair of steps at x 10 on the even rows.
 */
export function grooveScreen(groove: Groove): string[] {
  const lines = blankScreen(`GROOVE ${hex2(groove.id)}`, [[2, 'TIC'], [6, 'PPQ'], [10, 'SWING']])
  groove.ticks.forEach((ticks, i) => {
    const cells: [number, string][] = [[0, i.toString(16).toUpperCase()], [2, hex2(ticks)]]
    if (i === 0) cells.push([6, String(groove.ppq ?? 24)])
    const pair = groove.ticks[i + 1]
    if (i % 2 === 0 && ticks != null && pair != null && ticks + pair > 0) cells.push([10, `${((ticks / (ticks + pair)) * 100).toFixed(1)}%`])
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  })
  return lines
}
