// How each track moves through the song, in clock ticks: every step lasts what its groove gives it
// (see chainStepTicks), a chain ends where PlayPath says (its last phrase, a HOP), a counted HOP
// goes back so many times, HOP FF stops the track, and a track may loop one phrase (Play on a
// Phrase view plays that phrase alone). The playback tracker measures on the device where each
// track is; this says where it goes from there.

import { ROWS_PER_PHRASE } from '../song'
import type { SongContext } from '../songContext'
import { chainStepTicks, DEFAULT_TICKS, occurrenceKey } from './groove'
import { type HopCounts, hopsKey, type Place, PlayPath, type Run } from './playPath'

/** Walks through at most this many runs of steps (a chain, or up to a HOP) when moving a track on or measuring between steps. */
const MAX_CHAIN_WALK = 512
const MAX_RUNS_AHEAD = 64

/** Step lengths of one chain occurrence in clock ticks, and where each step starts (one more entry: the total). */
export interface ChainTicks {
  steps : number[]
  starts: number[]
}

/** A track playing one phrase over and over: the one at `chainRow` of its chain on `songRow`. */
export interface PhraseLoop {
  songRow : number
  chainRow: number
}

/** Where a walk starts: a step of a song row's chain, with the track's state there. */
export interface WalkStart {
  songRow : number
  /** Steps into the song row's chain. */
  step    : number
  /** The counted HOPs the track has hopped at (see PlayPath). */
  hops    : HopCounts
  /** Steps started since playing began, this one included: a step played again counts again. */
  serial  : number
  /** Reached by moving on (a start), not read on screen: a HOP on its step hops rather than plays. */
  reached?: boolean
}

/** Where a walk got to. */
export interface Walked {
  songRow: number
  step   : number
  /** How far into the step, 0 to 1. */
  phase  : number
  /** A HOP FF stopped the track. */
  stopped: boolean
  /** Clock ticks from the start step's start to this step's start. */
  offset : number
  serial : number
  hops   : HopCounts
}

/** One time a track reaches a step ahead: clock ticks to it, and the track's state there. */
export interface Reached {
  ticks : number
  hops  : HopCounts
  serial: number
}

function withStarts(steps: number[]): ChainTicks {
  const starts = [0]
  for (const ticks of steps) starts.push(starts[starts.length - 1] + ticks)
  return { steps, starts }
}

/** Ticks from the chain start to the start of `step` (the chain's total past its end). */
const startOf = (chain: ChainTicks, step: number): number => chain.starts[Math.max(0, Math.min(step, chain.steps.length))]

/** Steps from `from` to `to` (both included) that start, a skipped step (no ticks) aside. */
function startsIn(chain: ChainTicks, from: number, to: number): number {
  let count = 0
  for (let step = Math.max(0, from); step <= to && step < chain.steps.length; step += 1) if (chain.steps[step] > 0) count += 1
  return count
}

export class SongWalk {
  /** Step lengths of every chain occurrence, from the grooves (see chainStepTicks). */
  private readonly ticksByOccurrence = new Map<string, ChainTicks>()
  /** Where the tracks go: chain ends and phrase HOPs. */
  private readonly path              : PlayPath

  constructor(private readonly song: SongContext) {
    this.path = new PlayPath(song.model)
    for (const [key, steps] of chainStepTicks(song.model, song.timeline)) this.ticksByOccurrence.set(key, withStarts(steps))
  }

  /** Step lengths of the chain a track plays on a song row; null for an empty cell. */
  chainTicks(songRow: number, track: number): ChainTicks | null {
    if (this.song.model.song[songRow]?.[track] == null) return null
    // Rows the timeline does not have yet (read after it was built) play the default groove.
    return this.ticksByOccurrence.get(occurrenceKey(track, songRow)) ?? withStarts(Array(this.chainSteps(songRow, track)).fill(DEFAULT_TICKS))
  }

  /** Clock ticks the whole chain a track plays on a song row lasts; 0 for an empty cell. */
  chainLength(songRow: number, track: number): number {
    const chain = this.chainTicks(songRow, track)
    return chain ? startOf(chain, chain.steps.length) : 0
  }

  /** Steps the chain a track plays on a song row has (up to its first empty row). */
  chainSteps(songRow: number, track: number): number {
    return this.path.chainSteps(songRow, track)
  }

  /** How long a step lasts, in clock ticks (a skipped step counts as a default one where a length is needed). */
  stepTicks(songRow: number, track: number, step: number): number {
    return this.chainTicks(songRow, track)?.steps[step] || DEFAULT_TICKS
  }

  /** How long phrase `chainRow` of a track's chain lasts, in clock ticks. */
  phraseTicks(songRow: number, track: number, chainRow: number): number {
    const chain = this.chainTicks(songRow, track)
    const ticks = chain ? startOf(chain, (chainRow + 1) * ROWS_PER_PHRASE) - startOf(chain, chainRow * ROWS_PER_PHRASE) : 0
    return ticks || DEFAULT_TICKS * ROWS_PER_PHRASE
  }

  /** The phrase at `chainRow` of a track's chain on `songRow`, null when there is none. */
  phraseAt(songRow: number, track: number, chainRow: number): number | null {
    const { model } = this.song
    const chainId   = model.song[songRow]?.[track]
    return chainId == null ? null : (model.chains[chainId]?.rows[chainRow]?.phrase ?? null)
  }

  /** The song row a track goes on to after `row` (see PlayPath.nextRow). */
  nextRow(row: number, track: number): number {
    return this.path.nextRow(row, track)
  }

  /** The step a track enters `toRow` on, coming from `fromRow` (see PlayPath.entryStep). */
  entryStep(track: number, fromRow: number, toRow: number): number {
    return this.path.entryStep(track, fromRow, toRow)
  }

