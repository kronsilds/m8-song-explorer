// Screen-level moves on the M8: read a view until it has settled, put the cursor on a cell,
// page the song, step to an instrument, table, scale or groove. Only arrows, Shift+arrows and
// Option+arrows are pressed here, keys that move around and never change the song
// (Option+Left/Right is avoided on the Song view, where it solos tracks).

import type { M8KeyName, M8State } from '@yam8d/m8-sdk'
import type { M8Port } from './port'
import { isPage, readSongRows, type ScreenView, songCellX, stableContent, viewOf } from './screen/screenReader'

export class ExploreCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export class M8MoveError extends Error {}

/** Views yam8d can navigate between by name. */
export const GRAPH_VIEWS = new Set([
  'song',
  'project',
  'mixer',
  'effectsettings',
  'inst',
  'table',
  'phrase',
  'chain',
  'groove',
  'scale',
  'instmods',
  'instrumentpool',
])

export type NavigableView = 'song' | 'inst' | 'table' | 'scale' | 'groove'
export type ItemView = 'inst' | 'table' | 'scale' | 'groove'

export interface DriverOptions {
  /** Delay between two screen reads while waiting for a view to settle. */
  pollMs?         : number
  /** How long a view may take to appear after a key. */
  settleTimeoutMs?: number
  signal?         : AbortSignal
  log?            : (message: string) => void
}

const DEFAULT_POLL_MS           = 30
const DEFAULT_SETTLE_TIMEOUT_MS = 2000
/** A view press is sent again at most this many times while the screen has not moved. */
const PRESS_RETRIES             = 2
const PRESS_RETRY_WAIT_MS       = 1200
/** Option presses that leave dialogs and sub-views. */
const MAX_SUB_VIEW_EXITS        = 5
const SUB_VIEW_EXIT_WAIT_MS     = 250
const GO_TO_VIEW_TIMEOUT_MS     = 4000
const MAX_CURSOR_STEPS          = 40
const CURSOR_MOVE_TIMEOUT_MS    = 600
const VIEW_NAME_POLL_MS         = 40
/** Song pages scrolled at most (256 rows, 16 a page, with room to spare). */
const MAX_SONG_PAGES            = 24
const SONG_PAGE_TIMEOUT_MS      = 1000
const MAX_ITEM_STEPS            = 160
const ITEM_STEP_TIMEOUT_MS      = 1200
/** Option+Up/Down steps this many instruments or tables. */
const BIG_STEP                  = 16

const ITEM_NAMES                : Record<ItemView, string> = {
  inst  : 'instrument',
  table : 'table',
  scale : 'scale',
  groove: 'groove'
}

export class M8Driver {
  readonly port                   : M8Port
  private readonly pollMs         : number
  private readonly settleTimeoutMs: number
  private readonly signal?        : AbortSignal
  private readonly log            : (message: string) => void
  /** Option+Up/Down steps 16 items on Instrument and Table; turned off if the device disagrees. */
  private readonly bigStepsWork   : Record<'inst' | 'table', boolean> = {
    inst : true,
    table: true
  }

  constructor(port: M8Port, options: DriverOptions = {}) {
    this.port            = port
    this.pollMs          = options.pollMs ?? DEFAULT_POLL_MS
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.signal          = options.signal
    this.log             = options.log ?? (() => {})
  }

