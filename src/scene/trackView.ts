// One track in 3D: its front column (chain/phrase tree, notes), its wall (step details,
// instrument and table panels, links) and the coloured bars shown when zoomed out.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three'
import type { Text } from 'troika-three-text'
import { formatTranspose, playedNote, transposeSemitones } from '../model/harmony'
import { hex2, type PhraseInstance, type PhraseStep, type SongModel, type TableRow } from '../model/song'
import {
  CHAIN_COL,
  CHAR_W,
  FRONT_W,
  INST_COL,
  NOTE_COL,
  PANEL_CHARS,
  PANEL_FIELDS,
  PANEL_ROWS,
  PANEL_U0,
  PHRASE_COL,
  ROW_H,
  SIDE_CHARS,
  SIDE_FIELDS,
  SIDE_U0,
  type Panel,
  type SongLayout,
  type TrackLayout,
  WALL_ANGLE,
  WALL_HINGE,
} from './layout'
import { mix, type Palette } from './palette'
import { makeText, Rich, type TextBlock } from './text'

/** A unit quad with its origin at the top-left corner. */
const QUAD = new PlaneGeometry(1, 1).translate(0.5, -0.5, 0)

interface Rect {
  x: number
  y: number
  w: number
  h: number
  z?: number
  color: string
}

function quads(rects: Rect[], opacity: number): InstancedMesh {
  const material = new MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: DoubleSide })
  const mesh = new InstancedMesh(QUAD, material, Math.max(1, rects.length))
  const m = new Matrix4()
  const c = new Color()
  rects.forEach((r, i) => {
    m.makeScale(r.w, r.h, 1).setPosition(r.x, r.y, r.z ?? 0)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.set(r.color))
  })
  mesh.count = rects.length
  mesh.frustumCulled = false
  return mesh
}

