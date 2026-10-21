// An instrument as the Instrument and Inst. Mods views show it, parsed into cells that keep
// their place on the device screen (so the SDK can explain each one as if the cursor were on
// it): parameters with their values, and the four modulators.
//
// Layouts seen on a Model:02, firmware 6.5 (screen x without the margin):
// - Instrument view: TYPE / NAME / TRANSP. TBL.TIC EQ on lines 2-4, then the parameters from
//   line 6. Left labels at x 0 with values at x 8 (MIDI OUT: x 12; EXTERNAL CCs: x 4); the
//   mixer column on the right (AMP LIM PAN DRY MFX DEL REV) has its label at x 18 and value at
//   x 22. FM synth rows hold four operator columns at x 8, 14, 20, 26.
// - Inst. Mods view: MOD1 and MOD3 side by side from line 2, MOD2 and MOD4 from line 10. Left
//   labels at x 0 with values at x 5, right labels at x 16 with values at x 21.

import type { Instrument } from './song'

export type InstrumentScreen = 'inst' | 'mods'

/** How a value is drawn: a level bar, a bar from the middle, an option name, plain text. */
export type CellShape = 'level' | 'bipolar' | 'option' | 'text'

export interface InstrumentCell {
  screen   : InstrumentScreen
  /** Line of the stored screen (0 is the title row) and x of the value. */
  line     : number
  x        : number
  width    : number
  /** Label as on the device: 'CUTOFF', 'AMT', 'RATIO'. */
  label    : string
  /** FM operator ('A'..'D') of a four-column row. */
  operator?: string
  /** The value as shown, upper case. */
  text     : string
  shape    : CellShape
  /** 00-FF for hex values and options, null otherwise. */
  value    : number | null
  /** The option name ('LOWPASS') of an option. */
  option   : string | null
  /** Modulator slot 1-4 of an Inst. Mods cell. */
  slot?    : number
}

export type ModKind = 'AHD' | 'ADSR' | 'DRUM' | 'LFO' | 'TRIG' | 'TRACKING'

export interface ModSlot {
  slot : number
  kind : ModKind | null
  /** The type as shown: 'AHD ENV'. */
  type : string | null
  /** The destination's name, null when OFF. */
  dest : string | null
  /** The slot's cells by label (MOD1, DEST, AMT, ATK...). */
  cells: Record<string, InstrumentCell>
}

/** Labels of the mixer column on the right of the Instrument view. */
const MIXER_LABELS     = new Set(['AMP', 'LIM', 'PAN', 'DRY', 'MFX', 'DEL', 'REV'])
const MIXER_LABEL_X    = 18
const MIXER_VALUE_X    = 22
/** Where the left values usually start. */
const VALUE_X          = 8
/** FM rows with one value per operator: their columns. */
const OPERATOR_STEP    = 6
const OPERATORS        = ['A', 'B', 'C', 'D']
/** Parameters drawn from the middle (80 is the centre). */
const BIPOLAR_LABELS   = new Set(['PAN', 'DETUNE'])
/** Hex numbers that are not levels: a channel, a tick count, a slot. */
const PLAIN_HEX_LABELS = new Set(['CHANNEL', 'TBL.TIC', 'EQ'])
/** Inst. Mods zones: label x, value x. */
const MOD_ZONES        = [[0, 5], [16, 21]] as const
const MOD_ZONE_WIDTH   = 15

const MOD_KINDS: [prefix: string, kind: ModKind][] = [
  ['AHD', 'AHD'],
  ['ADSR', 'ADSR'],
  ['DRUM', 'DRUM'],
  ['LFO', 'LFO'],
  ['TRIG', 'TRIG'],
  ['TRACK', 'TRACKING'],
]

