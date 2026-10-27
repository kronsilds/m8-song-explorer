// Coarse cursor moves: a phrase up / down a track, the same cell in the next track.

import { expect, test } from 'bun:test'
import { phraseMoved, trackMoved } from '../src/model/stepMoves'
import type { PhraseInstance } from '../src/model/timeline'

const instance = (track: number, row: number): PhraseInstance => ({
  key     : `${track}:${row}`,
  track,
  songRow : row / 16,
  chain   : 0,
  chainRow: 0,
  phrase  : 0,
  row
})

const tracks = [
  [instance(0, 0), instance(0, 16), instance(0, 48)],
  [instance(1, 0), instance(1, 32)],
  []
]

test('a phrase down keeps the step, also across a gap', () => {
  const moved = phraseMoved(tracks[0], {
    instance: tracks[0][0],
    step    : 5
  }, 1)
  expect(moved.instance.row).toBe(16)
  expect(moved.step).toBe(5)
  expect(phraseMoved(tracks[0], {
    instance: tracks[0][1],
    step    : 5
  }, 1).instance.row).toBe(48)
})

test('a phrase up from the first phrase goes to its first step, down from the last to its last', () => {
  expect(phraseMoved(tracks[0], {
    instance: tracks[0][0],
    step    : 9
  }, -1)).toEqual({
    instance: tracks[0][0],
    step    : 0
  })
  expect(phraseMoved(tracks[0], {
    instance: tracks[0][2],
    step    : 3
  }, 1)).toEqual({
    instance: tracks[0][2],
    step    : 15
  })
})

test('the next track gives the same timeline row', () => {
  const moved = trackMoved(tracks, {
    instance: tracks[0][0],
    step    : 7
  }, 1)
  expect(moved).toEqual({
    instance: tracks[1][0],
    step    : 7
  })
})

test('an empty stretch in the next track takes the nearest phrase', () => {
  expect(trackMoved(tracks, {
    instance: tracks[0][1],
    step    : 2
  }, 1)).toEqual({
    instance: tracks[1][0],
    step    : 15
  })
  expect(trackMoved(tracks, {
    instance: tracks[0][2],
    step    : 0
  }, -1)).toBeNull()
})

test('no track beyond the edges, none without phrases', () => {
  expect(trackMoved(tracks, {
    instance: tracks[0][0],
    step    : 0
  }, -1)).toBeNull()
  expect(trackMoved(tracks, {
    instance: tracks[1][0],
    step    : 0
  }, 1)).toBeNull()
})
