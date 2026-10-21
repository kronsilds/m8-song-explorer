// Grooves: how long each phrase step lasts. A groove lists the ticks each step takes and
// loops at its first '--' row; 00 skips the step. The project GROOVE applies to every track
// until GRV (this track) or GGR (all tracks) changes it. Durations are given in MIDI clock
// ticks (24 per quarter note), so a groove at 48/96/192 PPQ is scaled down to them.
//
// Not yet checked on the device: that the groove restarts at each phrase (step s of a phrase
// uses groove row s modulo the loop), and that GRV / GGR apply from the step they are on.

import { chainLength, fxValues, type Groove, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../song'
import type { PhraseInstance, Timeline } from '../timeline'

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
 * Clock ticks of every step of every chain occurrence, keyed by occurrenceKey (one entry
 * per chain step, chainLength x 16). The groove in force follows the song down the timeline:
 * a GRV changes its own track, a GGR every track, from the timeline row it is on.
 */
export function chainStepTicks(model: SongModel, timeline: Timeline): Map<string, number[]> {
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
