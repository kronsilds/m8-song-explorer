// Reads M8 screens into model objects: which view is shown, and the song rows, chain, phrase,
// table, instrument, project settings, groove or scale on it. Pure functions of the screen text.

import { type M8Screen, parseGridScreen, parseViewTitle, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X } from '../../model/columns'
import { pitchClassOfName } from '../../model/music/pitch'
import { FIRST_CONTENT_ROW, TITLE_ROW } from '../../model/screens'
import {
  type Chain,
  emptyFx,
  type FxCell,
  type Groove,
  type Instrument,
  type Phrase,
  type PhraseStep,
  ROWS_PER_CHAIN,
  ROWS_PER_PHRASE,
  ROWS_PER_TABLE,
  type Scale,
  type Table,
  type TableRow,
  TRACKS,
} from '../../model/song'

export type ViewKind = 'song' | 'chain' | 'phrase' | 'inst' | 'instmods' | 'table' | 'scale' | 'groove' | 'other'

export interface ScreenView {
  kind  : ViewKind
  /** Item number from the title (chain, phrase, instrument, table, scale, groove). */
  id    : number | null
  title : string
  screen: M8Screen
}

/** Right edge of the content the explorer reads; the track panel lives beyond it. */
export const CONTENT_COLUMNS      = 30
export const LAST_CONTENT_ROW     = 21
/**
 * Right edge of the Instrument and Inst. Mods views: FM operator D and LOAD / SAVE reach x 30
 * (screen column 31); the track panel starts at screen column 34 (device, fw 6.5).
 */
export const WIDE_CONTENT_COLUMNS = 33

/** Screen x (without the margin) of the values on the Project and Instrument views. */
const PROJECT_VALUE_X    = 13
const INSTRUMENT_VALUE_X = 8

const TITLE_VIEW_KINDS        : Record<string, ViewKind> = {
  SONG  : 'song',
  LIVE  : 'song',
  CHAIN : 'chain',
  PHRASE: 'phrase',
  TABLE : 'table',
  SCALE : 'scale',
  GROOVE: 'groove'
}

/** A screen row's content, without the margin and the track panel. */
const contentOf     = (line: string): string => line.slice(SCREEN_MARGIN, CONTENT_COLUMNS)
/** A screen row's content up to the track panel. */
const wideContentOf = (line: string): string => line.slice(SCREEN_MARGIN, WIDE_CONTENT_COLUMNS)

export const titleOf          = (screen: M8Screen): string =>
  contentOf(screen.lines[TITLE_ROW] ?? '')
    .trim()
    .toUpperCase()

function viewKindOf(title: string): ViewKind {
  const titleWord = title.split(/\s+/)[0] ?? ''
  if (/^INST\.?\s+MODS\b/.test(title)) return 'instmods'
  if (titleWord.startsWith('INST') && !titleWord.startsWith('INSTRUMENT')) return 'inst'
  return TITLE_VIEW_KINDS[titleWord] ?? 'other'
}

function viewIdOf(kind: ViewKind, title: string): string | null {
  if (kind === 'scale' || kind === 'groove') return /^(?:SCALE|GROOVE)\s+([0-9A-F]{2})\b/.exec(title)?.[1] ?? null
  if (kind === 'instmods') return /^INST\.?\s+MODS\s+([0-9A-F]{2})\b/.exec(title)?.[1] ?? null
  if (kind === 'song' || kind === 'other') return null
  return parseViewTitle(title).viewId
}

export function viewOf(screen: M8Screen): ScreenView {
  const title = titleOf(screen)
  const kind  = viewKindOf(title)
  const id    = viewIdOf(kind, title)
  return {
    kind,
    id: id == null ? null : Number.parseInt(id, 16),
    title,
    screen
  }
}

/**
 * What has to stay unchanged between two reads for a screen to count as drawn. The '>' play
 * markers come and go with the notes of a song that plays (Scale view: 'D >ON'), so they do not count.
 */
export const stableContent = (screen: M8Screen): string =>
  screen.lines
    .slice(TITLE_ROW, LAST_CONTENT_ROW + 1)
    .map((line) => wideContentOf(line).replaceAll('>', ' '))
    .join('\n')

