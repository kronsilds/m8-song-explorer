// Reads the 16 chord banks of Hypersynth instruments. The Instrument view shows one bank on its
// CHORD line ('01> 00 0B 10 15 -- --'); the others show only when the bank number is changed. So
// on each instrument: the cursor goes to the bank number, Edit is held and Left / Right tapped one
// checked step at a time through 00..0F, every line is read, and the bank is put back to the one it
// showed. The instrument is the same afterwards; nothing is saved.
// Measured on a Model:02, firmware 6.5: the bank number is at screen x 9 of the CHORD line, the
// value stops at 00 and 0F, and a voice a bank does not use is drawn '--'.

import type { M8State } from '@yam8d/m8-sdk'
import { CHORD_BANKS } from '../../model/music/hypersynthChord'
import { type DriverOptions, GRAPH_VIEWS, M8Driver, M8MoveError } from '../driver'
import type { M8Port } from '../port'
import type { ScreenView } from '../screen/screenReader'

const EDIT_HOLD_MS      = 200
const TAP_MS            = 80
const RELEASE_WAIT_MS   = 120
const CHANGE_TIMEOUT_MS = 1200
const CURSOR_WAIT_MS    = 1500
const CURSOR_POLL_MS    = 100

/** The CHORD line of an Instrument screen: the bank number, then six voices (hex or '--'). */
const CHORD_LINE = /CHORD\s+(([0-9A-F]{2})\s*>(?:\s*(?:[0-9A-F]{2}|--)){6})/

interface ChordRow {
  /** Screen cell of the bank number. */
  x   : number
  y   : number
  bank: number
  /** The CHORD value as drawn: '01> 00 0B 10 15 -- --'. */
  text: string
}

/** The CHORD line on an Instrument screen; null when the instrument has none. */
export function chordRow(view: ScreenView): ChordRow | null {
  for (const [y, raw] of view.screen.lines.entries()) {
    const line  = raw.toUpperCase()
    const match = CHORD_LINE.exec(line)
    if (!match) continue
    return {
      x   : match.index + match[0].indexOf(match[1]),
      y,
      bank: Number.parseInt(match[2], 16),
      text: match[1]
    }
  }
  return null
}

/**
 * The chord banks of each instrument in `instruments` (ids), as CHORD values indexed by bank. An
 * instrument whose view shows no CHORD line is left out. Goes back to the view it started from.
 */
export async function readChordBanks(port: M8Port, instruments: readonly number[], options: DriverOptions = {}): Promise<Map<number, string[]>> {
  const driver    = new M8Driver(port, options)
  const log       = options.log ?? (() => {})
  const startView = (await port.getState()).viewName
  const banks     = new Map<number, string[]>()
  try {
    for (const id of instruments) {
      driver.throwIfCancelled()
      const view = await driver.stepToItem('inst', id, await driver.goToView('inst'))
      const row  = chordRow(view)
      if (!row) {
        log(`instrument ${id.toString(16)} shows no CHORD line`)
        continue
      }
      banks.set(id, await readInstrumentBanks(port, driver, row, log))
    }
  } finally {
    await driver.leaveSubViews()
    if (startView && GRAPH_VIEWS.has(startView)) await port.navigateToView(startView).catch(() => false)
  }
  return banks
}

/** Waits for the cursor to report the bank number of the CHORD line (the text under it arrives late). */
async function waitForBankCursor(port: M8Port, driver: M8Driver, row: ChordRow): Promise<M8State> {
  const onBank   = (state: M8State) => /CHORD/i.test(state.currentLine ?? '') && Number.parseInt(state.textUnderCursor ?? '', 16) === row.bank && state.cursorPos?.x === row.x
  const deadline = Date.now() + CURSOR_WAIT_MS
  for (;;) {
    const state = await port.getState()
    if (onBank(state) || Date.now() > deadline) return state
    await driver.sleep(CURSOR_POLL_MS)
  }
}

/** Steps the bank number under the cursor through every bank, reads each CHORD line, and puts the first one back. */
async function readInstrumentBanks(port: M8Port, driver: M8Driver, start: ChordRow, log: (message: string) => void): Promise<string[]> {
  await driver.moveCursor(start.x, start.y)
  const state = await waitForBankCursor(port, driver, start)
  // Edit is only held once the cursor says it is on the bank number: anywhere else it would change another value.
  if (!/CHORD/i.test(state.currentLine ?? '') || Number.parseInt(state.textUnderCursor ?? '', 16) !== start.bank || state.cursorPos?.x !== start.x) {
    throw new M8MoveError(`the cursor is on "${state.textUnderCursor ?? ''}" of "${state.currentLine ?? ''}", not the chord bank number`)
  }
  const chords     : string[] = Array.from({ length: CHORD_BANKS }, () => '')
  let row          = start
  chords[row.bank] = row.text
  /** One Edit+side tap; false when the bank did not change (the end of its range). */
  const tap        = async (side: 'left' | 'right'): Promise<boolean> => {
    const before = row.bank
    await port.keyDown(['edit', side])
    await driver.sleep(TAP_MS)
    await port.keyDown(['edit'])
    const changed = await driver.settleOrNull((view) => (chordRow(view)?.bank ?? before) !== before, 'the chord bank to change', CHANGE_TIMEOUT_MS)
    const next    = changed && chordRow(changed)
    if (!next) return false
    row              = next
    chords[row.bank] = row.text
    return true
  }
  try {
    await port.keyDown(['edit'])
    await driver.sleep(EDIT_HOLD_MS)
    for (let step = 0; step < CHORD_BANKS && row.bank > 0; step += 1) if (!(await tap('left'))) break
    for (let step = 0; step < CHORD_BANKS && row.bank < CHORD_BANKS - 1; step += 1) if (!(await tap('right'))) break
    // Back to the bank the instrument had.
    for (let step = 0; step < CHORD_BANKS && row.bank !== start.bank; step += 1) if (!(await tap(row.bank > start.bank ? 'left' : 'right'))) break
  } finally {
    await driver.sleep(RELEASE_WAIT_MS)
    await port.keyUp()
  }
  if (row.bank !== start.bank) throw new M8MoveError(`the chord bank reads ${row.bank.toString(16)}, it was ${start.bank.toString(16)}: set it back on the M8`)
  log(`read ${chords.filter(Boolean).length} chord banks`)
  return chords
}
