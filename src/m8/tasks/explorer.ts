// Walks the whole song on the M8: pages the Song view, enters every chain used (Shift+Right
// from its first song cell), every phrase those chains play, then every instrument the
// phrases use with its table and modulators, the tables TBL/TBX point at, and the scales the song plays with
// (the project's and the ones SCA/SCG point at) and the grooves (the project's and the ones
// GRV/GGR point at). Only moves, never edits.

import { SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X } from '../../model/columns'
import { hex2 } from '../../model/hex'
import { referencedGrooves } from '../../model/music/groove'
import { referencedScales } from '../../model/music/harmony'
import { chainLength, emptyModel, SONG_ROWS, type SongModel, TRACKS, usedItems } from '../../model/song'
import { ExploreCancelled, type ItemView, M8Driver, M8MoveError } from '../driver'
import type { M8Port } from '../port'
import { learnColumnColors } from '../screen/colorReader'
import {
  gridRowScreenY,
  INSTRUMENT_TYPE_X,
  instrumentTypeRow,
  isPage,
  readChain,
  readGroove,
  readInstrument,
  readInstrumentMods,
  readPhrase,
  readProject,
  readScale,
  readSongRows,
  readTable,
  type ScreenView,
  type ViewKind,
} from '../screen/screenReader'

export interface ExploreProgress {
  phase  : 'song' | 'chains' | 'instruments' | 'tables' | 'scales' | 'grooves' | 'done'
  message: string
  done   : number
  total  : number
}

export interface ExploreOptions {
  signal?         : AbortSignal
  onProgress?     : (progress: ExploreProgress) => void
  /** Called whenever the model gained something (to draw while exploring). */
  onUpdate?       : (model: SongModel) => void
  readInstruments?: boolean
  readTables?     : boolean
  /** Read each instrument's Inst. Mods view (its modulators). */
  readMods?       : boolean
  readScales?     : boolean
  readGrooves?    : boolean
  /** Song rows to read from row 00 (all 256 by default). */
  songRows?       : number
  pollMs?         : number
  settleTimeoutMs?: number
  log?            : (message: string) => void
}

/** One item step of the exploration: every listed item of one view kind, read in turn. */
interface ItemStep {
  view    : ItemView
  phase   : ExploreProgress['phase']
  ids     : number[]
  /** Reads the item on screen (and what is reached from it); returns the view to step on from. */
  read    : (view: ScreenView, id: number) => Promise<ScreenView>
  /** Scales and grooves only refine the view: a view that cannot be reached ends the step with a warning. */
  optional: boolean
}

const ITEM_NAMES                  : Record<ItemView, string> = {
  inst  : 'instrument',
  table : 'table',
  scale : 'scale',
  groove: 'groove'
}

const SONG_TOP_PAGES              = 24
const PROJECT_VIEW_TIMEOUT_MS     = 2500
const NEXT_SONG_PAGE_TIMEOUT_MS   = 1500
const INSTRUMENT_TABLE_TIMEOUT_MS = 1500
const NEXT_PHRASE_TIMEOUT_MS      = 900

const capitalize = (text: string): string => text[0].toUpperCase() + text.slice(1)
const messageOf  = (error: unknown): string => (error as Error).message

/** Explores the song on the M8 behind `port`; a cancelled run returns what was read. */
export function exploreSong(port: M8Port, options: ExploreOptions = {}): Promise<SongModel> {
  return new SongExplorer(port, options).run()
}

class SongExplorer {
  private readonly model              = emptyModel('device')
  private readonly driver             : M8Driver
  private readonly log                : (message: string) => void
  private readonly colorsLearnt       = new Set<ViewKind>()
  /** Whether Option+Down in a phrase moves to the chain's next phrase (learnt on the device). */
  private optionDownReachesNextPhrase : boolean | null = null

  constructor(
    private readonly port: M8Port,
    private readonly options: ExploreOptions,
  ) {
    this.log    = options.log ?? (() => {})
    this.driver = new M8Driver(port, {
      pollMs         : options.pollMs,
      settleTimeoutMs: options.settleTimeoutMs,
      signal         : options.signal,
      log            : this.log
    })
  }

  async run(): Promise<SongModel> {
    const { options, model } = this
    const readTables         = options.readTables ?? true
    try {
      await this.readProjectSettings()
      await this.readSongGrid()
      await this.readChains()
      if (options.readInstruments ?? true) await this.readInstruments(readTables, options.readMods ?? true)
      if (readTables) await this.readTablesNotYetRead()
      if (options.readScales ?? true) await this.readScales()
      if (options.readGrooves ?? true) await this.readGrooves()
      // Leave the M8 on the song, where the exploration started.
      await this.driver.goToView('song').catch(() => {})
      this.progress('done', 'Song explored', 1, 1)
    } catch (error) {
      if (!(error instanceof ExploreCancelled)) throw error
      model.warnings.push('exploration cancelled: the model is incomplete')
      this.progress('done', 'Cancelled', 0, 1)
    }
    model.capturedAt = Date.now()
    this.update()
    return model
  }