/** The screen row grid row `rowIndex` is drawn on, null when it is not on screen. */
export function gridRowScreenY(view: ScreenView, gridName: string, rowIndex: number): number | null {
  return parseGridScreen(gridName, view.screen).find((row) => row.rowIndex === rowIndex)?.screenRow ?? null
}

/** The M8 pads names with dashes up to their 12 characters ('DEMO2-------'); the text stream is lower case. */
const nameOf = (raw: string): string | null => raw.trim().replace(/-+$/, '').toUpperCase() || null

type GridField = { rawValue: string; isEmpty: boolean; hexValue: number | null }

const hexOrNull  = (field: GridField): number | null => (field.isEmpty ? null : field.hexValue)

const fxOf       = (command: GridField | undefined, value: GridField | undefined): FxCell =>
  command && !command.isEmpty ? {
    cmd: command.rawValue.toUpperCase(),
    val: value?.hexValue ?? null
  } : emptyFx()

const fxLanesOf  = (fields: Record<string, GridField>): FxCell[] => [1, 2, 3].map((lane) => fxOf(fields[`fx${lane}cmd`], fields[`fx${lane}val`]))

/** True when the grid shows rows 0..count-1, in order. */
const isFullPage = (rows: { rowIndex: number | null }[], count: number): boolean =>
  rows.length === count && rows.every((row, i) => row.rowIndex === i)

// ---------------------------------------------------------------------------
// Grid views

export interface SongRowReading {
  row      : number
  screenRow: number
  /** Chain per track, null for an empty cell. */
  chains   : (number | null)[]
}

/** Song rows on screen: row number -> chains, with the screen row they are drawn on. */
export function readSongRows(view: ScreenView): SongRowReading[] {
  if (view.kind !== 'song') return []
  return parseGridScreen('song', view.screen).map((row) => ({
    row      : row.rowIndex as number,
    screenRow: row.screenRow,
    chains   : Array.from({ length: TRACKS }, (_, track) => {
      const field = row.fields[`track${track + 1}`]
      return field ? hexOrNull(field) : null
    })
  }))
}

export function readChain(view: ScreenView): Chain | null {
  if (view.kind !== 'chain' || view.id == null) return null
  const rows = parseGridScreen('chain', view.screen)
  if (!isFullPage(rows, ROWS_PER_CHAIN)) return null
  return {
    id  : view.id,
    rows: rows.map(({ fields }) => ({
      phrase   : hexOrNull(fields.phrase),
      transpose: fields.transpose.hexValue
    }))
  }
}

export function readPhrase(view: ScreenView): Phrase | null {
  if (view.kind !== 'phrase' || view.id == null) return null
  const rows = parseGridScreen('phrase', view.screen)
  if (!isFullPage(rows, ROWS_PER_PHRASE)) return null
  return {
    id   : view.id,
    steps: rows.map(
      ({ fields }): PhraseStep => ({
        note: fields.note.isEmpty ? null : fields.note.rawValue.toUpperCase(),
        vel : hexOrNull(fields.vel),
        inst: hexOrNull(fields.inst),
        fx  : fxLanesOf(fields)
      }),
    )
  }
}

