import { describe, expect, test } from 'bun:test'
import { demoSong } from '../src/model/demo'
import { type SongModel, TRACKS } from '../src/model/song'
import { FACE_CHARS } from '../src/scene/instrumentFace'
import { MAX_PANEL_COLS, PANEL_SPAN, type Panel, SongLayout } from '../src/scene/layout'

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
        if (a !== b && a.col === b.col) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(PANEL_SPAN - 1e-6)
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
