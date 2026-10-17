// Screen-level moves on the M8: read a view until it has settled, put the cursor on a
// cell, page the song, step to an instrument or a table. Only arrows, Shift+arrows and
// Option+arrows are pressed here, keys that move around and never change the song
// (Option+Left/Right is avoided on the Song view, where it solos tracks).

import {
  type M8KeyName,
  type M8Screen,
  type M8ScreenCells,
  parseGridScreen,
  parseViewTitle,
  SCREEN_MARGIN,
} from '@yam8d/m8-sdk'
import { FIRST_CONTENT_ROW, TITLE_ROW } from '../model/screens'
import {
  type Chain,
  emptyFx,
  type FxCell,
  type Groove,
  type Instrument,
  type ObservedColors,
  type Phrase,
  type PhraseStep,
  ROWS_PER_CHAIN,
  type Scale,
  ROWS_PER_PHRASE,
  type Table,
  type TableRow,
  TRACKS,
} from '../model/song'
import type { M8Port } from './port'

export type ViewKind = 'song' | 'chain' | 'phrase' | 'inst' | 'table' | 'scale' | 'groove' | 'other'

export interface ScreenView {
  kind: ViewKind
  /** Item number from the title (chain, phrase, instrument, table). */
  id: number | null
  title: string
  screen: M8Screen
}

export class ExploreCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export class M8MoveError extends Error {}

/** Views yam8d can navigate between by name. */
export const GRAPH_VIEWS = new Set([
  'song', 'project', 'mixer', 'effectsettings', 'inst', 'table', 'phrase', 'chain', 'groove', 'scale', 'instmods', 'instrumentpool',
])

/** Right edge of the content the explorer reads; the track panel lives beyond it. */
const CONTENT_COLUMNS = 30
const LAST_CONTENT_ROW = 21

export function titleOf(screen: M8Screen): string {
  return (screen.lines[TITLE_ROW] ?? '').slice(SCREEN_MARGIN, CONTENT_COLUMNS).trim().toUpperCase()
}

export function viewOf(screen: M8Screen): ScreenView {
  const title = titleOf(screen)
  const word = title.split(/\s+/)[0] ?? ''
  const kind: ViewKind =
    word === 'SONG' || word === 'LIVE'
      ? 'song'
      : word === 'CHAIN'
        ? 'chain'
        : word === 'PHRASE'
          ? 'phrase'
          : word.startsWith('INST') && !word.startsWith('INSTRUMENT')
            ? 'inst'
            : word === 'TABLE'
              ? 'table'
              : word === 'SCALE'
                ? 'scale'
                : word === 'GROOVE'
                  ? 'groove'
                  : 'other'
  const viewId =
    kind === 'scale' || kind === 'groove'
      ? (/^(?:SCALE|GROOVE)\s+([0-9A-F]{2})\b/.exec(title)?.[1] ?? null)
      : kind === 'song' || kind === 'other'
        ? null
        : parseViewTitle(title).viewId
  return { kind, id: viewId == null ? null : parseInt(viewId, 16), title, screen }
}

/** What has to stay unchanged between two reads for a screen to count as drawn. */
const stableKey = (screen: M8Screen): string =>
  screen.lines
    .slice(TITLE_ROW, LAST_CONTENT_ROW + 1)
    .map((l) => l.slice(SCREEN_MARGIN, CONTENT_COLUMNS))
    .join('\n')

const upper = (s: string) => s.toUpperCase()

/** The M8 pads names with dashes up to their 12 characters ('DEMO2-------'). */
const nameOf = (raw: string): string | null => upper(raw.trim().replace(/-+$/, '')) || null

const fxOf = (cmd: { rawValue: string; isEmpty: boolean } | undefined, val: { hexValue: number | null } | undefined): FxCell =>
  cmd && !cmd.isEmpty ? { cmd: upper(cmd.rawValue), val: val?.hexValue ?? null } : emptyFx()