export function readTable(view: ScreenView): Table | null {
  if (view.kind !== 'table' || view.id == null) return null
  const rows = parseGridScreen('table', view.screen)
  if (!isFullPage(rows, ROWS_PER_TABLE)) return null
  return {
    id  : view.id,
    rows: rows.map(
      ({ fields }): TableRow => ({
        transpose: hexOrNull(fields.transpose),
        volume   : hexOrNull(fields.volume),
        fx       : fxLanesOf(fields)
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Label / value views

/** A screen's content rows, without the margin and the track panel. */
const contentLines = (screen: M8Screen): string[] => screen.lines.map(contentOf)

/** The first content row starting with `label`. */
const rowLabelled  = (lines: string[], label: string): string | undefined => lines.find((line) => new RegExp(`^${label}\\b`, 'i').test(line))

/** Rows from the title to the last content row, without the margin and the track panel, trailing blank rows dropped. */
function storedLines(screen: M8Screen): string[] {
  const lines = screen.lines.slice(TITLE_ROW, LAST_CONTENT_ROW + 1).map((line) => wideContentOf(line).trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}

export function readInstrument(view: ScreenView): Instrument | null {
  if (view.kind !== 'inst' || view.id == null) return null
  const lines    = contentLines(view.screen)
  const typeLine = rowLabelled(lines, 'TYPE')
  if (!typeLine) return null
  const nameLine = rowLabelled(lines, 'NAME')
  return {
    id   : view.id,
    type : typeLine.slice(INSTRUMENT_VALUE_X, 21).trim().toUpperCase() || null,
    name : nameOf(nameLine?.slice(INSTRUMENT_VALUE_X, 20) ?? ''),
    lines: storedLines(view.screen)
  }
}

/** The Inst. Mods view's rows (title first), null until its first modulator and destination are drawn. */
export function readInstrumentMods(view: ScreenView): { id: number; lines: string[] } | null {
  if (view.kind !== 'instmods' || view.id == null) return null
  const lines = storedLines(view.screen)
  if (!lines.some((line) => /^MOD1\s/i.test(line)) || !lines.some((line) => /^DEST\s/i.test(line))) return null
  return {
    id: view.id,
    lines
  }
}

/** Screen row of the Instrument view's TYPE value, where Shift+Right opens the instrument's table; -1 when not found. */
export const instrumentTypeRow = (view: ScreenView): number => view.screen.lines.findIndex((line) => /^TYPE\b/i.test(line.slice(SCREEN_MARGIN)))
export const INSTRUMENT_TYPE_X = INSTRUMENT_VALUE_X

export interface ProjectInfo {
  name     : string | null
  tempo    : number | null
  /** TRANSPOSE as the raw byte. */
  transpose: number | null
  /**
   * SCALE: the byte in front of the scale name ('00C CHROMATIC', '20D CHROMATIC'). Its low digit is
   * the scale number (0-F) and its high digit the key (0 = C, 1 = C#, 2 = D ... B = B), as in SCA.
   */
  scale    : number | null
  key      : number | null
  /** GROOVE: the number in front of the groove name ('00DEFAULT'). */
  groove   : number | null
}

/** The two hex digits a value starts with ('00DEFAULT' -> 0). */
function leadingHex(text: string): number | null {
  const match = /^([0-9A-F]{2})/.exec(text)
  return match ? Number.parseInt(match[1], 16) : null
}

/** NAME, TEMPO, TRANSPOSE, GROOVE and SCALE of the Project view; null when the screen is not (yet) the Project view. */
export function readProject(screen: M8Screen): ProjectInfo | null {
  if (!/^PROJECT\b/.test(titleOf(screen))) return null
  const lines    = contentLines(screen)
  const nameLine = rowLabelled(lines, 'NAME')
  if (!nameLine) return null
  const projectValue = (label: string) => (rowLabelled(lines, label)?.slice(PROJECT_VALUE_X) ?? '').toUpperCase()
  const tempo        = Number.parseFloat(rowLabelled(lines, 'TEMPO')?.slice(PROJECT_VALUE_X, 19) ?? '')
  const scale        = projectValue('SCALE')
  const key          = /^[0-9A-F]{2}([A-G]#?)/.exec(scale)?.[1]
  const scaleByte    = leadingHex(scale)
  return {
    name     : nameOf(nameLine.slice(PROJECT_VALUE_X, 25)),
    tempo    : Number.isNaN(tempo) ? null : tempo,
    transpose: leadingHex(projectValue('TRANSPOSE')),
    scale    : scaleByte == null ? null : scaleByte & 0x0f,
    key      : key ? pitchClassOfName(key) : scaleByte == null ? null : scaleByte >> 4,
    groove   : leadingHex(projectValue('GROOVE'))
  }
}

/**
 * The Groove view: rows 0-F with the ticks of each step ('06', '00' skips it, '--' ends the
 * loop), and the PPQ on row 0 (24, 48, 96 or 192) next to the swing ('50.0%'). The layout
 * comes from the SDK's view map; not yet checked on the device. Null until all 16 rows are drawn.
 */
export function readGroove(view: ScreenView): Groove | null {
  if (view.kind !== 'groove' || view.id == null) return null
  const ticks: (number | null | undefined)[] = Array(16).fill(undefined)
  let ppq    : number | null = null
  for (const line of contentLines(view.screen).slice(FIRST_CONTENT_ROW)) {
    // The play marker can take the blank after the row number ('0>06').
    const match = /^([0-9A-F])[^0-9A-Z-]([0-9A-F]{2}|--)(.*)$/.exec(line.toUpperCase())
    if (!match) continue
    const [, rowDigit, rowTicks, rest] = match
    const row                          = Number.parseInt(rowDigit, 16)
    if (ticks[row] !== undefined) continue
    ticks[row] = rowTicks === '--' ? null : Number.parseInt(rowTicks, 16)
    if (row === 0) {
      const ppqMatch = /(?:^|\s)(24|48|96|192)(?![\d.%])/.exec(rest)
      if (ppqMatch) ppq = Number.parseInt(ppqMatch[1], 10)
    }
  }
  if (ticks.some((rowTicks) => rowTicks === undefined)) return null
  return {
    id   : view.id,
    ticks: ticks as (number | null)[],
    ppq
  }
}

/**
 * The Scale view: KEY (under the title), the 12 interval rows and NAME, found by their labels.
 * On the device (fw 6.5) an interval row reads 'C  ON 00.00' or 'C# ON 00.00', and a note out of
 * the scale 'C# -- -- --'. Null until all 12 interval rows are drawn.
 */
export function readScale(view: ScreenView): Scale | null {
  if (view.kind !== 'scale' || view.id == null) return null
  const lines   = contentLines(view.screen).map((line) => line.toUpperCase())
  const keyName = /^KEY\s+([A-G]#?)/.exec(rowLabelled(lines, 'KEY') ?? '')?.[1]
  const key     = keyName ? pitchClassOfName(keyName) : null
  const notes   : Scale['notes'] = []
  for (const line of lines) {
    // While the song plays the M8 draws a '>' before the EN cell of the note being played ('D >ON 00.00').
    const match = /^([A-G])([-# ])\s*>?\s*(ON|OFF|--)(?:\s*([+-]?\d+\.\d+))?/.exec(line)
    if (!match) continue
    const [, letter, accidental, enabled, offsetText] = match
    const pitch                                       = pitchClassOfName(accidental === '#' ? `${letter}#` : letter)
    if (pitch < 0) continue
    // The rows are named from the key (D, D#, E ... for key D): the scale is stored as intervals from it.
    const interval = (pitch - (key ?? 0) + 12) % 12
    if (notes[interval]) continue
    const offset    = offsetText != null ? Number.parseFloat(offsetText) : null
    notes[interval] = {
      enabled: enabled === 'ON',
      offset : offset != null && !Number.isNaN(offset) ? offset : null
    }
  }
  if (notes.filter(Boolean).length < 12) return null
  const name = /^NAME\s+(.*)$/.exec(rowLabelled(lines, 'NAME') ?? '')?.[1] ?? ''
  return {
    id  : view.id,
    name: nameOf(name),
    notes,
    key
  }
}

// ---------------------------------------------------------------------------
// Fully drawn pages

const isSongPage  = (view: ScreenView): boolean => {
  const rows = readSongRows(view)
  return rows.length > 0 && rows.every((row, i) => i === 0 || row.row === rows[i - 1].row + 1)
}

/** How to tell a view kind is fully drawn: its reader reads it. */
const PAGE_CHECKS : Partial<Record<ViewKind, (view: ScreenView) => boolean>> = {
  song    : isSongPage,
  chain   : (view) => readChain(view) != null,
  phrase  : (view) => readPhrase(view) != null,
  table   : (view) => readTable(view) != null,
  inst    : (view) => readInstrument(view) != null,
  instmods: (view) => readInstrumentMods(view) != null,
  scale   : (view) => readScale(view) != null,
  groove  : (view) => readGroove(view) != null
}

/** True when the view is a fully drawn page of that kind (and number). */
export function isPage(view: ScreenView, kind: ViewKind, id?: number | null): boolean {
  if (view.kind !== kind) return false
  if (id != null && view.id !== id) return false
  return PAGE_CHECKS[kind]?.(view) ?? true
}

/** Screen x of a track's cell on the Song view, margin included. */
export const songCellX = (track: number): number => COLUMN_X.song.track(track) + SCREEN_MARGIN
