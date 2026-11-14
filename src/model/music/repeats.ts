// REP lanes: what a REP command does to the value of the command above it, row after row.
// REP does not re-enter that command (which would add its value to the one before): it shifts the
// computed value of the parameter. With a CUTOFF of 40 and CUT 70 the computed value is B0, and a
// REP 04 adds 1 to it on every row. A REP step counts in quarters (01 = +0.25, 7F = +31.75,
// 80 = -32, FF = -0.25). The computed value stops at 00 and FF, or at the RTO value (an absolute
// value, not a shift): it never wraps. A REP still running at the end of a phrase goes on in the
// next phrase of the track (the device marks that lane '^^').
// Not modelled: a phrase reached by a song jump or a chain loop (it counts as not following), the
// reset a trigger (an instrument number or a RET) gives a relative parameter, relative commands of
// one parameter adding up across lanes, and tables.
// An empty cell under a running REP shows the computed value ('CUTB2'). A parameter whose instrument
// value is not known here (PIT, VOL, FIN) shows its shift instead, marked with its sign ('+PIT0C',
// '-PIT04'), with no stop at 00 or FF.
// Not checked on a device: a REP applies its first step on its own row.

import { lookupFxCommand } from '@yam8d/m8-sdk'
import { hex2 } from '../hex'
import { type InstrumentScreen, instrumentPage } from '../instrumentPage'
import { FX_LANES, type FxCell, type Instrument, ROWS_PER_PHRASE } from '../song'
import type { SongContext } from '../songContext'

export type RepEvent = 'none' | 'set' | 'rep' | 'change' | 'continue' | 'stop' | 'replace' | 'limit' | 'orphan'
/** Why a running REP no longer moves the value: it is at FF, at 00 or at the RTO value. */
export type Held = 'max' | 'min' | 'limit' | null

/** The state of one FX lane on one row, after the row. */
export interface RepRow {
  event    : RepEvent
  /** A REP is running after this row. */
  active   : boolean
  /** The repeated command was set in an earlier phrase (the M8 shows '^^'). */
  carried  : boolean
  cmd      : string | null
  /** The command shifts an instrument parameter (CUT, RES...), as opposed to setting a value. */
  relative : boolean
  /** The command's own value as typed. */
  source   : number | null
  /** What a cell of the lane shows while the REP runs: the computed value's whole part, or the size of the shift when the instrument's own value is not known (see `repeatedCell` for its sign). */
  value    : number | null
  /** The relative shift, in quarters. */
  shift    : number | null
  /** The computed value in quarters; null when the instrument's own value is not known. */
  computed : number | null
  /** The instrument's own value of a relative command's parameter, when known. */
  base     : number | null
  /** The REP's step as typed (00-7F up, 80-FF down, in quarters). */
  increment: number | null
  /** The RTO value in force. */
  limit    : number | null
  held     : Held
}

interface Level {
  /** Quarters: the computed value (the shift alone when `known` is false). */
  q    : number
  /** The instrument's own value in quarters, 0 for a command that is not relative. */
  baseQ: number
  known: boolean
}

/** What a lane hands to the next phrase when a REP is still running at its end. */
export interface RepCarry {
  cmd      : string
  relative : boolean
  source   : number | null
  increment: number | null
  limit    : number | null
  level    : Level
}

const QUARTERS = 4
const MAX      = 0xff * QUARTERS

/** A REP step in quarters: 00-7F up, 80-FF down. */
export const stepQuarters = (step: number): number => (step > 0x7f ? step - 0x100 : step)
const signed8             = (value: number): number => (value > 0x7f ? value - 0x100 : value)

/** Quarters as the decimal they mean: 705 -> '176.25', 12 -> '3'. */
export const quarterText   = (quarters: number): string => String(quarters / QUARTERS)
const signedQuarters       = (quarters: number): string => `${quarters < 0 ? '−' : '+'}${quarterText(Math.abs(quarters))}`
/** A REP step in decimal: '+0.25', '+1', '−32'. */
export const incrementText = (step: number): string => signedQuarters(stepQuarters(step))