// ---------------------------------------------------------------------------
// Reading views

/** Song rows on screen: row number -> chains, with the screen row they are drawn on. */
export function readSongRows(view: ScreenView): { row: number; screenRow: number; chains: (number | null)[] }[] {
  if (view.kind !== 'song') return []
  return parseGridScreen('song', view.screen).map((r) => ({
    row: r.rowIndex as number,
    screenRow: r.screenRow,
    chains: Array.from({ length: TRACKS }, (_, t) => {
      const f = r.fields[`track${t + 1}`]
      return f && !f.isEmpty ? f.hexValue : null
    }),
  }))
}

const fullPage = (rows: { rowIndex: number | null }[], count: number) =>
  rows.length === count && rows.every((r, i) => r.rowIndex === i)

export function readChain(view: ScreenView): Chain | null {
  if (view.kind !== 'chain' || view.id == null) return null
  const rows = parseGridScreen('chain', view.screen)
  if (!fullPage(rows, ROWS_PER_CHAIN)) return null
  return {
    id: view.id,
    rows: rows.map((r) => ({
      phrase: r.fields.phrase.isEmpty ? null : r.fields.phrase.hexValue,
      transpose: r.fields.transpose.hexValue,
    })),
  }
}

export function readPhrase(view: ScreenView): Phrase | null {
  if (view.kind !== 'phrase' || view.id == null) return null
  const rows = parseGridScreen('phrase', view.screen)
  if (!fullPage(rows, ROWS_PER_PHRASE)) return null
  return {
    id: view.id,
    steps: rows.map((r): PhraseStep => {
      const f = r.fields
      return {
        note: f.note.isEmpty ? null : upper(f.note.rawValue),
        vel: f.vel.isEmpty ? null : f.vel.hexValue,
        inst: f.inst.isEmpty ? null : f.inst.hexValue,
        fx: [1, 2, 3].map((l) => fxOf(f[`fx${l}cmd`], f[`fx${l}val`])),
      }
    }),
  }
}

export function readTable(view: ScreenView): Table | null {
  if (view.kind !== 'table' || view.id == null) return null
  const rows = parseGridScreen('table', view.screen)
  if (!fullPage(rows, ROWS_PER_PHRASE)) return null
  return {
    id: view.id,
    rows: rows.map((r): TableRow => {
      const f = r.fields
      return {
        transpose: f.transpose.isEmpty ? null : f.transpose.hexValue,
        volume: f.volume.isEmpty ? null : f.volume.hexValue,
        fx: [1, 2, 3].map((l) => fxOf(f[`fx${l}cmd`], f[`fx${l}val`])),
      }
    }),
  }
}

export function readInstrument(view: ScreenView): Instrument | null {
  if (view.kind !== 'inst' || view.id == null) return null
  const data = view.screen.lines.map((l) => l.slice(SCREEN_MARGIN, CONTENT_COLUMNS))
  const typeLine = data.find((l) => /^TYPE\b/i.test(l))
  if (!typeLine) return null
  const nameLine = data.find((l) => /^NAME\b/i.test(l))
  const name = nameLine?.slice(8, 20).trim() ?? ''
  return {
    id: view.id,
    type: upper(typeLine.slice(8, 21).trim()) || null,
    // The text stream is lower case; the M8 shows names upper case.
    name: nameOf(name),
    lines: data.slice(TITLE_ROW, LAST_CONTENT_ROW + 1).map((l) => l.trimEnd()),
  }
}

export interface ProjectInfo {
  name: string | null
  tempo: number | null
  /** TRANSPOSE as the raw byte. */
  transpose: number | null
  /** SCALE: the number and the key in front of the scale name ('00C CHROMATIC'). */
  scale: number | null
  key: number | null
  /** GROOVE: the number in front of the groove name ('00DEFAULT'). */
  groove: number | null
}

