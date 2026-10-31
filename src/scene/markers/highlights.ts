// What the 3D view marks: the selection (its cell and the rows it covers), the cell under the
// pointer, every place the M8 cursor is (pulsing), and the selection's links drawn thick. Also
// tells the sticky layout which panels matter now.

import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { Palette } from '../../model/palette'
import { type Selection, sameSelection, selectionTrack } from '../../model/selection'
import type { SceneContent } from '../content'
import type { Link } from '../layout'
import { linkCurve } from '../shapes'
import type { TrackPlacement } from '../track/placement'
import type { WallFolds } from '../track/wallFolds'
import { CellMarker } from './cellMarker'

const MAX_DEVICE_MARKERS = 64

export class Highlights {
  /** The cell under the pointer. */
  hovered                         : Selection | null = null
  /** Where the M8 cursor is (every place the item under it appears). */
  private places                  : Selection[] = []
  private readonly selectionMarks = [new CellMarker(), new CellMarker(), new CellMarker()]
  private readonly hoverMark      = new CellMarker()
  private readonly deviceMarks    : CellMarker[] = []
  /** The selection's links, drawn thick. */
  private links                   : LineSegments2 | null = null
  private readonly linkMaterial   = new LineMaterial({
    linewidth  : 2.2,
    transparent: true,
    depthWrite : false
  })
  /** The links of a selected phrase, all of them, faint. */
  private readonly faintMaterial  = new LineMaterial({
    linewidth  : 1.2,
    opacity    : 0.5,
    transparent: true,
    depthWrite : false
  })

  constructor(
    private readonly content: Readonly<SceneContent>,
    private readonly placement: TrackPlacement,
    private readonly folds: WallFolds,
  ) {}

  get devicePlaces(): readonly Selection[] {
    return this.places
  }

  set devicePlaces(places: readonly Selection[]) {
    this.places = places.slice(0, MAX_DEVICE_MARKERS)
  }

  /** The places marked are the same places in a new layout (see SongLayout.resolve). */
  resolve(resolve: (selection: Selection) => Selection | null): void {
    this.hovered = this.hovered && resolve(this.hovered)
    this.places  = this.places.flatMap((place) => resolve(place) ?? [])
  }

  applyPalette(palette: Palette): void {
    this.linkMaterial.color.set(palette.hot)
    this.faintMaterial.color.set(palette.hot)
  }

  /** The view's size in pixels (the thick links' width is in pixels). */
  resize(width: number, height: number): void {
    this.linkMaterial.resolution.set(width, height)
    this.faintMaterial.resolution.set(width, height)
  }

  /** Marks the selection, the hovered cell and the M8 cursor's places again, and the selection's links. */
  refresh(selection: Selection | null, palette: Palette): void {
    const { placement } = this
    this.markPanels(selection)
    for (const marker of this.selectionMarks) marker.hide()
    const rects = selection ? placement.rectsOf(selection) : []
    rects.forEach((rect, i) => {
      const isCell = i === rects.length - 1
      this.selectionMarks[i]?.show(rect, palette.hot, isCell ? 0.3 : 0.08, isCell ? 1 : 0.35)
    })

    this.hoverMark.hide()
    if (this.hovered && !sameSelection(this.hovered, selection)) {
      const cell = placement.rectsOf(this.hovered).at(-1)
      if (cell) this.hoverMark.show(cell, palette.hover, 0.12, 0.8)
    }

    this.places.forEach((place, i) => {
      const cell          = placement.rectsOf(place).at(-1)
      this.deviceMarks[i] ??= new CellMarker()
      if (cell) this.deviceMarks[i].show(cell, palette.device, 0.18, 1)
      else this.deviceMarks[i].hide()
    })
    for (let i = this.places.length; i < this.deviceMarks.length; i += 1) this.deviceMarks[i].hide()
    this.refreshLinks(selection)
  }

  /** The M8 cursor's places pulse; true while there are any. */
  pulse(now: number): boolean {
    if (this.places.length === 0) return false
    const opacity = 0.55 + 0.45 * Math.sin(now / 180)
    for (const marker of this.deviceMarks) marker.outlineOpacity = opacity
    return true
  }

  removeLinks(): void {
    this.links?.removeFromParent()
    this.links?.geometry.dispose()
    this.links = null
  }

  /** The links of the selection, drawn thick. */
  refreshLinks(selection: Selection | null): void {
    this.removeLinks()
    if (!selection || !this.content.layout) return
    const view  = this.content.trackViews[selectionTrack(selection)]
    const links = this.selectionLinks(selection)
    // A selected row draws its own links; the phrase draws all of them, faintly; a panel header draws all of its panel's.
    const faint = selection.kind === 'chain'
    if (!links.length || !view) return
    const positions: number[] = []
    for (const link of links) {
      if (link.panel.alpha < 0.05) continue
      const [from, to] = view.linkEnds(link.row, link.col, link.panel.shownY, link.panel.shownU, this.folds.opened(view.track.track).fx ? 1 : 0)
      const points     = linkCurve(from, to)
      for (let i = 0; i < points.length - 1; i += 1) {
        const [a, b] = [points[i], points[i + 1]]
        positions.push(a.x, a.y, a.z + 0.02, b.x, b.y, b.z + 0.02)
      }
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(positions)
    this.links             = new LineSegments2(geometry, faint ? this.faintMaterial : this.linkMaterial)
    this.links.renderOrder = 4
    view.wall.add(this.links)
  }

  /** The thick links of the selection go with the details or the panels they join. */
  followWalls(selection: Selection | null): void {
    if (!this.links || !selection) return
    const view         = this.content.trackViews[selectionTrack(selection)]
    this.links.visible = !!view && view.panelsAlpha > 0.05
  }

  /** The links of a selection: a step's own, a phrase's (its chain labels) all of them, a panel's all of its panel's. */
  private selectionLinks(selection: Selection): Link[] {
    const layout = this.content.layout
    if (!layout) return []
    if (selection.kind !== 'step' && selection.kind !== 'chain') {
      return layout.tracks[selection.track]?.links.filter((link) => link.panel.table === selection.table) ?? []
    }
    const inRow = (link: Link) => selection.kind === 'chain' || link.step === selection.step
    const links = layout.instanceLinks(selection.instance).filter(inRow)
    // Each note also links to the instrument it plays (the last one set when its I column is empty).
    const drawn = new Set(links.map((link) => `${link.row}:${link.col}:${link.panel.table}`))
    for (const link of layout.noteInstrumentLinks(selection.instance).filter(inRow)) {
      if (!drawn.has(`${link.row}:${link.col}:${link.panel.table}`)) links.push(link)
    }
    return links
  }

  /**
   * Tells the sticky layout which panels matter now: the selected one and the one under the M8
   * cursor are pinned (whole on screen, their table down to the row pointed at), the ones the
   * selected step links to are kept open.
   */
  private markPanels(selection: Selection | null): void {
    const layout = this.content.layout
    if (!layout) return
    for (const track of layout.tracks) {
      for (const panel of track.panels) {
        panel.pinned      = false
        panel.linked      = false
        panel.selectedRow = null
      }
    }
    for (const place of [...this.places, ...(selection ? [selection] : [])]) {
      if (place.kind === 'step' || place.kind === 'chain') continue
      const panel = layout.panelOf(place.track, place.table)
      if (!panel) continue
      panel.pinned = true
      if (place.kind === 'table') panel.selectedRow = Math.max(panel.selectedRow ?? 0, place.row)
    }
    if (selection?.kind === 'step') for (const link of this.selectionLinks(selection)) link.panel.linked = true
  }
}