/** The Instrument view parameter each relative command moves, as that view labels it. */
const PARAMETERS: Record<string, string> = {
  CUT: 'CUTOFF',
  RES: 'RES',
  AMP: 'AMP',
  PAN: 'PAN',
  TBR: 'TIMBRE',
  COL: 'COLOR',
  RED: 'REDUX',
  DEG: 'DEGRADE',
  SWM: 'SWARM',
  WID: 'WIDTH',
  SUB: 'SUBOSC',
  LOP: 'LOOP ST',
  LEN: 'LENGTH',
  FM1: 'MOD1',
  FM2: 'MOD2',
  FM3: 'MOD3',
  FM4: 'MOD4'
}

/** Where a relative command's parameter is on the instrument's screens. */
interface Parameter {
  /** As the panel names it: 'CUTOFF', 'MOD2 AMT'. */
  name  : string
  screen: InstrumentScreen
  label : string
  /** Modulator slot (1-4) of an Inst. Mods parameter. */
  slot? : number
}

/** The parameter a relative command moves; null for one with no value on the instrument's screens (PIT, VOL, FIN). */
function parameterOf(cmd: string): Parameter | null {
  const label = PARAMETERS[cmd]
  if (label) return {
    name  : label,
    screen: 'inst',
    label
  }
  // EA1-EA4 and LA1-LA4: the amount of a modulator.
  const mod = /^[EL]A([1-4])$/.exec(cmd)
  if (mod) return {
    name  : `MOD${mod[1]} AMT`,
    screen: 'mods',
    label : 'AMT',
    slot  : Number(mod[1])
  }
  return null
}

/** The instrument's own value of the parameter a relative command moves; null when it is not known. */
export function parameterBase(instrument: Instrument | undefined, cmd: string): number | null {
  const parameter = parameterOf(cmd)
  if (!instrument || !parameter) return null
  const page  = instrumentPage(instrument)
  const cells = parameter.screen === 'mods' ? page.mods : page.cells
  const found = cells.find((cell) => cell.screen === parameter.screen && cell.label === parameter.label && !cell.operator && (parameter.slot == null || cell.slot === parameter.slot) && cell.value != null)
  return found?.value ?? null
}

const clamp = (quarters: number): number => Math.min(MAX, Math.max(0, quarters))

/** The level a command sets: its value, or the instrument's value shifted by it. */
function startLevel(value: number | null, relative: boolean, base: number | null): Level | null {
  if (value == null) return null
  if (!relative) return {
    q    : value * QUARTERS,
    baseQ: 0,
    known: true
  }
  if (base == null) return {
    q    : signed8(value) * QUARTERS,
    baseQ: 0,
    known: false
  }
  return {
    q    : clamp(base * QUARTERS + signed8(value) * QUARTERS),
    baseQ: base * QUARTERS,
    known: true
  }
}

/** Moves a level by `delta` quarters: it stops at 00, FF and the RTO value, and never wraps. */
function move(level: Level, delta: number, limit: number | null): Held {
  if (!level.known) {
    level.q += delta
    return null
  }
  const before = level.q
  let next     = before + delta
  let held     : Held = null
  if (limit != null) {
    const bound = limit * QUARTERS
    if ((delta > 0 && next >= bound && before <= bound) || (delta < 0 && next <= bound && before >= bound)) {
      next = bound
      held = 'limit'
    }
  }
  // Held means it has come to the end it moves toward: it stays there from now on.
  if (next >= MAX && delta > 0) {
    next = MAX
    held = 'max'
  } else if (next <= 0 && delta < 0) {
    next = 0
    held = 'min'
  }
  level.q = next
  return held
}

/** The instrument's own value of a relative command's parameter on a row, when known. */
type BaseOf = (cmd: string, row: number) => number | null

/** The byte a cell of the lane shows while its REP runs: the computed value, or the size of the shift when the instrument's own value is not known. */
function shownValue(level: Level): number {
  if (level.known) return Math.floor(level.q / QUARTERS)
  return Math.min(0xff, Math.floor(Math.abs(level.q) / QUARTERS))
}