/** NAME, TEMPO, TRANSPOSE, GROOVE and SCALE of the Project view; null when the screen is not (yet) the Project view. */
export function readProject(screen: M8Screen): ProjectInfo | null {
  if (!/^PROJECT\b/.test(titleOf(screen))) return null
  const data = screen.lines.map((l) => l.slice(SCREEN_MARGIN, CONTENT_COLUMNS))
  const nameLine = data.find((l) => /^NAME\b/i.test(l))
  if (!nameLine) return null
  const name = nameLine.slice(13, 25).trim()
  const tempo = parseFloat(data.find((l) => /^TEMPO\b/i.test(l))?.slice(13, 19) ?? '')
  const valueOf = (label: RegExp) => upper(data.find((l) => label.test(l))?.slice(13) ?? '')
  const hex = (text: string) => {
    const m = /^([0-9A-F]{2})/.exec(text)
    return m ? parseInt(m[1], 16) : null
  }
  const scale = valueOf(/^SCALE\b/i)
  const key = /^[0-9A-F]{2}([A-G]#?)/.exec(scale)?.[1]
  return {
    name: nameOf(name),
    tempo: Number.isNaN(tempo) ? null : tempo,
    transpose: hex(valueOf(/^TRANSPOSE\b/i)),
    scale: hex(scale),
    key: key ? PITCHES.indexOf(key) : null,
    groove: hex(valueOf(/^GROOVE\b/i)),
  }
}

/**
 * The Groove view: rows 0-F with the ticks of each step ('06', '00' skips it, '--' ends the
 * loop), and the PPQ on row 0 (24, 48, 96 or 192) next to the swing ('50.0%'). The layout
 * comes from the SDK's view map; not yet checked on the device. Null until all 16 rows are drawn.
 */
export function readGroove(view: ScreenView): Groove | null {
  if (view.kind !== 'groove' || view.id == null) return null
  const ticks: (number | null)[] = Array(16).fill(undefined)
  let ppq: number | null = null
  for (const line of view.screen.lines.slice(FIRST_CONTENT_ROW).map((l) => upper(l.slice(SCREEN_MARGIN, CONTENT_COLUMNS)))) {
    // The play marker can take the blank after the row number ('0>06').
    const m = /^([0-9A-F])[^0-9A-Z-]([0-9A-F]{2}|--)(.*)$/.exec(line)
    if (!m) continue
    const i = parseInt(m[1], 16)
    if (ticks[i] !== undefined) continue
    ticks[i] = m[2] === '--' ? null : parseInt(m[2], 16)
    if (i === 0) {
      const p = /(?:^|\s)(24|48|96|192)(?![\d.%])/.exec(m[3])
      if (p) ppq = parseInt(p[1], 10)
    }
  }
  if (ticks.some((t) => t === undefined)) return null
  return { id: view.id, ticks, ppq }
}

const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * The Scale view: KEY (under the title), the 12 interval rows and NAME, found by their labels.
 * On the device (fw 6.5) an interval row reads 'C  ON 00.00' or 'C# ON 00.00', and a note out of
 * the scale 'C# -- -- --'. Null until all 12 interval rows are drawn.
 */
export function readScale(view: ScreenView): Scale | null {
  if (view.kind !== 'scale' || view.id == null) return null
  const data = view.screen.lines.map((l) => upper(l.slice(SCREEN_MARGIN, CONTENT_COLUMNS)))
  const notes: Scale['notes'] = []
  for (const line of data) {
    const m = /^([A-G])([-# ])\s*(ON|OFF|--)(?:\s*([+-]?\d+\.\d+))?/.exec(line)
    if (!m) continue
    const i = PITCHES.indexOf(`${m[1]}${m[2] === '#' ? '#' : ''}`)
    if (i < 0 || notes[i]) continue
    const offset = m[4] != null ? parseFloat(m[4]) : null
    notes[i] = { enabled: m[3] === 'ON', offset: offset != null && !Number.isNaN(offset) ? offset : null }
  }
  if (PITCHES.some((_, i) => !notes[i])) return null
  const key = /^KEY\s+([A-G]#?)/.exec(data.find((l) => /^KEY\b/.test(l)) ?? '')?.[1]
  const name = /^NAME\s+(.*)$/.exec(data.find((l) => /^NAME\b/.test(l)) ?? '')?.[1] ?? ''
  return { id: view.id, name: nameOf(name), notes, key: key ? PITCHES.indexOf(key) : null }
}

/** True when the view is a fully drawn page of that kind (and number). */
export function isPage(view: ScreenView, kind: ViewKind, id?: number | null): boolean {
  if (view.kind !== kind) return false
  if (id != null && view.id !== id) return false
  switch (kind) {
    case 'song': {
      const rows = readSongRows(view)
      return rows.length > 0 && rows.every((r, i) => i === 0 || r.row === rows[i - 1].row + 1)
    }
    case 'chain':
      return readChain(view) != null
    case 'phrase':
      return readPhrase(view) != null
    case 'table':
      return readTable(view) != null
    case 'inst':
      return readInstrument(view) != null
    case 'scale':
      return readScale(view) != null
    case 'groove':
      return readGroove(view) != null
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Colours the device uses for each column (learnt once per view kind)

const COLOR_FIELDS: Record<string, { key: string; x: number }[]> = {
  song: Array.from({ length: TRACKS }, (_, t) => ({ key: `track${t + 1}`, x: 3 + 3 * t })),
  chain: [
    { key: 'phrase', x: 2 },
    { key: 'transpose', x: 5 },
  ],
  phrase: [
    { key: 'note', x: 2 },
    { key: 'vel', x: 6 },
    { key: 'inst', x: 9 },
    { key: 'fx1cmd', x: 12 },
    { key: 'fx1val', x: 15 },
    { key: 'fx2cmd', x: 18 },
    { key: 'fx2val', x: 21 },
    { key: 'fx3cmd', x: 24 },
    { key: 'fx3val', x: 27 },
  ],
  table: [
    { key: 'transpose', x: 2 },
    { key: 'volume', x: 5 },
    { key: 'fx1cmd', x: 8 },
    { key: 'fx1val', x: 11 },
    { key: 'fx2cmd', x: 14 },
    { key: 'fx2val', x: 17 },
    { key: 'fx3cmd', x: 20 },
    { key: 'fx3val', x: 23 },
  ],
}

const mostCommon = (values: (string | null | undefined)[]): string | undefined => {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | undefined
  let n = 0
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c]
  return best
}

/** Which colour each column of a grid view is drawn in, filled and empty, plus row numbers, title and background. */
export function learnColors(kind: ViewKind, cells: M8ScreenCells): ObservedColors[string] | null {
  const fields = COLOR_FIELDS[kind]
  if (!fields) return null
  const rows = parseGridScreen(kind, cells)
  if (rows.length === 0) return null
  const out: ObservedColors[string] = {}
  const fgAt = (y: number, x: number) => cells.fg[y]?.[x + SCREEN_MARGIN] ?? null
  for (const { key, x } of fields) {
    const filled = rows.filter((r) => r.fields[key] && !r.fields[key].isEmpty).map((r) => fgAt(r.screenRow, x))
    const empty = rows.filter((r) => r.fields[key]?.isEmpty).map((r) => fgAt(r.screenRow, x))
    out[key] = { filled: mostCommon(filled), empty: mostCommon(empty) }
  }
  out.rowIndex = { filled: mostCommon(rows.map((r) => fgAt(r.screenRow, 0))) }
  const titleRow = cells.fg[TITLE_ROW] ?? []
  out.title = { filled: mostCommon(titleRow.slice(SCREEN_MARGIN, 12)) }
  out.background = { filled: mostCommon(cells.bg.slice(FIRST_CONTENT_ROW, LAST_CONTENT_ROW).flat()) }
  return out
}

// ---------------------------------------------------------------------------
// The driver

export interface DriverOptions {
  /** Delay between two screen reads while waiting for a view to settle. */
  pollMs?: number
  /** How long a view may take to appear after a key. */
  settleTimeoutMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
}

export class M8Driver {
  readonly port: M8Port
  private readonly pollMs: number
  private readonly settleTimeoutMs: number
  private readonly signal?: AbortSignal
  private readonly log: (message: string) => void
  /** Option+Up/Down steps 16 items on Instrument and Table; turned off if the device disagrees. */
  private bigSteps: Record<'inst' | 'table', boolean> = { inst: true, table: true }

  constructor(port: M8Port, options: DriverOptions = {}) {
    this.port = port
    this.pollMs = options.pollMs ?? 30
    this.settleTimeoutMs = options.settleTimeoutMs ?? 2000
    this.signal = options.signal
    this.log = options.log ?? (() => {})
  }

  checkCancelled(): void {
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
    const deadline = Date.now() + timeoutMs
    let previous: string | null = null
    let last: ScreenView | null = null
    for (;;) {
      this.checkCancelled()
      const view = await this.read()
      last = view
      if (accept(view)) {
        const key = stableKey(view.screen)
        if (key === previous) return view
        previous = key
      } else {
        previous = null
      }
      if (Date.now() > deadline) {
        throw new M8MoveError(`waited ${timeoutMs} ms for ${what}; the M8 shows "${last?.title || 'no title'}"`)
      }
      await this.sleep(this.pollMs)
    }
  }

  /** Same as settle, but null instead of an error when the view does not come. */
  async maybeSettle(accept: (view: ScreenView) => boolean, what: string, timeoutMs: number): Promise<ScreenView | null> {
    try {
      return await this.settle(accept, what, timeoutMs)
    } catch (error) {
      if (error instanceof M8MoveError) return null
      throw error
    }
  }

  async press(keys: M8KeyName[]): Promise<void> {
    this.checkCancelled()
    await this.port.press(keys)
  }

  /**
   * Presses keys that open another view and waits for it. The M8 sometimes misses such a press
   * (seen on the device: Shift+Right on a chain row left `CHAIN 0B*` in place, while the same
   * press by hand opened the phrase), so it is sent again, at most twice more, and only while
   * the screen still shows the view it was pressed on: a slow view is never skipped past.
   */
  async pressTo(keys: M8KeyName[], accept: (view: ScreenView) => boolean, what: string, timeoutMs = this.settleTimeoutMs): Promise<ScreenView> {
    const from = await this.read()
    await this.press(keys)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = await this.maybeSettle(accept, what, Math.min(1200, timeoutMs))
      if (view) return view
      const here = await this.read()
      if (here.kind !== from.kind || here.id !== from.id) break
      this.log(`${keys.join('+')} on "${from.title}" did not open ${what}; pressing it again`)
      await this.press(keys)
    }
    return this.settle(accept, what, timeoutMs)
  }

  /** Leaves dialogs and sub-views with Option until a view yam8d can navigate from. */
  async leaveSubViews(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const state = await this.port.getState()
      if (GRAPH_VIEWS.has(state.viewName ?? '')) return
      this.log(`leaving "${state.viewName ?? 'dialog'}" (Option)`)
      await this.press(['opt'])
      await this.sleep(250)
    }
  }

  async gotoView(kind: 'song' | 'inst' | 'table' | 'scale' | 'groove'): Promise<ScreenView> {
    const here = await this.read()
    if (isPage(here, kind)) return here
    await this.leaveSubViews()
    await this.port.navigateToView(kind)
    return this.settle((v) => isPage(v, kind), `the ${kind} view`, 4000)
  }

  /**
   * Puts the cursor on screen cell (x, y), counted like cursorPos (margin included).
   * yam8d's navigateTo does the walking; arrows finish the job if it stops short.
   */
  async moveCursor(x: number, y: number): Promise<void> {
    this.checkCancelled()
    await this.port.navigateTo(x, y)
    for (let i = 0; i < 40; i += 1) {
      const pos = (await this.port.getState()).cursorPos
      if (!pos) throw new M8MoveError('the cursor is not visible')
      if (pos.x === x && pos.y === y) return
      const key: M8KeyName = pos.y < y ? 'down' : pos.y > y ? 'up' : pos.x < x ? 'right' : 'left'
      await this.press([key])
      const moved = await this.waitCursorChange(pos)
      if (!moved) throw new M8MoveError(`the cursor stays at (${pos.x}, ${pos.y}) on its way to (${x}, ${y})`)
      // Cells are several columns wide: stop once the target column is passed on the way right.
      const now = (await this.port.getState()).cursorPos
      if (now && now.y === y && key === 'right' && now.x > x) {
        await this.press(['left'])
        await this.waitCursorChange(now)
        return
      }
    }
    throw new M8MoveError(`could not reach (${x}, ${y})`)
  }

  private async waitCursorChange(from: { x: number; y: number }, timeoutMs = 600): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pos = (await this.port.getState()).cursorPos
      if (pos && (pos.x !== from.x || pos.y !== from.y)) return true
      await this.sleep(this.pollMs)
    }
    return false
  }

  /** Song view: scrolls until song row `row` is on screen and puts the cursor on its cell of `track`. */
  async songCursorTo(row: number, track: number): Promise<ScreenView> {
    let view = await this.settle((v) => isPage(v, 'song'), 'the song view')
    for (let i = 0; i < 24; i += 1) {
      const rows = readSongRows(view)
      const hit = rows.find((r) => r.row === row)
      if (hit) {
        await this.moveCursor(3 + 3 * track + SCREEN_MARGIN, hit.screenRow)
        return view
      }
      const first = rows[0].row
      await this.press(row < first ? ['opt', 'up'] : ['opt', 'down'])
      const next = await this.maybeSettle(
        (v) => isPage(v, 'song') && readSongRows(v)[0].row !== first,
        `song row ${row}`,
        1000,
      )
      if (!next) throw new M8MoveError(`song row ${row.toString(16)} cannot be scrolled into view`)
      view = next
    }
    throw new M8MoveError(`song row ${row.toString(16)} is out of reach`)
  }

  /**
   * Instrument, Table, Scale or Groove view: Option+arrows until item `id` is shown. On the Scale view
   * Option+Up/Down jump to the first / last scale, so only Option+Left/Right are used there (and
   * on the Groove view, where there are only 32).
   */
  async stepTo(kind: 'inst' | 'table' | 'scale' | 'groove', id: number, from?: ScreenView): Promise<ScreenView> {
    let view = from ?? (await this.settle((v) => isPage(v, kind), `the ${kind} view`))
    for (let i = 0; i < 160 && view.id !== id; i += 1) {
      const current = view.id as number
      const diff = id - current
      const big = (kind === 'inst' || kind === 'table') && this.bigSteps[kind] && Math.abs(diff) >= 16
      const keys: M8KeyName[] = big ? ['opt', diff > 0 ? 'down' : 'up'] : ['opt', diff > 0 ? 'right' : 'left']
      await this.press(keys)
      const next = await this.maybeSettle((v) => isPage(v, kind) && v.id !== current, `${kind} ${id}`, 1200)
      if (!next) throw new M8MoveError(`${kind === 'inst' ? 'instrument' : kind} ${current.toString(16)} does not move on`)
      if (big && (kind === 'inst' || kind === 'table') && Math.abs(id - (next.id as number)) >= Math.abs(diff)) {
        this.log(`Option+Up/Down does not step 16 ${kind} items toward the target here; using single steps`)
        this.bigSteps[kind] = false
      }
      view = next
    }
    if (view.id !== id) throw new M8MoveError(`${kind} ${id.toString(16)} is out of reach`)
    return view
  }
}
