// Coarse cursor moves over the unrolled timeline: a whole phrase up or down a track, or the
// same cell in the next track. Pure functions of the phrase instances, no scene needed.

import { ROWS_PER_PHRASE } from './song'
import type { PhraseInstance } from './timeline'

/** A step cell without its column: where in the timeline the cursor is. */
export interface StepPlace {
  instance: PhraseInstance
  step    : number
}

/** Moves one phrase up (-1) or down (+1) its track, on the same step; at either end of the track it goes to the first or last step of the end phrase. */
export function phraseMoved(instances: PhraseInstance[], from: StepPlace, direction: number): StepPlace {
  const sorted = [...instances].sort((a, b) => a.row - b.row)
  const index  = sorted.findIndex((instance) => instance.key === from.instance.key)
  const next   = sorted[index + Math.sign(direction)]
  if (index < 0 || !next) {
    const atStart = direction < 0
    return {
      instance: from.instance,
      step    : atStart ? 0 : ROWS_PER_PHRASE - 1
    }
  }
  return {
    instance: next,
    step    : from.step
  }
}

/**
 * Moves to the same timeline row in the next (+1) or previous (-1) track. Where that track
 * has no phrase on the row, the nearest phrase takes it, on its closest step. Null when
 * there is no such track or it holds no phrase.
 */
export function trackMoved(tracks: PhraseInstance[][], from: StepPlace, direction: number): StepPlace | null {
  const track = from.instance.track + Math.sign(direction)
  if (track < 0 || track >= tracks.length) return null
  const row        = from.instance.row + from.step
  let best         : PhraseInstance | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const instance of tracks[track]) {
    const distance = row < instance.row ? instance.row - row : Math.max(0, row - (instance.row + ROWS_PER_PHRASE - 1))
    if (distance < bestDistance) [best, bestDistance] = [instance, distance]
  }
  if (!best) return null
  return {
    instance: best,
    step    : Math.min(ROWS_PER_PHRASE - 1, Math.max(0, row - best.row))
  }
}
