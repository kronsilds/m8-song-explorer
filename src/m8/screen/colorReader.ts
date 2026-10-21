// The colours the device draws each grid column in, learnt from a screen with colours while
// exploring (once per view kind), so the 3D view can use the same ones.

import { type M8ScreenCells, parseGridScreen, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { GRID_FIELDS } from '../../model/columns'
import { FIRST_CONTENT_ROW, TITLE_ROW } from '../../model/screens'
import type { ObservedColors } from '../../model/song'
import { LAST_CONTENT_ROW, type ViewKind } from './screenReader'

/** Screen x where the title text whose colour is learnt ends. */
const TITLE_END_X = 12

function mostCommon(values: (string | null | undefined)[]): string | undefined {
  const counts = new Map<string, number>()
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best      : string | undefined
  let bestCount = 0
  for (const [value, count] of counts) if (count > bestCount) [best, bestCount] = [value, count]
  return best
}

/** Which colour each column of a grid view is drawn in, filled and empty, plus row numbers, title and background. */
export function learnColumnColors(kind: ViewKind, cells: M8ScreenCells): ObservedColors[string] | null {
  const fields = GRID_FIELDS[kind as keyof typeof GRID_FIELDS]
  if (!fields) return null
  const rows = parseGridScreen(kind, cells)
  if (rows.length === 0) return null
  const foregroundAt = (y: number, x: number) => cells.fg[y]?.[x + SCREEN_MARGIN] ?? null
  const colors       : ObservedColors[string] = {}
  for (const { key, x } of fields) {
    const filled = rows.filter((row) => row.fields[key] && !row.fields[key].isEmpty).map((row) => foregroundAt(row.screenRow, x))
    const empty  = rows.filter((row) => row.fields[key]?.isEmpty).map((row) => foregroundAt(row.screenRow, x))
    colors[key]  = {
      filled: mostCommon(filled),
      empty : mostCommon(empty)
    }
  }
  colors.rowIndex   = { filled: mostCommon(rows.map((row) => foregroundAt(row.screenRow, 0))) }
  colors.title      = { filled: mostCommon((cells.fg[TITLE_ROW] ?? []).slice(SCREEN_MARGIN, TITLE_END_X)) }
  colors.background = { filled: mostCommon(cells.bg.slice(FIRST_CONTENT_ROW, LAST_CONTENT_ROW).flat()) }
  return colors
}
