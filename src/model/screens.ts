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

/** The Phrase view; with `chainPosition`, the '<' the M8 draws in the margin of that row (the chain row it shows the phrase at). */
export function phraseScreen(phrase: Phrase, chainPosition: number | null = null): string[] {
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
    ], i === chainPosition ? '<' : ' ')
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

/** Stored screen lines (title row first, no margin) placed back on a screen. */
export function storedScreen(stored: string[]): string[] {
  const lines = Array.from({ length: SCREEN_HEIGHT }, () => '')
  stored.forEach((line, i) => {
    if (TITLE_ROW + i < SCREEN_HEIGHT) lines[TITLE_ROW + i] = line ? ` ${line}` : ''
  })
  return lines
}

/**
 * The Instrument view of each type with its default values, as the device draws it (Model:02,
 * fw 6.5, captured 2026-10-21), from the TYPE line on, without the margin.
 */
export const INSTRUMENT_TEMPLATES: Record<string, string[]> = {
  WAVSYNTH  : [
    'SHAPE   00PULSE 12%',
    '',
    'SIZE    20        AMP 00',
    'MULT    00        LIM 00CLIP',
    'WARP    00        PAN 80',
    'SCAN    00        DRY C0',
    'FILTER  00OFF     MFX 00',
    'CUTOFF  FF        DEL 00',
    'RES     00        REV 00',
  ],
  MACROSYN  : [
    'SHAPE   00CSAW',
    '',
    'TIMBRE  80        AMP 00',
    'COLOR   80        LIM 00CLIP',
    'DEGRADE 00        PAN 80',
    'REDUX   00        DRY C0',
    'FILTER  00OFF     MFX 00',
    'CUTOFF  FF        DEL 00',
    'RES     00        REV 00',
  ],
  SAMPLER   : [
    'SAMPLE  LOAD             REC.',
    '',
    'SLICE   00OFF     AMP 00',
    'PLAY    00FWD     LIM 00CLIP',
    'START   00        PAN 80',
    'LOOP ST 00        DRY C0',
    'LENGTH  FF        MFX 00',
    'DETUNE  80        DEL 00',
    'DEGRADE 00        REV 00',
    'FILTER  00OFF',
    'CUTOFF  FF',
    'RES     00',
  ],
  FMSYNTH   : [
    'ALGO    00A>B>C>D',
    '        A SIN B SIN C SIN D SIN',
    'RATIO   01.00 01.00 01.00 01.00',
    'LEV/FB  80/00 80/00 80/00 80/00',
    'MOD     ----- ----- ----- -----',
    '        ----- ----- ----- -----',
    'MOD1    00        AMP 00',
    'MOD2    00        LIM 00CLIP',
    'MOD3    00        PAN 80',
    'MOD4    00        DRY C0',
    'FILTER  00OFF     MFX 00',
    'CUTOFF  FF        DEL 00',
    'RES     00        REV 00',
  ],
  HYPERSYN  : [
    'SCALE   00DEFAULT',
    'CHORD   00> 00 00 00 00 00 00',
    '',
    '',
    'SHAPE   00SAW',
    'SHIFT   80        AMP 00',
    'SWARM   00        LIM 00CLIP',
    'WIDTH   00        PAN 80',
    'SUBOSC  80        DRY C0',
    'FILTER  00OFF     MFX 00',
    'CUTOFF  FF        DEL 00',
    'RES     00        REV 00',
  ],
  'MIDI OUT': [
    'PORT        00MIDI+USB',
    'CHANNEL     01',
    'BANK:PG     ---:---',
    ...'ABCDEFGHIJ'.split('').map((cc) => `CC${cc} CC:VAL  ---:--`),
  ],
  EXTERNAL  : [
    'INPUT   00LINE-IN STEREO',
    'PORT    01MIDI+USB',
    'CHANNEL 01',
    'BANK:PG ---:---',
    '',
    'CCA 001:--        AMP 00',
    'CCB 002:--        LIM 00CLIP',
    'CCC 003:--        PAN 80',
    'CCD 004:--        DRY C0',
    'FILTER  00OFF     MFX 00',
    'CUTOFF  FF        DEL 00',
    'RES     00        REV 00',
  ]
}

/** Replaces the value after `label` (left column at x 8, or the mixer column) with `value`. */
function setParameter(lines: string[], label: string, value: string): void {
  for (const [i, line] of lines.entries()) {
    const at = line.startsWith(`${label} `) ? 0 : line.indexOf(` ${label} `, 17) === 17 ? 18 : -1
    if (at < 0) continue
    const valueX = at === 0 ? 8 : 22
    const end    = valueX + Math.max(value.length, (/^\S+/.exec(line.slice(valueX))?.[0] ?? '').length)
    lines[i]     = `${line.slice(0, valueX).padEnd(valueX)}${value.padEnd(end - valueX)}${line.slice(end)}`.trimEnd()
    return
  }
}

