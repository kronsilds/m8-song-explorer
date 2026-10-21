// Reads the device theme: opens System Settings > EDIT THEME from the Project view, reads the
// 13 colours and goes back to the view it started from.

import { M8_THEME_VIEW, type M8Theme, parseThemeScreen } from '@yam8d/m8-sdk'
import { type DriverOptions, GRAPH_VIEWS, M8Driver, M8MoveError } from '../driver'
import type { M8Port } from '../port'

/** Project row 20 holds SYSTEM SETTINGS, its row 7 EDIT THEME (measured on a Model:02, firmware 6.5). */
const SYSTEM_SETTINGS_CELL     = {
  x: 14,
  y: 20
}
const EDIT_THEME_CELL          = {
  x: 16,
  y: 7
}
const THEME_COLOURS_TIMEOUT_MS = 3000

/**
 * Edit is only pressed after checking the cursor row says what it should, so a moved layout
 * stops the walk instead of changing a setting.
 */
export async function readDeviceTheme(port: M8Port, options: DriverOptions = {}): Promise<M8Theme> {
  const driver      = new M8Driver(port, options)
  const startView   = (await port.getState()).viewName
  const onThemeView = startView === M8_THEME_VIEW
  if (!onThemeView) await openThemeView(port, driver)
  const view  = await driver.settle((v) => parseThemeScreen(v.screen) != null, 'the theme colours', THEME_COLOURS_TIMEOUT_MS)
  const theme = parseThemeScreen(view.screen) as M8Theme
  if (!onThemeView) {
    await driver.leaveSubViews()
    if (startView && GRAPH_VIEWS.has(startView)) await port.navigateToView(startView).catch(() => false)
  }
  return theme
}

async function openThemeView(port: M8Port, driver: M8Driver): Promise<void> {
  await driver.leaveSubViews()
  await port.navigateToView('project')
  await driver.waitForViewName('project')
  await editEntryAt(driver, SYSTEM_SETTINGS_CELL, /SYSTEM/i, 'the Project row', 'SYSTEM SETTINGS')
  await driver.waitForViewName('systemsettings')
  await editEntryAt(driver, EDIT_THEME_CELL, /THEME/i, 'the System Settings row', 'THEME')
  await driver.waitForViewName(M8_THEME_VIEW)
}

/** Moves the cursor to an entry and presses Edit there, once the cursor row reads `expected`. */
async function editEntryAt(driver: M8Driver, cell: { x: number; y: number }, expected: RegExp, where: string, entry: string): Promise<void> {
  await driver.moveCursor(cell.x, cell.y)
  const line = (await driver.port.getState()).currentLine ?? ''
  if (!expected.test(line)) throw new M8MoveError(`${where} under the cursor reads "${line}", not ${entry}`)
  await driver.press(['edit'])
}
