// Where a track goes next along its chains: through its phrases to the chain's end, then to the
// next song row (back to the start of its run at an empty cell), unless a phrase HOP sends it on.
//
// A HOP XY in a phrase, as the track reaches the HOP's step (device, fw 6.5, GEN_INTERMIS and a
// test song, 2026-10-28/29):
// - HOP 0Y goes on at row Y of the next phrase, as the song would go on: the chain's next phrase,
//   or after its last phrase the next song row's chain (back to the start of the run at an empty
//   cell). The HOP's step never plays.
// - HOP XY with X > 0 goes back to row Y of its own phrase, X times; then the HOP's step plays like
//   any other and the phrase runs on, and the next time the track reaches it the count starts
//   over (HOP 32 on step 3 played step 2 four times on every pass; HOP 14 in a chain's first
//   phrase stayed in that phrase).
// - HOP FF stops the track.

import { chainLength, fxValues, ROWS_PER_PHRASE, type SongModel } from '../song'

/** HOP FF stops the track. */
export const HOP_STOP = 0xff
/** Runs followed through a song row to find where a track leaves it. */
const MAX_ENTRY_RUNS  = 64

/** A step of the chain a track plays on a song row. */
export interface Place {
  songRow: number
  step   : number
}

/** Hops taken so far at each counted HOP (X > 0), keyed 'songRow:step'; a HOP whose step plays leaves it. */
export type HopCounts = ReadonlyMap<string, number>

export const NO_HOPS: HopCounts = new Map()

/** Two equal keys: the same hops taken. */
export const hopsKey = (hops: HopCounts): string =>
  [...hops]
    .map(([key, count]) => `${key}=${count}`)
    .sort()
    .join(',')

/** A run of steps from a place to `last`, then on to `next` (null: a HOP FF stops the track there). */
export interface Run {
  last: number
  next: Place | null
  /** The hops taken at the end of the run. */
  hops: HopCounts
}

const placeKey = (songRow: number, step: number): string => `${songRow}:${step}`

function withCount(hops: HopCounts, key: string, count: number | null): HopCounts {
  const out = new Map(hops)
  if (count == null) out.delete(key)
  else out.set(key, count)
  return out
}

export class PlayPath {
  /** The HOPs of each chain: [chain step, value], by step. */
  private readonly hopsByChain = new Map<number, [step: number, value: number][]>()

  constructor(private readonly model: SongModel) {}

  /** Steps of the chain a track plays on a song row (0 for an empty cell). */
  chainSteps(songRow: number, track: number): number {
    const chainId = this.model.song[songRow]?.[track]
    return (chainId == null ? 0 : chainLength(this.model.chains[chainId])) * ROWS_PER_PHRASE
  }

  /** The row a track goes to after `row`: the next one, or back to the start of its run at an empty cell. */
  nextRow(row: number, track: number): number {
    const chainAt = (songRow: number) => this.model.song[songRow]?.[track] ?? null
    if (chainAt(row + 1) != null) return row + 1
    let runStart = row
    while (runStart > 0 && chainAt(runStart - 1) != null) runStart -= 1
    return runStart
  }

  /** The HOPs in the phrases a chain plays, by chain step (the first HOP of a step counts). */
  hops(chainId: number): [step: number, value: number][] {
    const known = this.hopsByChain.get(chainId)
    if (known) return known
    const chain = this.model.chains[chainId]
    const hops  : [number, number][] = []
    for (let chainRow = 0; chain && chainRow < chainLength(chain); chainRow += 1) {
      this.model.phrases[chain.rows[chainRow]?.phrase ?? -1]?.steps.forEach((step, s) => {
        const [value] = fxValues(step.fx, 'HOP')
        if (value != null) hops.push([chainRow * ROWS_PER_PHRASE + s, value])
      })
    }
    this.hopsByChain.set(chainId, hops)
    return hops
  }

  /**
   * The run of steps from `place` on: up to the first HOP that hops, else to the chain's end (with
   * `loop`, the end of the phrase at that chain row, played over and over; a HOP Y in it is taken
   * as going to its own row Y, not checked on the device). `playing` says the place's own step is
   * known to play (a reading of the screen): a HOP there plays rather than hops.
   */
  run(track: number, place: Place, hops: HopCounts, playing: boolean, loop: number | null = null): Run {
    const chainId = this.model.song[place.songRow]?.[track]
    const steps   = this.chainSteps(place.songRow, track)
    const first   = loop == null ? 0 : loop * ROWS_PER_PHRASE
    const after   = loop == null ? steps : Math.min(first + ROWS_PER_PHRASE, steps)
    let taken     = hops
    for (const [at, value] of chainId == null ? [] : this.hops(chainId)) {
      if (at < place.step || at >= after) continue
      if (value === HOP_STOP) return {
        last: at - 1,
        next: null,
        hops: taken
      }
      const key   = placeKey(place.songRow, at)
      const times = value >> 4
      const count = taken.get(key) ?? 0
      // Its step plays: a counted HOP that has hopped its count, or the step known to play. Counted again from the start next time.
      if ((playing && at === place.step) || (times > 0 && count >= times)) {
        taken = withCount(taken, key, null)
        continue
      }
      if (times > 0) taken = withCount(taken, key, count + 1)
      const row      = value & 0x0f
      const chainRow = Math.floor(at / ROWS_PER_PHRASE)
      // A counted HOP (and any HOP in a phrase played alone) stays in its phrase; HOP 0Y goes to the next one.
      const target   = loop ?? (times > 0 ? chainRow : chainRow + 1)
      return {
        last: at - 1,
        next: target * ROWS_PER_PHRASE < steps ? {
          songRow: place.songRow,
          step   : target * ROWS_PER_PHRASE + row
        } : {
          songRow: this.nextRow(place.songRow, track),
          step   : row
        },
        hops: taken
      }
    }
    return {
      last: after - 1,
      next: loop == null ? {
        songRow: this.nextRow(place.songRow, track),
        step   : 0
      } : {
        songRow: place.songRow,
        step   : first
      },
      hops: taken
    }
  }

  /** The step a track starts song row `toRow` on when it comes from row `fromRow`: 0, or row Y of a HOP 0Y that sends it there. */
  entryStep(track: number, fromRow: number, toRow: number): number {
    let place : Place = {
      songRow: fromRow,
      step   : 0
    }
    let hops  = NO_HOPS
    for (let runs = 0; runs < MAX_ENTRY_RUNS; runs += 1) {
      const run = this.run(track, place, hops, false)
      if (!run.next) return 0
      if (run.next.songRow !== fromRow) return run.next.songRow === toRow ? run.next.step : 0
      place = run.next
      hops  = run.hops
    }
    return 0
  }

  /** The hops taken once the track has played from `place` to step `to` of the same run: the HOPs it played through start over. */
  passed(track: number, place: Place, hops: HopCounts, to: number): HopCounts {
    const chainId = this.model.song[place.songRow]?.[track]
    let taken     = hops
    for (const [at] of chainId == null ? [] : this.hops(chainId)) {
      if (at >= place.step && at <= to && taken.has(placeKey(place.songRow, at))) taken = withCount(taken, placeKey(place.songRow, at), null)
    }
    return taken
  }
}
