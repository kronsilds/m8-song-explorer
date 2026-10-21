// The instrument face of a panel, laid out in character cells. It is as tall as a table panel
// and two panel columns wide: on the left the Instrument view's rows as the device places them
// (so every value sits where the M8 cursor would be), a bar after each level and a mark under
// the parameters a modulator drives; on the right the four modulators as on the Inst. Mods
// view (MOD1 / MOD2 on the left, MOD3 / MOD4 on the right), each card with its type, the shape
// of its envelope or LFO, its destination and its values. Pure layout; trackView draws it.

import { hex2 } from '../model/hex'
import { type InstrumentCell, type InstrumentPage, instrumentPage, type ModSlot } from '../model/instrumentPage'
import { modShape, type Point } from '../model/modShapes'
import type { Instrument } from '../model/song'

/** Rows of the face: as many as a table panel (PANEL_ROWS in layout.ts), so the two line up. */
export const FACE_ROWS      = 18
/** Characters of the Instrument view part: the device's content (FM operator D ends at x 30). */
export const INST_CHARS     = 31
/** Title and TRANSP. rows above the parameters. */
export const FACE_HEADER    = 2
/** The modulator cards start here, a blank right of the Instrument view part. */
export const MODS_X         = INST_CHARS + 1
export const MOD_CARD_CHARS = 10
const MOD_CARD_GAP          = 1
/** Half the face's height each: title, curve, destination, then up to five values. */
export const MOD_CARD_ROWS  = FACE_ROWS / 2
/** Rows of a card's curve, under its title row. */
export const MOD_CURVE_ROWS = 2
/** Face width in characters, modulator cards included. */
export const FACE_CHARS     = MODS_X + 2 * MOD_CARD_CHARS + MOD_CARD_GAP
/** A modulator value's label takes this many characters, blank included; the value follows. */
const MOD_LABEL_CHARS       = 5
/** The mixer column's labels start here; left bars stop a blank before. */
const MIXER_X               = 18
/** Bars shorter than this are not drawn. */
const MIN_BAR_CHARS         = 2

export type TextRole = 'title' | 'label' | 'value' | 'option' | 'empty' | `slot${1 | 2 | 3 | 4}`

/** A run of characters drawn in one colour. */
export type TextRun = [text: string, role: TextRole]

/** Where a cell sits on the face, in characters and rows from its top-left corner. */
export interface FacePlace {
  cell  : InstrumentCell
  col   : number
  row   : number
  width : number
  height: number
}

export interface FaceBar {
  col    : number
  row    : number
  width  : number
  /** 0..1 */
  level  : number
  bipolar: boolean
  /** A thin meter under the value instead of a bar after it (FM operator levels). */
  under  : boolean
  /** Slots (1-4) whose destination is this parameter. */
  slots  : number[]
  /** The slot whose card the bar is on (a modulator value), tinted in its colour. */
  tint   : number | null
}

export interface ModCard {
  slot  : ModSlot
  col   : number
  row   : number
  /** The curve: t and v in 0..1 across the card's curve rows. */
  points: Point[]
  /** Its destination is set (not OFF). */
  active: boolean
  /** LFOs swing around the middle; envelopes rise from the bottom. */
  center: boolean
}

export interface InstrumentFace {
  rows  : number
  lines : TextRun[][]
  places: FacePlace[]
  bars  : FaceBar[]
  cards : ModCard[]
}

/** The face's characters and their colour roles, written anywhere, read back as runs per row. */
class FaceText {
  private readonly chars: string[][]
  private readonly roles: TextRole[][]

  constructor(rows: number) {
    this.chars = Array.from({ length: rows }, () => Array<string>(FACE_CHARS).fill(' '))
    this.roles = Array.from({ length: rows }, () => Array<TextRole>(FACE_CHARS).fill('empty'))
  }

  /** Writes `text` at (row, col), in one role or a role per character; what falls outside is dropped. */
  put(row: number, col: number, text: string, role: TextRole | TextRole[]): void {
    if (row < 0 || row >= this.chars.length) return
    for (let i = 0; i < text.length; i += 1) {
      const x = col + i
      if (x < 0 || x >= FACE_CHARS) continue
      this.chars[row][x] = text[i]
      this.roles[row][x] = typeof role === 'string' ? role : (role[i] ?? 'empty')
    }
  }

  /** Runs of each row, its trailing blanks left out. */
  lines(): TextRun[][] {
    return this.chars.map((chars, row) => {
      let end = chars.length
      while (end > 0 && chars[end - 1] === ' ') end -= 1
      const runs: TextRun[] = []
      for (let i = 0; i < end; i += 1) {
        const last = runs[runs.length - 1]
        const role = this.roles[row][i]
        if (last && last[1] === role) last[0] += chars[i]
        else runs.push([chars[i], role])
      }
      return runs
    })
  }
}

