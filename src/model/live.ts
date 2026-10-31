// What the M8 does live, in the song's terms: where each track plays, a track's mute and solo,
// and what an edit made on the device changed. m8/ works these out from the device; the 3D view
// and the HUD draw them.

/** The M8 views the explorer reads; 'other' for the rest. */
export type ViewKind = 'song' | 'chain' | 'phrase' | 'inst' | 'instmods' | 'table' | 'scale' | 'groove' | 'other'

/** What an edit made on the M8 changed: the item of a view (its number; null for the Song view), or the project's settings. */
export interface DeviceEdit {
  kind: ViewKind | 'project'
  id  : number | null
}

/** A track's mute or solo, as the explorer's header buttons and the M8's CC MAP notes set them. */
export type TrackToggle = 'mute' | 'solo'

/** The note a track's panel shows (right of most views), and when it last changed (ms). */
export interface TrackNote {
  /** Semitones (C-0 = 0), null for '---'. */
  pitch    : number | null
  changedAt: number
}

/** Where a track plays now. */
export interface TrackPlayhead {
  /** Timeline row being played, null when the track has nothing at this song row. */
  row      : number | null
  songRow  : number
  /** True once the step is known (to within half a step), false while it is guessed. */
  exact    : boolean
  /** How far into its step the track is, 0 to 1 (the step lasts what its groove gives it). */
  phase    : number
  /** Step of the chain being played (a beat every 4). */
  step     : number
  /** Steps started since playing began: it changes as each step starts, a step a HOP or a loop plays again too. */
  serial   : number
  /** When the step started, in ms (performance.now). */
  startedAt: number
  /** The note the M8's track panel shows, the evidence of what it really played (chance, random FX). */
  note     : TrackNote | null
}
