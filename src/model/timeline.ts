// The song unrolled step by step, the way the 3D view shows it: every phrase at each place
// it plays, song rows as bands of timeline rows, and the instrument in force at each step.

import { chainLength, lastSongRow, ROWS_PER_PHRASE, type SongModel, TRACKS } from './song'

/** One phrase as it is played at one place of the song. */
export interface PhraseInstance {
  /** Unique per place: 'track:songRow:chainRow'. */
  key     : string
  track   : number
  songRow : number
  chain   : number
  chainRow: number
  phrase  : number
  /** First timeline row of this instance. */
  row     : number
}

/** A song row: the timeline rows it spans (the longest chain on that row). */
export interface SongBand {
  songRow: number
  /** First timeline row. */
  row    : number
  /** Timeline rows it spans. */
  length : number
  /** Chain per track, null for an empty cell. */
  chains : (number | null)[]
}

export interface Timeline {
  bands    : SongBand[]
  instances: PhraseInstance[]
  /** Instances per track, sorted by row. */
  byTrack  : PhraseInstance[][]
  /** Instances of each phrase number. */
  byPhrase : Map<number, PhraseInstance[]>
  totalRows: number
}

/** Rows an empty song row takes, so it still shows as a gap. */
const EMPTY_BAND_ROWS = 1

export function buildTimeline(model: SongModel): Timeline {
  const bands     : SongBand[] = []
  const instances : PhraseInstance[] = []
  const byTrack   : PhraseInstance[][] = Array.from({ length: TRACKS }, () => [])
  const byPhrase  = new Map<number, PhraseInstance[]>()
  const lastRow   = lastSongRow(model)
  let bandRow     = 0
  for (let songRow = 0; songRow <= lastRow; songRow += 1) {
    const chains     = Array.from({ length: TRACKS }, (_, track) => model.song[songRow]?.[track] ?? null)
    let longestChain = 0
    chains.forEach((chainId, track) => {
      if (chainId == null) return
      const chain   = model.chains[chainId]
      const phrases = chainLength(chain)
      longestChain  = Math.max(longestChain, phrases)
      for (let chainRow = 0; chainRow < phrases; chainRow += 1) {
        const phrase = chain?.rows[chainRow]?.phrase
        if (phrase == null) continue
        const instance: PhraseInstance = {
          key  : `${track}:${songRow}:${chainRow}`,
          track,
          songRow,
          chain: chainId,
          chainRow,
          phrase,
          row  : bandRow + chainRow * ROWS_PER_PHRASE
        }
        instances.push(instance)
        byTrack[track].push(instance)
        byPhrase.set(phrase, [...(byPhrase.get(phrase) ?? []), instance])
      }
    })
    const length = longestChain > 0 ? longestChain * ROWS_PER_PHRASE : EMPTY_BAND_ROWS
    bands.push({
      songRow,
      row: bandRow,
      length,
      chains
    })
    bandRow += length
  }
  return {
    bands,
    instances,
    byTrack,
    byPhrase,
    totalRows: bandRow
  }
}

/** The instance of a track covering a timeline row, if any. */
export function instanceAt(timeline: Timeline, track: number, row: number): PhraseInstance | null {
  const instances = timeline.byTrack[track] ?? []
  let low         = 0
  let high        = instances.length - 1
  while (low <= high) {
    const middle   = (low + high) >> 1
    const instance = instances[middle]
    if (row < instance.row) high = middle - 1
    else if (row >= instance.row + ROWS_PER_PHRASE) low = middle + 1
    else return instance
  }
  return null
}

/**
 * Instrument each step plays: the I column, or the last one set earlier on the track
 * ('--' keeps the current instrument). Keyed by instance key, 16 entries each.
 */
export function effectiveInstruments(model: SongModel, timeline: Timeline): Map<string, (number | null)[]> {
  const byInstance = new Map<string, (number | null)[]>()
  for (const instances of timeline.byTrack) {
    let current: number | null = null
    for (const instance of instances) {
      const steps   = model.phrases[instance.phrase]?.steps ?? []
      const perStep : (number | null)[] = []
      for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
        const step = steps[s]
        if (step?.inst != null) current = step.inst
        const insCommand = step?.fx.find((fx) => fx.cmd === 'INS' && fx.val != null)
        if (insCommand?.val != null) current = insCommand.val
        perStep.push(current)
      }
      byInstance.set(instance.key, perStep)
    }
  }
  return byInstance
}
