import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './style.css'

import { createM8ClientSync, type M8Client, observeThemeColors } from '@yam8d/m8-sdk'
import {
  absorbScreen,
  isOtherSong,
  type DeviceFocus,
  type DeviceTarget,
  deviceFocus,
  readDeviceTheme,
  readMidiSync,
  SYNC_OUT_TARGET,
  setMidiSyncOut,
  showOnDevice,
} from './m8/device'
import { ExploreCancelled, readSongRows, viewOf } from './m8/driver'
import { exploreSong } from './m8/explorer'
import { PlaybackTracker } from './m8/playback'
import { clientPort, type M8Port, withTimeout } from './m8/port'
import { describeSelection } from './m8/semantics'
import { demoSong } from './model/demo'
import { PHRASE_COLUMNS, type Selection, sameSelection, TABLE_COLUMNS } from './model/selection'
import { hex2, lastSongRow, type SongModel, usedItems } from './model/song'
import { exportModel, importModel, loadModel, loadTheme, saveModel, saveTheme } from './model/storage'
import type { SongLayout } from './scene/layout'
import { makePalette, type ThemeColors } from './scene/palette'
import { preloadText } from './scene/text'
import { World } from './scene/world'
import { type Action, Hud } from './ui/hud'
import type { PhraseColumn, TableColumn } from './m8/device'

const app = document.getElementById('app') as HTMLElement
const stage = document.createElement('div')
stage.className = 'stage'
app.append(stage)

const hud = new Hud(app)
let model: SongModel = loadModel() ?? demoSong()
let exactTheme = model.theme ?? loadTheme()
let observedTheme: Partial<ThemeColors> = {}
let paletteKey = ''
let palette = makePalette(exactTheme?.colors ?? null, model.observedColors)

let client: M8Client | null = null
let port: M8Port | null = null
let busy: 'explore' | 'theme' | 'show' | null = null
let controller: AbortController | null = null
let following = false
/** The selection (and its meaning) follows the M8 cursor. */
let autoSelect = false
/** The device place auto select chose last: a click wins until the M8 cursor moves on. */
let autoSelected: Selection | null = null
/** The M8 has another song loaded than the one explored: nothing from the screen is merged. */
let otherSong = false
let lastSongContext: { songRow: number; track: number } | null = null
let lastChainRow: number | null = null

hud.applyPalette(palette)
await preloadText()
const world = new World(stage, palette)
world.setModel(model)

// Where the song plays: screen markers, moved on at the tempo between readings.
const tracker = new PlaybackTracker(model, (world.layout as SongLayout).timeline)
let trackedLayout = world.layout
tracker.onCorrection = (track, predicted, actual, clocked) =>
  console.debug(`[playback] track ${track + 1}: predicted step ${predicted}, the M8 shows ${actual} (${actual - predicted > 0 ? '+' : ''}${actual - predicted}) · ${clocked ? 'MIDI clock' : 'tempo'}`)
world.setPlayheadSource(() => {
  if (world.layout && world.layout !== trackedLayout) {
    trackedLayout = world.layout
    tracker.setSong(model, world.layout.timeline)
  }
  return tracker.playheads(performance.now())
})

/**
 * MIDI clock from the M8 (needs SYNC OUT on in the M8's MIDI Settings): when it runs, each
 * track moves on by clock ticks (six per step, or what its groove gives) instead of by the tempo. Registered once; the
 * clock itself is enabled per device connection (enableClock).
 */
function listenToClock(c: M8Client): void {
  const local = (epochMs: number) => epochMs - performance.timeOrigin
  // Play on the M8 sends the Song Position Pointer, then Continue (or Start, from the top).
  let songPosition = 0
  c.onTransport((e) => {
    const msPerTick = e.msPerTick ?? 60000 / tracker.bpm / 24
    tracker.clockTick(e.ticks, local(e.at), msPerTick)
    if (e.kind === 'position') songPosition = e.spp ?? 0
    if ((e.kind === 'start' || e.kind === 'continue') && !otherSong) {
      const placed = tracker.transportStart(e.kind === 'start' ? 0 : songPosition, local(e.at))
      console.info(`[transport] ${e.kind} at song position ${e.kind === 'start' ? 0 : songPosition}${placed ? '' : ' (no song row starts there: following the screen)'}`)
    }
    if (e.kind === 'stop') tracker.transportReset()
  })
}

