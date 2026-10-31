// What the explorer works out once from a song model: the song unrolled step by step, the
// instrument each step plays and the scale each track plays with along the song. The app builds
// one for every version of the model (edits on the M8 change the model in place, so it builds a
// new one after them) and hands the same one to the 3D view, the playback tracker, the device
// cursor and the cell descriptions.

import { ScaleMap } from './music/harmony'
import type { SongModel } from './song'
import { buildTimeline, effectiveInstruments, type Timeline } from './timeline'

export interface SongContext {
  readonly model    : SongModel
  readonly timeline : Timeline
  /** Instrument each step plays, per instance key (see effectiveInstruments). */
  readonly effective: ReadonlyMap<string, readonly (number | null)[]>
  /** The scale each track plays with along the song. */
  readonly scales   : ScaleMap
}

export function buildSongContext(model: SongModel): SongContext {
  const timeline = buildTimeline(model)
  return {
    model,
    timeline,
    effective: effectiveInstruments(model, timeline),
    scales   : new ScaleMap(model, timeline)
  }
}

/** The instrument a step plays: its I column or INS, else the last one set before it on its track; null when none is. */
export const effectiveInstrumentAt = (song: SongContext, instanceKey: string, step: number): number | null =>
  song.effective.get(instanceKey)?.[step] ?? null