  throwIfCancelled(): void {
    if (this.signal?.aborted) throw new ExploreCancelled()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async read(): Promise<ScreenView> {
    return viewOf(await this.port.getScreen())
  }

  /**
   * Reads the screen until `accept` holds for two reads in a row with the same content:
   * the M8 draws a view over several frames, the title first.
   */
  async settle(accept: (view: ScreenView) => boolean, what: string, timeoutMs = this.settleTimeoutMs): Promise<ScreenView> {
    const deadline      = Date.now() + timeoutMs
    let previousContent : string | null = null
    for (;;) {
      this.throwIfCancelled()
      const view = await this.read()
      if (accept(view)) {
        const content = stableContent(view.screen)
        if (content === previousContent) return view
        previousContent = content
      } else {
        previousContent = null
      }
      if (Date.now() > deadline) throw new M8MoveError(`waited ${timeoutMs} ms for ${what}; the M8 shows "${view.title || 'no title'}"`)
      await this.sleep(this.pollMs)
    }
  }

  /** Same as settle, but null instead of an error when the view does not come. */
  async settleOrNull(accept: (view: ScreenView) => boolean, what: string, timeoutMs: number): Promise<ScreenView | null> {
    try {
      return await this.settle(accept, what, timeoutMs)
    } catch (error) {
      if (error instanceof M8MoveError) return null
      throw error
    }
  }

  async press(keys: M8KeyName[]): Promise<void> {
    this.throwIfCancelled()
    await this.port.press(keys)
  }

  /**
   * Presses keys that open another view and waits for it. The M8 sometimes misses such a press
   * (seen on the device: Shift+Right on a chain row left `CHAIN 0B*` in place, while the same
   * press by hand opened the phrase), so it is sent again, at most twice more, and only while
   * the screen still shows the view it was pressed on: a slow view is never skipped past.
   */
  async pressToOpen(keys: M8KeyName[], accept: (view: ScreenView) => boolean, what: string, timeoutMs = this.settleTimeoutMs): Promise<ScreenView> {
    const pressedOn = await this.read()
    await this.press(keys)
    for (let retry = 0; retry < PRESS_RETRIES; retry += 1) {
      const opened = await this.settleOrNull(accept, what, Math.min(PRESS_RETRY_WAIT_MS, timeoutMs))
      if (opened) return opened
      const now = await this.read()
      if (now.kind !== pressedOn.kind || now.id !== pressedOn.id) break
      this.log(`${keys.join('+')} on "${pressedOn.title}" did not open ${what}; pressing it again`)
      await this.press(keys)
    }
    return this.settle(accept, what, timeoutMs)
  }

  /** Leaves dialogs and sub-views with Option until a view yam8d can navigate from. */
  async leaveSubViews(): Promise<void> {
    for (let exit = 0; exit < MAX_SUB_VIEW_EXITS; exit += 1) {
      const state = await this.port.getState()
      if (GRAPH_VIEWS.has(state.viewName ?? '')) return
      this.log(`leaving "${state.viewName ?? 'dialog'}" (Option)`)
      await this.press(['opt'])
      await this.sleep(SUB_VIEW_EXIT_WAIT_MS)
    }
  }

  async goToView(kind: NavigableView): Promise<ScreenView> {
    const here = await this.read()
    if (isPage(here, kind)) return here
    await this.leaveSubViews()
    await this.port.navigateToView(kind)
    return this.settle((view) => isPage(view, kind), `the ${kind} view`, GO_TO_VIEW_TIMEOUT_MS)
  }

  /** Waits until the SDK reports view `name` (the views without a title the explorer reads). */
  async waitForViewName(name: string, timeoutMs = 3000): Promise<M8State> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await this.port.getState()
      if (state.viewName === name) return state
      if (Date.now() > deadline) throw new M8MoveError(`expected the ${name} view, the M8 shows "${state.viewName ?? 'nothing'}"`)
      await this.sleep(VIEW_NAME_POLL_MS)
    }
  }

  /**
   * Puts the cursor on screen cell (x, y), counted like cursorPos (margin included).
   * yam8d's navigateTo does the walking; arrows finish the job if it stops short.
   */
  async moveCursor(x: number, y: number): Promise<void> {
    this.throwIfCancelled()
    await this.port.navigateTo(x, y)
    for (let step = 0; step < MAX_CURSOR_STEPS; step += 1) {
      const position = (await this.port.getState()).cursorPos
      if (!position) throw new M8MoveError('the cursor is not visible')
      if (position.x === x && position.y === y) return
      const key: M8KeyName = position.y < y ? 'down' : position.y > y ? 'up' : position.x < x ? 'right' : 'left'
      await this.press([key])
      if (!(await this.waitForCursorMove(position))) {
        throw new M8MoveError(`the cursor stays at (${position.x}, ${position.y}) on its way to (${x}, ${y})`)
      }
      // Cells are several columns wide: stop once the target column is passed on the way right.
      const moved = (await this.port.getState()).cursorPos
      if (moved && moved.y === y && key === 'right' && moved.x > x) {
        await this.press(['left'])
        await this.waitForCursorMove(moved)
        return
      }
    }
    throw new M8MoveError(`could not reach (${x}, ${y})`)
  }

  private async waitForCursorMove(from: { x: number; y: number }): Promise<boolean> {
    const deadline = Date.now() + CURSOR_MOVE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const position = (await this.port.getState()).cursorPos
      if (position && (position.x !== from.x || position.y !== from.y)) return true
      await this.sleep(this.pollMs)
    }
    return false
  }

  /** Song view: scrolls until song row `row` is on screen and puts the cursor on its cell of `track`. */
  async moveToSongCell(row: number, track: number): Promise<ScreenView> {
    let view = await this.settle((v) => isPage(v, 'song'), 'the song view')
    for (let page = 0; page < MAX_SONG_PAGES; page += 1) {
      const rows   = readSongRows(view)
      const target = rows.find((reading) => reading.row === row)
      if (target) {
        await this.moveCursor(songCellX(track), target.screenRow)
        return view
      }
      const firstRow = rows[0].row
      await this.press(row < firstRow ? ['opt', 'up'] : ['opt', 'down'])
      const scrolled = await this.settleOrNull(
        (v) => isPage(v, 'song') && readSongRows(v)[0].row !== firstRow,
        `song row ${row}`,
        SONG_PAGE_TIMEOUT_MS,
      )
      if (!scrolled) throw new M8MoveError(`song row ${row.toString(16)} cannot be scrolled into view`)
      view = scrolled
    }
    throw new M8MoveError(`song row ${row.toString(16)} is out of reach`)
  }

  /**
   * Instrument, Table, Scale or Groove view: Option+arrows until item `id` is shown. On the Scale view
   * Option+Up/Down jump to the first / last scale, so only Option+Left/Right are used there (and
   * on the Groove view, where there are only 32).
   */
  async stepToItem(kind: ItemView, id: number, from?: ScreenView): Promise<ScreenView> {
    let view = from ?? (await this.settle((v) => isPage(v, kind), `the ${kind} view`))
    for (let step = 0; step < MAX_ITEM_STEPS && view.id !== id; step += 1) {
      const current  = view.id as number
      const distance = id - current
      const bigStep  = (kind === 'inst' || kind === 'table') && this.bigStepsWork[kind] && Math.abs(distance) >= BIG_STEP
      const keys     : M8KeyName[] = bigStep ? ['opt', distance > 0 ? 'down' : 'up'] : ['opt', distance > 0 ? 'right' : 'left']
      await this.press(keys)
      const next = await this.settleOrNull((v) => isPage(v, kind) && v.id !== current, `${kind} ${id}`, ITEM_STEP_TIMEOUT_MS)
      if (!next) throw new M8MoveError(`${ITEM_NAMES[kind]} ${current.toString(16)} does not move on`)
      if (bigStep && Math.abs(id - (next.id as number)) >= Math.abs(distance)) {
        this.log(`Option+Up/Down does not step 16 ${kind} items toward the target here; using single steps`)
        this.bigStepsWork[kind as 'inst' | 'table'] = false
      }
      view = next
    }
    if (view.id !== id) throw new M8MoveError(`${kind} ${id.toString(16)} is out of reach`)
    return view
  }
}
