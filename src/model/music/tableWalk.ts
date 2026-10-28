// A table read as a whole, for the selection panel: where each of its cursors goes after the
// note that starts it (the rows it plays, whether it loops or stops, and how long that takes),
// the chord its transpose column spells, and the steps of the song that start it. The moves
// come from tableRun.ts, which lists what is modelled and what is not checked on the device.

import { hexDigit } from '../hex'
import type { SongModel, TableRow } from '../song'
import type { Timeline } from '../timeline'
import { CLOCK_PPQ, DEFAULT_TICKS } from './groove'
import { noteNumber, noteText, pitchClass } from './pitch'
import { stepTables } from './tablePlayback'
import { MAX_PLAIN_TIC, startTableRun, stepTableRun, tableRunCursors, tableRunKey } from './tableRun'

/** Row changes followed before giving up on finding where a table repeats. */
const MAX_EVENTS    = 4000
/** Rows of a 200 Hz table (TIC FF) per second. */
const FAST_ROW_MS   = 5
/** Groups of rows listed before the rest is cut ('0–3, 1–2, …'). */
const MAX_RUNS      = 6
/** Transposes listed before the rest is cut. */
const MAX_INTERVALS = 8

/** What one unit of a walk is: a MIDI clock tick, a 200 Hz row (TIC FF), or a note (TIC 00). */
export type WalkUnit = 'tick' | 'fast' | 'note'

export interface CursorWalk {
  /**
   * 'loop': plays `intro` once, then `loop` over and over; 'stop': plays `intro` and stays on its
   * last row (a HOP onto its own row); 'still': follows a TIC with no rows to time (a map, or
   * 200 Hz in one lane); 'long': no repeat found soon, `intro` holds what was followed.
   */
  kind      : 'loop' | 'stop' | 'still' | 'long'
  intro     : number[]
  loop      : number[]
  /** Units from the note to the start of `loop` (for a stop: to its last row), and of one pass of `loop`. */
  introUnits: number
  loopUnits : number
}

export interface TableWalk {
  tic    : number
  unit   : WalkUnit
  /** The transpose / volume cursor, then one per FX lane. */
  cursors: CursorWalk[]
}

interface Entry {
  at : number
  row: number
}

/** Follows a table started at `tic` until it repeats; null for the map modes (TIC FC-FE), where a row is picked, not reached. */
export function walkTable(rows: TableRow[], tic: number): TableWalk | null {
  const unit : WalkUnit | null = tic === 0 ? 'note' : tic === 0xff ? 'fast' : tic <= MAX_PLAIN_TIC ? 'tick' : null
  // One row per note or per 5 ms is followed as one row per unit.
  const run  = unit && startTableRun(rows, unit === 'tick' ? tic : 1)
  if (!unit || !run) return null
  const entries = tableRunCursors(run).map((cursor): Entry[] => [{
    at : 0,
    row: cursor.row
  }])
  const seen    = new Map<string, number>()
  let time      = 0
  let cycle     : { from: number; to: number } | null = null
  // Until the state repeats, then once more round, so each cursor shows its own loop twice.
  let until     = Number.POSITIVE_INFINITY
  for (let events = 0; events < MAX_EVENTS && time < until; events += 1) {
    if (!cycle) {
      const key   = tableRunKey(run)
      const first = seen.get(key)
      if (first == null) seen.set(key, time)
      else {
        cycle = {
          from: first,
          to  : time
        }
        until = 2 * time - first
        continue
      }
    }
    const before = tableRunCursors(run)
    const step   = stepTableRun(run)
    if (!step) break
    time        += step.ticks
    // A THO moves the cursors that did not come to a row by themselves too.
    tableRunCursors(run).forEach((cursor, index) => {
      if (step.entered.includes(index) || cursor.row !== before[index].row) entries[index].push({
        at : time,
        row: cursor.row
      })
    })
  }
  const state = tableRunCursors(run)
  return {
    tic,
    unit,
    cursors: entries.map((list, index) => cursorWalk(list, state[index].rate === 0, state[index].stopped, cycle))
  }
}