/** Colour roles of a device line: labels, then each value over them (options dimmer after their number). */
function lineRoles(text: string, cells: InstrumentCell[]): TextRole[] {
  const roles: TextRole[] = Array.from(text, (char) => (char === ' ' ? 'empty' : 'label'))
  for (const cell of cells) {
    const empty = /^[-:]+$/.test(cell.text)
    for (let i = 0; i < cell.text.length && cell.x + i < roles.length; i += 1) {
      roles[cell.x + i] = empty ? 'empty' : cell.shape === 'option' && i >= 2 ? 'option' : 'value'
    }
  }
  return roles
}

/** The title row: 'I01 GRAYSATURN' on the left, the type on the right of the Instrument view part. */
function titleRow(instrument: Instrument, page: InstrumentPage, text: FaceText, places: FacePlace[]): void {
  const nameCell = page.cells.find((cell) => cell.label === 'NAME')
  const typeCell = page.cells.find((cell) => cell.label === 'TYPE')
  const name     = (instrument.name ?? '').padEnd(12, '-').slice(0, 12)
  const type     = (instrument.type ?? typeCell?.text ?? '?').slice(0, 14)
  const typeCol  = INST_CHARS - type.length
  text.put(0, 0, `I${hex2(instrument.id)} `, 'title')
  text.put(0, 4, name, instrument.name ? 'value' : 'empty')
  text.put(0, typeCol, type, 'label')
  if (nameCell) places.push({
    cell  : nameCell,
    col   : 4,
    row   : 0,
    width : 12,
    height: 1
  })
  if (typeCell) places.push({
    cell  : typeCell,
    col   : typeCol,
    row   : 0,
    width : type.length,
    height: 1
  })
}

/** Bars of the level values on one device line. */
function barsOf(cells: InstrumentCell[], row: number, page: InstrumentPage): FaceBar[] {
  const bars: FaceBar[] = []
  for (const cell of cells) {
    if ((cell.shape !== 'level' && cell.shape !== 'bipolar') || cell.value == null) continue
    const slots = page.slots.filter((slot) => slot.dest != null && slot.dest === cell.label).map((slot) => slot.slot)
    if (cell.operator) {
      bars.push({
        col    : cell.x,
        row,
        width  : cell.width,
        level  : cell.value / 0xff,
        bipolar: false,
        under  : true,
        slots,
        tint   : null
      })
      continue
    }
    const col = cell.x + cell.width + 1
    const end = cell.x < MIXER_X ? MIXER_X - 1 : INST_CHARS
    if (end - col < MIN_BAR_CHARS) continue
    bars.push({
      col,
      row,
      width  : end - col,
      level  : cell.value / 0xff,
      bipolar: cell.shape === 'bipolar',
      under  : false,
      slots,
      tint   : null
    })
  }
  return bars
}

/** A modulator value as it fits a card: the option name without its number, hex as is. */
const modValueText = (cell: InstrumentCell): string => (cell.shape === 'option' && cell.option ? cell.option : cell.text).slice(0, MOD_CARD_CHARS - MOD_LABEL_CHARS)

/**
 * The four modulator cards, two columns of two as on the Inst. Mods view: the slot and its type,
 * the curve, the destination, then its values (AMT, ATK...) with a small bar after each level.
 * Every value is placed on its card; the curve stands for the slot's MODn cell.
 */