  private progress(phase: ExploreProgress['phase'], message: string, done: number, total: number): void {
    this.options.onProgress?.({ phase, message, done, total })
  }

  private update(): void {
    this.options.onUpdate?.(this.model)
  }

  /** Learns the colours of a view kind once, from a fresh screen with colours. */
  private async learnColors(view: ScreenView): Promise<void> {
    if (this.colorsLearnt.has(view.kind)) return
    this.colorsLearnt.add(view.kind)
    const cells = await this.port.getScreenCells()
    if (!cells) return
    const colors = learnColumnColors(view.kind, cells)
    if (colors) this.model.observedColors[view.kind] = colors
  }

  // ---------------------------------------------------------------------------
  // Song

  private async readProjectSettings(): Promise<void> {
    this.progress('song', 'Reading the project name', 0, 1)
    await this.driver.leaveSubViews()
    try {
      await this.port.navigateToView('project')
      const view    = await this.driver.settle((v) => readProject(v.screen) != null, 'the project view', PROJECT_VIEW_TIMEOUT_MS)
      const project = readProject(view.screen)
      Object.assign(this.model, {
        name            : project?.name ?? null,
        tempo           : project?.tempo ?? null,
        projectTranspose: project?.transpose ?? null,
        projectScale    : project?.scale ?? null,
        projectKey      : project?.key ?? null,
        projectGroove   : project?.groove ?? null
      })
    } catch (error) {
      if (error instanceof ExploreCancelled) throw error
      this.log(`project name not read: ${messageOf(error)}`)
    }
  }

  /** Song view, Option+Up to row 00, then Option+Down page by page. */
  private async readSongGrid(): Promise<void> {
    const { driver, model } = this
    this.progress('song', 'Reading the song view', 0, 1)
    let view       = await driver.goToView('song')
    const rowLimit = Math.min(SONG_ROWS, this.options.songRows ?? SONG_ROWS)
    for (let page = 0; page < SONG_TOP_PAGES && readSongRows(view)[0].row > 0; page += 1) {
      const firstRow = readSongRows(view)[0].row
      await driver.press(['opt', 'up'])
      view = await driver.settle((v) => isPage(v, 'song') && readSongRows(v)[0].row < firstRow, 'the top of the song')
    }
    await this.learnColors(view)
    this.log(`first song page as read:\n${numberedLines(view.screen.lines)}`)
    this.storeSongPage(view, rowLimit)
    for (;;) {
      const lastRow = readSongRows(view).at(-1)?.row ?? 0
      this.progress('song', `Song rows 00-${hex2(lastRow)}`, lastRow + 1, rowLimit)
      if (lastRow >= rowLimit - 1) break
      await driver.press(['opt', 'down'])
      const next = await driver.settleOrNull(
        (v) => isPage(v, 'song') && (readSongRows(v).at(-1)?.row ?? 0) > lastRow,
        'the next song page',
        NEXT_SONG_PAGE_TIMEOUT_MS,
      )
      if (!next) break
      view = next
      this.storeSongPage(view, rowLimit)
    }
    for (let row = 0; row < model.song.length; row += 1) model.song[row] ??= Array(TRACKS).fill(null)
    this.update()
  }

  private storeSongPage(view: ScreenView, rowLimit: number): void {
    const rows = readSongRows(view)
    if (rows.some((reading) => reading.chains.some((chain) => chain != null))) {
      const first = rows[0]
      const last  = rows[rows.length - 1]
      const cells = rows.map((reading) => `${hex2(reading.row)}=${reading.chains.map((chain) => hex2(chain)).join(' ')}`).join(' | ')
      this.log(`song page ${hex2(first.row)}-${hex2(last.row)} on screen rows ${first.screenRow}-${last.screenRow}: ${cells}`)
    }
    for (const reading of rows) if (reading.row < rowLimit) this.model.song[reading.row] = reading.chains
  }

  // ---------------------------------------------------------------------------
  // Chains and their phrases

  private async readChains(): Promise<void> {
    const firstCell = new Map<number, { row: number; track: number }>()
    for (const [row, chains] of this.model.song.entries()) {
      for (const [track, chain] of chains.entries()) if (chain != null && !firstCell.has(chain)) firstCell.set(chain, { row, track })
    }
    let done = 0
    for (const [chainId, { row, track }] of firstCell) {
      this.progress('chains', `Chain ${hex2(chainId)} (song row ${hex2(row)}, track ${track + 1})`, done, firstCell.size)
      try {
        await this.exploreChain(chainId, row, track)
      } catch (error) {
        if (error instanceof ExploreCancelled) throw error
        this.model.warnings.push(`chain ${hex2(chainId)}: ${messageOf(error)}`)
        this.log(`chain ${hex2(chainId)} failed: ${messageOf(error)}`)
        await this.driver.leaveSubViews()
        await this.driver.goToView('song')
      }
      done += 1
      this.update()
    }
  }

