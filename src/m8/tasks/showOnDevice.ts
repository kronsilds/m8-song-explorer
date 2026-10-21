// Walks the M8 to a cell of the model: the song cell, then the chain row, then the phrase
// step; or the instrument, then its table row.

import { SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X, type PhraseColumn, phraseColumnX, type TableColumn, tableColumnX } from '../../model/columns'
import { hex2 } from '../../model/hex'
import type { Selection } from '../../model/selection'
import type { SongModel } from '../../model/song'
import { type DriverOptions, M8Driver, M8MoveError } from '../driver'
import type { M8Port } from '../port'
import { gridRowScreenY, isPage, type ScreenView } from '../screen/screenReader'

export type DeviceTarget =
  | { kind: 'song'; songRow: number; track: number }
  | { kind: 'chain'; songRow: number; track: number; chainRow: number }
  | { kind: 'step'; songRow: number; track: number; chainRow: number; step: number; column: PhraseColumn }
  | { kind: 'instrument'; instrument: number }
  | { kind: 'table'; table: number; row: number; column: TableColumn }

/** Where on the M8 a selection is. */
export function deviceTargetOf(selection: Selection): DeviceTarget {
  switch (selection.kind) {
    case 'step': {
      const { songRow, track, chainRow } = selection.instance
      return {
        kind  : 'step',
        songRow,
        track,
        chainRow,
        step  : selection.step,
        column: selection.column
      }
    }
    case 'chain': {
      const { songRow, track, chainRow } = selection.instance
      return {
        kind: 'chain',
        songRow,
        track,
        chainRow
      }
    }
    case 'table':
      return {
        kind  : 'table',
        table : selection.table,
        row   : selection.row,
        column: selection.column
      }
    case 'instrument':
      return selection.instrument != null
        ? {
          kind      : 'instrument',
          instrument: selection.instrument
        }
        : {
          kind  : 'table',
          table : selection.table,
          row   : 0,
          column: 'transpose'
        }
  }
}

/** Puts the cursor on grid row `row` of the view, at screen x `x` (margin excluded). */
async function moveToGridCell(driver: M8Driver, view: ScreenView, gridName: string, row: number, x: number): Promise<void> {
  const y = gridRowScreenY(view, gridName, row)
  if (y == null) throw new M8MoveError(`row ${row.toString(16)} is not on the ${gridName} screen`)
  await driver.moveCursor(x + SCREEN_MARGIN, y)
}

export async function showOnDevice(port: M8Port, model: SongModel, target: DeviceTarget, options: DriverOptions = {}): Promise<void> {
  const driver = new M8Driver(port, options)
  await driver.leaveSubViews()
  if (target.kind === 'instrument' || target.kind === 'table') await showInstrumentOrTable(driver, model, target)
  else await showSongCell(driver, model, target)
}

/** A table that belongs to an instrument (00-7F, with that instrument read) is reached from it. */
async function showInstrumentOrTable(
  driver: M8Driver,
  model: SongModel,
  target: Extract<DeviceTarget, { kind: 'instrument' | 'table' }>,
): Promise<void> {
  const throughInstrument = target.kind === 'instrument' || (target.table < 0x80 && model.instruments[target.table])
  if (throughInstrument) {
    const instrument = target.kind === 'instrument' ? target.instrument : target.table
    await driver.stepToItem('inst', instrument, await driver.goToView('inst'))
    if (target.kind === 'instrument') return
    await driver.press(['shift', 'right'])
  } else {
    await driver.stepToItem('table', target.table, await driver.goToView('table'))
  }
  const tableView = await driver.settle((view) => isPage(view, 'table', target.table), `table ${hex2(target.table)}`)
  await moveToGridCell(driver, tableView, 'table', target.row, tableColumnX(target.column))
}

async function showSongCell(driver: M8Driver, model: SongModel, target: Extract<DeviceTarget, { kind: 'song' | 'chain' | 'step' }>): Promise<void> {
  await driver.goToView('song')
  await driver.moveToSongCell(target.songRow, target.track)
  if (target.kind === 'song') return

  const chainId = model.song[target.songRow]?.[target.track]
  if (chainId == null) throw new M8MoveError('that song cell is empty')
  await driver.press(['shift', 'right'])
  const chainView = await driver.settle((view) => isPage(view, 'chain', chainId), `chain ${hex2(chainId)}`)
  await moveToGridCell(driver, chainView, 'chain', target.chainRow, COLUMN_X.chain.phrase)
  if (target.kind === 'chain') return

  const phraseId = model.chains[chainId]?.rows[target.chainRow]?.phrase
  if (phraseId == null) throw new M8MoveError('that chain row is empty')
  await driver.press(['shift', 'right'])
  const phraseView = await driver.settle((view) => isPage(view, 'phrase', phraseId), `phrase ${hex2(phraseId)}`)
  await moveToGridCell(driver, phraseView, 'phrase', target.step, phraseColumnX(target.column))
}
