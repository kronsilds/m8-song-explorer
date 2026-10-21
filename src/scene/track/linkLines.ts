// The thin links of a track's wall: from the places near the view to the panels shown, as
// curves leaving the wall, fading toward the edges of the view and with their panel. The
// vertex buffers are reused from frame to frame (grown when a frame needs more).

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineBasicMaterial, LineSegments } from 'three'
import { CHAR_W, type Link, ROW_H, SIDE_U0, type SongLayout, type TrackLayout } from '../layout'
import type { Palette } from '../palette'
import { bezierWeights, smoothstep } from '../shapes'

const SEGMENTS_PER_LINK = 14
const LINK_OPACITY      = 0.6
/** Share of the view height over which links fade out toward its top and bottom edges. */
const EDGE_FADE_SHARE   = 0.2
/** Height above the wall of a link's ends. */
const END_Z             = 0.05

export class LinkLines {
  readonly lines          = new LineSegments(new BufferGeometry(), new LineBasicMaterial({
    vertexColors: true,
    transparent : true,
    depthWrite  : false
  }))
  private readonly colors : Record<Link['kind'], Color>
  /** What the last drawing depended on: the same key draws the same links. */
  private drawnKey        = ''
  private positions       = new Float32Array(0)
  private vertexColors    = new Float32Array(0)

  constructor(
    private readonly layout: SongLayout,
    private readonly track: TrackLayout,
    palette: Palette,
  ) {
    this.colors              = {
      instrument: new Color(palette.link),
      table     : new Color(palette.tableLink)
    }
    this.lines.frustumCulled = false
  }

  /** Redraws the links for the view [yBottom, yTop] when it or a panel moved. Returns true when redrawn. */
  update(yTop: number, yBottom: number): boolean {
    const panelsKey = this.track.panels
      .map((p) => (p.alpha > 0 ? `${p.shownY.toFixed(3)}:${p.shownU.toFixed(3)}:${p.alpha.toFixed(3)}` : '-'))
      .join(',')
    const key       = `${yTop.toFixed(3)}|${yBottom.toFixed(3)}|${panelsKey}`
    if (key === this.drawnKey) return false
    this.drawnKey = key
    this.ensureCapacity(this.track.links.length * SEGMENTS_PER_LINK * 2)
    const fadeBand = (yTop - yBottom) * EDGE_FADE_SHARE
    let vertices   = 0
    for (const link of this.track.links) {
      const panel = link.panel
      if (panel.alpha <= 0.01) continue
      const startY = this.layout.rowY(link.row) - ROW_H / 2
      if (startY > yTop || startY < yBottom) continue
      const alpha = LINK_OPACITY * panel.alpha * smoothstep(0, 1, (startY - yBottom) / fadeBand) * smoothstep(0, 1, (yTop - startY) / fadeBand)
      if (alpha < 0.02) continue
      vertices = this.addCurve(vertices, link, startY, alpha)
    }
    const geometry = this.lines.geometry
    geometry.setDrawRange(0, vertices)
    if (geometry.attributes.position) {
      geometry.attributes.position.needsUpdate = true
      geometry.attributes.color.needsUpdate    = true
    }
    return true
  }

  /** The same curve as linkCurve(), sampled without allocating. Returns the vertex count after it. */
  private addCurve(vertices: number, link: Link, startY: number, alpha: number): number {
    const { panel }                   = link
    const color                       = this.colors[link.kind]
    const startX                      = SIDE_U0 + (link.col + 2) * CHAR_W
    const endX                        = panel.shownU - 0.5
    const endY                        = panel.shownY - ROW_H * 0.5
    const lift                        = 1.2 + Math.min(Math.hypot(endX - startX, endY - startY) * 0.05, 3)
    // Control points: out of the wall toward the viewer, then into the panel's title from the left.
    const controlX1                   = startX + (endX - startX) * 0.45
    const controlX2                   = endX - 2.5
    const controlZ1                   = lift
    const controlZ2                   = lift * 0.6
    const { positions, vertexColors } = this
    let previousX                     = startX
    let previousY                     = startY
    let previousZ                     = END_Z
    for (let i = 1; i <= SEGMENTS_PER_LINK; i += 1) {
      const [w0, w1, w2, w3] = bezierWeights(i / SEGMENTS_PER_LINK)
      const x                = w0 * startX + w1 * controlX1 + w2 * controlX2 + w3 * endX
      const y                = (w0 + w1) * startY + (w2 + w3) * endY
      const z                = w0 * END_Z + w1 * controlZ1 + w2 * controlZ2 + w3 * END_Z
      const p                = vertices * 3
      positions[p]           = previousX
      positions[p + 1]       = previousY
      positions[p + 2]       = previousZ
      positions[p + 3]       = x
      positions[p + 4]       = y
      positions[p + 5]       = z
      const c                = vertices * 4
      for (const offset of [c, c + 4]) {
        vertexColors[offset]     = color.r
        vertexColors[offset + 1] = color.g
        vertexColors[offset + 2] = color.b
        vertexColors[offset + 3] = alpha
      }
      vertices  += 2
      previousX = x
      previousY = y
      previousZ = z
    }
    return vertices
  }

  private ensureCapacity(vertices: number): void {
    if (this.positions.length >= vertices * 3) return
    this.positions    = new Float32Array(vertices * 3)
    this.vertexColors = new Float32Array(vertices * 4)
    const geometry    = new BufferGeometry()
    // Plain BufferAttributes share the arrays (Float32BufferAttribute would copy them).
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage))
    geometry.setAttribute('color', new BufferAttribute(this.vertexColors, 4).setUsage(DynamicDrawUsage))
    this.lines.geometry.dispose()
    this.lines.geometry = geometry
  }
}
