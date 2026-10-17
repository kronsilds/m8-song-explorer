// Grooves: how long each phrase step lasts. A groove lists the ticks each step takes and
// loops at its first '--' row; 00 skips the step. The project GROOVE applies to every track
// until GRV (this track) or GGR (all tracks) changes it. Durations are given in MIDI clock
// ticks (24 per quarter note), so a groove at 48/96/192 PPQ is scaled down to them.
//
// Not yet checked on the device: that the groove restarts at each phrase (step s of a phrase
// uses groove row s modulo the loop), and that GRV / GGR apply from the step they are on.

import { chainLength, type Groove, type PhraseInstance, ROWS_PER_PHRASE, type SongModel, type Timeline, TRACKS } from './song'

/** MIDI clock ticks per quarter note (the M8's default groove resolution too). */
export const CLOCK_PPQ = 24
/** Ticks per step of the default groove (06 06): a sixteenth at 24 PPQ. */
export const DEFAULT_TICKS = 6

/** The ticks a groove loops through: its rows up to the first '--' (the default 06 when there are none). */
export function grooveLoop(groove: Groove | undefined): number[] {
  if (!groove) return [DEFAULT_TICKS]
  const end = groove.ticks.findIndex((t) => t == null)
  const loop = (end === -1 ? groove.ticks : groove.ticks.slice(0, end)) as number[]
  // A groove of nothing but 00 would never move on; the device cannot play it either.
  return loop.length && loop.some((t) => t > 0) ? loop : [DEFAULT_TICKS]
}

/** MIDI clock ticks phrase step `step` (0-15) takes under a groove; 0 for a skipped step. */
export function stepClockTicks(groove: Groove | undefined, step: number): number {
  const loop = grooveLoop(groove)
  const ppq = groove?.ppq && groove.ppq > 0 ? groove.ppq : CLOCK_PPQ
  return (loop[step % loop.length] * CLOCK_PPQ) / ppq
}

/** True when a groove plays every step as a plain sixteenth. */
export function isStraight(groove: Groove | undefined): boolean {
  for (let s = 0; s < ROWS_PER_PHRASE; s += 1) if (stepClockTicks(groove, s) !== DEFAULT_TICKS) return false
  return true
}

/** Grooves the song plays with: the project's and the ones GRV / GGR point at, sorted. */
export function referencedGrooves(model: SongModel): number[] {
  const out = new Set<number>([model.projectGroove ?? 0])
  for (const phrase of Object.values(model.phrases)) {
    for (const step of phrase.steps) for (const f of step.fx) if ((f.cmd === 'GRV' || f.cmd === 'GGR') && f.val != null) out.add(f.val)
  }
  return [...out].sort((a, b) => a - b)
}

/** Key of one chain occurrence: a track's cell on a song row. */
export const occurrenceKey = (track: number, songRow: number): string => `${track}:${songRow}`

/**
 * Clock ticks of every step of every chain occurrence, keyed by occurrenceKey (one entry
 * per chain step, chainLength x 16). The groove in force follows the song down the timeline:
 * a GRV changes its own track, a GGR every track, from the timeline row it is on.
 */
export function chainStepTicks(model: SongModel, timeline: Timeline): Map<string, number[]> {
  const grooves = model.grooves ?? {}
  // GRV / GGR events in timeline order.
  const events: { row: number; track: number; global: boolean; groove: number }[] = []
  for (const inst of timeline.instances) {
    model.phrases[inst.phrase]?.steps.forEach((step, s) => {
      for (const f of step.fx) {
        if ((f.cmd === 'GRV' || f.cmd === 'GGR') && f.val != null) events.push({ row: inst.row + s, track: inst.track, global: f.cmd === 'GGR', groove: f.val })
      }
    })
  }
  events.sort((a, b) => a.row - b.row || a.track - b.track)

  const out = new Map<string, number[]>()
  for (let track = 0; track < TRACKS; track += 1) {
    let current = model.projectGroove ?? 0
    let next = 0
    const byRow = new Map<number, PhraseInstance[]>()
    for (const inst of timeline.byTrack[track]) byRow.set(inst.songRow, [...(byRow.get(inst.songRow) ?? []), inst])
    for (const band of timeline.bands) {
      const chainId = band.chains[track]
      if (chainId == null) continue
      const length = chainLength(model.chains[chainId]) * ROWS_PER_PHRASE
      const ticks: number[] = Array(length).fill(DEFAULT_TICKS)
      for (const inst of byRow.get(band.songRow) ?? []) {
        for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
          const row = inst.row + s
          while (next < events.length && events[next].row <= row) {
            const e = events[next]
            if (e.global || e.track === track) current = e.groove
            next += 1
          }
          ticks[inst.chainRow * ROWS_PER_PHRASE + s] = stepClockTicks(grooves[current], s)
        }
      }
      out.set(occurrenceKey(track, band.songRow), ticks)
    }
  }
  return out
}