/** Asks for the clock: yam8d forwards it, a standalone page opens the M8's MIDI input itself. */
async function enableClock(c: M8Client): Promise<void> {
  try {
    const result = await c.enableMidiTransport()
    console.info('[transport]', result.ok ? 'listening to the M8 MIDI clock' : `no MIDI clock: ${result.error}`)
  } catch {
    console.info('[transport] this yam8d does not forward MIDI clock')
  }
}

/** Reads the screen often while the song plays (to catch every chain change), rarely otherwise. */
async function pollPlayback(): Promise<void> {
  if (client?.isConnected && !busy && !otherSong) {
    try {
      tracker.observe(await client.getScreen(), performance.now())
    } catch {
      // Next time.
    }
  }
  window.setTimeout(() => void pollPlayback(), tracker.playing ? 60 : 500)
}
updateSummary()
updateButtons()

// ---------------------------------------------------------------------------
// Palette: exact theme (Theme View) under what the screen shows now

function refreshPalette(): void {
  const roles = { ...(exactTheme?.colors ?? {}), ...observedTheme }
  // Column colours learnt while exploring belong to the theme of that moment: once the
  // device shows another background, they are stale and the theme roles take over.
  const learntOn = model.observedColors.song?.background?.filled
  const columns = learntOn && roles.background && learntOn !== roles.background ? {} : model.observedColors
  const key = JSON.stringify([roles, columns])
  if (key === paletteKey) return
  paletteKey = key
  palette = makePalette(roles, columns)
  hud.applyPalette(palette)
  world.setPalette(palette)
}
refreshPalette()

function updateSummary(): void {
  const rows = lastSongRow(model) + 1
  const { instruments } = usedItems(model)
  const source = model.source === 'demo' ? 'demo song' : model.source === 'file' ? 'from file' : `read ${new Date(model.capturedAt).toLocaleString()}`
  hud.setSummary(
    `${model.name ?? 'UNTITLED'}${model.tempo ? ` · ${model.tempo} BPM` : ''}${model.midiSync?.syncOut ? ` · sync ${model.midiSync.syncOut}` : ''} · ${rows} rows · ${Object.keys(model.chains).length} chains · ${Object.keys(model.phrases).length} phrases · ${instruments.length} instruments · ${source}`,
  )
  if (model.warnings.length) hud.notify(`${model.warnings.length} warning(s): ${model.warnings[0]}`, 'warn', 7000)
}

function updateButtons(): void {
  const connected = port != null
  hud.setEnabled('explore', connected && !busy)
  hud.setEnabled('theme', connected && !busy)
  hud.setEnabled('follow', connected)
  hud.setActive('follow', following)
  hud.setEnabled('autoselect', connected)
  hud.setActive('autoselect', autoSelect)
  renderSelection(world.getSelection())
}

function setModel(next: SongModel, keepView: boolean): void {
  model = next
  world.setModel(model, keepView)
  refreshPalette()
  updateSummary()
}

// ---------------------------------------------------------------------------
// Selection -> meaning

function effectiveInstrument(sel: Selection): number | null {
  if (sel.kind !== 'step') return null
  return world.layout?.effective.get(sel.instance.key)?.[sel.step] ?? null
}

function renderSelection(sel: Selection | null): void {
  hud.renderInfo(sel ? describeSelection(model, sel, effectiveInstrument(sel), world.layout?.scales) : null, port != null && !busy)
}

world.onSelect = (sel) => renderSelection(sel)
world.onHover = (sel) => {
  const d = sel ? describeSelection(model, sel, effectiveInstrument(sel), world.layout?.scales) : null
  hud.setHover(d ? [...d.path, d.title].join(' › ') : null)
}