/** Stored Instrument view lines of an instrument of `type`, with some values changed. */
export function instrumentLines(id: number, type: string, name: string | null, values: Record<string, string> = {}): string[] {
  const lines = [
    `INST. ${hex2(id)}`,
    '',
    `TYPE    ${type.padEnd(14)}LOAD SAVE`,
    `NAME    ${(name ?? '').padEnd(12, '-')}`,
    'TRANSP. ON   TBL.TIC 01   EQ --',
    '',
    ...(INSTRUMENT_TEMPLATES[type] ?? []),
  ]
  for (const [label, value] of Object.entries(values)) setParameter(lines, label, value)
  return lines
}

/** A modulator for instrumentModsLines: its type with code ('00AHD ENV'), then its rows below MODn. */
export interface ModSpec {
  type: string
  rows: [label: string, value: string][]
}

/** The rows each modulator type shows under its MODn line (device, fw 6.5). */
export const MOD_ROWS: Record<string, string[]> = {
  'AHD ENV' : ['DEST', 'AMT', 'ATK', 'HOLD', 'DEC'],
  'ADSR ENV': ['DEST', 'AMT', 'ATK', 'DEC', 'SUS', 'REL'],
  'DRUM ENV': ['DEST', 'AMT', 'PEAK', 'BODY', 'DEC'],
  LFO       : ['DEST', 'AMT', 'OSC', 'TRIG', 'FREQ'],
  'TRIG ENV': ['DEST', 'AMT', 'ATK', 'HOLD', 'DEC', 'SRC'],
  TRACKING  : ['DEST', 'AMT', 'SRC', 'LVAL', 'HVAL']
}

/** Stored Inst. Mods lines: MOD1 / MOD3 side by side from line 2, MOD2 / MOD4 from line 10. */
export function instrumentModsLines(id: number, mods: ModSpec[]): string[] {
  const lines = Array.from({ length: 18 }, () => '')
  lines[0]    = `INST. MODS ${hex2(id)}`
  mods.slice(0, 4).forEach((mod, i) => {
    const top  = i % 2 === 0 ? 2 : 10
    const left = i < 2 ? 0 : 16
    const rows : [string, string][] = [[`MOD${i + 1}`, mod.type], ...mod.rows]
    rows.forEach(([label, value], r) => {
      lines[top + r] = `${lines[top + r].padEnd(left).slice(0, left)}${label.padEnd(5)}${value}`.trimEnd()
    })
  })
  return lines
}

/** The default modulators of a new instrument (device): two AHD envelopes and two LFOs, all OFF. */
export const DEFAULT_MODS: ModSpec[] = [{
  type: '00AHD ENV',
  rows: [['DEST', '00OFF'], ['AMT', 'FF'], ['ATK', '00'], ['HOLD', '00'], ['DEC', '80']]
}, {
  type: '00AHD ENV',
  rows: [['DEST', '00OFF'], ['AMT', 'FF'], ['ATK', '00'], ['HOLD', '00'], ['DEC', '80']]
}, {
  type: '03LFO',
  rows: [['DEST', '00OFF'], ['AMT', 'FF'], ['OSC', '00TRI'], ['TRIG', '00FREE'], ['FREQ', '10']]
}, {
  type: '03LFO',
  rows: [['DEST', '00OFF'], ['AMT', 'FF'], ['OSC', '00TRI'], ['TRIG', '00FREE'], ['FREQ', '10']]
}]

/** The Inst. Mods screen: the stored lines when read, else the default modulators; an empty page for type NONE (as on the device). */
export const instrumentModsScreen = (instrument: Instrument): string[] => {
  if (instrument.type === 'NONE') return blankScreen(`INST. MODS ${hex2(instrument.id)}`)
  return storedScreen(instrument.mods?.length ? instrument.mods : instrumentModsLines(instrument.id, DEFAULT_MODS))
}

/** The instrument screen: the stored lines when read, else its header (TYPE, NAME) as the schema reads it. */
export function instrumentScreen(instrument: Instrument): string[] {
  if (instrument.lines.length) return storedScreen(instrument.lines)
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
    lines[FIRST_CONTENT_ROW + 1 + interval] = screenLine([[0, PITCH_NAMES[((scale.key ?? 0) + interval) % 12]], ...cells])
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
