// What the 3D view shows now, shared by its parts: the song laid out, a view per track, and the
// angle the walls are turned to. The world replaces them; its parts only read them.

import type { SongLayout } from './layout'
import type { TrackView } from './track/trackView'

export interface SceneContent {
  layout    : SongLayout | null
  trackViews: TrackView[]
  /** How far the walls are turned from the front (radians). */
  wallAngle : number
}
