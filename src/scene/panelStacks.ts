// Which panels each track's wall shows for the rows in view, and where they stick: columns by how
// far away a panel is used (distance bands), a grid that stays still while the song plays or
// scrolls, and the least useful panels folding or hiding when a column has too little room (see
// stick). SongLayout owns one for its tracks.

import { ROWS_PER_PHRASE } from '../model/song'
import { PANEL_CHARS, PANEL_GAP_ROWS, type Panel, panelSpan, panelU, ROW_H, shownPanelRows, TITLE_ROWS, type UseSpan } from './dimensions'
import type { ShownPanel, TrackLayout } from './layout'

/** Height of a phrase on the wall. */
const PHRASE_HEIGHT     = ROWS_PER_PHRASE * ROW_H
/**
 * The reach panels are placed for: the view height, and at least this many phrases, so that when
 * zoomed in panels do not change band, or come and go, at every phrase of a fast song.
 */
const MIN_REACH_PHRASES = 6
/**
 * Distance bands, in reaches between the view and a panel's nearest use: on screen or within half
 * a reach, within one and a half, within four, further. A panel's band is the first column it may
 * take, so how far along the wall it is tells how far away it is used.
 */
const DISTANCE_BANDS    = [0.5, 1.5, 4]
/** How far (in reaches) a panel may go past the edge of its band before it changes band, so panels do not change columns while a song plays or scrolls a little. */
const BAND_HYSTERESIS   = 0.5
/** The band of panels used further than the last DISTANCE_BANDS edge: they show their title lines only, while there is room. */
const FAR_BAND          = DISTANCE_BANDS.length
/** How far (in view heights, and at least a phrase) the uses of a panel may scroll off screen before it stops counting as used on screen (it then folds before those that are). */
const NOW_HYSTERESIS    = 0.25
/** Fewest table rows a fold must hide to make room: a smaller table is nearly its title lines, and folding it would mostly move the panels below (it still folds for a fuller table used on screen, or a title). */
const MIN_FOLD_ROWS     = 2
/** How much the view height may change (a zoom) before a track's grid is laid out afresh for it, in the order its panels had. */
const REPACK_ZOOM       = 0.15

/** A panel being placed by stick(): the columns it may take, where it goes and how it shows. */
interface Placing {
  panel   : Panel
  band    : number
  now     : boolean
  /** Top y of its use nearest to the view: panels that come in together stack in the order of their uses. */
  useY    : number
  /** Turned to its instrument face: it opens where it is, at the top of its column. */
  turned  : boolean
  /** Its face is wider than a column (turned, on a wall with more than one): it takes the next column too. */
  wide    : boolean
  /** Selected and moved to the top of its column, so it is whole on screen. */
  promoted: boolean
  /** May fold to its title lines and make way (not selected, linked or turned). */
  foldable: boolean
  /** First and last columns it may take. */
  from    : number
  last    : number
  /** Its column (-1 while it has none) and its place in it. */
  col     : number
  seq     : number
  folded  : boolean
  hidden  : boolean
}

const placingRows = (placing: Placing): number => (placing.folded ? TITLE_ROWS : placing.panel.rows)

/** Height a column of panels takes stacked, its panels at `rows` rows (no gap after the last). */
function stackHeight(members: Placing[], rows = placingRows): number {
  if (!members.length) return 0
  return members.reduce((sum, member) => sum + panelSpan(rows(member)), 0) - PANEL_GAP_ROWS * ROW_H
}

export class PanelStacks {
  /** Panels that came into a column so far: the next one's place (see Panel.seq). */
  private arrivals  = 0
  /** View height each track's grid was last laid out afresh for (see REPACK_ZOOM). */
  private packedFor = new Map<number, number>()

  /** `rowY`: the top y of a timeline row (see SongLayout.rowY). */
  constructor(
    private readonly tracks: readonly TrackLayout[],
    private readonly rowY: (row: number) => number,
  ) {}

