// Screens drawn the way the M8 draws them (40 columns, a one-column margin, titles on
// row 3, content from row 6), so the SDK's semantic parser can read any cell of the
// model as if the device cursor were on it. The fake M8 in the tests uses them too.

import { SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X } from './columns'
import { hex2, hexDigit } from './hex'
import { PITCH_NAMES } from './music/pitch'
import { type Chain, FX_LANES, type FxCell, type Groove, type Instrument, type Phrase, type Scale, type SongModel, type Table, TRACKS } from './song'

export const SCREEN_WIDTH      = 40
export const SCREEN_HEIGHT     = 24
export const TITLE_ROW         = 3
/** Row 5 holds the column headers, content starts on row 6 (seen on a Model:02, firmware 6.5). */
export const HEADER_ROW        = 5
export const FIRST_CONTENT_ROW = 6
export const VISIBLE_SONG_ROWS = 16

/** A text and the screen x (without the margin) it starts at. */
type Cell = [x: number, text: string]

/** A screen row: the margin, then each text at its x. */
export function screenLine(cells: Cell[], marker = ' '): string {
  const chars = Array.from({ length: SCREEN_WIDTH }, () => ' ')
  chars[0]    = marker
  for (const [x, text] of cells) {
    for (let i = 0; i < text.length && x + SCREEN_MARGIN + i < SCREEN_WIDTH; i += 1) chars[x + SCREEN_MARGIN + i] = text[i]
  }
  return chars.join('').trimEnd()
}

function blankScreen(title: string, header?: Cell[]): string[] {
  const lines      = Array.from({ length: SCREEN_HEIGHT }, () => '')
  lines[TITLE_ROW] = screenLine([[0, title]])
  if (header) lines[HEADER_ROW] = screenLine(header)
  return lines
}

const fxTexts = (fx: FxCell | undefined): [command: string, value: string] => (fx?.cmd ? [fx.cmd, hex2(fx.val, '00')] : ['---', '00'])

function fxCells(fx: FxCell[], commandX: readonly number[], valueX: readonly number[]): Cell[] {
  const cells: Cell[] = []
  for (let lane = 0; lane < FX_LANES; lane += 1) {
    const [command, value] = fxTexts(fx[lane])
    cells.push([commandX[lane], command], [valueX[lane], value])
  }
  return cells
}

export function songScreen(model: SongModel, firstRow: number): string[] {
  const header = Array.from({ length: TRACKS }, (_, track): Cell => [COLUMN_X.song.track(track) + 1, String(track + 1)])
  const lines  = blankScreen('SONG', header)
  for (let i = 0; i < VISIBLE_SONG_ROWS; i += 1) {
    const row = firstRow + i
    if (row > 0xff) break
    const cells: Cell[] = [[COLUMN_X.song.row, hex2(row)]]
    for (let track = 0; track < TRACKS; track += 1) cells.push([COLUMN_X.song.track(track), hex2(model.song[row]?.[track] ?? null)])
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  }
  return lines
}

export function chainScreen(chain: Chain): string[] {
  const lines = blankScreen(`CHAIN ${hex2(chain.id)}`, [
    [2, 'PH'],
    [5, 'TSP'],
  ])
  chain.rows.forEach((row, i) => {
    lines[FIRST_CONTENT_ROW + i] = screenLine([
      [COLUMN_X.chain.row, hexDigit(i)],
      [COLUMN_X.chain.phrase, hex2(row.phrase)],
      [COLUMN_X.chain.transpose, hex2(row.transpose ?? 0)],
    ])
  })
  return lines
}

export function phraseScreen(phrase: Phrase): string[] {
  const lines = blankScreen(`PHRASE ${hex2(phrase.id)}`, [
    [2, 'N'],
    [6, 'V'],
    [9, 'I'],
    [12, 'FX1'],
    [18, 'FX2'],
    [24, 'FX3'],
  ])
  phrase.steps.forEach((step, i) => {
    lines[FIRST_CONTENT_ROW + i] = screenLine([
      [COLUMN_X.phrase.row, hexDigit(i)],
      [COLUMN_X.phrase.note, step.note ?? '---'],
      [COLUMN_X.phrase.vel, hex2(step.vel)],
      [COLUMN_X.phrase.inst, hex2(step.inst)],
      ...fxCells(step.fx, COLUMN_X.phrase.fxCmd, COLUMN_X.phrase.fxVal),
    ])
  })
  return lines
}

export function tableScreen(table: Table): string[] {
  const lines = blankScreen(`TABLE ${hex2(table.id)}`, [
    [2, 'N'],
    [5, 'V'],
    [8, 'FX1'],
    [14, 'FX2'],
    [20, 'FX3'],
  ])
  table.rows.forEach((row, i) => {
    lines[FIRST_CONTENT_ROW + i] = screenLine([
      [COLUMN_X.table.row, hexDigit(i)],
      [COLUMN_X.table.transpose, hex2(row.transpose ?? 0)],
      [COLUMN_X.table.volume, hex2(row.volume)],
      ...fxCells(row.fx, COLUMN_X.table.fxCmd, COLUMN_X.table.fxVal),
    ])
  })
  return lines
}

export interface ProjectSettings {
  transpose?: number | null
  groove?   : number | null
  scale?    : number | null
  key?      : number | null
  scaleName?: string | null
}