function targetOf(sel: Selection): DeviceTarget {
  switch (sel.kind) {
    case 'step':
      return { kind: 'step', songRow: sel.instance.songRow, track: sel.instance.track, chainRow: sel.instance.chainRow, step: sel.step, column: sel.column }
    case 'chain':
      return { kind: 'chain', songRow: sel.instance.songRow, track: sel.instance.track, chainRow: sel.instance.chainRow }
    case 'table':
      return { kind: 'table', table: sel.table, row: sel.row, column: sel.column }
    case 'instrument':
      return sel.inst != null ? { kind: 'instrument', inst: sel.inst } : { kind: 'table', table: sel.table, row: 0, column: 'transpose' }
  }
}

// ---------------------------------------------------------------------------
// Device

async function connect(): Promise<void> {
  const inFrame = window.parent !== window
  hud.setStatus(inFrame ? 'Connecting to yam8d…' : 'Looking for the M8…', 'busy')
  // Inside yam8d the SDK uses yam8d's connection; on its own the page connects to the M8 itself
  const { client: c, connect: open } = createM8ClientSync()
  try {
    await withTimeout(open(), 6000, inFrame ? 'the SDK handshake' : 'the M8')
  } catch {
    hud.setStatus('Not connected · this page could not reach yam8d')
    return
  }
  client = c
  const schedule = () => scheduleSync()
  c.onViewChange(schedule)
  c.onCursorMove(schedule)
  c.onTextUpdate(schedule)
  c.onStateChange(schedule)
  // The model arrives with the M8's first system message, after the connection itself
  c.onStateChange(() => {
    if (port && !busy && !otherSong) hud.setStatus(connectedStatus(c), 'ok')
  })
  listenToClock(c)
  c.onConnectionChange((connected) => (connected ? deviceUp(c) : deviceDown(c)))
  if (c.isConnected) deviceUp(c)
  else deviceDown(c)
  void pollPlayback()
}

/** "M8 connected · M8 Model:02", plus how, when this page holds the device itself. */
function connectedStatus(c: M8Client): string {
  const how = c.mode === 'standalone' ? ` · ${c.deviceTransport ?? 'direct'}${c.isAudioConnected ? ' + audio' : ''}` : ''
  return `M8 connected · ${c.state.deviceModel ?? 'device'}${how}`
}

function deviceUp(c: M8Client): void {
  port = clientPort(c)
  hud.setStatus(connectedStatus(c), 'ok')
  hud.setButton('device', { hidden: c.mode !== 'standalone', label: 'Disconnect M8' })
  updateButtons()
  scheduleSync()
  void enableClock(c)
}

function deviceDown(c: M8Client): void {
  port = null
  tracker.transportReset()
  world.setDevice([])
  if (c.mode === 'standalone') {
    hud.setStatus('Standalone · Connect M8 (disconnect it in yam8d first)')
    hud.setButton('device', { hidden: false, label: 'Connect M8' })
  } else {
    hud.setStatus('Not connected · yam8d has no M8')
  }
  updateButtons()
}

/** Standalone: the device picker needs this click. Audio comes along when the M8 offers it. */
async function toggleDevice(): Promise<void> {
  const c = client
  if (!c || busy) return
  try {
    if (c.isConnected) {
      await c.disconnectDevice()
      return
    }
    hud.setStatus('Connecting to the M8…', 'busy')
    await c.connectDevice({ audio: true })
    if (!c.isAudioConnected) hud.notify('Connected without sound: no M8 audio input was found, or audio permission was refused', 'warn', 7000)
    deviceUp(c)
  } catch (error) {
    deviceDown(c)
    const message = error instanceof Error ? error.message : String(error)
    // Closing the browser's picker is not an error worth showing
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) hud.notify(`Could not connect to the M8: ${message}`, 'warn', 7000)
  }
}

let syncTimer = 0
function scheduleSync(): void {
  clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => void sync(), 140)
}