  /** Takes over how an earlier layout of the same song stacked its panels (see SongLayout.adoptState). */
  adopt(previous: PanelStacks): void {
    this.arrivals  = previous.arrivals
    this.packedFor = new Map(previous.packedFor)
  }

  /** A track's wall got other columns: its grid is laid out afresh at the next stick(). */
  forget(track: number): void {
    this.packedFor.delete(track)
  }

  /**
   * Panels for the view [yBottom, yTop]. A panel shows while the view is between its first and
   * last use in the song (a wider margin to leave than to come, so it does not flicker at the edge).
   * Distances are measured in reaches: the view height, at least MIN_REACH_PHRASES phrases.
   *
   * Columns tell how far away a panel is used: by distance band (see DISTANCE_BANDS), the panels
   * used on screen or within half a reach of it may take the first column, the ones used further
   * start from the second, and so on along the wall. Panels used further than the last band show
   * their title lines only, in the last column, while it has room for them.
   *
   * The grid stays still while the song plays or scrolls: a panel keeps its column and its place
   * in it until its band changes. A panel that comes in, or comes nearer, takes the first column
   * (from its band on) with room for it, at the bottom; one that goes further leaves a column it
   * may no longer take. Panels stack from the top of the view in the order they came in, so the
   * ones in use for long stay on top and newcomers do not push them around. After a zoom (see
   * REPACK_ZOOM) every panel chooses its column afresh, in that order.
   *
   * When a column has too little room, the least useful make way, lowest first: empty tables and
   * panels not used on screen fold to their title lines (the furthest first, then the ones with
   * the least in their tables), far ones hide, then each panel that still does not fit, from the
   * top: one used on screen opens when tables above it with fewer rows in them fold, else moves
   * back open to an earlier column where the panels there make way for it, else moves on open to
   * a later column where they do (see roomFor); else it folds, else it moves on folded. A panel
   * used on screen never hides: at the bottom of a column its title line is enough (the rest may
   * reach below the view), else the panels above it fold for its title. Tables that would hide
   * fewer than MIN_FOLD_ROWS rows fold only for a fuller table, or a title. The selected panel,
   * the ones the selected step links to and the ones turned to their instrument face never fold.
   * A panel turned to its instrument face takes the top of its column and of the next one. A
   * selected panel is kept whole on screen: when it would not be, it moves to the top of its
   * column. Returns true when anything moved.
   *
   * `viewHeight` is the height of the whole view, which sets the reach and tells a zoom; the room
   * for panels [yBottom, yTop] is shorter while the track header rests lower, at the start of the
   * song.
   */
  stick(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): boolean {
    // A panel that had to make way may find room once the others settled: a second pass places it.
    const moved = this.settle(track, yTop, yBottom, viewHeight)
    if (moved) this.settle(track, yTop, yBottom, viewHeight)
    return moved
  }

