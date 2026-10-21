// Key D: what the SDK reads on the M8 right now, printed to the console.

import type { M8Client } from '@yam8d/m8-sdk'
import type { M8Port } from '../m8/port'
import { readSongRows, viewOf } from '../m8/screen/screenReader'
import { numberedLines } from '../m8/tasks/explorer'

export async function dumpScreen(client: M8Client | null, port: M8Port | null): Promise<void> {
  if (!client) return console.info('[screen] not connected')
  const [state, screen]                                 = await Promise.all([client.fetchState(), client.getScreen()])
  const view                                            = viewOf(screen)
  const { viewName, viewTitle, cursorPos, currentLine } = state
  console.info(
    '[screen]',
    JSON.stringify({
      view : {
        kind : view.kind,
        id   : view.id,
        title: view.title
      },
      state: { viewName, viewTitle, cursorPos, currentLine }
    }),
  )
  console.info(`[screen] lines\n${numberedLines(screen.lines)}`)
  console.info('[screen] song rows', JSON.stringify(view.kind === 'song' ? readSongRows(view) : []))
  const cells = await port?.getScreenCells()
  if (!cells) return
  // Colours as letters, one per distinct colour, so markers drawn in another colour stand out.
  const letters     = new Map<string, string>()
  const letterOf    = (color: string | null) => {
    if (!color) return ' '
    if (!letters.has(color)) letters.set(color, String.fromCharCode(97 + letters.size))
    return letters.get(color) as string
  }
  const colorLines  = cells.fg.map((row, y) =>
    row
      .map((color, x) => ((cells.lines[y][x] ?? ' ') === ' ' ? ' ' : letterOf(color)))
      .join('')
      .trimEnd(),
  )
  const legend      = JSON.stringify(Object.fromEntries([...letters].map(([color, letter]) => [letter, color])))
  const stateColors = JSON.stringify({
    background: state.backgroundColor,
    title     : state.titleColor,
    cursor    : state.cursorColor
  })
  console.info(`[screen] colours ${legend} state=${stateColors}\n${numberedLines(colorLines)}`)
}