/** What the M8 shows now: its theme colours, edits made on the device, and where its cursor is. */
async function sync(): Promise<void> {
  if (!client?.isConnected || busy) return
  try {
    const [state, screen] = await Promise.all([client.fetchState(), client.getScreen()])
    // Background and titles: a palette change rebuilds the whole scene, so only stable colours.
    const observed = observeThemeColors(state)
    if (JSON.stringify(observed) !== JSON.stringify(observedTheme)) {
      observedTheme = observed
      refreshPalette()
    }
    const other = isOtherSong(model, screen)
    if (other != null && other !== otherSong) {
      otherSong = other
      if (other) tracker.transportReset()
      if (other) hud.notify('The M8 has another song loaded than the one shown here: Explore song to read it. Live updates are paused meanwhile.', 'warn', 9000)
      else hud.notify('The M8 is back on the explored song.')
      hud.setStatus(other ? 'M8 connected · another song is loaded' : connectedStatus(client), other ? 'busy' : 'ok')
    }
    if (otherSong) {
      world.setDevice([])
      return
    }
    if (absorbScreen(model, screen)) {
      world.setModel(model, true)
      saveModel(model)
      updateSummary()
    }
    const focus = deviceFocus(state, screen)
    const layout = world.layout
    const sels = focus && layout ? deviceSelections(layout, focus) : []
    world.setDevice(sels)
    tracker.context = lastSongContext
    const here = sels.length ? preferred(sels) : null
    if (autoSelect && here && !sameSelection(here, autoSelected)) {
      autoSelected = here
      // Following turns and scrolls by itself; alone, the selection turns the view for wall cells.
      world.select(here, following ? { silent: true, reveal: false } : { turn: true })
      if (following) renderSelection(here)
    }
    // While the song plays, following scrolls with the playheads; the cursor still picks the open track.
    if (following && here) world.follow(here, { scroll: !tracker.playing })
  } catch {
    // The next event tries again.
  }
}

function deviceSelections(layout: SongLayout, focus: DeviceFocus): Selection[] {
  const out: Selection[] = []
  const id = focus.id
  switch (focus.view) {
    case 'song': {
      const track = focus.column?.startsWith('track') ? Number(focus.column.slice(5)) - 1 : null
      if (focus.row == null || track == null) break
      lastSongContext = { songRow: focus.row, track }
      const inst = layout.timeline.byTrack[track].find((i) => i.songRow === focus.row && i.chainRow === 0)
      if (inst) out.push({ kind: 'chain', instance: inst })
      break
    }
    case 'chain':
      if (id == null || focus.row == null) break
      lastChainRow = focus.row
      for (const inst of layout.timeline.instances) if (inst.chain === id && inst.chainRow === focus.row) out.push({ kind: 'chain', instance: inst })
      break
    case 'phrase': {
      if (id == null) break
      const column = (PHRASE_COLUMNS as string[]).includes(focus.column ?? '') ? (focus.column as PhraseColumn) : 'note'
      for (const inst of layout.timeline.byPhrase.get(id) ?? []) out.push({ kind: 'step', instance: inst, step: focus.row ?? 0, column })
      break
    }
    case 'table': {
      if (id == null) break
      const column = (TABLE_COLUMNS as string[]).includes(focus.column ?? '') ? (focus.column as TableColumn) : 'transpose'
      for (const t of layout.tracks) {
        const panel = t.panels.find((p) => p.table === id)
        if (panel) out.push({ kind: 'table', table: id, row: focus.row ?? 0, column, track: t.track, inst: panel.inst })
      }
      break
    }
    case 'inst':
      for (const t of layout.tracks) {
        const panel = t.panels.find((p) => p.inst === id)
        if (panel) out.push({ kind: 'instrument', inst: id, table: panel.table, track: t.track })
      }
      break
  }
  return out.slice(0, 64)
}

/** The device place to follow: the one in the song/chain the M8 came from, else the first. */
function preferred(sels: Selection[]): Selection {
  const ctx = lastSongContext
  const match = sels.find(
    (s) =>
      (s.kind === 'step' || s.kind === 'chain') &&
      ctx &&
      s.instance.songRow === ctx.songRow &&
      s.instance.track === ctx.track &&
      (lastChainRow == null || s.instance.chainRow === lastChainRow),
  )
  return match ?? sels[0]
}