  /** One pass of stick(). */
  private settle(track: number, yTop: number, yBottom: number, viewHeight: number): boolean {
    const trackLayout = this.tracks[track]
    if (!trackLayout) return false
    const { cols, panels } = trackLayout
    const view             = yTop - yBottom
    const reach            = Math.max(viewHeight, MIN_REACH_PHRASES * PHRASE_HEIGHT)
    // Zoomed in or out since the grid was laid out: every panel chooses its column afresh, in the order it had.
    const packed           = this.packedFor.get(track)
    const repack           = packed == null || Math.abs(viewHeight / packed - 1) > REPACK_ZOOM
    if (repack) this.packedFor.set(track, viewHeight)
    const placings         : Placing[] = []
    for (const panel of panels) {
      const firstY = this.rowY(panel.row)
      const lastY  = this.rowY(panel.lastRow) - ROW_H
      const margin = reach * (panel.visible ? 0.3 : 0.1)
      if (firstY <= yBottom - margin || lastY >= yTop + margin) continue
      const [distance, useY] = this.viewDistance(panel, yTop, yBottom)
      const band             = this.bandOf(panel, distance, reach)
      const turned           = panel.chars > PANEL_CHARS
      const wide             = turned && cols > 1
      const last             = cols - 1 - (wide ? 1 : 0)
      const foldable         = !panel.pinned && !panel.linked && !turned
      const from             = panel.pinned || turned ? 0 : Math.min(band, last)
      placings.push({
        panel,
        band,
        now     : distance <= 0 || (panel.visible && panel.now && distance <= Math.max(NOW_HYSTERESIS * viewHeight, PHRASE_HEIGHT)),
        useY,
        turned,
        wide,
        promoted: panel.pinned && panel.promoted,
        foldable,
        from,
        last,
        // It keeps its column while it stays as near (or goes further) and may still take it.
        col     : !repack && panel.visible && band >= panel.band && panel.col >= from && panel.col <= last ? panel.col : -1,
        seq     : panel.seq,
        folded  : foldable && band >= FAR_BAND,
        hidden  : false
      })
    }

    const members    = (col: number) => placings.filter((p) => !p.hidden && (p.col === col || (p.wide && p.col === col - 1)))
    const stackOrder = (list: Placing[]) => list.sort((a, b) => Number(b.turned || b.promoted) - Number(a.turned || a.promoted) || a.seq - b.seq)
    const evictable  = (p: Placing) => p.foldable && p.band >= FAR_BAND
    // Folding a table that shows fewer rows than that would only move the panels below it.
    const folds      = (p: Placing) => p.foldable && !p.folded && p.panel.rows - TITLE_ROWS >= MIN_FOLD_ROWS
    /**
     * Whether `placing` fits in a column at `rows` rows: far panels there make way for a nearer
     * one and, for one used on screen, the panels there that are not fold.
     */
    const fitsIn     = (col: number, placing: Placing, rows: number) => {
      const others = members(col).filter((m) => m !== placing && !(evictable(m) && !evictable(placing)))
      const yields = (m: Placing) => placing.now && !m.now && folds(m)
      const extra  = others.length ? panelSpan(rows) : rows * ROW_H
      return stackHeight(others, (m) => (yields(m) ? TITLE_ROWS : placingRows(m))) + extra <= view + 1e-6
    }
    const fitsAt     = (col: number, placing: Placing, rows: number) => fitsIn(col, placing, rows) && (!placing.wide || fitsIn(col + 1, placing, rows))
    const columns    = (placing: Placing, from = placing.from) => Array.from({ length: Math.max(0, placing.last - from + 1) }, (_, i) => from + i)
    const takes      = (placing: Placing, col: number) => {
      if (repack || !(placing.panel.visible && placing.panel.col === col && placing.col < 0)) placing.seq = ++this.arrivals
      placing.col = col
    }
    /**
     * The panels of column `col` that make way for `placing` (used on screen) to open there, the
     * lowest first: the ones not used on screen fold, far ones hide, then tables with fewer rows
     * in them fold (with `emptyRowsOnly`, only the ones that show empty rows: trimming off), as
     * long as they hide fewer rows than it shows. Null when that is not enough.
     */
    const roomFor    = (col: number, placing: Placing, emptyRowsOnly = false): { fold: Placing[]; hide: Placing[] } | null => {
      const here   = members(col).filter((m) => m !== placing)
      const own    = here.filter((m) => m.col === col && m.foldable).sort((a, b) => b.seq - a.seq)
      const fold   : Placing[] = []
      const hide   : Placing[] = []
      let height   = stackHeight(here) + (here.length ? panelSpan(placingRows(placing)) : placingRows(placing) * ROW_H)
      let lost     = 0
      const enough = () => height <= view + 1e-6
      for (const m of own.filter((m) => !m.now && folds(m))) {
        if (enough()) break
        fold.push(m)
        height -= (m.panel.rows - TITLE_ROWS) * ROW_H
      }
      for (const m of own.filter(evictable)) {
        if (enough()) break
        hide.push(m)
        height -= panelSpan(placingRows(m))
      }
      const shows = (m: Placing) => !emptyRowsOnly || m.panel.rows - TITLE_ROWS > m.panel.contentRows
      for (const m of own.filter((m) => m.now && !m.folded && m.panel.rows > TITLE_ROWS && m.panel.contentRows < placing.panel.contentRows && shows(m))) {
        if (enough()) break
        fold.push(m)
        height -= (m.panel.rows - TITLE_ROWS) * ROW_H
        lost   += m.panel.contentRows
      }
      return enough() && (lost === 0 || lost < placing.panel.contentRows) ? { fold, hide } : null
    }

    // Newcomers, and panels that came nearer, in band order, then in the order they had (after a zoom), then in the order of their uses.
    const had    = (p: Placing) => (p.panel.visible ? p.seq : Number.POSITIVE_INFINITY)
    const movers = placings.filter((p) => p.col < 0).sort((a, b) => a.band - b.band || had(a) - had(b) || b.useY - a.useY || a.panel.table - b.panel.table)
    for (const placing of movers) {
      if (placing.turned) {
        takes(placing, Math.min(Math.max(placing.panel.visible ? placing.panel.col : 0, placing.from), placing.last))
        continue
      }
      const open   = columns(placing).find((col) => fitsAt(col, placing, placingRows(placing)))
      const folded = placing.foldable ? columns(placing).find((col) => fitsAt(col, placing, TITLE_ROWS)) : undefined
      const chosen = open ?? folded
      if (chosen == null && evictable(placing)) {
        placing.hidden = true
        continue
      }
      // No room anywhere: the column where it reaches least far down.
      const roomiest = columns(placing).reduce((best, col) => (stackHeight(members(col)) < stackHeight(members(best)) ? col : best), placing.from)
      takes(placing, chosen ?? roomiest)
    }

    // Columns with too little room: the least useful make way, lowest first.
    for (let col = 0; col < cols; col += 1) {
      const over   = () => stackHeight(members(col)) - view > 1e-6
      const lowest = (list: Placing[]) => list.filter((p) => p.col === col).sort((a, b) => b.seq - a.seq)
      // Empty tables fold, then panels not used on screen, the furthest first, then the ones with the least in their tables; far ones hide.
      const empty  = (p: Placing) => Number(p.panel.contentRows === 0)
      for (const p of lowest(members(col).filter((m) => folds(m) && (!m.now || m.panel.contentRows === 0)))
        .sort((a, b) => empty(b) - empty(a) || b.band - a.band || a.panel.contentRows - b.panel.contentRows)) {
        if (!over()) break
        p.folded = true
      }
      for (const p of lowest(members(col).filter(evictable))) {
        if (!over()) break
        p.hidden = true
      }
      if (!over()) continue
      // Still too little: from the top, so the panels there longest keep their place, and each
      // lower one that does not fit makes way (see makeRoom).
      let height     = -PANEL_GAP_ROWS * ROW_H
      const above    : Placing[] = []
      const fits     = (rows: number) => height + panelSpan(rows) <= view + 1e-6
      /**
       * Room below the panels above for `rows` more rows, when that is enough: the titles there of
       * panels not used on screen move on to a later column (or hide), then the panels there that
       * `fold` picks fold, the lowest first, as long as they hide fewer table rows than `budget`.
       */
      const makeRoom = (rows: number, fold: (m: Placing) => boolean, budget = Number.POSITIVE_INFINITY): boolean => {
        const room   = (h: number) => h + panelSpan(rows) <= view + 1e-6
        const titles : Placing[] = []
        const opens  : Placing[] = []
        let left     = height
        let lost     = 0
        for (const m of above.filter((m) => m.col === col && m.foldable && m.folded && !m.now).reverse()) {
          if (room(left)) break
          titles.push(m)
          left -= panelSpan(TITLE_ROWS)
        }
        for (const m of above.filter((m) => m.col === col && m.foldable && !m.folded && m.panel.rows > TITLE_ROWS && fold(m)).reverse()) {
          if (room(left)) break
          opens.push(m)
          left -= (m.panel.rows - TITLE_ROWS) * ROW_H
          lost += m.panel.contentRows
        }
        if (!room(left) || lost >= budget) return false
        for (const title of titles) {
          const to = columns(title, col + 1).find((c) => fitsAt(c, title, TITLE_ROWS))
          if (to != null) takes(title, to)
          else title.hidden = true
        }
        for (const open of opens) open.folded = true
        height = left
        return true
      }
      for (const p of stackOrder(members(col))) {
        // One used on screen opens once the titles above make way, or tables above with less in them fold.
        const short = p.col === col && !fits(placingRows(p))
        const less  = (m: Placing) => m.panel.contentRows < p.panel.contentRows
        if (short && !(p.now && (makeRoom(placingRows(p), () => false) || makeRoom(placingRows(p), less, p.panel.contentRows)))) {
          const movable = !p.turned && !p.promoted
          const later   = (rows: number) => (movable ? columns(p, col + 1).find((c) => fitsAt(c, p, rows)) : undefined)
          // One used on screen moves back open to an earlier column where the panels there make
          // way for it (tables used on screen only when they show empty rows).
          const back    = movable && p.now ? columns(p).find((c) => c < col && roomFor(c, p, true)) : undefined
          if (back != null) {
            const room = roomFor(back, p, true) as { fold: Placing[]; hide: Placing[] }
            for (const m of room.fold) m.folded = true
            for (const m of room.hide) m.hidden = true
            takes(p, back)
            continue
          }
          // Else it moves on open to a later column with room; else it folds, when that is
          // enough; else it moves on folded.
          const open   = movable && p.now ? columns(p, col + 1).find((c) => roomFor(c, p)) : undefined
          const folded = open == null && !(folds(p) && fits(TITLE_ROWS)) ? later(p.foldable ? TITLE_ROWS : placingRows(p)) : undefined
          if (open != null || folded != null) {
            if (open == null) p.folded = p.foldable
            takes(p, (open ?? folded) as number)
            continue
          }
          if (folds(p) && fits(TITLE_ROWS)) p.folded = true
          // Used on screen, at the bottom: its title line is enough, rather than folding the tables above.
          else if (p.now && p.foldable && fits(1)) p.folded = folds(p)
          else if (p.foldable && !p.now) {
            // Not used on screen: it hides.
            p.hidden = true
            continue
          } else if (makeRoom(p.foldable ? TITLE_ROWS : placingRows(p), () => true)) p.folded = p.foldable
          else if (p.foldable) {
            // Used on screen: the panels above fold for its title, and it hides only when even that is not enough.
            p.hidden = true
            continue
          }
          // Selected or linked, with no room even then: it is cut at the bottom.
        }
        height += panelSpan(placingRows(p))
        above.push(p)
      }
    }

    // Stack each column from the top: turned and promoted panels first, then in the order they came in.
    const stack = () => {
      const ys = new Map<Placing, number>()
      for (let col = 0; col < cols; col += 1) {
        const ordered = stackOrder(members(col))
        let ceiling   = yTop
        for (const p of ordered) {
          const y = ys.get(p) ?? ceiling
          ys.set(p, y)
          ceiling = Math.min(ceiling, y - panelSpan(placingRows(p)))
        }
      }
      return ys
    }
    let ys      = stack()
    const cut   = placings.filter((p) => p.panel.pinned && !p.promoted && (ys.get(p) ?? yTop) - placingRows(p) * ROW_H < yBottom - 1e-6)
    if (cut.length) {
      for (const p of cut) p.promoted = true
      ys = stack()
    }

    let moved     = false
    const byPanel = new Map(placings.map((p) => [p.panel, p]))
    for (const panel of panels) {
      const placing = byPanel.get(panel)
      const at      = placing ? ys.get(placing) : undefined
      const visible = at != null && placing != null
      const y       = at ?? panel.naturalY
      const col     = visible ? placing.col : panel.col
      const folded  = visible && placing.folded
      if (visible !== panel.visible || col !== panel.col || folded !== panel.folded || Math.abs(y - panel.y) > 1e-3) moved = true
      panel.visible  = visible
      panel.band     = placing?.band ?? panel.band
      panel.now      = visible && placing.now
      panel.seq      = placing?.seq ?? panel.seq
      panel.y        = y
      panel.col      = col
      panel.u        = panelU(col)
      panel.folded   = folded
      panel.promoted = visible && placing.promoted
    }
    return moved
  }

