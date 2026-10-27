import { describe, expect, test } from 'bun:test'
import { demoSong } from '../src/model/demo'
import { emptyModel, emptyStep, type SongModel, TRACKS } from '../src/model/song'
import { FACE_CHARS } from '../src/scene/instrumentFace'
import { MAX_PANEL_COLS, PANEL_ROWS, PANEL_SPAN, type Panel, panelSpan, ROW_H, SongLayout, shownPanelRows, TITLE_ROWS } from '../src/scene/layout'

/** The demo song with track 0's first phrase using `n` different instruments, one per step. */
function crowded(n: number): SongModel {
  const model  = demoSong()
  const layout = new SongLayout(model)
  const first  = layout.tracks[0].instances[0]
  const phrase = model.phrases[first.phrase]
  phrase.steps.forEach((step, s) => {
    if (s < n) Object.assign(step, {
      note: 'C-4',
      inst: s
    })
  })
  return model
}

/** `model` with the tables of instruments 0..n-1 full: a transpose on every row. */
function fullTables(model: SongModel, n: number): SongModel {
  for (let id = 0; id < n; id += 1) {
    model.tables[id] = {
      id,
      rows: Array.from({ length: 16 }, () => ({
        transpose: 1,
        volume   : null,
        fx       : [{
          cmd: null,
          val: null
        }, {
          cmd: null,
          val: null
        }, {
          cmd: null,
          val: null
        }]
      }))
    }
  }
  return model
}

/** A song on track 0 playing `phrases` (each a list of [step, instrument]) one after the other, 16 to a chain. */
function songOf(phrases: [step: number, inst: number][][]): SongModel {
  const model  = emptyModel('demo')
  const chains = Math.ceil(phrases.length / 16)
  model.song   = Array.from({ length: chains }, (_, chain) => [chain, null, null, null, null, null, null, null])
  for (let chain = 0; chain < chains; chain += 1) {
    model.chains[chain] = {
      id  : chain,
      rows: Array.from({ length: 16 }, (_, row) => ({
        phrase   : chain * 16 + row < phrases.length ? chain * 16 + row : null,
        transpose: 0
      }))
    }
  }
  phrases.forEach((notes, id) => {
    const steps = Array.from({ length: 16 }, emptyStep)
    for (const [step, inst] of notes) Object.assign(steps[step], {
      note: 'C-4',
      inst
    })
    model.phrases[id] = {
      id,
      steps
    }
  })
  return model
}

/** First timeline row of a phrase of a songOf() song. */
const phraseRow = (phrase: number) => phrase * 16

describe('panel columns', () => {
  test('more panels in view than fit one column spread over columns without overlapping', () => {
    const layout = new SongLayout(crowded(8))
    const track  = layout.tracks[0]
    expect(track.cols).toBeGreaterThan(1)
    expect(track.cols).toBeLessThanOrEqual(MAX_PANEL_COLS)
    expect(track.wallLen).toBeGreaterThan(layout.tracks[TRACKS - 1].wallLen - 1e-9)

    // A view that holds three panels' worth of rows at the top of the song.
    const yTop = layout.rowY(0)
    layout.stick(0, yTop, yTop - PANEL_SPAN * 3)
    const shown = track.panels.filter((p) => p.visible)
    expect(shown.length).toBeGreaterThan(3)
    expect(new Set(shown.map((p) => p.col)).size).toBeGreaterThan(1)
    for (const a of shown) {
      for (const b of shown) {
        if (a !== b && a.col === b.col && a.y > b.y) expect(a.y - b.y).toBeGreaterThanOrEqual(panelSpan(shownPanelRows(a)) - 1e-6)
      }
    }
  })

  test('a panel keeps its column while the view scrolls a little', () => {
    const layout = new SongLayout(crowded(8))
    const yTop   = layout.rowY(0)
    layout.stick(0, yTop, yTop - PANEL_SPAN * 3)
    const before = layout.tracks[0].panels.map((p) => p.col)
    layout.stick(0, yTop - 1.5, yTop - 1.5 - PANEL_SPAN * 3)
    expect(layout.tracks[0].panels.map((p) => p.col)).toEqual(before)
  })

  test('a track with few panels keeps one column, two when an instrument face may span them', () => {
    const layout = new SongLayout(demoSong())
    for (const t of layout.tracks) {
      const faces = t.panels.some((p) => layout.instrumentFace(p.instrument))
      if (t.panels.length <= 2) expect(t.cols).toBe(faces ? 2 : 1)
    }
  })

  test('a panel turned to its instrument face never takes the last column', () => {
    const layout = new SongLayout(demoSong())
    const track  = layout.tracks.find((t) => t.panels.some((p) => layout.instrumentFace(p.instrument)))
    if (!track) throw new Error('the demo song has no instrument panel')
    const panel = track.panels.find((p) => layout.instrumentFace(p.instrument)) as Panel
    panel.chars = FACE_CHARS
    panel.col   = track.cols - 1
    const yTop  = layout.rowY(panel.row)
    layout.stick(track.track, yTop, yTop - PANEL_SPAN * 3)
    expect(panel.visible).toBe(true)
    expect(panel.col).toBeLessThan(track.cols - 1)
  })
})