function cursorWalk(list: Entry[], still: boolean, stopped: boolean, cycle: { from: number; to: number } | null): CursorWalk {
  const rows  = list.map((entry) => entry.row)
  const ended = (kind: CursorWalk['kind']): CursorWalk => ({
    kind,
    intro     : rows,
    loop      : [],
    introUnits: list[list.length - 1].at,
    loopUnits : 0
  })
  if (still) return ended('still')
  if (stopped) return ended('stop')
  if (!cycle) return ended('long')
  // The entries of one pass of the whole table's cycle repeat after it: this cursor's own loop
  // is the shortest repeat among them, and starts as early as the entries before agree with it.
  const first = list.findIndex((entry) => entry.at > cycle.from)
  const count = list.filter((entry) => entry.at > cycle.from && entry.at <= cycle.to).length
  if (first < 0 || !count) return ended('stop')
  const repeatsAfter = (period: number, index: number, units: number): boolean =>
    index + period < list.length && rows[index] === rows[index + period] && list[index + period].at - list[index].at === units
  let period         = count
  for (let candidate = 1; candidate < count; candidate += 1) {
    if (count % candidate) continue
    const units = list[first + candidate].at - list[first].at
    if (Array.from({ length: count }, (_, k) => first + k).every((index) => repeatsAfter(candidate, index, units))) {
      period = candidate
      break
    }
  }
  const loopUnits = list[first + period].at - list[first].at
  let start       = first
  while (start > 0 && repeatsAfter(period, start - 1, loopUnits)) start -= 1
  return {
    kind      : 'loop',
    intro     : rows.slice(0, start),
    loop      : rows.slice(start, start + period),
    introUnits: list[start].at,
    loopUnits
  }
}

/** Every row a cursor plays. */
export const playedRows = (walk: CursorWalk): number[] => [...walk.intro, ...walk.loop]

// ---------------------------------------------------------------------------
// Words