  /**
   * The panels stick() would show for the view [yBottom, yTop], with the wall u of their column,
   * their top y and the rows they would show, without moving any: for framing a view the camera
   * is not at yet.
   */
  probe(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): ShownPanel[] {
    const panels   = this.tracks[track]?.panels ?? []
    const arrivals = this.arrivals
    const packed   = this.packedFor.get(track)
    const saved    = panels.map((panel) => ({
      visible : panel.visible,
      y       : panel.y,
      col     : panel.col,
      u       : panel.u,
      band    : panel.band,
      now     : panel.now,
      seq     : panel.seq,
      folded  : panel.folded,
      promoted: panel.promoted
    }))
    this.stick(track, yTop, yBottom, viewHeight)
    const shown = panels.filter((panel) => panel.visible).map((panel) => ({
      panel,
      u   : panel.u,
      y   : panel.y,
      rows: shownPanelRows(panel)
    }))
    panels.forEach((panel, i) => {
      Object.assign(panel, saved[i])
    })
    this.arrivals = arrivals
    if (packed == null) this.packedFor.delete(track)
    else this.packedFor.set(track, packed)
    return shown
  }

  /** Top y of the stretch that uses a panel nearest to the view [yBottom, yTop]. */
  nearestUseY(panel: Panel, yTop: number, yBottom: number): number {
    return this.viewDistance(panel, yTop, yBottom)[1]
  }

