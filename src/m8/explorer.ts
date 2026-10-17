// Walks the whole song on the M8: pages the Song view, enters every chain used (Shift+Right
// from its first song cell), every phrase those chains play, then every instrument the
// phrases use and its table, the tables TBL/TBX point at, and the scales the song plays with
// (the project's and the ones SCA/SCG point at) and the grooves (the project's and the ones
// GRV/GGR point at). Only moves, never edits.

import { parseGridScreen, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { referencedGrooves } from '../model/groove'
import { COLUMNS } from '../model/screens'
import { ScaleMap } from '../model/harmony'
import { chainLength, emptyModel, hex2, type SongModel, SONG_ROWS, TRACKS, usedItems } from '../model/song'
import {
  ExploreCancelled,
  isPage,
  readGroove,
  readProject,
  readScale,
  learnColors,
  M8Driver,
  M8MoveError,
  readChain,
  readInstrument,
  readPhrase,
  readSongRows,
  readTable,
  type ScreenView,
  type ViewKind,
} from './driver'
import type { M8Port } from './port'

export interface ExploreProgress {
  phase: 'song' | 'chains' | 'instruments' | 'tables' | 'scales' | 'grooves' | 'done'
  message: string
  done: number
  total: number
}

export interface ExploreOptions {
  signal?: AbortSignal
  onProgress?: (progress: ExploreProgress) => void
  /** Called whenever the model gained something (to draw while exploring). */
  onUpdate?: (model: SongModel) => void
  readInstruments?: boolean
  readTables?: boolean
  readScales?: boolean
  readGrooves?: boolean
  /** Song rows to read from row 00 (all 256 by default). */
  songRows?: number
  pollMs?: number
  settleTimeoutMs?: number
  log?: (message: string) => void
}

export async function exploreSong(port: M8Port, options: ExploreOptions = {}): Promise<SongModel> {
  const model = emptyModel('device')
  const log = options.log ?? (() => {})
  const driver = new M8Driver(port, { pollMs: options.pollMs, settleTimeoutMs: options.settleTimeoutMs, signal: options.signal, log })
  const progress = (p: ExploreProgress) => options.onProgress?.(p)
  const update = () => options.onUpdate?.(model)
  const learnt = new Set<ViewKind>()
  /** Whether Option+Down in a phrase moves to the chain's next phrase (learnt on the device). */
  let optionDownWorks: boolean | null = null

  /** Learns the colours of a view kind once, from a fresh screen with colours. */
  const learn = async (view: ScreenView) => {
    if (learnt.has(view.kind)) return
    learnt.add(view.kind)
    const cells = await port.getScreenCells()
    if (!cells) return
    const colors = learnColors(view.kind, cells)
    if (colors) model.observedColors[view.kind] = colors
  }

  try {
    // --- Song -------------------------------------------------------------
    progress({ phase: 'song', message: 'Reading the project name', done: 0, total: 1 })
    await driver.leaveSubViews()
    try {
      await port.navigateToView('project')
      const pv = await driver.settle((v) => readProject(v.screen) != null, 'the project view', 2500)
      const project = readProject(pv.screen)
      model.name = project?.name ?? null
      model.tempo = project?.tempo ?? null
      model.projectTranspose = project?.transpose ?? null
      model.projectScale = project?.scale ?? null
      model.projectKey = project?.key ?? null
      model.projectGroove = project?.groove ?? null
    } catch (error) {
      if (error instanceof ExploreCancelled) throw error
      log(`project name not read: ${(error as Error).message}`)
    }
    progress({ phase: 'song', message: 'Reading the song view', done: 0, total: 1 })
    let view = await driver.gotoView('song')
    const limit = Math.min(SONG_ROWS, options.songRows ?? SONG_ROWS)
    for (let i = 0; i < 24 && readSongRows(view)[0].row > 0; i += 1) {
      const first = readSongRows(view)[0].row
      await driver.press(['opt', 'up'])
      view = await driver.settle((v) => isPage(v, 'song') && readSongRows(v)[0].row < first, 'the top of the song')
    }
    await learn(view)
    log(`first song page as read:\n${view.screen.lines.map((l, y) => `${String(y).padStart(2, '0')}|${l}|`).join('\n')}`)
    const record = (v: ScreenView) => {
      const rows = readSongRows(v)
      if (rows.some((r) => r.chains.some((c) => c != null))) log(`song page ${hex2(rows[0].row)}-${hex2(rows.at(-1)!.row)} on screen rows ${rows[0].screenRow}-${rows.at(-1)!.screenRow}: ${rows.map((r) => `${hex2(r.row)}=${r.chains.map((c) => hex2(c)).join(' ')}`).join(' | ')}`)
      for (const r of rows) if (r.row < limit) model.song[r.row] = r.chains
    }
    record(view)
    for (;;) {
      const rows = readSongRows(view)
      const last = rows[rows.length - 1].row
      progress({ phase: 'song', message: `Song rows 00-${hex2(last)}`, done: last + 1, total: limit })
      if (last >= limit - 1) break
      await driver.press(['opt', 'down'])
      const next = await driver.maybeSettle(
        (v) => isPage(v, 'song') && readSongRows(v).at(-1)!.row > last,
        'the next song page',
        1500,
      )
      if (!next) break
      view = next
      record(view)
    }
    for (let r = 0; r < model.song.length; r += 1) model.song[r] ??= Array(TRACKS).fill(null)
    update()

    // --- Chains and their phrases ----------------------------------------------
    const firstCell = new Map<number, { row: number; track: number }>()
    model.song.forEach((chains, row) =>
      chains.forEach((chain, track) => {
        if (chain != null && !firstCell.has(chain)) firstCell.set(chain, { row, track })
      }),
    )
    const chainIds = [...firstCell.keys()]
    let done = 0
    for (const chainId of chainIds) {
      const { row, track } = firstCell.get(chainId) as { row: number; track: number }
      progress({ phase: 'chains', message: `Chain ${hex2(chainId)} (song row ${hex2(row)}, track ${track + 1})`, done, total: chainIds.length })
      try {
        await visitChain(chainId, row, track)
      } catch (error) {
        if (error instanceof ExploreCancelled) throw error
        model.warnings.push(`chain ${hex2(chainId)}: ${(error as Error).message}`)
        log(`chain ${hex2(chainId)} failed: ${(error as Error).message}`)
        await recoverToSong()
      }
      done += 1
      update()
    }

    // --- Instruments and their tables -----------------------------------------
    const readTables = options.readTables ?? true
    if (options.readInstruments ?? true) {
      const { instruments } = usedItems(model)
      let at: ScreenView | null = instruments.length ? await driver.gotoView('inst') : null
      for (const [i, id] of instruments.entries()) {
        progress({ phase: 'instruments', message: `Instrument ${hex2(id)}`, done: i, total: instruments.length })
        try {
          at = await driver.stepTo('inst', id, at ?? undefined)
          const inst = readInstrument(at)
          if (inst) model.instruments[id] = inst
          if (readTables) {
            await driver.press(['shift', 'right'])
            let tv = await driver.maybeSettle((v) => isPage(v, 'table'), `the table of instrument ${hex2(id)}`, 1500)
            if (!tv) {
              // Seen on the device: Shift+Right left the Instrument view in place once. Retry
              // from the TYPE value, a field where Shift+Right means "table".
              const typeRow = at.screen.lines.findIndex((l) => /^TYPE\b/i.test(l.slice(SCREEN_MARGIN)))
              if (typeRow >= 0) await driver.moveCursor(8 + SCREEN_MARGIN, typeRow)
              await driver.press(['shift', 'right'])
              tv = await driver.settle((v) => isPage(v, 'table'), `the table of instrument ${hex2(id)}`)
            }
            await learn(tv)
            const table = readTable(tv)
            if (table) model.tables[table.id] = table
            at = await driver.pressTo(['shift', 'left'], (v) => isPage(v, 'inst', id), `instrument ${hex2(id)}`)
          }
        } catch (error) {
          if (error instanceof ExploreCancelled) throw error
          model.warnings.push(`instrument ${hex2(id)}: ${(error as Error).message}`)
          at = null
          await driver.leaveSubViews()
          at = await driver.gotoView('inst').catch(() => null)
        }
        update()
      }
    }

    // --- Tables reached through TBL / TBX -----------------------------------------
    if (readTables) {
      const missing = usedItems(model).tables.filter((t) => !model.tables[t])
      let at: ScreenView | null = missing.length ? await driver.gotoView('table') : null
      for (const [i, id] of missing.entries()) {
        progress({ phase: 'tables', message: `Table ${hex2(id)}`, done: i, total: missing.length })
        try {
          at = await driver.stepTo('table', id, at ?? undefined)
          const table = readTable(at)
          if (table) model.tables[id] = table
        } catch (error) {
          if (error instanceof ExploreCancelled) throw error
          model.warnings.push(`table ${hex2(id)}: ${(error as Error).message}`)
          at = await driver.gotoView('table').catch(() => null)
        }
        update()
      }
    }

    // --- Scales: the project's and the ones SCA / SCG point at -------------------
    if (options.readScales ?? true) {
      const wanted = [...new Set([model.projectScale ?? 0, ...ScaleMap.referenced(model)])].sort((a, b) => a - b)
      model.scales = {}
      let at: ScreenView | null = null
      try {
        at = await driver.gotoView('scale')
      } catch (error) {
        if (error instanceof ExploreCancelled) throw error
        model.warnings.push(`scales not read: ${(error as Error).message}`)
        log(`scale view not reached: ${(error as Error).message}`)
      }
      for (const [i, id] of (at ? wanted : []).entries()) {
        progress({ phase: 'scales', message: `Scale ${hex2(id)}`, done: i, total: wanted.length })
        try {
          at = await driver.stepTo('scale', id, at ?? undefined)
          const scale = readScale(at)
          if (scale) model.scales[id] = scale
        } catch (error) {
          if (error instanceof ExploreCancelled) throw error
          model.warnings.push(`scale ${hex2(id)}: ${(error as Error).message}`)
          at = await driver.gotoView('scale').catch(() => null)
          if (!at) break
        }
        update()
      }
    }

    // --- Grooves: the project's and the ones GRV / GGR point at (step lengths for the playheads)
    if (options.readGrooves ?? true) {
      const wanted = referencedGrooves(model)
      model.grooves = {}
      let at: ScreenView | null = null
      try {
        at = await driver.gotoView('groove')
      } catch (error) {
        if (error instanceof ExploreCancelled) throw error
        model.warnings.push(`grooves not read: ${(error as Error).message}`)
        log(`groove view not reached: ${(error as Error).message}`)
      }
      for (const [i, id] of (at ? wanted : []).entries()) {
        progress({ phase: 'grooves', message: `Groove ${hex2(id)}`, done: i, total: wanted.length })
        try {
          at = await driver.stepTo('groove', id, at ?? undefined)
          const groove = readGroove(at)
          if (groove) model.grooves[id] = groove
        } catch (error) {
          if (error instanceof ExploreCancelled) throw error
          model.warnings.push(`groove ${hex2(id)}: ${(error as Error).message}`)
          at = await driver.gotoView('groove').catch(() => null)
          if (!at) break
        }
        update()
      }
    }

    // Leave the M8 on the song, where the exploration started.
    await driver.gotoView('song').catch(() => {})
    progress({ phase: 'done', message: 'Song explored', done: 1, total: 1 })
  } catch (error) {
    if (!(error instanceof ExploreCancelled)) throw error
    model.warnings.push('exploration cancelled: the model is incomplete')
    progress({ phase: 'done', message: 'Cancelled', done: 0, total: 1 })
  }
  model.capturedAt = Date.now()
  update()
  return model

  async function recoverToSong(): Promise<void> {
    await driver.leaveSubViews()
    await driver.gotoView('song')
  }

  /**
   * Song cell -> Shift+Right -> chain. Each phrase the chain plays is entered from its
   * row; a phrase right below the one just read is reached with Option+Down (next
   * phrase in the chain) while the device agrees.
   */
  async function visitChain(chainId: number, row: number, track: number): Promise<void> {
    await driver.songCursorTo(row, track)
    const cv = await driver.pressTo(['shift', 'right'], (v) => isPage(v, 'chain', chainId), `chain ${hex2(chainId)}`)
    await learn(cv)
    const chain = readChain(cv)
    if (!chain) throw new M8MoveError(`chain ${hex2(chainId)} could not be read`)
    model.chains[chainId] = chain

    const len = chainLength(chain)
    let inPhrase = false
    let lastRow = -1
    for (let i = 0; i < len; i += 1) {
      const phraseId = chain.rows[i].phrase
      if (phraseId == null || model.phrases[phraseId]) continue
      if (inPhrase && i === lastRow + 1 && optionDownWorks !== false) {
        await driver.press(['opt', 'down'])
        const pv = await driver.maybeSettle((v) => isPage(v, 'phrase', phraseId), `phrase ${hex2(phraseId)}`, 900)
        if (pv) {
          optionDownWorks = true
          storePhrase(pv)
          lastRow = i
          continue
        }
        log('Option+Down in the phrase view did not reach the next phrase of the chain; entering each phrase from the chain')
        optionDownWorks = false
      }
      if (inPhrase) {
        await driver.pressTo(['shift', 'left'], (v) => isPage(v, 'chain', chainId), `chain ${hex2(chainId)}`)
        inPhrase = false
      }
      await driver.moveCursor(COLUMNS.chain.phrase + SCREEN_MARGIN, chainRowY(cv, i))
      const pv = await driver.pressTo(['shift', 'right'], (v) => isPage(v, 'phrase', phraseId), `phrase ${hex2(phraseId)}`)
      await learn(pv)
      storePhrase(pv)
      inPhrase = true
      lastRow = i
    }
    if (inPhrase) {
      await driver.pressTo(['shift', 'left'], (v) => isPage(v, 'chain', chainId), `chain ${hex2(chainId)}`)
    }
    await driver.pressTo(['shift', 'left'], (v) => isPage(v, 'song'), 'the song view')
  }

  function storePhrase(view: ScreenView): void {
    const phrase = readPhrase(view)
    if (phrase) model.phrases[phrase.id] = phrase
  }
}

/** Screen row chain row `i` is drawn on. */
function chainRowY(view: ScreenView, i: number): number {
  const hit = parseGridScreen('chain', view.screen).find((r) => r.rowIndex === i)
  if (!hit) throw new M8MoveError(`chain row ${i.toString(16)} is not on screen`)
  return hit.screenRow
}