describe('panel sizes and folding', () => {
  test('a table shows down to its last row with content, an empty one only its title lines', () => {
    const model = crowded(3)
    fullTables(model, 1)
    model.tables[1] = {
      id  : 1,
      rows: (model.tables[0]?.rows ?? []).map((row, r) => ({
        ...row,
        transpose: r === 4 ? 1 : 0
      }))
    }
    model.tables[2] = {
      id  : 2,
      rows: (model.tables[0]?.rows ?? []).map((row) => ({
        ...row,
        transpose: 0
      }))
    }
    const panels    = new SongLayout(model).tracks[0].panels
    const rows      = (table: number) => panels.find((p) => p.table === table)?.rows
    expect(rows(0)).toBe(PANEL_ROWS)
    expect(rows(1)).toBe(TITLE_ROWS + 5)
    expect(rows(2)).toBe(TITLE_ROWS)
  })

  test('with trimming off, every table shows its 16 rows', () => {
    const model = crowded(3)
    fullTables(model, 1)
    const layout = new SongLayout(model, false)
    for (const panel of layout.tracks[0].panels) expect(layout.tableFaceRows(panel)).toBe(PANEL_ROWS)
  })

  test('when panels used on screen do not fit, the lowest fold, none hides and none is pushed off the bottom', () => {
    const layout  = new SongLayout(fullTables(crowded(14), 14))
    const track   = layout.tracks[0]
    const yTop    = layout.rowY(0)
    const yBottom = yTop - PANEL_SPAN * 2
    layout.stick(0, yTop, yBottom)
    const used = track.panels.filter((p) => p.table < 14)
    expect(used.every((p) => p.visible)).toBe(true)
    expect(used.some((p) => p.folded)).toBe(true)
    expect(used.some((p) => !p.folded)).toBe(true)
    for (const p of used) expect(p.y - shownPanelRows(p) * ROW_H).toBeGreaterThanOrEqual(yBottom - 1e-6)
    // Down each column the open panels come first: the ones there longest keep their tables.
    for (let col = 0; col < track.cols; col += 1) {
      const column = used.filter((p) => p.col === col).sort((a, b) => b.y - a.y)
      const first  = column.findIndex((p) => p.folded)
      if (first >= 0) expect(column.slice(first).every((p) => p.folded)).toBe(true)
    }
  })

  test('panels not used on screen fold before the ones that are', () => {
    // Instruments 0-5 play in the first and last phrases, only 0-2 in between.
    const all    = [0, 1, 2, 3, 4, 5].map((inst): [number, number] => [inst, inst])
    const layout = new SongLayout(fullTables(songOf([all, ...Array.from({ length: 5 }, () => all.slice(0, 3)), all]), 6))
    const track  = layout.tracks[0]
    const panel  = (table: number) => track.panels.find((p) => p.table === table) as Panel
    const yTop   = layout.rowY(phraseRow(2))
    layout.stick(0, yTop, yTop - PANEL_SPAN * 1.2)
    for (const table of [0, 1, 2]) expect(panel(table).folded).toBe(false)
    for (const table of [3, 4, 5]) expect(panel(table).visible && panel(table).folded).toBe(true)
  })

  test('a table used on screen opens before the tables above it with less in them', () => {
    // Instrument 1 comes first with one row in its table, instrument 2 below it with sixteen; trimming off.
    const both  : [number, number][] = [
      [0, 1],
      [2, 2]
    ]
    const model = fullTables(songOf(Array.from({ length: 4 }, () => both)), 3)
    model.tables[1].rows.forEach((row, r) => {
      row.transpose = r === 0 ? 1 : 0
    })
    const layout = new SongLayout(model, false)
    const panel  = (table: number) => layout.tracks[0].panels.find((p) => p.table === table) as Panel
    const yTop   = layout.rowY(phraseRow(1))
    layout.stick(0, yTop, yTop - PANEL_SPAN * 1.2)
    expect(panel(1).y).toBeGreaterThan(panel(2).y)
    expect(panel(1).folded).toBe(true)
    expect(panel(2).folded).toBe(false)
  })

  test('tables of one row do not fold for one another: the ones with no room show at least their title line', () => {
    const model   = crowded(14)
    model.tables  = {}
    const layout  = new SongLayout(model)
    const yTop    = layout.rowY(0)
    const yBottom = yTop - PANEL_SPAN * 0.8
    layout.stick(0, yTop, yBottom)
    const used = layout.tracks[0].panels.filter((p) => p.table < 14)
    expect(used.length).toBe(14)
    for (const panel of used) {
      expect(panel.rows).toBeLessThan(TITLE_ROWS + 2)
      expect(panel.visible).toBe(true)
      expect(panel.folded).toBe(false)
      expect(panel.y - ROW_H).toBeGreaterThanOrEqual(yBottom - 1e-6)
    }
  })

  test('at the bottom of a full column, a table used on screen shows its title line rather than fold the one above', () => {
    // One column, two sixteen-row tables used on screen, room for one and a line.
    const both   : [number, number][] = [
      [0, 1],
      [2, 2]
    ]
    const layout = new SongLayout(fullTables(songOf(Array.from({ length: 4 }, () => both)), 3), false)
    const panel  = (table: number) => layout.tracks[0].panels.find((p) => p.table === table) as Panel
    const yTop   = layout.rowY(phraseRow(1))
    const bottom = yTop - PANEL_SPAN - ROW_H * 1.2
    layout.stick(0, yTop, bottom)
    expect(layout.tracks[0].cols).toBe(1)
    expect(panel(1).folded).toBe(false)
    expect(panel(2).folded).toBe(true)
    expect(panel(2).y - ROW_H).toBeGreaterThanOrEqual(bottom - 1e-6)
  })

  test('empty tables fold before tables with something in them', () => {
    const model = crowded(14)
    fullTables(model, 7)
    for (let id = 7; id < 14; id += 1) {
      model.tables[id] = {
        id,
        rows: (model.tables[0]?.rows ?? []).map((row) => ({
          ...row,
          transpose: 0
        }))
      }
    }
    const layout  = new SongLayout(model, false)
    const track   = layout.tracks[0]
    const yTop    = layout.rowY(0)
    const yBottom = yTop - PANEL_SPAN * 2
    for (const panel of track.panels) panel.rows = layout.tableFaceRows(panel)
    layout.stick(0, yTop, yBottom)
    const shown = track.panels.filter((p) => p.visible)
    expect(shown.some((p) => p.folded)).toBe(true)
    if (shown.some((p) => p.folded && p.contentRows > 0)) expect(shown.every((p) => p.contentRows > 0 || p.folded)).toBe(true)
  })

  test('a pinned panel never folds and comes whole on screen, even from low in a crowded view', () => {
    const layout  = new SongLayout(fullTables(crowded(14), 14))
    const track   = layout.tracks[0]
    const yTop    = layout.rowY(0)
    const yBottom = yTop - PANEL_SPAN * 2
    layout.stick(0, yTop, yBottom)
    // The lowest folded panel: opened where it is, it would reach past the bottom.
    const last = track.panels.filter((p) => p.folded).sort((a, b) => a.y - b.y)[0]
    expect(last.y - last.rows * ROW_H).toBeLessThan(yBottom)
    last.pinned = true
    layout.stick(0, yTop, yBottom)
    expect(last.folded).toBe(false)
    expect(last.y).toBeLessThanOrEqual(yTop + 1e-6)
    expect(last.y - last.rows * ROW_H).toBeGreaterThanOrEqual(yBottom - 1e-6)
  })

  test('a panel the selected step links to never folds', () => {
    const layout  = new SongLayout(fullTables(crowded(14), 14))
    const track   = layout.tracks[0]
    const yTop    = layout.rowY(0)
    const yBottom = yTop - PANEL_SPAN * 2
    layout.stick(0, yTop, yBottom)
    const folded  = track.panels.find((p) => p.folded) as Panel
    folded.linked = true
    layout.stick(0, yTop, yBottom)
    expect(folded.folded).toBe(false)
  })
})

