import { describe, expect, test } from 'bun:test'
import type { M8Screen } from '@yam8d/m8-sdk'
import { DeviceCursor } from '../src/app/deviceCursor'
import { type DeviceFocus, deviceFocus } from '../src/m8/screen/liveScreen'
import { readChainMarks, viewChainPosition, viewOf } from '../src/m8/screen/screenReader'
import { phraseScreen } from '../src/model/screens'
import { emptyModel, emptyStep, ROWS_PER_PHRASE } from '../src/model/song'
import { SongLayout } from '../src/scene/layout'
import { FakeM8 } from './fakeM8'

// Track 1 plays chain 00 on song rows 0 and 1: phrases 05, 06, 05, 05 (05 three times), then
// chain 02 on row 2: phrase 06. Track 2 plays chain 01 on song row 0: phrases 06, 05.
const song   = emptyModel('repeats')
const phrase = (id: number) => ({
  id,
  steps: Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
})
const chain  = (id: number, phrases: number[]) => ({
  id,
  rows: Array.from({ length: 16 }, (_, row) => ({
    phrase   : phrases[row] ?? null,
    transpose: 0
  }))
})
song.phrases = {
  5: phrase(5),
  6: phrase(6)
}
song.chains  = {
  0: chain(0, [5, 6, 5, 5]),
  1: chain(1, [6, 5]),
  2: chain(2, [6])
}
song.song    = [
  [0, 1, null, null, null, null, null, null],
  [0, null, null, null, null, null, null, null],
  [2, null, null, null, null, null, null, null],
]

const screenOf = (lines: string[]): M8Screen => ({
  width : 40,
  height: 24,
  lines
})
const focus    = (view: DeviceFocus['view'], id: number | null, row: number, column: string, chainMarks: number[] = []): DeviceFocus => ({
  view,
  id,
  row,
  column,
  cursor: null,
  chainMarks
})

describe('the chain position of a Phrase view', () => {
  test("is a row with a '<' in the margin; a song playing adds one on the chain row playing", () => {
    expect(readChainMarks(viewOf(screenOf(phraseScreen(song.phrases[5], 2))))).toEqual([2])
    expect(readChainMarks(viewOf(screenOf(phraseScreen(song.phrases[5]))))).toEqual([])
    expect(readChainMarks(viewOf(screenOf(phraseScreen(song.phrases[5], 2, 7))))).toEqual([2, 7])
  })

  test('of two marks, is the one known, the nearer to it after a key, or the one that stayed', () => {
    expect(viewChainPosition([3], null)).toBe(3)
    expect(viewChainPosition([3, 5], 3)).toBe(3)
    // Option+Down from 3 while row 5 plays.
    expect(viewChainPosition([4, 5], 3, [3, 5])).toBe(4)
    // Option+Down from 3 while row 2 plays: as near as the playing one, but the one that moved.
    expect(viewChainPosition([2, 4], 3, [2, 3])).toBe(4)
    // Not known (a reload while the song plays): the one that stayed as the other moved on.
    expect(viewChainPosition([3, 4], null, [])).toBeNull()
    expect(viewChainPosition([3, 5], null, [3, 4])).toBe(3)
  })

  test('is read with the cursor on the M8, also on the marked row', async () => {
    const fake = new FakeM8(song)
    fake.view  = 'song'
    await fake.press(['shift', 'right'])
    await fake.press(['down'])
    await fake.press(['down'])
    await fake.press(['shift', 'right'])
    const first = deviceFocus(await fake.getState(), await fake.getScreen())
    expect(first).toMatchObject({
      view      : 'phrase',
      id        : 5,
      row       : 0,
      chainMarks: [2]
    })
    await fake.press(['opt', 'down'])
    await fake.press(['down'])
    await fake.press(['down'])
    await fake.press(['down'])
    const next = deviceFocus(await fake.getState(), await fake.getScreen())
    expect(next).toMatchObject({
      view      : 'phrase',
      id        : 5,
      row       : 3,
      column    : 'note',
      chainMarks: [3]
    })
    expect(fake.forbidden).toEqual([])
  })
})

describe('the M8 cursor on a phrase played more than once in its chain', () => {
  const layout = new SongLayout(song)
  const placed = (cursor: DeviceCursor, at: DeviceFocus) => cursor.preferred(cursor.placesOf(layout, at))

  test('before any Song view, a chain in one song cell gives the song row and track', () => {
    const cursor = new DeviceCursor()
    placed(cursor, focus('chain', 1, 1, 'phrase'))
    expect(cursor.songContext).toEqual({
      songRow: 0,
      track  : 1
    })
    // Chain 00 is on two song rows: no telling which.
    const other = new DeviceCursor()
    placed(other, focus('chain', 0, 0, 'phrase'))
    expect(other.songContext).toBeNull()
  })

  test("follows the repeat the '<' marks, in the song cell the M8 came from", () => {
    const cursor = new DeviceCursor()
    placed(cursor, focus('song', null, 1, 'track1'))
    for (const chainRow of [3, 2, 0]) {
      expect(placed(cursor, focus('phrase', 5, 7, 'note', [chainRow]))).toMatchObject({
        kind    : 'step',
        step    : 7,
        instance: {
          songRow: 1,
          track  : 0,
          chainRow
        }
      })
    }
  })

  test('follows the M8 to another track, and keeps that track', () => {
    const cursor = new DeviceCursor()
    placed(cursor, focus('song', null, 0, 'track1'))
    // Option+Right on the Phrase view: track 2's chain 01, phrase 05 at its row 1.
    expect(placed(cursor, focus('phrase', 5, 4, 'note', [1]))).toMatchObject({
      instance: {
        songRow : 0,
        track   : 1,
        chainRow: 1
      }
    })
    expect(cursor.songContext).toEqual({
      songRow: 0,
      track  : 1
    })
    // Option+Left back to track 1, its Chain view on row 2, then a Phrase view without a '<'.
    expect(placed(cursor, focus('chain', 0, 2, 'phrase'))).toMatchObject({
      instance: {
        songRow : 0,
        track   : 0,
        chainRow: 2
      }
    })
    expect(placed(cursor, focus('phrase', 5, 9, 'note'))).toMatchObject({
      step    : 9,
      instance: {
        songRow : 0,
        track   : 0,
        chainRow: 2
      }
    })
  })

  test("follows the M8 down the song from a Chain view (Option+Down), and keeps that row", () => {
    const cursor = new DeviceCursor()
    placed(cursor, focus('song', null, 0, 'track1'))
    expect(placed(cursor, focus('chain', 2, 0, 'phrase'))).toMatchObject({
      instance: {
        songRow: 2,
        track  : 0
      }
    })
    // Phrase 06 at chain row 0 is also track 2's on song row 0: the context says row 2.
    expect(placed(cursor, focus('phrase', 6, 0, 'note', [0]))).toMatchObject({
      instance: {
        songRow : 2,
        track   : 0,
        chainRow: 0
      }
    })
  })
})
