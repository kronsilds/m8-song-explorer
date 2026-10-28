import { expect, test } from 'bun:test'
import { Group, Mesh, type MeshBasicMaterial } from 'three'
import type { TrackPlayhead } from '../src/m8/playback'
import { ROW_H, type SongLayout } from '../src/scene/layout'
import { PlayheadView } from '../src/scene/markers/playheadView'
import type { Palette } from '../src/scene/palette'
import type { TrackView } from '../src/scene/track/trackView'

/** Rows hang down from y 0, one ROW_H each; no notes to flash. */
const layout  = {
  rowY      : (row: number) => -row * ROW_H,
  instanceAt: () => null
} as unknown as SongLayout
const palette = { device: '#4af' } as Palette
const views   = Array.from({ length: 8 }, () => ({
  front     : new Group(),
  wall      : new Group(),
  wallAlpha : 0,
  frontAlpha: 1
})) as unknown as TrackView[]
const head    = (row: number): TrackPlayhead => ({
  row,
  songRow: 0,
  exact  : true,
  phase  : 0,
  step   : row
})
/** The halo of a track: the mesh on its front column drawn with vertex alphas. */
const haloOf  = (track: number) => views[track].front.children.find((child) => child instanceof Mesh && (child.material as MeshBasicMaterial).vertexColors) as Mesh | undefined

test('a playhead out of sight lights a halo at the edge it is past; the lead is the one furthest down', () => {
  const view  = new PlayheadView()
  // Rows 30 to 60 are in sight.
  const edges = {
    top   : -30 * ROW_H,
    bottom: -60 * ROW_H
  }
  view.update([head(10), head(40), head(80)], layout, views, palette, 0, () => edges)
  const above = haloOf(0)
  const below = haloOf(2)
  expect(above?.visible).toBe(true)
  expect(above?.position.y).toBe(edges.top)
  expect(above?.scale.y).toBeGreaterThan(0)
  expect(below?.visible).toBe(true)
  expect(below?.position.y).toBe(edges.bottom)
  expect(below?.scale.y).toBeLessThan(0)
  expect(haloOf(1)?.visible ?? false).toBe(false)
  expect(view.leadPosition()).toBe(80)
  // Back in sight, or stopped: no halo.
  view.update([head(35), head(40), null], layout, views, palette, 0, () => edges)
  expect(haloOf(0)?.visible).toBe(false)
  expect(haloOf(2)?.visible).toBe(false)
  expect(view.leadPosition()).toBe(40)
})