describe('which panels show, and in which column', () => {
  // Views here are one or two phrases high, so distances are measured in reaches of MIN_REACH_PHRASES (6) phrases.
  test('a panel used far apart stays between its uses, further along the wall the further away its next use is', () => {
    const busy   : [number, number][] = [
      [0, 1],
      [2, 2],
      [4, 3],
      [6, 4],
      [8, 5]
    ]
    const layout = new SongLayout(songOf([[[0, 0x20]], ...Array.from({ length: 29 }, () => busy), [[0, 0x20]]]))
    const track  = layout.tracks[0]
    const panel  = (table: number) => track.panels.find((p) => p.table === table) as Panel
    const view   = (phrase: number) => layout.stick(0, layout.rowY(phraseRow(phrase)), layout.rowY(phraseRow(phrase)) - 32 * ROW_H)
    expect(track.cols).toBe(3)
    // Phrases 0D-0E on screen: its uses are more than one and a half reaches away.
    view(13)
    expect(panel(0x20).visible).toBe(true)
    expect(panel(0x20).col).toBe(2)
    expect(panel(1).col).toBe(0)
    // Its next use within a reach: one column nearer.
    view(23)
    expect(panel(0x20).col).toBe(1)
    // On screen: the first column, below the panels already there.
    view(30)
    expect(panel(0x20).col).toBe(0)
    expect(panel(0x20).y).toBeLessThan(panel(5).y)
  })

  test('a panel used further than four reaches away shows its title lines only', () => {
    const layout = new SongLayout(fullTables(songOf([[[0, 0]], ...Array.from({ length: 62 }, (): [number, number][] => [[0, 1]]), [[0, 0]]]), 1))
    const panel  = layout.tracks[0].panels.find((p) => p.table === 0) as Panel
    const view   = (phrase: number) => layout.stick(0, layout.rowY(phraseRow(phrase)), layout.rowY(phraseRow(phrase)) - 32 * ROW_H)
    view(31)
    expect(panel.visible).toBe(true)
    expect(panel.folded).toBe(true)
    view(63)
    expect(panel.folded).toBe(false)
  })

  test('panels that come in together stack in the order of their uses, from the top', () => {
    const busy   : [number, number][] = [
      [0, 3],
      [2, 1],
      [4, 2]
    ]
    const layout = new SongLayout(songOf(Array.from({ length: 8 }, () => busy)))
    const track  = layout.tracks[0]
    layout.stick(0, layout.rowY(16), layout.rowY(48))
    const ys = [3, 1, 2].map((table) => (track.panels.find((p) => p.table === table) as Panel).y)
    expect(ys[0]).toBeGreaterThan(ys[1])
    expect(ys[1]).toBeGreaterThan(ys[2])
    expect(ys[0]).toBeCloseTo(layout.rowY(16), 6)
  })

  test('the grid stays still while the view moves within a band', () => {
    const busy   : [number, number][] = [
      [0, 3],
      [2, 1],
      [4, 2]
    ]
    const layout = new SongLayout(songOf(Array.from({ length: 8 }, () => busy)))
    const track  = layout.tracks[0]
    const places = () => track.panels.map((p) => [p.table, p.col, Math.round(p.y * 1000)])
    layout.stick(0, layout.rowY(16), layout.rowY(48))
    const first = places()
    // Scroll by one row at a time, as when following playback: nothing moves on screen.
    for (let row = 17; row < 64; row += 1) {
      layout.stick(0, layout.rowY(row), layout.rowY(row + 32))
      const shift = layout.rowY(row) - layout.rowY(16)
      expect(places()).toEqual(first.map(([table, col, y]) => [table, col, Math.round(y + shift * 1000)]))
    }
  })

  test('a panel used more than half a reach away steps aside, and comes back to the first column when on screen', () => {
    const both   : [number, number][] = [
      [0, 0],
      [2, 1]
    ]
    const layout = new SongLayout(songOf([[...both, [4, 4]], ...Array.from({ length: 8 }, () => both), [[0, 4]]]))
    const track  = layout.tracks[0]
    const panel  = (table: number) => track.panels.find((p) => p.table === table) as Panel
    const view   = (phrase: number) => layout.stick(0, layout.rowY(phraseRow(phrase)), layout.rowY(phraseRow(phrase)) - 16 * ROW_H)
    expect(track.cols).toBeGreaterThan(1)
    // Phrase 4 on screen: instrument 4 was last played four phrases above, and comes back five below.
    view(4)
    for (const table of [0, 1]) expect(panel(table).col).toBe(0)
    expect(panel(4).visible).toBe(true)
    expect(panel(4).col).toBeGreaterThan(0)
    // Its phrase on screen: back in the first column.
    view(9)
    expect(panel(4).col).toBe(0)
  })

  test('a panel that comes in takes the bottom of its column: the ones there do not move, whatever their numbers', () => {
    const pair   : [number, number][] = [
      [0, 1],
      [2, 2]
    ]
    const layout = new SongLayout(songOf([...Array.from({ length: 12 }, () => pair), [...pair, [4, 0]]]))
    const track  = layout.tracks[0]
    const panel  = (table: number) => track.panels.find((p) => p.table === table) as Panel
    let came     = false
    for (let row = 0; row <= phraseRow(12); row += 1) {
      const yTop = layout.rowY(row)
      layout.stick(0, yTop, yTop - 16 * ROW_H)
      expect(panel(1).y).toBeCloseTo(yTop, 6)
      expect(panel(2).y).toBeLessThan(panel(1).y)
      if (!panel(0).visible) continue
      came = true
      expect(panel(0).y).toBeLessThan(panel(2).y)
    }
    expect(came).toBe(true)
  })

  test('after a zoom out, the grid is laid out afresh: panels come back to the first column, in the order they had', () => {
    const six    : [number, number][] = [0, 1, 2, 3, 4, 5].map((inst) => [inst * 2, inst])
    const layout = new SongLayout(fullTables(songOf(Array.from({ length: 8 }, () => six)), 6))
    const track  = layout.tracks[0]
    const yTop   = layout.rowY(phraseRow(2))
    layout.stick(0, yTop, yTop - PANEL_SPAN * 1.2)
    expect(track.panels.some((p) => p.col > 0)).toBe(true)
    const order = [...track.panels].sort((a, b) => a.seq - b.seq).map((p) => p.table)
    layout.stick(0, yTop, yTop - PANEL_SPAN * 7)
    expect(track.panels.every((p) => p.visible && p.col === 0 && !p.folded)).toBe(true)
    expect([...track.panels].sort((a, b) => b.y - a.y).map((p) => p.table)).toEqual(order)
  })

  test('a small zoom moves no panel to another column', () => {
    const six    : [number, number][] = [0, 1, 2, 3, 4, 5].map((inst) => [inst * 2, inst])
    const layout = new SongLayout(fullTables(songOf(Array.from({ length: 8 }, () => six)), 6))
    const track  = layout.tracks[0]
    const yTop   = layout.rowY(phraseRow(2))
    layout.stick(0, yTop, yTop - PANEL_SPAN * 2)
    const cols = track.panels.map((p) => p.col)
    layout.stick(0, yTop, yTop - PANEL_SPAN * 2.2)
    expect(track.panels.map((p) => p.col)).toEqual(cols)
  })

  test('less room under a header resting at the start of the song is not a zoom', () => {
    const three  : [number, number][] = [
      [0, 1],
      [2, 2],
      [4, 3]
    ]
    const layout = new SongLayout(songOf(Array.from({ length: 8 }, () => three)))
    const track  = layout.tracks[0]
    const yTop   = layout.rowY(phraseRow(1))
    const view   = PANEL_SPAN * 2
    layout.stick(0, yTop, yTop - view)
    const places = track.panels.map((p) => p.seq)
    layout.stick(0, yTop - view * 0.4, yTop - view, view)
    expect(track.panels.map((p) => p.seq)).toEqual(places)
    // The same room as the whole view is a zoom: the grid is laid out afresh.
    layout.stick(0, yTop - view * 0.4, yTop - view)
    expect(track.panels.map((p) => p.seq)).not.toEqual(places)
  })

  test('one call settles the grid: a second on the same view moves nothing', () => {
    const layout = new SongLayout(fullTables(crowded(14), 14))
    const yTop   = layout.rowY(0)
    for (let row = 0; row < 64; row += 1) {
      const top = yTop - row * ROW_H
      layout.stick(0, top, top - PANEL_SPAN * 1.5)
      expect(layout.stick(0, top, top - PANEL_SPAN * 1.5)).toBe(false)
    }
  })
})

describe('note instrument links', () => {
  test('a note with no instrument of its own links to the one the track played last', () => {
    const model  = demoSong()
    const layout = new SongLayout(model)
    const first  = layout.tracks[0].instances[0]
    const steps  = model.phrases[first.phrase].steps
    Object.assign(steps[0], {
      note: 'C-4',
      inst: 5,
      fx  : []
    })
    Object.assign(steps[1], {
      note: 'D-4',
      inst: null,
      fx  : []
    })
    Object.assign(steps[2], {
      note: 'OFF',
      inst: null,
      fx  : []
    })
    Object.assign(steps[3], {
      note: null,
      inst: null,
      fx  : []
    })
    const links = new SongLayout(model).noteInstrumentLinks(first)
    const rows  = links.filter((link) => link.step < 4)
    expect(rows.map((link) => [link.step, link.panel.table])).toEqual([[0, 5], [1, 5]])
    expect(rows[1].row).toBe(first.row + 1)
    expect(rows[1].col).toBe(rows[0].col)
  })
})