  /**
   * Song cell -> Shift+Right -> chain. Each phrase the chain plays is entered from its
   * row; a phrase right below the one just read is reached with Option+Down (next
   * phrase in the chain) while the device agrees.
   */
  private async exploreChain(chainId: number, songRow: number, track: number): Promise<void> {
    const { driver, model } = this
    const isThisChain       = (view: ScreenView) => isPage(view, 'chain', chainId)
    await driver.moveToSongCell(songRow, track)
    const chainView = await driver.pressToOpen(['shift', 'right'], isThisChain, `chain ${hex2(chainId)}`)
    await this.learnColors(chainView)
    const chain = readChain(chainView)
    if (!chain) throw new M8MoveError(`chain ${hex2(chainId)} could not be read`)
    model.chains[chainId] = chain

    let inPhrase     = false
    let lastChainRow = -1
    for (let chainRow = 0; chainRow < chainLength(chain); chainRow += 1) {
      const phraseId = chain.rows[chainRow].phrase
      if (phraseId == null || model.phrases[phraseId]) continue
      const isThisPhrase = (view: ScreenView) => isPage(view, 'phrase', phraseId)
      if (inPhrase && chainRow === lastChainRow + 1 && this.optionDownReachesNextPhrase !== false) {
        await driver.press(['opt', 'down'])
        const phraseView = await driver.settleOrNull(isThisPhrase, `phrase ${hex2(phraseId)}`, NEXT_PHRASE_TIMEOUT_MS)
        if (phraseView) {
          this.optionDownReachesNextPhrase = true
          this.storePhrase(phraseView)
          lastChainRow = chainRow
          continue
        }
        this.log('Option+Down in the phrase view did not reach the next phrase of the chain; entering each phrase from the chain')
        this.optionDownReachesNextPhrase = false
      }
      if (inPhrase) {
        await driver.pressToOpen(['shift', 'left'], isThisChain, `chain ${hex2(chainId)}`)
        inPhrase = false
      }
      const rowY = gridRowScreenY(chainView, 'chain', chainRow)
      if (rowY == null) throw new M8MoveError(`chain row ${chainRow.toString(16)} is not on screen`)
      await driver.moveCursor(COLUMN_X.chain.phrase + SCREEN_MARGIN, rowY)
      const phraseView = await driver.pressToOpen(['shift', 'right'], isThisPhrase, `phrase ${hex2(phraseId)}`)
      await this.learnColors(phraseView)
      this.storePhrase(phraseView)
      inPhrase     = true
      lastChainRow = chainRow
    }
    if (inPhrase) await driver.pressToOpen(['shift', 'left'], isThisChain, `chain ${hex2(chainId)}`)
    await driver.pressToOpen(['shift', 'left'], (view) => isPage(view, 'song'), 'the song view')
  }

  private storePhrase(view: ScreenView): void {
    const phrase = readPhrase(view)
    if (phrase) this.model.phrases[phrase.id] = phrase
  }

  // ---------------------------------------------------------------------------
  // Instruments, tables, scales and grooves

  private readInstruments(readTables: boolean, readMods: boolean): Promise<void> {
    return this.readEachItem({
      view    : 'inst',
      phase   : 'instruments',
      ids     : usedItems(this.model).instruments,
      optional: false,
      read    : async (view, id) => {
        const instrument = readInstrument(view)
        if (instrument) this.model.instruments[id] = instrument
        const back = readTables ? await this.readInstrumentTable(view, id) : view
        return readMods ? this.readModulators(id) : back
      }
    })
  }

  /** Shift+Right to the instrument's table, read it, Shift+Left back; returns the instrument view. */
  private async readInstrumentTable(instrumentView: ScreenView, id: number): Promise<ScreenView> {
    const { driver }  = this
    const isTablePage = (view: ScreenView) => isPage(view, 'table')
    const what        = `the table of instrument ${hex2(id)}`
    await driver.press(['shift', 'right'])
    let tableView = await driver.settleOrNull(isTablePage, what, INSTRUMENT_TABLE_TIMEOUT_MS)
    if (!tableView) {
      // Seen on the device: Shift+Right left the Instrument view in place once. Retry
      // from the TYPE value, a field where Shift+Right means "table".
      const typeRow = instrumentTypeRow(instrumentView)
      if (typeRow >= 0) await driver.moveCursor(INSTRUMENT_TYPE_X + SCREEN_MARGIN, typeRow)
      await driver.press(['shift', 'right'])
      tableView = await driver.settle(isTablePage, what)
    }
    await this.learnColors(tableView)
    const table = readTable(tableView)
    if (table) this.model.tables[table.id] = table
    return driver.pressToOpen(['shift', 'left'], (view) => isPage(view, 'inst', id), `instrument ${hex2(id)}`)
  }