  /** The run of steps from `place` on (see PlayPath.run), into the phrase the track loops (`loop`) if it reaches it. */
  private run(track: number, place: Place, hops: HopCounts, playing: boolean, loop: PhraseLoop | null): Run {
    const first = loop?.songRow === place.songRow ? loop.chainRow * ROWS_PER_PHRASE : null
    if (loop && first != null && place.step >= first && place.step < first + ROWS_PER_PHRASE) return this.path.run(track, place, hops, playing, loop.chainRow)
    const run = this.path.run(track, place, hops, playing)
    // A run that reaches the looped phrase goes into it.
    if (first != null && place.step < first && run.last >= first) return {
      last: first - 1,
      next: {
        songRow: place.songRow,
        step   : first
      },
      hops: this.path.passed(track, place, hops, first - 1)
    }
    return run
  }

  /**
   * Where a track is `ticks` after the start of `from`'s step, walking its steps' ticks past HOPs
   * (taking their counts) and chain ends, into the phrase it loops (`loop`); `stopped` once a HOP FF
   * ended the track. A loop (a chain looping on itself, HOPs back) is gone round as many whole
   * times as fit, not step by step.
   */
  walk(track: number, from: WalkStart, ticks: number, loop: PhraseLoop | null): Walked {
    let place : Place = {
      songRow: from.songRow,
      step   : from.step
    }
    let hops  = from.hops
    let chain = this.chainTicks(place.songRow, track)
    if (!chain) return {
      ...place,
      phase  : 0,
      stopped: false,
      offset : 0,
      serial : from.serial,
      hops
    }
    // Ticks to go from the start of the place's step, ticks walked to it, steps started before it.
    let left   = ticks
    let walked = 0
    let serial = from.serial - 1
    let run    = this.run(track, place, hops, !from.reached, loop)
    const seen = new Map<string, { walked: number; serial: number }>()
    for (let runs = 0; runs < MAX_CHAIN_WALK; runs += 1) {
      const room = startOf(chain, run.last + 1) - startOf(chain, place.step)
      if (left < room) break
      // HOP FF: stopped on its step.
      if (!run.next) return {
        songRow: place.songRow,
        step   : run.last + 1,
        phase  : 0,
        stopped: true,
        offset : walked + room,
        serial : serial + startsIn(chain, place.step, run.last),
        hops   : run.hops
      }
      const next = this.chainTicks(run.next.songRow, track)
      if (!next) break
      left         -= room
      walked       += room
      serial       += startsIn(chain, place.step, run.last)
      place        = run.next
      hops         = run.hops
      chain        = next
      // The same place with the same hops taken: the track goes round a loop, every whole turn of it alike.
      const key    = `${place.songRow}:${place.step}|${hopsKey(hops)}`
      const before = seen.get(key)
      if (before) {
        const turn = walked - before.walked
        if (turn > 0 && left >= turn) {
          const turns = Math.floor(left / turn)
          left        -= turns * turn
          walked      += turns * turn
          serial      += turns * (serial - before.serial)
        }
        seen.clear()
      }
      seen.set(key, {
        walked,
        serial
      })
      run = this.run(track, place, hops, false, loop)
    }
    // The step whose span holds the position (a skipped step has none), within the run.
    const end      = startOf(chain, run.last + 1)
    const position = Math.min(startOf(chain, place.step) + left, end - 1e-6)
    let step       = Math.min(place.step, chain.steps.length - 1)
    while (step < chain.steps.length - 1 && chain.starts[step + 1] <= position) step += 1
    const length = chain.steps[step]
    const phase  = length > 0 ? Math.min(0.999, Math.max(0, (position - chain.starts[step]) / length)) : 0
    return {
      songRow: place.songRow,
      step,
      phase,
      stopped: false,
      offset : walked + chain.starts[step] - startOf(chain, place.step),
      serial : serial + startsIn(chain, place.step, step),
      hops   : this.path.passed(track, place, hops, step)
    }
  }

  /** Each time, in order, a track reaches (toRow, toStep) from `from`'s step on, within a few runs. */
  *reaches(track: number, from: WalkStart, toRow: number, toStep: number, loop: PhraseLoop | null): Generator<Reached> {
    let place   : Place = {
      songRow: from.songRow,
      step   : from.step
    }
    let hops    = from.hops
    let total   = 0
    let serial  = from.serial - 1
    let playing = !from.reached
    for (let runs = 0; runs < MAX_RUNS_AHEAD; runs += 1) {
      const chain = this.chainTicks(place.songRow, track)
      if (!chain) return
      const run   = this.run(track, place, hops, playing, loop)
      if (place.songRow === toRow && toStep >= place.step && toStep <= run.last) yield {
        ticks : total + startOf(chain, toStep) - startOf(chain, place.step),
        hops  : this.path.passed(track, place, hops, toStep),
        serial: serial + startsIn(chain, place.step, toStep)
      }
      total  += startOf(chain, run.last + 1) - startOf(chain, place.step)
      serial += startsIn(chain, place.step, run.last)
      if (!run.next) return
      place   = run.next
      hops    = run.hops
      playing = false
    }
  }

  /** True when (toRow, toStep) is the step a track plays right after `from`'s, skipped steps aside. */
  follows(track: number, from: WalkStart, toRow: number, toStep: number, loop: PhraseLoop | null): boolean {
    const length = this.chainTicks(from.songRow, track)?.steps[from.step] ?? 0
    for (const reached of this.reaches(track, from, toRow, toStep, loop)) return length > 0 && Math.abs(reached.ticks - length) < 1e-6
    return false
  }
}