/** A value's shape, number and option name. */
export function readValue(label: string, text: string): Pick<InstrumentCell, 'shape' | 'value' | 'option'> {
  const hex = /^[0-9A-F]{2}$/.exec(text)
  if (hex) {
    return {
      shape : PLAIN_HEX_LABELS.has(label) ? 'text' : BIPOLAR_LABELS.has(label) ? 'bipolar' : 'level',
      value : Number.parseInt(text, 16),
      option: null
    }
  }
  // FM LEV/FB '80/00': the level comes first.
  const pair = /^([0-9A-F]{2})\/[0-9A-F]{2}$/.exec(text)
  if (pair) return {
    shape : 'level',
    value : Number.parseInt(pair[1], 16),
    option: null
  }
  // '01LOWPASS', '16WT-OSC:TUBE', '02[A>B+C]>D'; not '001:--' or '00> 00 00'.
  const option = /^([0-9A-F]{2})([A-Z[].*)$/.exec(text)
  if (option) {
    return {
      shape : 'option',
      value : Number.parseInt(option[1], 16),
      option: option[2].trim()
    }
  }
  return {
    shape : 'text',
    value : null,
    option: null
  }
}

function cell(screen: InstrumentScreen, line: number, x: number, label: string, text: string, extra: Partial<InstrumentCell> = {}): InstrumentCell {
  return {
    screen,
    line,
    x,
    width: Math.max(2, text.length),
    label,
    text,
    ...readValue(label, text),
    ...extra
  }
}

const upper = (lines: string[]): string[] => lines.map((line) => line.toUpperCase().trimEnd())

/** The label of a left parameter and where its value starts; null for a line without one. */
function leftLabel(line: string): { label: string; valueX: number } | null {
  if (!line.trim() || line[0] === ' ') return null
  // The usual layout: a label of up to 7 characters, the value at x 8.
  if (line[VALUE_X - 1] === ' ' && line[VALUE_X] && line[VALUE_X] !== ' ') return {
    label : line.slice(0, VALUE_X).trim(),
    valueX: VALUE_X
  }
  // Labels with a gap of two blanks or more (MIDI OUT: 'PORT        00MIDI+USB', 'CCA CC:VAL  ---:--').
  const gapped = /^(\S+(?: \S+)*?) {2,}(?=\S)/.exec(line)
  if (gapped) return {
    label : gapped[1],
    valueX: gapped[0].length
  }
  // One blank (EXTERNAL: 'CCA 001:--').
  const tight = /^(\S+) (?=\S)/.exec(line)
  return tight ? {
    label : tight[1],
    valueX: tight[0].length
  } : null
}

/** Four operator values ('01.00 01.00 01.00 01.00') as cells, or null when the value is not such a row. */
function operatorCells(lineIndex: number, label: string, line: string, valueX: number): InstrumentCell[] | null {
  const values = OPERATORS.map((_, i) => line.slice(valueX + i * OPERATOR_STEP, valueX + i * OPERATOR_STEP + OPERATOR_STEP - 1))
  if (!values.every((value) => /^\S{5}$/.test(value))) return null
  return values.map((text, i) => cell('inst', lineIndex, valueX + i * OPERATOR_STEP, label, text, { operator: OPERATORS[i] }))
}

/**
 * The cells of the Instrument view: TYPE, NAME, TRANSP. / TBL.TIC / EQ, then every parameter.
 * `lines` are the stored screen lines (title row first, no margin).
 */
export function instrumentCells(rawLines: string[]): InstrumentCell[] {
  const lines   = upper(rawLines)
  const cells   : InstrumentCell[] = []
  let lastLabel = ''
  lines.forEach((line, index) => {
    if (index === 0 || !line.trim()) return
    if (line.startsWith('TYPE ')) {
      const type = line.slice(VALUE_X, VALUE_X + 13).trim()
      if (type) cells.push(cell('inst', index, VALUE_X, 'TYPE', type))
      return
    }
    if (line.startsWith('NAME ')) {
      cells.push(cell('inst', index, VALUE_X, 'NAME', line.slice(VALUE_X, VALUE_X + 12).trim() || '------------'))
      return
    }
    if (line.startsWith('TRANSP.')) {
      for (const [label, offset] of [['TRANSP.', 8], ['TBL.TIC', 8], ['EQ', 3]] as const) {
        const at   = line.indexOf(label)
        const text = at < 0 ? '' : (/^\S+/.exec(line.slice(at + offset))?.[0] ?? '')
        if (text) cells.push(cell('inst', index, at + offset, label === 'TRANSP.' ? 'TRANSP' : label, text))
      }
      return
    }
    const mixerLabel = line.slice(MIXER_LABEL_X, MIXER_VALUE_X).trim()
    const hasMixer   = MIXER_LABELS.has(mixerLabel) && line[MIXER_LABEL_X - 1] === ' ' && line[MIXER_VALUE_X - 1] === ' '
    const left       = hasMixer ? line.slice(0, MIXER_LABEL_X - 1).trimEnd() : line
    if (left.trim()) {
      const labelled = leftLabel(left)
      if (labelled) lastLabel = labelled.label
      const label  = labelled?.label ?? lastLabel
      const valueX = labelled?.valueX ?? left.search(/\S/)
      if (!labelled && /^\s+[A-D] \S/.test(left)) {
        // FM operator shapes under ALGO: 'A SW4 B W0F C SIN D SIN'.
        for (const match of left.matchAll(/([A-D]) (\S+)/g)) {
          cells.push(cell('inst', index, (match.index ?? 0) + 2, 'SHAPE', match[2], { operator: match[1] }))
        }
      } else {
        const operators = operatorCells(index, label, left, labelled ? valueX : VALUE_X)
        if (operators) cells.push(...operators)
        else {
          const text = left.slice(valueX).trim()
          if (text) cells.push(cell('inst', index, valueX, label, text))
        }
      }
    }
    if (hasMixer) {
      const text = /^\S+/.exec(line.slice(MIXER_VALUE_X))?.[0]
      if (text) cells.push(cell('inst', index, MIXER_VALUE_X, mixerLabel, text))
    }
  })
  return cells
}

/** The cells of the Inst. Mods view, each with the slot (1-4) it belongs to. */
export function modCells(rawLines: string[]): InstrumentCell[] {
  const lines = upper(rawLines)
  const cells : InstrumentCell[] = []
  const slots = [0, 0]
  lines.forEach((line, index) => {
    if (index === 0) return
    MOD_ZONES.forEach(([labelX, valueX], zone) => {
      const label = line.slice(labelX, valueX - 1).trim()
      const text  = line.slice(valueX, labelX + MOD_ZONE_WIDTH + 1).trim()
      if (!/^[A-Z][A-Z0-9]*$/.test(label) || !text) return
      const slot = /^MOD(\d)$/.exec(label)
      if (slot) slots[zone] = Number(slot[1])
      if (!slots[zone]) return
      cells.push(cell('mods', index, valueX, label, text, { slot: slots[zone] }))
    })
  })
  return cells
}

export const modKindOf = (type: string | null): ModKind | null => MOD_KINDS.find(([prefix]) => type?.startsWith(prefix))?.[1] ?? null

/** The four modulators of an Inst. Mods screen, in slot order (slots not on screen are left out). */
export function modSlots(cells: InstrumentCell[]): ModSlot[] {
  const slots: ModSlot[] = []
  for (let slot = 1; slot <= 4; slot += 1) {
    const own = cells.filter((c) => c.slot === slot)
    if (!own.length) continue
    const byLabel = Object.fromEntries(own.map((c) => [c.label, c]))
    const head    = byLabel[`MOD${slot}`]
    const type    = head?.option ?? head?.text ?? null
    const dest    = byLabel.DEST?.option ?? null
    slots.push({
      slot,
      kind : modKindOf(type),
      type,
      dest : dest && dest !== 'OFF' ? dest : null,
      cells: byLabel
    })
  }
  return slots
}

/** Everything the explorer knows of an instrument's screens, parsed. */
export interface InstrumentPage {
  cells: InstrumentCell[]
  /** Inst. Mods cells, empty when the view was not read. */
  mods : InstrumentCell[]
  slots: ModSlot[]
}

const pages = new WeakMap<Instrument, InstrumentPage>()

/** The instrument's page, parsed once per instrument object. */
export function instrumentPage(instrument: Instrument): InstrumentPage {
  let page = pages.get(instrument)
  if (!page) {
    const mods = modCells(instrument.mods ?? [])
    page       = {
      cells: instrumentCells(instrument.lines),
      mods,
      slots: modSlots(mods)
    }
    pages.set(instrument, page)
  }
  return page
}

/** The cell at (line, x) of a screen, or the nearest one on that line. */
export function cellAt(page: InstrumentPage, screen: InstrumentScreen, line: number, x: number): InstrumentCell | null {
  const onLine = (screen === 'inst' ? page.cells : page.mods).filter((c) => c.line === line)
  return onLine.find((c) => x >= c.x && x < c.x + c.width) ?? onLine.reduce<InstrumentCell | null>((best, c) => (!best || Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best), null)
}

/** Parameters a modulator's destination names ('CUTOFF' -> the CUTOFF cell). */
export const isModulated = (slot: ModSlot, label: string): boolean => slot.dest != null && slot.dest === label

/** Modulators whose destination is a parameter's label. */
export const modulatorsOf = (page: InstrumentPage, label: string): ModSlot[] => page.slots.filter((slot) => isModulated(slot, label))