/** Follows one lane down `cells` (the steps of a phrase), starting from `carry` when a REP comes in. */
export function traceLane(cells: readonly (FxCell | undefined)[], baseOf: BaseOf = () => null, carry: RepCarry | null = null): { rows: RepRow[]; end: RepCarry | null } {
  let cmd       = carry?.cmd ?? null
  let relative  = carry?.relative ?? false
  let source    = carry?.source ?? null
  let level     = carry ? { ...carry.level } : null
  let active    = carry != null
  let increment = carry?.increment ?? null
  let limit     = carry?.limit ?? null
  let carried   = carry != null
  let held      : Held = null
  const rows    : RepRow[] = []
  cells.forEach((cell, i) => {
    let event: RepEvent = 'none'
    if (cell?.cmd === 'REP') {
      const amount = cell.val ?? 0
      if (amount === 0) {
        event     = active ? 'stop' : 'none'
        active    = false
        increment = null
        held      = null
      } else if (cmd == null) {
        event = 'orphan'
      } else {
        event     = active ? 'change' : 'rep'
        active    = true
        increment = amount
        if (level) held = move(level, stepQuarters(amount), limit)
      }
    } else if (cell?.cmd === 'RTO') {
      event = 'limit'
      limit = cell.val
    } else if (cell?.cmd) {
      event     = active ? 'replace' : 'set'
      cmd       = cell.cmd
      relative  = lookupFxCommand(cmd)?.relative === true
      source    = cell.val
      level     = startLevel(cell.val, relative, relative ? baseOf(cmd, i) : null)
      active    = false
      increment = null
      limit     = null
      carried   = false
      held      = null
    } else if (active) {
      event = 'continue'
      if (level) held = move(level, stepQuarters(increment ?? 0), limit)
    }
    const running = active && level != null
    rows.push({
      event,
      active,
      carried  : carried && cmd != null,
      cmd,
      relative,
      source,
      value    : running && level ? shownValue(level) : null,
      shift    : running && level && relative ? (level.known ? level.q - level.baseQ : level.q) : null,
      computed : running && level?.known ? level.q : null,
      base     : running && level?.known && relative ? level.baseQ / QUARTERS : null,
      increment: active ? increment : null,
      limit    : active || event === 'limit' ? limit : null,
      held     : active ? held : null
    })
  })
  return {
    rows,
    end: active && cmd != null && level ? {
      cmd,
      relative,
      source,
      increment,
      limit,
      level: { ...level }
    } : null
  }
}


const cache = new WeakMap<SongContext, Map<string, RepRow[][]>>()

/** The REP lanes of every phrase instance of the song (by instance key, then lane, then step). */
export function repeatLanes(song: SongContext): Map<string, RepRow[][]> {
  const known = cache.get(song)
  if (known) return known
  const byInstance = new Map<string, RepRow[][]>()
  for (const instances of song.timeline.byTrack) {
    let previousRow = Number.NEGATIVE_INFINITY
    let carries     : (RepCarry | null)[] = []
    for (const instance of instances) {
      const steps    = song.model.phrases[instance.phrase]?.steps ?? []
      const playing  = song.effective.get(instance.key) ?? []
      const incoming = previousRow + ROWS_PER_PHRASE === instance.row ? carries : []
      const baseOf   = (command: string, row: number): number | null => parameterBase(song.model.instruments[playing[row] ?? -1], command)
      const traced   : { rows: RepRow[]; end: RepCarry | null }[] = []
      for (let lane = 0; lane < FX_LANES; lane += 1) {
        const cells = Array.from({ length: ROWS_PER_PHRASE }, (_, step) => steps[step]?.fx[lane])
        traced.push(traceLane(cells, baseOf, incoming[lane] ?? null))
      }
      byInstance.set(instance.key, traced.map((lane) => lane.rows))
      previousRow = instance.row
      carries     = traced.map((lane) => lane.end)
    }
  }
  cache.set(song, byInstance)
  return byInstance
}

