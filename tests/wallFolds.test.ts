// Fold rules of the track walls: buttons keep a part unfolded, navigations unfold until they leave.

import { expect, test } from 'bun:test'
import { WallFolds } from '../src/scene/track/wallFolds'

test('a navigation unfolds a part until a navigation leaves the track; its button then keeps it for good', () => {
  const folds = new WallFolds()
  folds.unfoldByNavigation(2, 'fx')
  expect(folds.opened(2)).toEqual({
    fx    : true,
    panels: false
  })
  expect(folds.buttonState(2, 'fx')).toBe('auto')
  expect(folds.unfoldedByNavigation(2)).toEqual([])
  expect(folds.unfoldedByNavigation(null)).toEqual([2])
  // Pressing the button on a part a navigation opened: it stays open, now by the button.
  expect(folds.toggle(2, 'fx')).toEqual({
    opened : true,
    wasOpen: true
  })
  expect(folds.buttonState(2, 'fx')).toBe('on')
  folds.foldNavigation(folds.unfoldedByNavigation(null))
  expect(folds.isUnfolded(2)).toBe(true)
})

test('every track at once, and how far a part is unfolded across the tracks', () => {
  const folds = new WallFolds()
  expect(folds.coverage('panels')).toBe('off')
  folds.unfoldByNavigation(0, 'panels')
  expect(folds.coverage('panels')).toBe('some')
  folds.setAll(true, 'panels')
  expect(folds.coverage('panels')).toBe('all')
  expect(folds.allByButton()).toBe(false)
  expect(folds.unfoldedByNavigation(null)).toEqual([])
  folds.setAll(false)
  expect(folds.anyUnfolded()).toBe(false)
  expect(folds.toggle(99, 'fx')).toBeNull()
})