// ---------------------------------------------------------------------------
// Actions

async function explore(): Promise<void> {
  if (!port || busy) return
  const ok = await hud.confirm(
    'EXPLORE THE SONG',
    'The M8 will walk through the Song, Chain, Phrase, Instrument, Table, Scale and Groove views to read the whole song. It only presses arrows, Shift+arrows and Option+arrows, so nothing is edited; at the end it opens Project › MIDI SETTINGS (Edit on that entry) to check the sync setting. Keep your hands off the M8 until it finishes; Cancel stops it and keeps what was read.',
    'Explore',
  )
  if (!ok) return
  busy = 'explore'
  controller = new AbortController()
  updateButtons()
  hud.setStatus('Exploring the M8…', 'busy')
  hud.showProgress('Starting…', null)
  let lastDraw = 0
  try {
    const next = await exploreSong(port, {
      signal: controller.signal,
      onProgress: (p) => hud.showProgress(p.message, p.total ? p.done / p.total : null),
      onUpdate: (m) => {
        if (performance.now() - lastDraw < 1200) return
        lastDraw = performance.now()
        setModel(m, model.source === 'device')
        // Keep what was read if the page goes away mid-run.
        saveModel(m)
      },
      log: (m) => console.info('[explore]', m),
    })
    next.theme = exactTheme
    otherSong = false
    if (!controller.signal.aborted) next.midiSync = await checkMidiSync()
    setModel(next, false)
    saveModel(next)
    hud.notify(next.warnings.length ? `Explored with ${next.warnings.length} warning(s)` : 'Song explored', next.warnings.length ? 'warn' : 'info')
  } catch (error) {
    if (!(error instanceof ExploreCancelled)) hud.notify(`Exploration failed: ${(error as Error).message}`, 'warn', 8000)
  } finally {
    busy = null
    controller = null
    hud.hideProgress()
    if (client) hud.setStatus(connectedStatus(client), 'ok')
    updateButtons()
    scheduleSync()
  }
}

/**
 * After an exploration: reads the song's MIDI SYNC OUT and, when it does not send clock,
 * transport and song position, offers to set it (the explorer follows playback with them).
 * The change stays in the loaded song until the user saves it.
 */
async function checkMidiSync(): Promise<SongModel['midiSync']> {
  if (!port) return null
  hud.showProgress('Checking the MIDI sync setting…', null)
  let sync: SongModel['midiSync'] = null
  try {
    sync = await readMidiSync(port, { log: (m) => console.info('[sync]', m) })
  } catch (error) {
    console.info('[sync] not read:', (error as Error).message)
    return null
  }
  if (sync?.syncOut === SYNC_OUT_TARGET) return sync
  hud.hideProgress()
  const ok = await hud.confirm(
    'MIDI SYNC',
    `SYNC OUT is ${sync?.syncOut ?? 'unknown'} in this song. Set it to ${SYNC_OUT_TARGET}? With clock, transport and song position the explorer places every track the moment Play is pressed and follows it exactly. It changes the song's MIDI Settings (Edit held + Right on SYNC OUT); the change is kept only if you save the song on the M8.`,
    'Set it',
  )
  if (!ok) return sync
  hud.showProgress(`Setting SYNC OUT to ${SYNC_OUT_TARGET}…`, null)
  try {
    const value = await setMidiSyncOut(port, { log: (m) => console.info('[sync]', m) })
    hud.notify(`SYNC OUT set to ${value} (save the song on the M8 to keep it)`)
    return { syncIn: sync?.syncIn ?? null, syncOut: value }
  } catch (error) {
    hud.notify(`Could not set SYNC OUT: ${(error as Error).message}`, 'warn', 8000)
    return sync
  }
}