/** The rows a REP covers in a lane, as runs of consecutive rows: [first, last]. */
export function repeatRuns(rows: readonly RepRow[]): [first: number, last: number][] {
  const runs: [number, number][] = []
  rows.forEach((row, i) => {
    if (!row.active) return
    const last = runs.at(-1)
    if (last && last[1] === i - 1) last[1] = i
    else runs.push([i, i])
  })
  return runs
}

/** The sign in front of a cell that shows a shift, not a value. */
export type ShiftSign = '+' | '-' | null

/** True when a row's cell can only show the shift: the instrument's own value is not known. */
const showsShift = (row: RepRow): boolean => row.computed == null && row.shift != null

/**
 * What an empty cell under a REP shows, as drawn in it: the computed value (['CUT', 'B2'], no sign),
 * or the shift with its sign when the instrument's own value is not known (['PIT', '04'] with '-').
 */
export function repeatedCell(row: RepRow): [sign: ShiftSign, command: string, value: string] {
  const sign: ShiftSign = showsShift(row) ? ((row.shift ?? 0) < 0 ? '-' : '+') : null
  return [sign, (row.cmd ?? '---').padEnd(3).slice(0, 3), row.value == null ? '??' : hex2(row.value)]
}


/** A number of quarters as 'hex (decimal)': 'B1 (177)', 'B1 (177.25)'. */
const levelText = (quarters: number): string => `${hex2(Math.floor(quarters / QUARTERS))} (${quarterText(quarters)})`

const HELD: Record<Exclude<Held, null>, string> = {
  max  : 'It cannot go above FF (255).',
  min  : 'It cannot go below 00 (0).',
  limit: 'It is held at the RTO value.'
}

/** What a lane's REP does to its parameter on this row; the sentence after the one that names the REP. */
function resultText(row: RepRow): string {
  if (row.computed == null) {
    if (row.shift == null) return ''
    const [sign, , value] = repeatedCell(row)
    return `${row.cmd} is now ${signedQuarters(row.shift)} from the instrument's own value, which is not known here: the cell shows this shift in hex, after its sign (${sign === '-' ? '−' : '+'}${value}).`
  }
  if (row.relative && row.base != null) {
    const parameter = (row.cmd && parameterOf(row.cmd)?.name) || row.cmd
    return `${parameter} is now ${levelText(row.computed)}: the instrument's ${levelText(row.base * QUARTERS)}, shifted by ${signedQuarters(row.computed - row.base * QUARTERS)}.`
  }
  return `${row.cmd} is now ${levelText(row.computed)}.`
}

/** What a REP does on this row of a lane, for the panel; null when the row has nothing to say about a REP. */
export function repeatText(row: RepRow | undefined): string | null {
  if (!row) return null
  const where = row.carried ? ' (it began in the previous phrase: the M8 shows ^^ on this lane)' : ''
  const step  = row.increment != null ? `${incrementText(row.increment)} per row` : ''
  const tail  = [resultText(row), row.held ? HELD[row.held] : '', row.limit != null ? `RTO ${hex2(row.limit)} (${row.limit}) is the stop value.` : ''].filter(Boolean)
  switch (row.event) {
    case 'rep':
    case 'change':
      return [`REP ${step} shifts ${row.cmd} on every row${where}.`, ...tail].join(' ')
    case 'continue':
      return [`REP ${step} is still shifting ${row.cmd}${where}.`, ...tail].join(' ')
    case 'stop':
      return `REP 00 stops the shifting of ${row.cmd}${where}.`
    case 'replace':
      return `${row.cmd} replaces the running REP: it no longer shifts anything.`
    case 'limit':
      return row.limit == null ? null : `Stops a REP at ${hex2(row.limit)} (${row.limit}). It is an absolute value, not a shift.`
    case 'orphan':
      return 'No command above it in this lane for REP to shift.'
    default:
      return null
  }
}