/** '0–3, 1–2': rows in play order, runs of consecutive rows joined. */
export function rowRuns(rows: number[]): string {
  const runs: [number, number][] = []
  for (const row of rows) {
    const last = runs[runs.length - 1]
    if (last && row === last[1] + 1) last[1] = row
    else runs.push([row, row])
  }
  const text = runs.slice(0, MAX_RUNS).map(([from, to]) => (from === to ? hexDigit(from) : `${hexDigit(from)}–${hexDigit(to)}`))
  return `${text.join(', ')}${runs.length > MAX_RUNS ? ', …' : ''}`
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Milliseconds of `ticks` MIDI clock ticks at `tempo` BPM. */
export const tickMs = (ticks: number, tempo: number): number => (ticks * 60000) / (tempo * CLOCK_PPQ)

const msText = (ms: number): string => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`

/** '24 ticks (4 steps), 500 ms', '30 ms', '4 notes'. */
export function unitsText(units: number, unit: WalkUnit, tempo: number | null): string {
  if (unit === 'note') return plural(units, 'note')
  if (unit === 'fast') return msText(units * FAST_ROW_MS)
  const steps = units % DEFAULT_TICKS === 0 ? ` (${plural(units / DEFAULT_TICKS, 'step')})` : ''
  return `${plural(units, 'tick')}${steps}${tempo ? `, ${msText(tickMs(units, tempo))}` : ''}`
}

/** How fast a table started at `tic` goes. */
export function ticText(tic: number, tempo: number | null): string {
  if (tic === 0) return 'one row each time the instrument is triggered'
  if (tic === 0xff) return 'one row every 5 ms (200 Hz)'
  if (tic === 0xfc) return 'octave map: the octave played picks the row'
  if (tic === 0xfd) return 'velocity map: the velocity played picks the row'
  if (tic === 0xfe) return 'note map: the note played picks the row'
  const perStep =
    tic === DEFAULT_TICKS
      ? 'one row per step'
      : DEFAULT_TICKS % tic === 0
        ? `${DEFAULT_TICKS / tic} rows per step`
        : tic % DEFAULT_TICKS === 0
          ? `one row every ${tic / DEFAULT_TICKS} steps`
          : ''
  const ms      = tempo ? `${msText(tickMs(tic, tempo))} per row` : ''
  return [`one row every ${plural(tic, 'tick')}`, perStep, ms].filter(Boolean).join(', ')
}

/** What a cursor does, in a sentence. */
export function describeWalk(walk: CursorWalk, unit: WalkUnit, tempo: number | null): string {
  const units = (n: number) => unitsText(n, unit, tempo)
  switch (walk.kind) {
    case 'still':
      return 'runs at a TIC of its own that has no rows to time (a map, or 200 Hz)'
    case 'stop': {
      const last = hexDigit(walk.intro[walk.intro.length - 1])
      if (walk.intro.length === 1) return `stays on row ${last}`
      return `plays rows ${rowRuns(walk.intro)} once and stops on row ${last}, ${units(walk.introUnits)} after the note`
    }
    case 'long':
      return `plays rows ${rowRuns(walk.intro)} without repeating soon`
    case 'loop': {
      const loop = `loops rows ${rowRuns(walk.loop)}, ${units(walk.loopUnits)} per pass`
      return walk.intro.length ? `plays rows ${rowRuns(walk.intro)}, then ${loop}` : loop
    }
  }
}

// ---------------------------------------------------------------------------
// Chords

const CHORDS: [pitchClasses: number[], name: string][] = [
  [[0], 'octaves'],
  [[0, 7], 'fifths (power chord)'],
  [[0, 4, 7], 'major chord'],
  [[0, 3, 7], 'minor chord'],
  [[0, 3, 6], 'diminished chord'],
  [[0, 4, 8], 'augmented chord'],
  [[0, 2, 7], 'sus2 chord'],
  [[0, 5, 7], 'sus4 chord'],
  [[0, 4, 7, 11], 'major 7th chord'],
  [[0, 3, 7, 10], 'minor 7th chord'],
  [[0, 4, 7, 10], 'dominant 7th chord'],
  [[0, 3, 6, 10], 'half-diminished 7th chord'],
  [[0, 3, 6, 9], 'diminished 7th chord'],
  [[0, 4, 7, 9], 'major 6th chord'],
  [[0, 3, 7, 9], 'minor 6th chord'],
  [[0, 2, 4, 7], 'add9 chord'],
  [[0, 2, 3, 7], 'minor add9 chord']
]

/** Name of the chord a set of transposes spells over the played note ('minor chord'); null when it is not a known one or leaves out the note itself. */
export function chordName(semitones: number[]): string | null {
  const classes = [...new Set(semitones.map(pitchClass))].sort((a, b) => a - b)
  if (new Set(semitones).size < 2 || classes[0] !== 0) return null
  return CHORDS.find(([chord]) => chord.length === classes.length && chord.every((pc, i) => pc === classes[i]))?.[1] ?? null
}

/** Values in play order, with a value repeated on the next rows written once: '0 +3 +7 +12'. */
export function intervalsText(semitones: number[]): string {
  const shown = semitones.filter((value, i) => i === 0 || value !== semitones[i - 1])
  const text  = shown.slice(0, MAX_INTERVALS).map((value) => (value > 0 ? `+${value}` : `${value}`))
  return `${text.join(' ')}${shown.length > MAX_INTERVALS ? ' …' : ''}`
}

/** The notes `semitones` make over `note` ('C-4 D#4 G-4 C-5'), repeats on the next rows written once; null when `note` is not a note. */
export function arpeggioText(note: string, semitones: number[]): string | null {
  const base = noteNumber(note)
  if (base == null) return null
  const shown = semitones.filter((value, i) => i === 0 || value !== semitones[i - 1])
  const notes = shown.slice(0, MAX_INTERVALS).map((value) => (base + value >= 0 ? noteText(base + value) : '---'))
  return `${notes.join(' ')}${shown.length > MAX_INTERVALS ? ' …' : ''}`
}

// ---------------------------------------------------------------------------
// The song's use of a table

/** A step of the song that starts a table. */
export interface TableUse {
  track: number
  /** Timeline row of the step. */
  row  : number
  tic  : number
  /** Started by a TBX beside the instrument's table. */
  aux  : boolean
  /** The note on the step, if any. */
  note : string | null
}

/** The steps that start table `table`, along the timeline (see stepTables for the rules). */
export function tableUses(model: SongModel, timeline: Timeline, effective: Map<string, (number | null)[]>, table: number): TableUse[] {
  const uses: TableUse[] = []
  for (const instance of timeline.instances) {
    model.phrases[instance.phrase]?.steps.forEach((step, s) => {
      const tables = stepTables(model, step, effective.get(instance.key)?.[s] ?? null)
      for (const [start, aux] of [[tables.primary, false], [tables.aux, true]] as const) {
        if (start?.table === table) uses.push({
          track: instance.track,
          row  : instance.row + s,
          tic  : start.tic,
          aux,
          note : step.note
        })
      }
    })
  }
  return uses
}