/** Key M: the same MIDI sync check as after an exploration, on demand. */
async function checkSyncNow(): Promise<void> {
  if (!port || busy) return
  busy = 'theme'
  updateButtons()
  try {
    const sync = await checkMidiSync()
    if (sync) {
      model.midiSync = sync
      saveModel(model)
      updateSummary()
      if (sync.syncOut === SYNC_OUT_TARGET) hud.notify(`SYNC OUT: ${sync.syncOut}`)
    }
  } finally {
    busy = null
    hud.hideProgress()
    updateButtons()
    scheduleSync()
  }
}

async function readTheme(): Promise<void> {
  if (!port || busy) return
  const ok = await hud.confirm(
    'READ THE DEVICE THEME',
    'The M8 will open Project › System Settings › Theme (Edit is pressed on SYSTEM SETTINGS and on EDIT THEME, after checking the cursor is on them), read the 13 colours, then leave with Option and go back to the current view.',
    'Read theme',
  )
  if (!ok) return
  busy = 'theme'
  updateButtons()
  hud.showProgress('Reading the theme…', null)
  try {
    const theme = await readDeviceTheme(port, { log: (m) => console.info('[theme]', m) })
    console.info('[theme] read', JSON.stringify(theme))
    exactTheme = theme
    model.theme = theme
    saveTheme(theme)
    saveModel(model)
    refreshPalette()
    hud.notify(`Theme read${theme.name ? `: ${theme.name}` : ''} (${theme.mode.toUpperCase()})`)
  } catch (error) {
    console.info('[theme] failed:', (error as Error).message)
    hud.notify(`Could not read the theme: ${(error as Error).message}`, 'warn', 8000)
  } finally {
    busy = null
    hud.hideProgress()
    updateButtons()
    scheduleSync()
  }
}

async function showSelection(): Promise<void> {
  const sel = world.getSelection()
  if (!port || busy || !sel) return
  busy = 'show'
  updateButtons()
  try {
    await showOnDevice(port, model, targetOf(sel))
  } catch (error) {
    hud.notify(`Could not reach it on the M8: ${(error as Error).message}`, 'warn', 7000)
  } finally {
    busy = null
    updateButtons()
    scheduleSync()
  }
}

function toggleAutoSelect(): void {
  if (!port) return
  autoSelect = !autoSelect
  autoSelected = null
  updateButtons()
  scheduleSync()
}

const DRAMATIC_KEY = 'm8-song-explorer:dramatic'
let dramatic = (() => {
  try {
    return localStorage.getItem(DRAMATIC_KEY) === '1'
  } catch {
    return false
  }
})()
world.setDramatic(dramatic)
hud.setActive('dramatic', dramatic)

function toggleDramatic(): void {
  dramatic = !dramatic
  world.setDramatic(dramatic)
  hud.setActive('dramatic', dramatic)
  try {
    localStorage.setItem(DRAMATIC_KEY, dramatic ? '1' : '0')
  } catch {}
}

const PLAYED_KEY = 'm8-song-explorer:played-notes'
let playedNotes = (() => {
  try {
    return localStorage.getItem(PLAYED_KEY) !== '0'
  } catch {
    return true
  }
})()
world.setPlayedNotes(playedNotes)
hud.setActive('played', playedNotes)

function togglePlayedNotes(): void {
  playedNotes = !playedNotes
  world.setPlayedNotes(playedNotes)
  hud.setActive('played', playedNotes)
  try {
    localStorage.setItem(PLAYED_KEY, playedNotes ? '1' : '0')
  } catch {}
}

