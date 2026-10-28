// Grooves: how long each phrase step lasts. A groove lists the ticks each step takes and
// loops at its first '--' row; 00 skips the step. The project GROOVE applies to every track
// until GRV (this track) or GGR (all tracks) changes it. Durations are given in MIDI clock
// ticks (24 per quarter note), so a groove at 48/96/192 PPQ is scaled down to them.
//
// Device (fw 6.5, GEN_INTERMIS): a GRV sets the length of its own step already, and a step a
// phrase HOP skips plays no GRV. Not yet checked on the device: that the groove restarts at each
// phrase (step s of a phrase uses groove row s modulo the loop), and how a GGR times in.

import { chainLength, type FxCell, fxValues, type Groove, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../song'
import type { PhraseInstance, Timeline } from '../timeline'
import { type HopCounts, hopsKey, NO_HOPS, type Place, PlayPath, type Run } from './playPath'

/** MIDI clock ticks per quarter note (the M8's default groove resolution too). */
export const CLOCK_PPQ     = 24
/** Ticks per step of the default groove (06 06): a sixteenth at 24 PPQ. */
export const DEFAULT_TICKS = 6

const GROOVE_COMMANDS      = ['GRV', 'GGR']

/** The ticks a groove loops through: its rows up to the first '--' (the default 06 when there are none). */
export function grooveLoop(groove: Groove | undefined): number[] {
  if (!groove) return [DEFAULT_TICKS]
  const end  = groove.ticks.findIndex((ticks) => ticks == null)
  const loop = (end === -1 ? groove.ticks : groove.ticks.slice(0, end)) as number[]
  // A groove of nothing but 00 would never move on; the device cannot play it either.
  return loop.length && loop.some((ticks) => ticks > 0) ? loop : [DEFAULT_TICKS]
}

/** MIDI clock ticks phrase step `step` (0-15) takes under a groove; 0 for a skipped step. */
export function stepClockTicks(groove: Groove | undefined, step: number): number {
  const loop = grooveLoop(groove)
  const ppq  = groove?.ppq && groove.ppq > 0 ? groove.ppq : CLOCK_PPQ
  return (loop[step % loop.length] * CLOCK_PPQ) / ppq
}

/** Grooves the song plays with: the project's and the ones GRV / GGR point at (phrases only), sorted. */
export function referencedGrooves(model: SongModel): number[] {
  const grooves = new Set<number>([model.projectGroove ?? 0])
  for (const phrase of Object.values(model.phrases)) {
    for (const step of phrase.steps) for (const groove of fxValues(step.fx, ...GROOVE_COMMANDS)) grooves.add(groove)
  }
  return [...grooves].sort((a, b) => a - b)
}

/** What a groove does to the sixteenths, for the debug log. */
export interface GrooveReport {
  id      : number
  /** Clock ticks of the steps the groove loops through (6 6 is the plain sixteenth). */
  loop    : number[]
  ppq     : number | null
  /** Every step lasts the default 6 clock ticks. */
  standard: boolean
  /** False when the groove was never read (the default is assumed). */
  read    : boolean
  /** 'project' (the project GROOVE), 'GRV' (a track), 'GGR' (all tracks). */
  usedBy  : string[]
}

/** The grooves the song plays with, which are not plain 6-6 sixteenths, and what points at them. */
export function grooveReports(model: SongModel): GrooveReport[] {
  const usedBy = new Map<number, Set<string>>()
  const use    = (groove: number, by: string) => usedBy.set(groove, (usedBy.get(groove) ?? new Set<string>()).add(by))
  use(model.projectGroove ?? 0, 'project')
  for (const phrase of Object.values(model.phrases)) {
    for (const step of phrase.steps) for (const command of GROOVE_COMMANDS) for (const groove of fxValues(step.fx, command)) use(groove, command)
  }
  return [...usedBy.keys()]
    .sort((a, b) => a - b)
    .map((id) => {
      const groove = model.grooves?.[id]
      const loop   = grooveLoop(groove).map((_, step) => stepClockTicks(groove, step))
      return {
        id,
        loop,
        ppq     : groove?.ppq ?? null,
        standard: loop.every((ticks) => ticks === DEFAULT_TICKS),
        read    : groove != null,
        usedBy  : [...(usedBy.get(id) as Set<string>)]
      }
    })
}

/** How the steps of one chain occurrence differ from the plain sixteenth. */
export interface TicksSummary {
  steps      : number
  /** Steps that do not last 6 clock ticks. */
  nonStandard: number
  /** The different step lengths, ascending (at most 8). */
  distinct   : number[]
}

export function summarizeTicks(ticks: number[]): TicksSummary {
  return {
    steps      : ticks.length,
    nonStandard: ticks.filter((t) => t !== DEFAULT_TICKS).length,
    distinct   : [...new Set(ticks)].sort((a, b) => a - b).slice(0, 8)
  }
}

/** Key of one chain occurrence: a track's cell on a song row. */
export const occurrenceKey = (track: number, songRow: number): string => `${track}:${songRow}`

interface GrooveChange {
  row   : number
  track : number
  /** GGR: every track. */
  global: boolean
  groove: number
}

/** GRV / GGR commands in timeline order. */
function grooveChanges(model: SongModel, timeline: Timeline): GrooveChange[] {
  const changes: GrooveChange[] = []
  for (const instance of timeline.instances) {
    model.phrases[instance.phrase]?.steps.forEach((step, s) => {
      for (const fx of step.fx) {
        if (fx.cmd != null && GROOVE_COMMANDS.includes(fx.cmd) && fx.val != null) {
          changes.push({
            row   : instance.row + s,
            track : instance.track,
            global: fx.cmd === 'GGR',
            groove: fx.val
          })
        }
      }
    })
  }
  return changes.sort((a, b) => a.row - b.row || a.track - b.track)
}

/**
 * Clock ticks of every step of every chain occurrence, keyed by occurrenceKey (one entry per
 * chain step, chainLength x 16). The groove in force follows the song as it plays: from the
 * first row of each block, the tracks walk their steps side by side in time, along their phrase
 * HOPs and chain ends (PlayPath), so a GRV changes its own track and a GGR every track from the
 * step it is on (device: the GRV's own step already plays with it), and a step a HOP skips
 * changes nothing. A step keeps the groove it first plays with; a step the walk never reaches
 * keeps the one in force down the timeline.
 */
export function chainStepTicks(model: SongModel, timeline: Timeline): Map<string, number[]> {
  const ticksByOccurrence = timelineStepTicks(model, timeline)
  const reached           = new Set<string>()
  const path              = new PlayPath(model)
  for (const band of timeline.bands) {
    if (band.blank || band.row !== band.block) continue
    walkGrooves(model, path, band.songRow, ticksByOccurrence, reached)
  }
  return ticksByOccurrence
}

/**
 * True when the FX in lane `lane` of a step is more likely to play than not: a CHA XY on the step
 * plays the FX left of it X times in 15 and the FX right of it Y times (device: GRV 01 right of
 * CHA F0 never played, right of CHA FF always). A chance of 8 in 15 or more counts as playing.
 */
function playsLikely(fx: FxCell[], lane: number): boolean {
  const cha = fx.findIndex((cell) => cell.cmd === 'CHA' && cell.val != null)
  if (cha < 0 || cha === lane) return true
  const chance = lane < cha ? (fx[cha].val as number) >> 4 : (fx[cha].val as number) & 0x0f
  return chance >= LIKELY_CHANCE
}

/** Fifteenths from which a CHA counts as playing its FX (see playsLikely). */
const LIKELY_CHANCE = 8

/** Steps walked from one block's start, all tracks together, before giving up on seeing each loop round. */
const MAX_WALKED_STEPS = 50000
/** Steps of no time in a row (a groove of 00s) before a track counts as stuck. */
const MAX_SKIPPED_RUN  = 64

interface GrooveWalker {
  track  : number
  place  : Place
  hops   : HopCounts
  run    : Run
  /** Clock tick the current step starts at. */
  at     : number
  groove : number
  skipped: number
  /** State at the start of each run seen so far: the same again is the track going round its loop. */
  seen   : Set<string>
  done   : boolean
}

/** Walks the tracks from song row `startRow` on, writing the step lengths of the steps first reached (see chainStepTicks). */
function walkGrooves(model: SongModel, path: PlayPath, startRow: number, ticksByOccurrence: Map<string, number[]>, reached: Set<string>): void {
  const grooves = model.grooves ?? {}
  const walkers : GrooveWalker[] = []
  for (let track = 0; track < TRACKS; track += 1) {
    if (model.song[startRow]?.[track] == null) continue
    const place = {
      songRow: startRow,
      step   : 0
    }
    walkers.push({
      track,
      place,
      hops   : NO_HOPS,
      run    : path.run(track, place, NO_HOPS, false),
      at     : 0,
      groove : model.projectGroove ?? 0,
      skipped: 0,
      seen   : new Set(),
      done   : false
    })
  }
  for (let walked = 0; walked < MAX_WALKED_STEPS; walked += 1) {
    let walker: GrooveWalker | null = null
    for (const w of walkers) if (!w.done && (!walker || w.at < walker.at)) walker = w
    if (!walker) return
    const { track, place } = walker
    const chainId          = model.song[place.songRow]?.[track]
    const chainRow         = Math.floor(place.step / ROWS_PER_PHRASE)
    const s                = place.step % ROWS_PER_PHRASE
    const step             = chainId == null ? undefined : model.phrases[model.chains[chainId]?.rows[chainRow]?.phrase ?? -1]?.steps[s]
    // The step's own GRV / GGR already set its length, unless a CHA on the step leaves it out.
    step?.fx.forEach((fx, lane) => {
      if (fx.val == null || !playsLikely(step.fx, lane)) return
      if (fx.cmd === 'GRV') walker.groove = fx.val
      if (fx.cmd === 'GGR') for (const w of walkers) w.groove = fx.val
    })
    const length = stepClockTicks(grooves[walker.groove], s)
    const key    = `${track}:${place.songRow}:${place.step}`
    const ticks  = ticksByOccurrence.get(occurrenceKey(track, place.songRow))
    if (!reached.has(key) && ticks && place.step < ticks.length) {
      ticks[place.step] = length
      reached.add(key)
    }
    walker.at      += length
    walker.skipped = length > 0 ? 0 : walker.skipped + 1
    if (walker.skipped > MAX_SKIPPED_RUN) walker.done = true
    // On to the next step: the next of the run, or where its end sends the track.
    if (place.step < walker.run.last) {
      walker.place = {
        songRow: place.songRow,
        step   : place.step + 1
      }
      continue
    }
    const next   = walker.run.next
    if (!next) {
      walker.done = true
      continue
    }
    const state  = `${next.songRow}:${next.step}|${hopsKey(walker.run.hops)}|${walker.groove}`
    if (walker.seen.has(state)) walker.done = true
    walker.seen.add(state)
    walker.place = next
    walker.hops  = walker.run.hops
    walker.run   = path.run(track, next, walker.hops, false)
  }
}

/** The step lengths with the groove in force down the timeline: a GRV changes its own track, a GGR every track, from the timeline row it is on. */
function timelineStepTicks(model: SongModel, timeline: Timeline): Map<string, number[]> {
  const grooves           = model.grooves ?? {}
  const changes           = grooveChanges(model, timeline)
  const ticksByOccurrence = new Map<string, number[]>()
  for (let track = 0; track < TRACKS; track += 1) {
    let grooveInForce        = model.projectGroove ?? 0
    let nextChange           = 0
    const instancesBySongRow = new Map<number, PhraseInstance[]>()
    for (const instance of timeline.byTrack[track]) {
      instancesBySongRow.set(instance.songRow, [...(instancesBySongRow.get(instance.songRow) ?? []), instance])
    }
    for (const band of timeline.bands) {
      const chainId = band.chains[track]
      if (chainId == null) continue
      const ticks: number[] = Array(chainLength(model.chains[chainId]) * ROWS_PER_PHRASE).fill(DEFAULT_TICKS)
      for (const instance of instancesBySongRow.get(band.songRow) ?? []) {
        for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
          const row = instance.row + s
          while (nextChange < changes.length && changes[nextChange].row <= row) {
            const change = changes[nextChange]
            if (change.global || change.track === track) grooveInForce = change.groove
            nextChange += 1
          }
          ticks[instance.chainRow * ROWS_PER_PHRASE + s] = stepClockTicks(grooves[grooveInForce], s)
        }
      }
      ticksByOccurrence.set(occurrenceKey(track, band.songRow), ticks)
    }
  }
  return ticksByOccurrence
}
