// Edits made on the M8: what absorbEdit says changed, and which tracks a new layout of the song
// draws differently (SongLayout.trackSignature), so the scene redraws only those.

import { describe, expect, test } from 'bun:test'
import type { M8Screen } from '@yam8d/m8-sdk'
import { absorbEdit } from '../src/m8/screen/liveScreen'
import { demoSong } from '../src/model/demo'
import { phraseScreen } from '../src/model/screens'
import { TRACKS } from '../src/model/song'
import { buildSongContext } from '../src/model/songContext'
import { SongLayout } from '../src/scene/layout'

const screenOf   = (lines: string[]): M8Screen => ({
  width : 40,
  height: 24,
  lines
})
const signatures = (layout: SongLayout) => Array.from({ length: TRACKS }, (_, track) => layout.trackSignature(track))
/** The tracks whose signature differs between two layouts. */
const changed    = (before: string[], after: SongLayout) => signatures(after).flatMap((signature, track) => (signature === before[track] ? [] : [track]))
/** Tracks that play a phrase. */
const playing    = (layout: SongLayout, phrase: number) => [...new Set((layout.timeline.byPhrase.get(phrase) ?? []).map((instance) => instance.track))].sort()

describe('an edit read from the M8 screen', () => {
  test('names the item it changed, once', () => {
    const model          = demoSong()
    const id             = Number(Object.keys(model.phrases)[0])
    const edited         = structuredClone(model.phrases[id])
    edited.steps[3].note = 'C-5'
    const screen         = screenOf(phraseScreen(edited))
    expect(absorbEdit(model, screen)).toEqual({
      kind: 'phrase',
      id
    })
    expect(model.phrases[id].steps[3].note).toBe('C-5')
    expect(absorbEdit(model, screen)).toBeNull()
  })
})

describe('the tracks an edit redraws', () => {
  test('a phrase edit changes only the tracks that play the phrase', () => {
    const model       = demoSong()
    const before      = new SongLayout(buildSongContext(model))
    const old         = signatures(before)
    const id          = before.timeline.instances[0].phrase
    model.phrases[id] = {
      ...model.phrases[id],
      steps: model.phrases[id].steps.map((step, s) => (s === 5 ? {
        ...step,
        note: step.note === 'D-4' ? 'E-4' : 'D-4'
      } : step))
    }
    expect(changed(old, new SongLayout(buildSongContext(model)))).toEqual(playing(before, id))
  })

  test('the same song draws every track alike; a project transpose redraws them all', () => {
    const model = demoSong()
    const old   = signatures(new SongLayout(buildSongContext(model)))
    expect(changed(old, new SongLayout(buildSongContext(model)))).toEqual([])
    model.projectTranspose = (model.projectTranspose ?? 0) + 1
    expect(changed(old, new SongLayout(buildSongContext(model)))).toEqual(Array.from({ length: TRACKS }, (_, track) => track))
  })

  test('a new layout takes over where the panels of the old one were and how they showed', () => {
    const model  = demoSong()
    const before = new SongLayout(buildSongContext(model))
    const panel  = before.tracks.flatMap((track) => track.panels)[0]
    Object.assign(panel, {
      visible: true,
      y      : -12,
      shownY : -11,
      alpha  : 0.7,
      flip   : 1,
      col    : 1,
      seq    : 9,
      folded : true
    })
    const after  = new SongLayout(buildSongContext(model))
    after.adoptState(before)
    const same   = after.tracks[panel.track].panels.find((other) => other.table === panel.table)
    expect(same).toMatchObject({
      visible: true,
      y      : -12,
      shownY : -11,
      alpha  : 0.7,
      flip   : 1,
      col    : 1,
      seq    : 9,
      folded : true
    })
  })
})