hud.onAction = (action: Action) => {
  switch (action) {
    case 'device':
      return void toggleDevice()
    case 'explore':
      return void explore()
    case 'cancel':
      return controller?.abort()
    case 'theme':
      return void readTheme()
    case 'follow':
      following = !following
      world.followPlayback = following
      if (!following) world.follow(null)
      updateButtons()
      return scheduleSync()
    case 'autoselect':
      return toggleAutoSelect()
    case 'front':
    case 'angle':
    case 'side':
    case 'overview':
      return world.view(action)
    case 'expand':
      return hud.setActive('expand', world.toggleExpandAll())
    case 'dramatic':
      return toggleDramatic()
    case 'played':
      return togglePlayedNotes()
    case 'export':
      return exportModel(model)
    case 'import':
      return void importModel().then((m) => {
        if (!m) return hud.notify('That file is not a song exported by this app', 'warn')
        setModel(m, false)
        saveModel(m)
      })
    case 'demo':
      return setModel(demoSong(), false)
    case 'show':
      return void showSelection()
    case 'help':
      return hud.toggleHelp()
  }
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return
  // Space plays / stops the M8, as it does in yam8d.
  if (e.code === 'Space') {
    e.preventDefault()
    if (!e.repeat && client?.isConnected) void client.sendKeyPress(e.shiftKey ? ['shift', 'play'] : ['play'])
    return
  }
  const keys: Record<string, () => void> = {
    ArrowUp: () => world.moveSelection(-1, 0),
    ArrowDown: () => world.moveSelection(1, 0),
    ArrowLeft: () => world.moveSelection(0, -1),
    ArrowRight: () => world.moveSelection(0, 1),
    PageUp: () => world.scrollRows(-16),
    PageDown: () => world.scrollRows(16),
    Home: () => world.view('overview'),
    '0': () => world.view('overview'),
    '1': () => world.view('front'),
    '2': () => world.view('angle'),
    '3': () => world.view('side'),
    e: () => hud.setActive('expand', world.toggleExpandAll()),
    x: () => toggleDramatic(),
    t: () => togglePlayedNotes(),
    f: () => world.focusSelection(),
    Enter: () => void showSelection(),
    Escape: () => world.select(null),
    '+': () => world.zoom(0.8),
    '=': () => world.zoom(0.8),
    '-': () => world.zoom(1.25),
    '?': () => hud.toggleHelp(),
    d: () => void dumpScreen(),
    m: () => void checkSyncNow(),
    a: () => toggleAutoSelect(),
  }
  const run = keys[e.key]
  if (run) {
    e.preventDefault()
    run()
  }
})

/** Diagnostics: what the SDK reads on the M8 right now, in the console. */
async function dumpScreen(): Promise<void> {
  if (!client) return console.info('[screen] not connected')
  const [state, screen] = await Promise.all([client.fetchState(), client.getScreen()])
  const view = viewOf(screen)
  console.info('[screen]', JSON.stringify({ view: { kind: view.kind, id: view.id, title: view.title }, state: { viewName: state.viewName, viewTitle: state.viewTitle, cursorPos: state.cursorPos, currentLine: state.currentLine } }))
  console.info(`[screen] lines\n${screen.lines.map((l, y) => `${String(y).padStart(2, '0')}|${l}|`).join('\n')}`)
  const rows = view.kind === 'song' ? readSongRows(view) : []
  console.info('[screen] song rows', JSON.stringify(rows))
  // Colours as letters, one per distinct colour, so markers drawn in another colour stand out.
  const cells = await port?.getScreenCells()
  if (!cells) return
  const legend = new Map<string, string>()
  const letter = (c: string | null) => {
    if (!c) return ' '
    if (!legend.has(c)) legend.set(c, String.fromCharCode(97 + legend.size))
    return legend.get(c) as string
  }
  const map = cells.fg.map((row, y) => `${String(y).padStart(2, '0')}|${row.map((c, x) => ((cells.lines[y][x] ?? ' ') === ' ' ? ' ' : letter(c))).join('').trimEnd()}|`)
  console.info(`[screen] colours ${JSON.stringify(Object.fromEntries([...legend].map(([c, l]) => [l, c])))} state=${JSON.stringify({ background: state.backgroundColor, title: state.titleColor, cursor: state.cursorColor })}\n${map.join('\n')}`)
}

// Debug handle for the console and for automated checks.
Object.assign(window as object, {
  __m8explorer: {
    world,
    get model() {
      return model
    },
    hex2,
    /** Try a theme without the device: roles as '#rrggbb'. */
    setTheme(colors: Partial<ThemeColors>) {
      observedTheme = colors
      refreshPalette()
    },
  },
})

void connect()