/** The Project view rows the explorer reads (TEMPO, TRANSPOSE, GROOVE, SCALE, NAME), placed as the schema reads them. */
export function projectScreen(name: string | null, tempo: number | null, settings: ProjectSettings = {}): string[] {
  const VALUE_X                = 13
  const scale                  = `${hex2(settings.scale ?? 0)}${PITCH_NAMES[settings.key ?? 0].padEnd(2)}${settings.scaleName ?? 'CHROMATIC'}`
  const lines                  = blankScreen('PROJECT')
  lines[FIRST_CONTENT_ROW]     = screenLine([
    [0, 'TEMPO'],
    [VALUE_X, (tempo ?? 120).toFixed(2).padStart(6, '0')],
  ])
  lines[FIRST_CONTENT_ROW + 1] = screenLine([
    [0, 'TRANSPOSE'],
    [VALUE_X, hex2(settings.transpose ?? 0)],
  ])
  lines[FIRST_CONTENT_ROW + 2] = screenLine([
    [0, 'GROOVE'],
    [VALUE_X, `${hex2(settings.groove ?? 0)}DEFAULT`],
  ])
  lines[FIRST_CONTENT_ROW + 3] = screenLine([
    [0, 'SCALE'],
    [VALUE_X, scale],
  ])
  lines[FIRST_CONTENT_ROW + 5] = screenLine([
    [0, 'MIDI'],
    [VALUE_X, 'SETTINGS'],
    [22, 'MAPPINGS'],
  ])
  lines[FIRST_CONTENT_ROW + 6] = screenLine([
    [0, 'NAME'],
    [VALUE_X, (name ?? '').padEnd(12, '-')],
  ])
  return lines
}

/** The instrument screen header (TYPE, NAME) as the schema reads it. */
export function instrumentScreen(instrument: Instrument): string[] {
  const lines                  = blankScreen(`INST. ${hex2(instrument.id)}`)
  lines[FIRST_CONTENT_ROW]     = screenLine([
    [0, 'TYPE'],
    [8, instrument.type ?? 'NONE'],
    [22, 'LOAD'],
    [27, 'SAVE'],
  ])
  lines[FIRST_CONTENT_ROW + 1] = screenLine([
    [0, 'NAME'],
    [8, (instrument.name ?? '').padEnd(12, '-')],
  ])
  lines[FIRST_CONTENT_ROW + 2] = screenLine([
    [0, 'TRANSP.'],
    [8, 'ON'],
    [13, 'TBL. TIC'],
    [21, '01'],
    [26, 'EQ'],
    [29, '--'],
  ])
  return lines
}

/**
 * The Scale view as the device draws it (Model:02, fw 6.5): KEY under the title, the column
 * headers, the 12 interval rows ('C  ON 00.00', a note out of the scale 'C# -- -- --'), then
 * TUNE, NAME and LOAD / SAVE.
 */
export function scaleScreen(scale: Scale): string[] {
  const lines              = blankScreen(`SCALE ${hex2(scale.id)}`)
  lines[HEADER_ROW]        = screenLine([
    [0, 'KEY'],
    [6, PITCH_NAMES[scale.key ?? 0]],
  ])
  lines[FIRST_CONTENT_ROW] = screenLine([
    [3, 'EN'],
    [6, 'OFFSET'],
  ])
  scale.notes.forEach((note, interval) => {
    const offset                            = note.offset ?? 0
    const offsetText                        = `${offset < 0 ? '-' : ''}${Math.abs(offset).toFixed(2).padStart(5, '0')}`
    const cells                             : Cell[] = note.enabled
      ? [
          [3, 'ON'],
          [6, offsetText],
        ]
      : [
          [3, '--'],
          [6, '-- --'],
        ]
    lines[FIRST_CONTENT_ROW + 1 + interval] = screenLine([[0, PITCH_NAMES[interval]], ...cells])
  })
  lines[FIRST_CONTENT_ROW + 13] = screenLine([
    [0, 'TUNE'],
    [6, '440.00'],
  ])
  lines[FIRST_CONTENT_ROW + 14] = screenLine([
    [0, 'NAME'],
    [6, (scale.name ?? '').padEnd(16, '-')],
  ])
  lines[FIRST_CONTENT_ROW + 15] = screenLine([
    [6, 'LOAD'],
    [11, 'SAVE'],
  ])
  return lines
}

/**
 * The Groove view after the SDK's view map (not yet checked on the device): rows 0-F with the
 * ticks of each step at x 2 ('--' ends the loop), the PPQ on row 0 at x 6, and the swing of
 * each pair of steps at x 10 on the even rows.
 */
export function grooveScreen(groove: Groove): string[] {
  const lines = blankScreen(`GROOVE ${hex2(groove.id)}`, [
    [2, 'TIC'],
    [6, 'PPQ'],
    [10, 'SWING'],
  ])
  groove.ticks.forEach((ticks, i) => {
    const cells: Cell[] = [
      [0, hexDigit(i)],
      [2, hex2(ticks)],
    ]
    if (i === 0) cells.push([6, String(groove.ppq ?? 24)])
    const pairTicks = groove.ticks[i + 1]
    if (i % 2 === 0 && ticks != null && pairTicks != null && ticks + pairTicks > 0) {
      cells.push([10, `${((ticks / (ticks + pairTicks)) * 100).toFixed(1)}%`])
    }
    lines[FIRST_CONTENT_ROW + i] = screenLine(cells)
  })
  return lines
}