function segments(points: number[], color: string, opacity: number): LineSegments {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  const lines = new LineSegments(geometry, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
  lines.frustumCulled = false
  return lines
}

/** A link from a step cell to a panel: a curve that leaves the wall toward the viewer and comes back. */
export function linkCurve(from: Vector3, to: Vector3, steps = 24): Vector3[] {
  // Out of the wall toward the viewer, then into the panel's title from the left.
  const lift = 1.2 + Math.min(from.distanceTo(to) * 0.05, 3)
  const p1 = new Vector3(from.x + (to.x - from.x) * 0.45, from.y, lift)
  const p2 = new Vector3(to.x - 2.5, to.y, lift * 0.6)
  const out: Vector3[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const a = (1 - t) ** 3
    const b = 3 * (1 - t) ** 2 * t
    const c = 3 * (1 - t) * t ** 2
    const d = t ** 3
    out.push(
      new Vector3(
        a * from.x + b * p1.x + c * p2.x + d * to.x,
        a * from.y + b * p1.y + c * p2.y + d * to.y,
        a * from.z + b * p1.z + c * p2.z + d * to.z,
      ),
    )
  }
  return out
}

export const fxText = (cmd: string | null, val: number | null): [string, string] => (cmd ? [cmd.padEnd(3).slice(0, 3), hex2(val, '00')] : ['---', '00'])

export class TrackView {
  readonly group = new Group()
  readonly front = new Group()
  readonly wall = new Group()
  readonly blocks: TextBlock[] = []
  readonly bars: InstancedMesh[] = []
  private readonly wallMaterials: { material: { opacity: number }; base: number }[] = []
  private readonly frontMaterials: { material: { opacity: number }; base: number }[] = []
  private readonly frontPanels: InstancedMesh
  wallAlpha = 0
  frontAlpha = 1
  private barsAlpha = 0
  /** The instrument / table panels of the wall, each in its own group. */
  readonly panels: {
    panel: Panel
    group: Group
    text: Text | null
    background: MeshBasicMaterial
    bars: MeshBasicMaterial
    build: () => Rich
  }[] = []
  private readonly links: LineSegments
  private readonly linkColors: { inst: Color; table: Color }
  private linksKey = ''
  /** Link vertices, reused from frame to frame (grown when a frame needs more). */
  private linkPositions = new Float32Array(0)
  private linkColorData = new Float32Array(0)
  /** Called when a panel's text finished laying out (to redraw). */
  onTextReady: () => void = () => {}

  constructor(
    readonly layout: SongLayout,
    readonly track: TrackLayout,
    readonly palette: Palette,
    /** Transposed phrases show the notes they play rather than the notes written. */
    readonly playedNotes = true,
  ) {
    const { model } = layout
    this.group.add(this.front, this.wall)
    this.wall.position.set(WALL_HINGE, 0, 0)
    this.wall.rotation.y = WALL_ANGLE

    const frontRects: Rect[] = []
    const wallRects: Rect[] = []
    const noteBars: Rect[] = []
    const fxBars: Rect[] = []
    const brackets: number[] = []
    const p = palette

    const panelA = p.panel
    const panelB = mix(p.panel, p.background, 0.55)
    const beat = mix(p.panel, p.label, 0.07)
    const t = track.track

    // --- phrase instances -------------------------------------------------
    track.instances.forEach((inst, i) => {
      const y = layout.rowY(inst.row)
      const h = 16 * ROW_H
      const shade = i % 2 ? panelB : panelA
      frontRects.push({ x: NOTE_COL * CHAR_W - 0.25, y: y - 0.05, w: FRONT_W - NOTE_COL * CHAR_W + 0.4, h: h - 0.1, z: -0.05, color: shade })
      wallRects.push({ x: SIDE_U0 - 0.3, y: y - 0.05, w: SIDE_CHARS * CHAR_W + 0.6, h: h - 0.1, z: -0.05, color: shade })
      for (let s = 0; s < 16; s += 4) {
        frontRects.push({ x: NOTE_COL * CHAR_W - 0.25, y: y - s * ROW_H, w: FRONT_W - NOTE_COL * CHAR_W + 0.4, h: ROW_H, z: -0.04, color: beat })
        wallRects.push({ x: SIDE_U0 - 0.3, y: y - s * ROW_H, w: SIDE_CHARS * CHAR_W + 0.6, h: ROW_H, z: -0.04, color: beat })
      }

      // Tree: the chain's bracket spans its phrases in this song row, the phrase's spans its steps.
      // A transposed phrase's bracket leaves its second row to the transpose label.
      const phraseX = (PHRASE_COL + 2.45) * CHAR_W
      const transposed = transposeSemitones(model.chains[inst.chain]?.rows[inst.chainRow]?.transpose) !== 0
      if (transposed) {
        brackets.push(phraseX, y - 0.3, 0, phraseX, y - ROW_H, 0, phraseX, y - 2 * ROW_H, 0, phraseX, y - h + 0.3, 0)
      } else {
        brackets.push(phraseX, y - 0.3, 0, phraseX, y - h + 0.3, 0)
      }
      brackets.push(phraseX, y - 0.3, 0, phraseX + 0.35, y - 0.3, 0)
      if (inst.chainRow === 0) {
        const siblings = track.instances.filter((o) => o.songRow === inst.songRow)
        const last = siblings[siblings.length - 1]
        const chainX = (CHAIN_COL + 2.45) * CHAR_W
        const bottom = layout.rowY(last.row) - h + 0.3
        brackets.push(chainX, y - 0.3, 0, chainX, bottom, 0, chainX, y - 0.3, 0, chainX + 0.35, y - 0.3, 0)
      }

      const phrase = model.phrases[inst.phrase]
      phrase?.steps.forEach((step, s) => {
        const sy = y - s * ROW_H - ROW_H * 0.14
        if (step.note && step.note !== 'OFF') {
          const vel = step.vel ?? 0x64
          const color = vel >= 0x70 ? p.theme.meterPeak : vel >= 0x48 ? p.theme.meterMid : p.theme.meterLow
          noteBars.push({ x: NOTE_COL * CHAR_W, y: sy, w: 3 * CHAR_W, h: ROW_H * 0.72, z: 0.02, color })
        }
        step.fx.forEach((f, lane) => {
          if (!f.cmd) return
          const [start] = SIDE_FIELDS[`fx${lane + 1}cmd` as 'fx1cmd']
          fxBars.push({ x: SIDE_U0 + start * CHAR_W, y: sy, w: 5 * CHAR_W, h: ROW_H * 0.72, z: 0.02, color: p.phrase[`fx${lane + 1}cmd` as 'fx1cmd'].filled })
        })
      })

      this.blocks.push({
        key: `f:${inst.key}`,
        parent: this.front,
        x: 0,
        y,
        height: h,
        layer: 'front',
        track: t,
        build: () => this.frontText(inst, phrase?.steps),
      })
      this.blocks.push({
        key: `w:${inst.key}`,
        parent: this.wall,
        x: SIDE_U0,
        y,
        height: h,
        layer: 'wall',
        track: t,
        build: () => this.sideText(phrase?.steps),
      })
    })

    // --- instrument / table panels: a group each, moved by the sticky layout ----
    for (const panel of track.panels) {
      const h = PANEL_ROWS * ROW_H
      const group = new Group()
      const table = model.tables[panel.table]
      const rects: Rect[] = [
        { x: PANEL_U0 - 0.45, y: 0.25, w: PANEL_CHARS * CHAR_W + 0.9, h: h + 0.5, z: -0.06, color: p.panel },
        { x: PANEL_U0 - 0.45, y: 0.25, w: PANEL_CHARS * CHAR_W + 0.9, h: ROW_H * 2 + 0.35, z: -0.05, color: p.panelHeader },
      ]
      const bars: Rect[] = []
      table?.rows.forEach((row, r) => {
        row.fx.forEach((f, lane) => {
          if (!f.cmd) return
          const [start] = PANEL_FIELDS[`fx${lane + 1}cmd` as 'fx1cmd']
          bars.push({ x: PANEL_U0 + start * CHAR_W, y: -(r + 2) * ROW_H - ROW_H * 0.14, w: 5 * CHAR_W, h: ROW_H * 0.72, z: 0.02, color: p.table[`fx${lane + 1}cmd` as 'fx1cmd'].filled })
        })
      })
      const background = quads(rects, 0.92)
      const barMesh = quads(bars, 0)
      group.add(background, barMesh)
      group.position.set(panel.shownU - PANEL_U0, panel.shownY, 0)
      group.visible = false
      this.wall.add(group)
      this.panels.push({
        panel,
        group,
        text: null,
        background: background.material as MeshBasicMaterial,
        bars: barMesh.material as MeshBasicMaterial,
        build: () => this.panelText(model, panel.inst, panel.table, table?.rows),
      })
    }

    // Links are drawn near the view only, fading with their panel and toward the edges (updateLinks).
    this.linkColors = { inst: new Color(p.link), table: new Color(p.tableLink) }
    this.links = this.trackMaterial(
      new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })),
      true,
    )
    this.links.frustumCulled = false
    this.wall.add(this.links)

    // --- headers ----------------------------------------------------------
    const top = layout.rowY(0) + ROW_H * 1.9
    this.blocks.push({
      key: `hf:${t}`,
      parent: this.front,
      x: 0,
      y: top + ROW_H * 2.4,
      height: ROW_H * 3,
      layer: 'static',
      track: t,
      build: () =>
        new Rich()
          .add(`TRACK ${t + 1}`, p.title)
          .nl()
          .add((track.label ?? '').slice(0, 12), p.label)
          .nl()
          .add('CH PH NOTE I', p.empty),
    })
    this.blocks.push({
      key: `hw:${t}`,
      parent: this.wall,
      x: SIDE_U0,
      y: top,
      height: ROW_H,
      layer: 'wall',
      track: t,
      build: () => new Rich().add('VL IN FX1   FX2   FX3', p.empty),
    })
    this.blocks.push({
      key: `hp:${t}`,
      parent: this.wall,
      x: PANEL_U0,
      y: top,
      height: ROW_H,
      layer: 'wall',
      track: t,
      build: () => new Rich().add('INSTRUMENTS · TABLES', p.empty),
    })

    this.frontPanels = quads(frontRects, 0.9)
    this.front.add(this.trackMaterial(this.frontPanels, false))
    this.front.add(this.trackMaterial(segments(brackets, p.bracket, 0.9), false))

    const wallPanels = quads(wallRects, 0.9)
    this.wall.add(this.trackMaterial(wallPanels, true))
    // A faint floor line along the hinge shows where the wall is when nothing is on it.
    this.wall.add(this.trackMaterial(segments([0, top, 0, track.wallLen, top, 0], p.rule, 0.8), true))

    const frontBars = quads(noteBars, 0)
    const wallBars = quads(fxBars, 0)
    this.front.add(frontBars)
    this.wall.add(this.trackMaterial(wallBars, true))
    this.bars.push(frontBars, wallBars)
  }

  /** Registers a wall material so its opacity follows the wall's fade. */
  private trackMaterial<T extends LineSegments | InstancedMesh>(object: T, wall: boolean): T {
    const material = object.material as LineBasicMaterial
    ;(wall ? this.wallMaterials : this.frontMaterials).push({ material, base: material.opacity })
    return object
  }

  /** Start (step cell) and end (panel title) of a link, in wall coordinates. */
  linkEnds(row: number, col: number, panelY: number, panelU: number): [Vector3, Vector3] {
    const y = this.layout.rowY(row) - ROW_H / 2
    return [new Vector3(SIDE_U0 + (col + 2) * CHAR_W, y, 0.05), new Vector3(panelU - 0.5, panelY - ROW_H * 0.5, 0.05)]
  }

  setWallAlpha(alpha: number): void {
    this.wallAlpha = alpha
    this.wall.visible = alpha > 0.01
    for (const { material, base } of this.wallMaterials) material.opacity = base * alpha
    this.applyBars()
  }

  /** The front column steps back while another track's wall is looked at. */
  setFrontAlpha(alpha: number): void {
    this.frontAlpha = alpha
    this.front.visible = alpha > 0.01
    for (const { material, base } of this.frontMaterials) material.opacity = base * alpha
    this.applyBars()
  }

  /** Bars fade in as the text becomes too small to read. */
  setBarsAlpha(alpha: number): void {
    this.barsAlpha = alpha
    this.applyBars()
  }

  private applyBars(): void {
    const [front, wall] = this.bars
    if (!front) return
    ;(front.material as MeshBasicMaterial).opacity = this.barsAlpha * this.frontAlpha
    ;(wall.material as MeshBasicMaterial).opacity = this.barsAlpha * this.wallAlpha
    for (const view of this.panels) view.bars.opacity = this.barsAlpha * this.wallAlpha * view.panel.alpha
  }

  /**
   * Eases each panel toward where the sticky layout wants it and fades it in or out; its
   * text exists only while it shows. Returns true while anything is still moving.
   */
  updatePanels(dt: number, textOn: boolean): boolean {
    let busy = false
    const fade = 1 - Math.exp(-dt * 6)
    const glide = 1 - Math.exp(-dt * 9)
    for (const view of this.panels) {
      const { panel, group } = view
      const goal = panel.visible ? 1 : 0
      panel.alpha += (goal - panel.alpha) * fade
      if (Math.abs(goal - panel.alpha) < 0.01) panel.alpha = goal
      // A panel coming back from hidden appears where it belongs instead of flying in.
      if (panel.alpha < 0.02) {
        panel.shownY = panel.y
        panel.shownU = panel.u
      } else {
        panel.shownY += (panel.y - panel.shownY) * glide
        panel.shownU += (panel.u - panel.shownU) * glide
      }
      if (Math.abs(panel.y - panel.shownY) < 0.01) panel.shownY = panel.y
      if (Math.abs(panel.u - panel.shownU) < 0.01) panel.shownU = panel.u
      if (panel.alpha !== goal || panel.shownY !== panel.y || panel.shownU !== panel.u) busy = true

      const alpha = panel.alpha * this.wallAlpha
      group.position.set(panel.shownU - PANEL_U0, panel.shownY, 0)
      group.visible = alpha > 0.01
      view.background.opacity = 0.92 * alpha
      view.bars.opacity = this.barsAlpha * alpha
      const wantText = textOn && alpha > 0.01
      if (wantText && !view.text) {
        const text = makeText(view.build())
        text.position.set(PANEL_U0, 0, 0.01)
        text.renderOrder = 2
        text.fillOpacity = alpha
        group.add(text)
        text.sync(() => this.onTextReady())
        view.text = text
      } else if (!wantText && view.text) {
        view.text.removeFromParent()
        view.text.dispose()
        view.text = null
      }
      if (view.text && Math.abs(view.text.fillOpacity - alpha) > 0.005) view.text.fillOpacity = alpha
    }
    return busy
  }

  /**
   * Links from the places near the view to the panels shown, as curves leaving the wall,
   * fading toward the edges of the view and with their panel. Redrawn on every frame where
   * the view or a panel moved, so they glide with them. Returns true when redrawn.
   */
  updateLinks(yTop: number, yBottom: number): boolean {
    const key = `${yTop.toFixed(3)}|${yBottom.toFixed(3)}|${this.track.panels
      .map((p) => (p.alpha > 0 ? `${p.shownY.toFixed(3)}:${p.shownU.toFixed(3)}:${p.alpha.toFixed(3)}` : '-'))
      .join(',')}`
    if (key === this.linksKey) return false
    this.linksKey = key
    const band = (yTop - yBottom) * 0.2
    const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
    const SEGMENTS = 14
    const needed = this.track.links.length * SEGMENTS * 2
    if (this.linkPositions.length < needed * 3) {
      this.linkPositions = new Float32Array(needed * 3)
      this.linkColorData = new Float32Array(needed * 4)
      const geometry = new BufferGeometry()
      // Plain BufferAttributes share the arrays (Float32BufferAttribute would copy them).
      geometry.setAttribute('position', new BufferAttribute(this.linkPositions, 3).setUsage(DynamicDrawUsage))
      geometry.setAttribute('color', new BufferAttribute(this.linkColorData, 4).setUsage(DynamicDrawUsage))
      this.links.geometry.dispose()
      this.links.geometry = geometry
    }
    const positions = this.linkPositions
    const colors = this.linkColorData
    let n = 0
    for (const link of this.track.links) {
      const panel = link.panel
      if (panel.alpha <= 0.01) continue
      const sy = this.layout.rowY(link.row) - ROW_H / 2
      if (sy > yTop || sy < yBottom) continue
      const alpha = 0.6 * panel.alpha * smooth((sy - yBottom) / band) * smooth((yTop - sy) / band)
      if (alpha < 0.02) continue
      const color = link.kind === 'inst' ? this.linkColors.inst : this.linkColors.table
      // The same curve as linkCurve(), sampled without allocating.
      const x0 = SIDE_U0 + (link.col + 2) * CHAR_W
      const x3 = panel.shownU - 0.5
      const y3 = panel.shownY - ROW_H * 0.5
      const lift = 1.2 + Math.min(Math.hypot(x3 - x0, y3 - sy) * 0.05, 3)
      const x1 = x0 + (x3 - x0) * 0.45
      const x2 = x3 - 2.5
      const z1 = lift
      const z2 = lift * 0.6
      let px = x0
      let py = sy
      let pz = 0.05
      for (let i = 1; i <= SEGMENTS; i += 1) {
        const t = i / SEGMENTS
        const a = (1 - t) ** 3
        const b = 3 * (1 - t) ** 2 * t
        const c = 3 * (1 - t) * t ** 2
        const d = t ** 3
        const x = a * x0 + b * x1 + c * x2 + d * x3
        const y = a * sy + b * sy + c * y3 + d * y3
        const z = a * 0.05 + b * z1 + c * z2 + d * 0.05
        positions.set([px, py, pz, x, y, z], n * 3)
        colors.set([color.r, color.g, color.b, alpha, color.r, color.g, color.b, alpha], n * 4)
        n += 2
        px = x
        py = y
        pz = z
      }
    }
    const geometry = this.links.geometry
    geometry.setDrawRange(0, n)
    if (geometry.attributes.position) {
      geometry.attributes.position.needsUpdate = true
      geometry.attributes.color.needsUpdate = true
    }
    return true
  }

  /**
   * Chain and phrase labels, notes and instruments of one phrase instance. A transposed phrase
   * gets its transpose under the phrase number ('+5', '-12'; the third character takes the
   * bracket's place) and, with playedNotes, the notes it plays in the transpose colour.
   */
  private frontText(inst: PhraseInstance, steps: PhraseStep[] | undefined): Rich {
    const p = this.palette
    const { model } = this.layout
    const st = transposeSemitones(model.chains[inst.chain]?.rows[inst.chainRow]?.transpose)
    const effective = this.layout.effective.get(inst.key)
    const r = new Rich()
    for (let s = 0; s < 16; s += 1) {
      if (s) r.nl()
      r.add(s === 0 && inst.chainRow === 0 ? hex2(inst.chain) : '  ', p.chainLabel).add(' ', p.empty)
      if (s === 1 && st !== 0) r.add(formatTranspose(st).padEnd(3), p.transpose)
      else r.add(s === 0 ? hex2(inst.phrase) : '  ', p.phraseLabel).add(' ', p.empty)
      const step = steps?.[s]
      const played = this.playedNotes ? playedNote(model, step?.note ?? null, st, effective?.[s], this.layout.scales.at(inst.track, inst.row + s)) : null
      if (played?.shift && step?.note && played.note !== step.note) r.add(played.note ?? '???', p.transpose)
      else r.add(step?.note ?? '---', step?.note ? p.phrase.note.filled : p.phrase.note.empty)
      r.add(' ', p.empty)
      r.add(hex2(step?.inst ?? null), step?.inst != null ? p.phrase.inst.filled : p.phrase.inst.empty)
    }
    return r
  }

  private sideText(steps: PhraseStep[] | undefined): Rich {
    const p = this.palette
    const r = new Rich()
    for (let s = 0; s < 16; s += 1) {
      if (s) r.nl()
      const step = steps?.[s]
      r.add(hex2(step?.vel ?? null), step?.vel != null ? p.phrase.vel.filled : p.phrase.vel.empty).add(' ', p.empty)
      r.add(hex2(step?.inst ?? null), step?.inst != null ? p.phrase.inst.filled : p.phrase.inst.empty)
      for (let lane = 0; lane < 3; lane += 1) {
        const f = step?.fx[lane]
        const [cmd, val] = fxText(f?.cmd ?? null, f?.val ?? null)
        const key = `fx${lane + 1}` as 'fx1'
        r.add(' ', p.empty)
        r.add(cmd, f?.cmd ? p.phrase[`${key}cmd`].filled : p.phrase[`${key}cmd`].empty)
        r.add(val, f?.cmd ? p.phrase[`${key}val`].filled : p.phrase[`${key}val`].empty)
      }
    }
    return r
  }

  private panelText(model: SongModel, inst: number | null, table: number, rows: TableRow[] | undefined): Rich {
    const p = this.palette
    const instrument = inst != null ? model.instruments[inst] : null
    const r = new Rich()
    if (inst != null) r.add(`I${hex2(inst)} `, p.title).add((instrument?.name ?? '------------').slice(0, 12), instrument?.name ? p.value : p.empty)
    else r.add(`TABLE ${hex2(table)}`, p.title)
    r.nl().add(`${(instrument?.type ?? (inst != null ? '?' : 'AUX TABLE')).slice(0, 13).padEnd(14)}`, p.label).add(`TBL ${hex2(table)}`, p.empty)
    for (let i = 0; i < 16; i += 1) {
      r.nl()
      const row = rows?.[i]
      r.add(i.toString(16).toUpperCase(), p.table.rowIndex.filled).add(' ', p.empty)
      if (!row) {
        r.add(i === 0 ? 'not read' : '', p.empty)
        continue
      }
      r.add(hex2(row.transpose ?? 0), row.transpose ? p.table.transpose.filled : p.table.transpose.empty).add(' ', p.empty)
      r.add(hex2(row.volume), row.volume != null ? p.table.volume.filled : p.table.volume.empty)
      for (let lane = 0; lane < 3; lane += 1) {
        const f = row.fx[lane]
        const [cmd, val] = fxText(f?.cmd ?? null, f?.val ?? null)
        const key = `fx${lane + 1}` as 'fx1'
        r.add(' ', p.empty)
        r.add(cmd, f?.cmd ? p.table[`${key}cmd`].filled : p.table[`${key}cmd`].empty)
        r.add(val, f?.cmd ? p.table[`${key}val`].filled : p.table[`${key}val`].empty)
      }
    }
    return r
  }

  dispose(): void {
    for (const view of this.panels) view.text?.dispose()
    this.group.traverse((o) => {
      const mesh = o as InstancedMesh
      if (mesh.isInstancedMesh || (o as LineSegments).isLineSegments) {
        if ((o as LineSegments).isLineSegments) (o as LineSegments).geometry.dispose()
        ;(mesh.material as MeshBasicMaterial).dispose()
        if (mesh.isInstancedMesh) mesh.dispose()
      }
    })
  }
}

export { INST_COL, NOTE_COL }