function modCards(page: InstrumentPage, text: FaceText, places: FacePlace[], bars: FaceBar[]): ModCard[] {
  const cards = page.slots.map((slot): ModCard => ({
    slot,
    col   : MODS_X + (slot.slot > 2 ? MOD_CARD_CHARS + MOD_CARD_GAP : 0),
    row   : slot.slot % 2 === 1 ? 0 : MOD_CARD_ROWS,
    points: modShape(slot),
    active: slot.dest != null,
    center: slot.kind === 'LFO'
  }))
  for (const card of cards) {
    const { slot, col, row, active } = card
    const place                      = (cell: InstrumentCell | undefined, at: number, x = col, width = MOD_CARD_CHARS, height = 1) => {
      if (cell) places.push({
        cell,
        col: x,
        row: at,
        width,
        height
      })
    }
    text.put(row, col, String(slot.slot), `slot${slot.slot}` as TextRole)
    text.put(row, col + 2, (slot.type ?? '?').slice(0, MOD_CARD_CHARS - 2), active ? 'label' : 'empty')
    const head = slot.cells[`MOD${slot.slot}`]
    place(head, row)
    place(head, row + 1, col, MOD_CARD_CHARS, MOD_CURVE_ROWS)

    const destRow = row + 1 + MOD_CURVE_ROWS
    text.put(destRow, col, `›${slot.dest ?? 'OFF'}`.slice(0, MOD_CARD_CHARS), active ? 'value' : 'empty')
    place(slot.cells.DEST, destRow)

    // The other values in the device's order, one per row.
    const values = Object.values(slot.cells).filter((cell) => cell !== head && cell !== slot.cells.DEST)
    values.slice(0, MOD_CARD_ROWS - 2 - MOD_CURVE_ROWS).forEach((cell, i) => {
      const at    = destRow + 1 + i
      const value = modValueText(cell)
      text.put(at, col, cell.label.slice(0, MOD_LABEL_CHARS - 1), active ? 'label' : 'empty')
      text.put(at, col + MOD_LABEL_CHARS, value, active ? 'value' : 'empty')
      place(cell, at, col + MOD_LABEL_CHARS, MOD_CARD_CHARS - MOD_LABEL_CHARS)
      const barCol = col + MOD_LABEL_CHARS + value.length + 1
      const width  = col + MOD_CARD_CHARS - barCol
      if (cell.shape === 'level' && cell.value != null && width >= MIN_BAR_CHARS) bars.push({
        col    : barCol,
        row    : at,
        width,
        level  : cell.value / 0xff,
        bipolar: false,
        under  : false,
        slots  : [],
        tint   : slot.slot
      })
    })
  }
  return cards
}

/** Lays out an instrument's face from its stored screens. */
export function layoutInstrumentFace(instrument: Instrument): InstrumentFace {
  const page   = instrumentPage(instrument)
  const text   = new FaceText(FACE_ROWS)
  const places : FacePlace[] = []
  const bars   : FaceBar[] = []
  const stored = instrument.lines.map((line) => line.toUpperCase())
  titleRow(instrument, page, text, places)

  // The TRANSP. / TBL.TIC / EQ line under the title.
  const transpLine  = stored.findIndex((line) => line.startsWith('TRANSP.'))
  const headerCells = page.cells.filter((cell) => cell.line === transpLine)
  if (transpLine >= 0) text.put(1, 0, stored[transpLine].slice(0, INST_CHARS), lineRoles(stored[transpLine], headerCells))
  else text.put(1, 0, 'NOT READ', 'empty')
  for (const cell of headerCells) places.push({
    cell,
    col   : cell.x,
    row   : 1,
    width : cell.width,
    height: 1
  })

  // The parameters, line for line as on the device (the blank line under TRANSP. is left out).
  let first = transpLine + 1
  while (first < stored.length && !stored[first].trim()) first += 1
  let last  = stored.length - 1
  while (last >= first && !stored[last].trim()) last -= 1
  for (let line = first; line <= last && transpLine >= 0; line += 1) {
    const row = FACE_HEADER + line - first
    if (row >= FACE_ROWS) break
    const cells = page.cells.filter((cell) => cell.line === line)
    text.put(row, 0, stored[line].slice(0, INST_CHARS), lineRoles(stored[line], cells))
    bars.push(...barsOf(cells, row, page))
    for (const cell of cells) places.push({
      cell,
      col   : cell.x,
      row,
      width : Math.min(cell.width, INST_CHARS - cell.x),
      height: 1
    })
  }

  let cards: ModCard[] = []
  if (page.slots.length) cards = modCards(page, text, places, bars)
  else ['MODULATORS', 'NOT READ:', 'EXPLORE AGAIN'].forEach((line, i) => {
    text.put(i, MODS_X, line, 'empty')
  })
  return {
    rows : FACE_ROWS,
    lines: text.lines(),
    places,
    bars,
    cards
  }
}

/**
 * Where a value is drawn: its own place, or for a modulator value without one the curve of its
 * card.
 */
export function placeOf(face: InstrumentFace, screen: InstrumentCell['screen'], line: number, x: number): FacePlace | null {
  const own = face.places.find((place) => place.cell.screen === screen && place.cell.line === line && place.cell.x === x)
  if (own) return own
  if (screen !== 'mods') return null
  const slot = face.cards.find((card) => Object.values(card.slot.cells).some((cell) => cell.line === line && cell.x === x))
  return slot ? (face.places.find((place) => place.cell.slot === slot.slot.slot && place.height === MOD_CURVE_ROWS) ?? null) : null
}

/** True for the instrument's title row (name, type), which stands for the whole instrument. */
export const isTitlePlace = (place: FacePlace): boolean => place.row === 0 && place.cell.screen === 'inst'

/** The place under a face position (characters, rows), the smallest first. */
export function placeAt(face: InstrumentFace, col: number, row: number): FacePlace | null {
  const hits = face.places.filter((place) => col >= place.col - 0.5 && col < place.col + place.width + 0.5 && row >= place.row && row < place.row + place.height)
  return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null
}