  /** Shift+Up to the instrument's Inst. Mods view, read it, Shift+Down back; returns the instrument view. */
  private async readModulators(id: number): Promise<ScreenView> {
    const { driver } = this
    const modsView   = await driver.pressToOpen(['shift', 'up'], (view) => isPage(view, 'instmods', id), `the modulators of instrument ${hex2(id)}`)
    const mods       = readInstrumentMods(modsView)
    const instrument = this.model.instruments[id]
    if (mods && instrument) instrument.mods = mods.lines
    // Shift+Down goes back to the view the Mods view was entered from: the Instrument view.
    return driver.pressToOpen(['shift', 'down'], (view) => isPage(view, 'inst', id), `instrument ${hex2(id)}`)
  }

  /** The tables only reached through TBL / TBX. */
  private readTablesNotYetRead(): Promise<void> {
    return this.readEachItem({
      view    : 'table',
      phase   : 'tables',
      ids     : usedItems(this.model).tables.filter((table) => !this.model.tables[table]),
      optional: false,
      read    : async (view, id) => {
        const table = readTable(view)
        if (table) this.model.tables[id] = table
        return view
      }
    })
  }

  /** The project's scale and the ones SCA / SCG point at. */
  private readScales(): Promise<void> {
    const scales      : NonNullable<SongModel['scales']> = {}
    this.model.scales = scales
    return this.readEachItem({
      view    : 'scale',
      phase   : 'scales',
      ids     : [...new Set([this.model.projectScale ?? 0, ...referencedScales(this.model), ...this.instrumentScales()])].sort((a, b) => a - b),
      optional: true,
      read    : async (view, id) => {
        const scale = readScale(view)
        if (scale) scales[id] = scale
        return view
      }
    })
  }

  /** The scales Hypersynth instruments pick with their SCALE parameter (00 uses the song / track scale). */
  private instrumentScales(): number[] {
    const ids: number[] = []
    for (const instrument of Object.values(this.model.instruments)) {
      if (instrument.type !== 'HYPERSYN') continue
      for (const line of instrument.lines) {
        const id = /^SCALE\s+([0-9A-F]{2})/i.exec(line)?.[1]
        if (id && Number.parseInt(id, 16) > 0) ids.push(Number.parseInt(id, 16) & 0x0f)
      }
    }
    return ids
  }

  /** The project's groove and the ones GRV / GGR point at: step lengths for the playheads. */
  private readGrooves(): Promise<void> {
    const grooves      : NonNullable<SongModel['grooves']> = {}
    this.model.grooves = grooves
    return this.readEachItem({
      view    : 'groove',
      phase   : 'grooves',
      ids     : referencedGrooves(this.model),
      optional: true,
      read    : async (view, id) => {
        const groove = readGroove(view)
        if (groove) grooves[id] = groove
        return view
      }
    })
  }

  /**
   * Goes to the item view, then steps to each item and reads it. A failed item is noted in
   * the warnings and the view is reached again for the next one.
   */
  private async readEachItem(step: ItemStep): Promise<void> {
    if (step.ids.length === 0) return
    const { driver, model } = this
    const itemName          = ITEM_NAMES[step.view]
    let view                : ScreenView | null
    try {
      view = await driver.goToView(step.view)
    } catch (error) {
      if (!step.optional || error instanceof ExploreCancelled) throw error
      model.warnings.push(`${itemName}s not read: ${messageOf(error)}`)
      this.log(`${itemName} view not reached: ${messageOf(error)}`)
      return
    }
    for (const [index, id] of step.ids.entries()) {
      this.progress(step.phase, `${capitalize(itemName)} ${hex2(id)}`, index, step.ids.length)
      try {
        view = await driver.stepToItem(step.view, id, view ?? undefined)
        view = await step.read(view, id)
      } catch (error) {
        if (error instanceof ExploreCancelled) throw error
        model.warnings.push(`${itemName} ${hex2(id)}: ${messageOf(error)}`)
        await driver.leaveSubViews()
        view = await driver.goToView(step.view).catch(() => null)
        if (!view && step.optional) break
      }
      this.update()
    }
  }
}

/** Screen lines prefixed with their row number, for the log. */
export const numberedLines = (lines: string[]): string => lines.map((line, y) => `${String(y).padStart(2, '0')}|${line}|`).join('\n')
