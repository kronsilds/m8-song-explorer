import { describe, expect, test } from 'bun:test'
import { demoSong } from '../src/model/demo'
import { type SongModel, TRACKS } from '../src/model/song'
import { MAX_PANEL_COLS, PANEL_SPAN, SongLayout } from '../src/scene/layout'

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

  test('a track with few panels keeps one column', () => {
    const layout = new SongLayout(demoSong())
    for (const t of layout.tracks) expect(t.cols).toBeGreaterThanOrEqual(1)
    const one = layout.tracks.find((t) => t.panels.length <= 3)
    if (one) expect(one.cols).toBe(1)
  })
})