  /** Top y of a use stretch, and the y of its bottom edge. */
  private spanTop(span: UseSpan): number {
    return this.rowY(span[0])
  }

  private spanBottom(span: UseSpan): number {
    return this.rowY(span[1]) - ROW_H
  }

  /** Height between the view [yBottom, yTop] and the nearest stretch that uses a panel (0 when one is on screen), and that stretch's top y. */
  private viewDistance(panel: Panel, yTop: number, yBottom: number): [distance: number, top: number] {
    let nearest = Number.POSITIVE_INFINITY
    let top     = this.rowY(panel.row)
    for (const span of panel.spans) {
      const spanTop  = this.spanTop(span)
      const bottom   = this.spanBottom(span)
      const distance = spanTop < yBottom ? yBottom - spanTop : bottom > yTop ? bottom - yTop : 0
      if (distance < nearest) [nearest, top] = [distance, spanTop]
    }
    return [nearest, top]
  }

  /**
   * A panel's distance band for a reach `reach` (see DISTANCE_BANDS), from the height between
   * the view and its nearest use. It comes to the first band as soon as one of its uses is on
   * screen; otherwise a shown panel keeps its band until it is BAND_HYSTERESIS of a reach past
   * that band's edges.
   */
  private bandOf(panel: Panel, distance: number, reach: number): number {
    if (distance <= 0) return 0
    const bandAt = DISTANCE_BANDS.findIndex((edge) => distance <= edge * reach)
    const band   = bandAt < 0 ? FAR_BAND : bandAt
    if (!panel.visible || band === panel.band) return band
    const low   = panel.band > 0 ? DISTANCE_BANDS[panel.band - 1] * reach : 0
    const high  = panel.band < FAR_BAND ? DISTANCE_BANDS[panel.band] * reach : Number.POSITIVE_INFINITY
    const slack = BAND_HYSTERESIS * reach
    return distance >= low - slack && distance <= high + slack ? panel.band : band
  }
}
