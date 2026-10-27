// The app: connects the song model, the 3D view, the HUD and the M8. It owns the shared state
// (the song shown, the device connection, what runs on the device) and turns HUD actions and
// keys into commands.

import { createM8ClientSync, type M8Client, observeThemeColors } from '@yam8d/m8-sdk'
import { ExploreCancelled } from '../m8/driver'
import { clientPort, type M8Port, withTimeout } from '../m8/port'
import { absorbScreen, deviceFocus, isOtherSong } from '../m8/screen/liveScreen'
import { viewOf } from '../m8/screen/screenReader'
import { describeSelection } from '../m8/semantics'
import { exploreSong, moveToSongTop } from '../m8/tasks/explorer'
import { type ChannelPlan, planChannel, readMidiSync, SYNC_OUT_TARGET, setCcMapChannel, setMidiSyncOut } from '../m8/tasks/midiSync'
import { deviceTargetOf, showOnDevice } from '../m8/tasks/showOnDevice'
import { readDeviceTheme } from '../m8/tasks/themeReader'
import { debugLog, type RunHandle } from '../model/debugLog'
import { demoSong } from '../model/demo'
import { hex2 } from '../model/hex'
import { type Selection, sameSelection } from '../model/selection'
import { lastSongRow, type MidiSync, type SongModel, usedItems } from '../model/song'
import { loadModel, loadTheme, saveModel, saveTheme } from '../model/storage'
import type { ThemeColors } from '../scene/palette'
import { preloadText } from '../scene/text'
import { World } from '../scene/world'
import { downloadDebugReport, openInAnalyzer } from '../ui/debugFile'
import { type Action, Hud } from '../ui/hud'
import { downloadSong, pickSongFile } from '../ui/songFile'
import { registerDebugProviders, watchPage } from './debugReport'
import { DeviceCursor } from './deviceCursor'
import { dumpScreen } from './diagnostics'
import { bindKeyboard, type KeyCommands } from './keyboard'
import { PlaybackFeed } from './playbackFeed'
import { preferences } from './preferences'
import { ThemeColorsSource } from './themeColors'
import { TrackMixer } from './trackMixer'

/** What runs on the device: one thing at a time. */
type DeviceTask = 'explore' | 'theme' | 'sync' | 'show'

const HANDSHAKE_TIMEOUT_MS = 6000
/** Device events are read once things calm down for this long. */
const SYNC_DEBOUNCE_MS     = 140
/** While exploring, the view is redrawn at most this often. */
const EXPLORE_REDRAW_MS    = 1200

const messageOf      = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** A message of a device task: to the console, and to the run it belongs to in the debug log. */
const logTo          = (tag: string, run?: RunHandle) => (message: string) => {
  console.info(tag, message)
  run?.message(`${tag} ${message}`)
}
/** Actions whose own events say more than "the button was pressed". */
const SILENT_ACTIONS : Action[] = ['help', 'follow', 'autoselect', 'explore', 'theme']

const CONFIRM_EXPLORE =
  'The M8 will walk through the Song, Chain, Phrase, Instrument, Table, Scale and Groove views to read the whole song. It only presses arrows, Shift+arrows and Option+arrows, so nothing is edited; at the end it opens Project › MIDI SETTINGS (Edit on that entry) to check the sync setting, then puts the cursor on the first cell of the Song view. Keep your hands off the M8 until it finishes; Cancel stops it and keeps what was read.'
const CONFIRM_THEME   =
  'The M8 will open Project › System Settings › Theme (Edit is pressed on SYSTEM SETTINGS and on EDIT THEME, after checking the cursor is on them), read the 13 colours, then leave with Option and go back to the current view.'

/** The MIDI Settings changes the explorer asks for: SYNC OUT (when `syncOut` is set) and CC MAP CHAN (when the plan sets it). */
function confirmMidiSettings(syncOut: string | null, plan: ChannelPlan, sync: MidiSync, explorerChannel: number): string {
  const parts: string[] = []
  if (syncOut != null) {
    parts.push(
      `SYNC OUT is ${syncOut} in this song. It would be set to ${SYNC_OUT_TARGET}: with clock, transport and song position the explorer places every track the moment Play is pressed and follows it exactly.`,
    )
  }
  if (plan.kind === 'set') {
    const cue = sync.songRowCueChan ?? 'unknown'
    parts.push(
      plan.reason === 'all'
        ? `CC MAP CHAN is ALL on the M8, so the mute / solo notes cannot reach a single track. It would be set to channel ${plan.channel}, the channel of the explorer's mute / solo buttons${plan.moved ? ` (not ${explorerChannel}: SONG ROW CUE CHAN already uses it, and is left as it is)` : ''}.`
        : `CC MAP CHAN and SONG ROW CUE CHAN are both ${cue}, so the mute / solo notes would cue song rows. SONG ROW CUE CHAN is left as it is; CC MAP CHAN would be set to channel ${plan.channel}.`,
    )
    if (plan.channel !== explorerChannel) parts.push(`The explorer's mute / solo channel changes from ${explorerChannel} to ${plan.channel}.`)
  }
  parts.push("This changes the song's MIDI Settings (Edit held + Right / Left on the value); the changes are kept only if you save the song on the M8.")
  return parts.join(' ')
}

export class ExplorerApp {
  private readonly hud      : Hud
  private readonly world    : World
  private readonly theme    : ThemeColorsSource
  private readonly playback : PlaybackFeed
  private readonly mixer    : TrackMixer
  private readonly cursor   = new DeviceCursor()
  private model             : SongModel

  private client          : M8Client | null = null
  private port            : M8Port | null = null
  private task            : DeviceTask | null = null
  private exploration     : AbortController | null = null
  private following       = false
  /** The selection (and its meaning) follows the M8 cursor. */
  private autoSelect      = false
  /** The device place auto select chose last: a click wins until the M8 cursor moves on. */
  private autoSelected    : Selection | null = null
  /** The M8 has another song loaded than the one explored: nothing from the screen is merged. */
  private otherSongLoaded = false
  private syncTimer       = 0
  /** The view the M8 was last seen on ('phrase:3'), to log its changes. */
  private deviceView      : string | null = null

  /** Shows the HUD at once, and the 3D view once the text font is loaded. */
  static async start(root: HTMLElement): Promise<ExplorerApp> {
    const stage     = document.createElement('div')
    stage.className = 'stage'
    root.append(stage)
    const hud   = new Hud(root, preferences.infoPinned.get())
    const model = loadModel() ?? demoSong()
    const theme = new ThemeColorsSource(model.theme ?? loadTheme(), model)
    hud.applyPalette(theme.palette)
    await preloadText()
    return new ExplorerApp(hud, new World(stage, theme.palette), theme, model)
  }

  private constructor(hud: Hud, world: World, theme: ThemeColorsSource, model: SongModel) {
    this.hud               = hud
    this.world             = world
    this.theme             = theme
    this.model             = model
    this.hud.onInfoPinned  = (pinned) => preferences.infoPinned.set(pinned)
    this.hud.onDebugExport = () => void this.exportDebugLog()
    this.world.setModel(this.model)
    this.playback          = new PlaybackFeed(
      this.world,
      () => this.model,
      () => (this.client?.isConnected && !this.task && !this.otherSongLoaded ? this.client : null),
      () => this.otherSongLoaded,
    )
    this.playback.appState = () => ({
      following : this.following,
      autoSelect: this.autoSelect,
      task      : this.task
    })
    this.updateSummary()
    this.updateButtons()
    this.refreshPalette()
    this.bindSelection()
    this.applyViewPreferences()
    this.mixer        = new TrackMixer(this.world, this.hud)
    const commands    = this.commands()
    this.hud.onAction = (action) => {
      if (!SILENT_ACTIONS.includes(action)) debugLog.event('action', { action })
      commands[action]()
    }
    bindKeyboard(this.keyCommands(commands), (fromCursor) => this.play(fromCursor))
    this.exposeDebugHandle()
    this.setUpDebugLog()
  }

  // ---------------------------------------------------------------------------
  // Commands

  private commands(): Record<Action, () => void> {
    const { world, hud } = this
    return {
      device    : () => void this.toggleDevice(),
      explore   : () => void this.explore(),
      cancel    : () => this.exploration?.abort(),
      theme     : () => void this.readTheme(),
      follow    : () => this.toggleFollow(),
      autoselect: () => this.toggleAutoSelect(),
      front     : () => world.view('front'),
      angle     : () => world.view('angle'),
      side      : () => world.view('side'),
      overview  : () => world.view('overview'),
      expand    : () => hud.setActive('expand', world.toggleAllWalls()),
      dramatic  : () => this.toggleDramatic(),
      played    : () => this.togglePlayedNotes(),
      export    : () => downloadSong(this.model),
      import    : () => void this.importSong(),
      demo      : () => this.setModel(demoSong(), false),
      show      : () => void this.showSelection(),
      help      : () => hud.toggleHelp()
    }
  }

  private keyCommands(command: Record<Action, () => void>): KeyCommands {
    const { world } = this
    return {
      ArrowUp           : () => world.moveSelection(-1, 0),
      ArrowDown         : () => world.moveSelection(1, 0),
      ArrowLeft         : () => world.moveSelection(0, -1),
      ArrowRight        : () => world.moveSelection(0, 1),
      'Shift+ArrowUp'   : () => world.moveSelection(-1, 0, true),
      'Shift+ArrowDown' : () => world.moveSelection(1, 0, true),
      'Shift+ArrowLeft' : () => world.moveSelection(0, -1, true),
      'Shift+ArrowRight': () => world.moveSelection(0, 1, true),
      PageUp            : () => world.scrollRows(-16),
      PageDown          : () => world.scrollRows(16),
      Home              : command.overview,
      '0'               : command.overview,
      '1'               : command.front,
      '2'               : command.angle,
      '3'               : command.side,
      e                 : command.expand,
      x                 : command.dramatic,
      t                 : command.played,
      a                 : command.autoselect,
      f                 : () => world.focusSelection(),
      i                 : () => world.toggleSelectedFace(),
      Enter             : command.show,
      Escape            : () => world.select(null),
      '+'               : () => world.zoom(0.8),
      '='               : () => world.zoom(0.8),
      '-'               : () => world.zoom(1.25),
      '?'               : command.help,
      d                 : () => void dumpScreen(this.client, this.port),
      m                 : () => void this.checkSyncNow()
    }
  }

  /** Space: play / stop the M8; Shift+Space continues from the cursor. */
  private play(fromCursor: boolean): void {
    debugLog.event('play-key', {
      fromCursor,
      connected: this.client?.isConnected ?? false,
      playing  : this.playback.tracker.playing,
      cursor   : this.playback.tracker.context,
      task     : this.task
    })
    if (this.client?.isConnected) void this.client.sendKeyPress(fromCursor ? ['shift', 'play'] : ['play'])
  }

  // ---------------------------------------------------------------------------
  // Song and view state

  private setModel(model: SongModel, keepView: boolean): void {
    this.model = model
    this.world.setModel(model, keepView)
    this.refreshPalette()
    this.updateSummary()
  }

  private refreshPalette(): void {
    const palette = this.theme.refresh(this.model)
    if (!palette) return
    this.hud.applyPalette(palette)
    this.world.setPalette(palette)
  }

  private updateSummary(): void {
    const { model } = this
    const source    =
      model.source === 'demo' ? 'demo song' : model.source === 'file' ? 'from file' : `read ${new Date(model.capturedAt).toLocaleString()}`
    const parts     = [
      `${model.name ?? 'UNTITLED'}${model.tempo ? ` · ${model.tempo} BPM` : ''}${model.midiSync?.syncOut ? ` · sync ${model.midiSync.syncOut}` : ''}`,
      `${lastSongRow(model) + 1} rows`,
      `${Object.keys(model.chains).length} chains`,
      `${Object.keys(model.phrases).length} phrases`,
      `${usedItems(model).instruments.length} instruments`,
      source,
    ]
    this.hud.setSummary(parts.join(' · '))
    if (model.warnings.length) this.hud.notify(`${model.warnings.length} warning(s): ${model.warnings[0]}`, 'warn', 7000, false)
  }

  private updateButtons(): void {
    const { hud }   = this
    const connected = this.port != null
    hud.setEnabled('explore', connected && !this.task)
    hud.setEnabled('theme', connected && !this.task)
    hud.setEnabled('follow', connected)
    hud.setActive('follow', this.following)
    hud.setEnabled('autoselect', connected)
    hud.setActive('autoselect', this.autoSelect)
    this.renderSelection(this.world.getSelection())
  }

  private applyViewPreferences(): void {
    const dramatic = preferences.dramatic.get()
    this.world.setDramatic(dramatic)
    this.hud.setActive('dramatic', dramatic)
    const playedNotes = preferences.playedNotes.get()
    this.world.setPlayedNotes(playedNotes)
    this.hud.setActive('played', playedNotes)
  }

  private toggleDramatic(): void {
    const dramatic = !preferences.dramatic.get()
    preferences.dramatic.set(dramatic)
    this.world.setDramatic(dramatic)
    this.hud.setActive('dramatic', dramatic)
  }

  private togglePlayedNotes(): void {
    const playedNotes = !preferences.playedNotes.get()
    preferences.playedNotes.set(playedNotes)
    this.world.setPlayedNotes(playedNotes)
    this.hud.setActive('played', playedNotes)
  }

  private async importSong(): Promise<void> {
    const model = await pickSongFile()
    if (!model) return this.hud.notify('That file is not a song exported by this app', 'warn')
    debugLog.event('import', {
      name  : model.name,
      chains: Object.keys(model.chains).length
    })
    this.setModel(model, false)
    saveModel(model)
  }

  // ---------------------------------------------------------------------------
  // Selection -> meaning

  private bindSelection(): void {
    this.world.onSelect = (selection) => this.renderSelection(selection)
    this.world.onHover  = (selection) => {
      const description = selection ? this.describe(selection) : null
      this.hud.setHover(description ? [...description.path, description.title].join(' › ') : null)
    }
  }

  private describe(selection: Selection) {
    const instrument = selection.kind === 'step' ? (this.world.layout?.effective.get(selection.instance.key)?.[selection.step] ?? null) : null
    return describeSelection(this.model, selection, instrument, this.world.layout?.scales)
  }

  private renderSelection(selection: Selection | null): void {
    this.hud.renderInfo(selection ? this.describe(selection) : null, this.port != null && !this.task)
  }

  // ---------------------------------------------------------------------------
  // Device connection

  async connect(): Promise<void> {
    const inFrame = window.parent !== window
    this.hud.setStatus(inFrame ? 'Connecting to yam8d…' : 'Looking for the M8…', 'busy')
    // Inside yam8d the SDK uses yam8d's connection; on its own the page connects to the M8 itself.
    const { client, connect } = createM8ClientSync()
    const asked               = performance.now()
    try {
      await withTimeout(connect(), HANDSHAKE_TIMEOUT_MS, inFrame ? 'the SDK handshake' : 'the M8')
      debugLog.provide('handshake', {
        ok  : true,
        ms  : Math.round(performance.now() - asked),
        mode: client.mode
      })
    } catch (error) {
      debugLog.provide('handshake', {
        ok   : false,
        ms   : Math.round(performance.now() - asked),
        error: messageOf(error)
      })
      debugLog.problem('handshake', messageOf(error))
      this.hud.setStatus('Not connected · this page could not reach yam8d')
      return
    }
    this.client        = client
    const scheduleSync = () => this.scheduleSync()
    client.onViewChange(scheduleSync)
    client.onCursorMove(scheduleSync)
    client.onTextUpdate(scheduleSync)
    client.onStateChange(scheduleSync)
    // The model arrives with the M8's first system message, after the connection itself.
    client.onStateChange(() => {
      if (this.port && !this.task && !this.otherSongLoaded) this.hud.setStatus(connectedStatus(client), 'ok')
    })
    this.playback.listenToClock(client)
    client.onConnectionChange((connected) => (connected ? this.deviceUp(client) : this.deviceDown(client)))
    if (client.isConnected) this.deviceUp(client)
    else this.deviceDown(client)
    void this.playback.poll()
  }

  private deviceUp(client: M8Client): void {
    debugLog.event('connection', {
      up         : true,
      mode       : client.mode,
      transport  : client.deviceTransport,
      audio      : client.isAudioConnected,
      deviceModel: client.state.deviceModel
    })
    this.port = clientPort(client)
    this.hud.setStatus(connectedStatus(client), 'ok')
    this.hud.setButton('device', {
      hidden: client.mode !== 'standalone',
      label : 'Disconnect M8'
    })
    this.updateButtons()
    this.scheduleSync()
    void this.playback.enableClock(client)
  }

  private deviceDown(client: M8Client): void {
    debugLog.event('connection', {
      up  : false,
      mode: client.mode
    })
    this.port       = null
    this.deviceView = null
    this.world.setDeviceInstrument(null)
    this.playback.tracker.transportReset('device-down')
    this.world.setDevicePlaces([])
    if (client.mode === 'standalone') {
      this.hud.setStatus('Standalone · Connect M8 (disconnect it in yam8d first)')
      this.hud.setButton('device', {
        hidden: false,
        label : 'Connect M8'
      })
    } else {
      this.hud.setStatus('Not connected · yam8d has no M8')
    }
    this.updateButtons()
  }

  /** Standalone: the device picker needs this click. Audio comes along when the M8 offers it. */
  private async toggleDevice(): Promise<void> {
    const client = this.client
    if (!client || this.task) return
    try {
      if (client.isConnected) {
        await client.disconnectDevice()
        return
      }
      this.hud.setStatus('Connecting to the M8…', 'busy')
      await client.connectDevice({ audio: true })
      if (!client.isAudioConnected)
        this.hud.notify('Connected without sound: no M8 audio input was found, or audio permission was refused', 'warn', 7000)
      this.deviceUp(client)
    } catch (error) {
      this.deviceDown(client)
      // Closing the browser's picker is not an error worth showing.
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        debugLog.event('connect-cancelled')
      } else {
        debugLog.problem('connect', messageOf(error))
        this.hud.notify(`Could not connect to the M8: ${messageOf(error)}`, 'warn', 7000)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Live: what the M8 shows now

  private scheduleSync(): void {
    clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => void this.sync(), SYNC_DEBOUNCE_MS)
  }

  /** What the M8 shows now: its theme colours, edits made on the device, and where its cursor is. */
  private async sync(): Promise<void> {
    const client = this.client
    if (!client?.isConnected || this.task) return
    try {
      const [state, screen] = await Promise.all([client.fetchState(), client.getScreen()])
      // Background and titles: a palette change rebuilds the whole scene, so only stable colours.
      if (this.theme.observe(observeThemeColors(state))) this.refreshPalette()
      this.noteOtherSong(client, isOtherSong(this.model, screen))
      if (this.otherSongLoaded) {
        this.world.setDevicePlaces([])
        this.world.setDeviceInstrument(null)
        return
      }
      if (absorbScreen(this.model, screen)) {
        const seen = viewOf(screen)
        debugLog.event('device-edit', {
          view   : seen.kind,
          id     : seen.id,
          title  : seen.title,
          playing: this.playback.tracker.playing
        })
        this.world.setModel(this.model, true)
        saveModel(this.model)
        this.updateSummary()
      }
      const focus  = deviceFocus(state, screen)
      this.noteDeviceView(focus, state.viewTitle)
      const layout = this.world.layout
      // On the Instrument or Inst. Mods view, that instrument's panels turn to their instrument face.
      this.world.setDeviceInstrument(focus && (focus.view === 'inst' || focus.view === 'instmods') ? focus.id : null)
      const places = focus && layout ? this.cursor.placesOf(layout, focus) : []
      this.world.setDevicePlaces(places)
      this.playback.tracker.context = this.cursor.songContext
      this.followCursor(this.cursor.preferred(places))
    } catch (error) {
      // The next event tries again.
      debugLog.problem('sync', messageOf(error))
    }
  }

  /** The view the M8 is on changed: one event per view (not per cursor move). */
  private noteDeviceView(focus: ReturnType<typeof deviceFocus>, title: string | null): void {
    const key = focus ? `${focus.view}:${focus.id ?? ''}` : null
    if (key === this.deviceView) return
    this.deviceView = key
    debugLog.event('device-view', {
      view  : focus?.view ?? null,
      id    : focus?.id ?? null,
      title,
      row   : focus?.row ?? null,
      column: focus?.column ?? null
    })
  }

  /** Pauses live updates while the M8 has another song loaded (null: the screen cannot tell). */
  private noteOtherSong(client: M8Client, other: boolean | null): void {
    if (other == null || other === this.otherSongLoaded) return
    this.otherSongLoaded = other
    debugLog.event('other-song', {
      other,
      explored: this.model.name,
      playing : this.playback.tracker.playing
    })
    if (other) {
      this.playback.tracker.transportReset('other-song')
      this.hud.notify(
        'The M8 has another song loaded than the one shown here: Explore song to read it. Live updates are paused meanwhile.',
        'warn',
        9000,
      )
      this.hud.setStatus('M8 connected · another song is loaded', 'busy')
    } else {
      this.hud.notify('The M8 is back on the explored song.')
      this.hud.setStatus(connectedStatus(client), 'ok')
    }
  }

  /** Auto select and Follow M8: the place under the M8 cursor. */
  private followCursor(place: Selection | null): void {
    if (this.autoSelect && place && !sameSelection(place, this.autoSelected)) {
      this.autoSelected = place
      // Following turns and scrolls by itself; alone, the selection turns the view for wall cells.
      this.world.select(place, this.following ? {
        silent: true,
        reveal: false
      } : { turn: true })
      if (this.following) this.renderSelection(place)
    }
    // While the song plays, following scrolls with the playheads; the cursor still picks the open track.
    if (this.following && place) this.world.follow(place, { scroll: !this.playback.tracker.playing })
  }

  private toggleFollow(): void {
    this.following            = !this.following
    debugLog.event('follow', {
      on       : this.following,
      connected: this.port != null,
      playing  : this.playback.tracker.playing
    })
    this.world.followPlayback = this.following
    if (!this.following) this.world.follow(null)
    this.updateButtons()
    this.scheduleSync()
  }

  private toggleAutoSelect(): void {
    if (!this.port) return
    this.autoSelect   = !this.autoSelect
    debugLog.event('auto-select', { on: this.autoSelect })
    this.autoSelected = null
    this.updateButtons()
    this.scheduleSync()
  }

  // ---------------------------------------------------------------------------
  // Device tasks

  /** Runs one task on the device at a time; the buttons follow, and the live view catches up after. */
  private async runDeviceTask(task: DeviceTask, run: (port: M8Port) => Promise<void>): Promise<void> {
    const port = this.port
    if (!port || this.task) return
    this.task = task
    this.updateButtons()
    try {
      await run(port)
    } finally {
      this.task = null
      this.hud.hideProgress()
      this.updateButtons()
      this.scheduleSync()
    }
  }

  private async explore(): Promise<void> {
    if (!this.port || this.task) return
    if (!(await this.hud.confirm('EXPLORE THE SONG', CONFIRM_EXPLORE, 'Explore'))) return
    await this.runDeviceTask('explore', async (port) => {
      const exploration = new AbortController()
      this.exploration  = exploration
      const run         = debugLog.startRun('explore', {
        previousSong: this.model.name,
        source      : this.model.source,
        transport   : this.client?.deviceTransport ?? null,
        following   : this.following
      })
      this.hud.setStatus('Exploring the M8…', 'busy')
      this.hud.showProgress('Starting…', null)
      let lastDrawAt = 0
      try {
        const explored       = await exploreSong(port, {
          signal    : exploration.signal,
          onProgress: (progress) => {
            run.phase(progress.phase, progress.message)
            this.hud.showProgress(progress.message, progress.total ? progress.done / progress.total : null)
          },
          onUpdate  : (model) => {
            if (performance.now() - lastDrawAt < EXPLORE_REDRAW_MS) return
            lastDrawAt = performance.now()
            this.setModel(model, this.model.source === 'device')
            // Keep what was read if the page goes away mid-run.
            saveModel(model)
          },
          log       : logTo('[explore]', run)
        })
        explored.theme       = this.theme.exactTheme
        this.otherSongLoaded = false
        if (!exploration.signal.aborted) {
          explored.midiSync = await this.checkMidiSync(port, run)
          await this.returnToSongTop(port, run)
        }
        this.setModel(explored, false)
        saveModel(explored)
        const warnings = explored.warnings.length
        run.finish(exploration.signal.aborted ? 'cancelled' : 'done', {
          name       : explored.name,
          tempo      : explored.tempo ?? null,
          rows       : lastSongRow(explored) + 1,
          chains     : Object.keys(explored.chains).length,
          phrases    : Object.keys(explored.phrases).length,
          instruments: Object.keys(explored.instruments).length,
          tables     : Object.keys(explored.tables).length,
          scales     : Object.keys(explored.scales ?? {}).length,
          grooves    : Object.keys(explored.grooves ?? {}).length,
          midiSync   : explored.midiSync ?? null
        }, explored.warnings)
        this.hud.notify(warnings ? `Explored with ${warnings} warning(s)` : 'Song explored', warnings ? 'warn' : 'info', 4200, false)
      } catch (error) {
        if (!(error instanceof ExploreCancelled)) {
          run.finish('failed', { error: messageOf(error) })
          this.hud.notify(`Exploration failed: ${messageOf(error)}`, 'warn', 8000)
        } else {
          run.finish('cancelled')
        }
      } finally {
        this.exploration = null
        if (this.client) this.hud.setStatus(connectedStatus(this.client), 'ok')
      }
    })
  }

  /** The end of an exploration: the M8 on the Song view, cursor on row 00, so Play starts from the top. */
  private async returnToSongTop(port: M8Port, run: RunHandle): Promise<void> {
    this.hud.showProgress('Moving the cursor to the top of the song…', null)
    run.phase('song-top', 'Moving the cursor to the top of the song')
    try {
      await moveToSongTop(port, { log: logTo('[explore]', run) })
    } catch (error) {
      run.message(`[explore] cursor not moved to the top of the song: ${messageOf(error)}`)
      debugLog.problem('song-top', messageOf(error))
    }
  }

  /**
   * Reads the song's MIDI SYNC OUT and, when it does not send clock, transport and song
   * position, offers to set it (the explorer follows playback with them). The change stays in
   * the loaded song until the user saves it.
   */
  private async checkMidiSync(port: M8Port, run: RunHandle): Promise<MidiSync | null> {
    this.hud.showProgress('Checking the MIDI sync setting…', null)
    run.phase('midi-sync', 'Checking the MIDI sync setting')
    let sync: MidiSync
    try {
      sync = await readMidiSync(port, { log: logTo('[sync]', run) })
    } catch (error) {
      console.info('[sync] not read:', messageOf(error))
      run.message(`[sync] not read: ${messageOf(error)}`)
      debugLog.problem('midi-sync', `MIDI settings not read: ${messageOf(error)}`)
      return null
    }
    const plan    = planChannel(sync, this.mixer.channel)
    const syncDue = sync.syncOut !== SYNC_OUT_TARGET
    run.message(`[sync] read ${JSON.stringify(sync)}; channel plan ${JSON.stringify(plan)}; explorer channel ${this.mixer.channel}`)
    if (plan.kind === 'adopt' && plan.channel !== this.mixer.channel) {
      this.mixer.useChannel(plan.channel)
      this.hud.notify(`Mute / solo channel set to ${plan.channel}, the M8's CC MAP CHAN`)
    }
    if (!syncDue && plan.kind !== 'set') return sync
    this.hud.hideProgress()
    const message = confirmMidiSettings(syncDue ? (sync.syncOut ?? 'unknown') : null, plan, sync, this.mixer.channel)
    if (!(await this.hud.confirm('MIDI SETTINGS', message, 'Apply'))) {
      run.message('[sync] changes declined')
      return sync
    }
    let result = sync
    if (syncDue) result = await this.applySyncOut(port, result, run)
    if (plan.kind === 'set') result = await this.applyCcMapChannel(port, result, plan.channel, run)
    return result
  }

  private async applySyncOut(port: M8Port, sync: MidiSync, run: RunHandle): Promise<MidiSync> {
    this.hud.showProgress(`Setting SYNC OUT to ${SYNC_OUT_TARGET}…`, null)
    try {
      const syncOut = await setMidiSyncOut(port, { log: logTo('[sync]', run) })
      this.hud.notify(`SYNC OUT set to ${syncOut} (save the song on the M8 to keep it)`)
      return {
        ...sync,
        syncOut
      }
    } catch (error) {
      run.message(`[sync] SYNC OUT not set: ${messageOf(error)}`)
      this.hud.notify(`Could not set SYNC OUT: ${messageOf(error)}`, 'warn', 8000)
      return sync
    }
  }

  /** Sets the M8's CC MAP CHAN, then the explorer's mute / solo channel follows it. */
  private async applyCcMapChannel(port: M8Port, sync: MidiSync, channel: number, run: RunHandle): Promise<MidiSync> {
    this.hud.showProgress(`Setting CC MAP CHAN to ${channel}…`, null)
    try {
      const ccMapChan = await setCcMapChannel(port, channel, { log: logTo('[sync]', run) })
      this.mixer.useChannel(channel)
      this.hud.notify(`CC MAP CHAN set to ${ccMapChan}, mute / solo use it (save the song on the M8 to keep it)`)
      return {
        ...sync,
        ccMapChan
      }
    } catch (error) {
      run.message(`[sync] CC MAP CHAN not set: ${messageOf(error)}`)
      this.hud.notify(`Could not set CC MAP CHAN: ${messageOf(error)}`, 'warn', 8000)
      return sync
    }
  }

  /** Key M: the same MIDI sync check as after an exploration, on demand. */
  private checkSyncNow(): Promise<void> {
    return this.runDeviceTask('sync', async (port) => {
      const run  = debugLog.startRun('sync', { previous: this.model.midiSync ?? null })
      const sync = await this.checkMidiSync(port, run)
      run.finish(sync ? 'done' : 'failed', { midiSync: sync })
      if (!sync) return
      this.model.midiSync = sync
      saveModel(this.model)
      this.updateSummary()
      if (sync.syncOut === SYNC_OUT_TARGET) this.hud.notify(`SYNC OUT: ${sync.syncOut}`)
    })
  }

  private async readTheme(): Promise<void> {
    if (!this.port || this.task) return
    if (!(await this.hud.confirm('READ THE DEVICE THEME', CONFIRM_THEME, 'Read theme'))) return
    await this.runDeviceTask('theme', async (port) => {
      this.hud.showProgress('Reading the theme…', null)
      const run = debugLog.startRun('theme')
      try {
        const theme = await readDeviceTheme(port, { log: logTo('[theme]', run) })
        console.info('[theme] read', JSON.stringify(theme))
        this.theme.exactTheme = theme
        this.model.theme      = theme
        saveTheme(theme)
        saveModel(this.model)
        this.refreshPalette()
        run.finish('done', {
          name: theme.name ?? null,
          mode: theme.mode
        })
        this.hud.notify(`Theme read${theme.name ? `: ${theme.name}` : ''} (${theme.mode.toUpperCase()})`)
      } catch (error) {
        console.info('[theme] failed:', messageOf(error))
        run.finish('failed', { error: messageOf(error) })
        this.hud.notify(`Could not read the theme: ${messageOf(error)}`, 'warn', 8000)
      }
    })
  }

  private showSelection(): Promise<void> {
    const selection = this.world.getSelection()
    if (!selection) return Promise.resolve()
    return this.runDeviceTask('show', async (port) => {
      const target = deviceTargetOf(selection)
      try {
        await showOnDevice(port, this.model, target)
        debugLog.event('show-on-device', {
          target,
          ok: true
        })
      } catch (error) {
        debugLog.event('show-on-device', {
          target,
          ok   : false,
          error: messageOf(error)
        })
        this.hud.notify(`Could not reach it on the M8: ${messageOf(error)}`, 'warn', 7000)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Debugging

  /** The debug log's global sections and page watchers; the rolling events are written where things happen. */
  private setUpDebugLog(): void {
    registerDebugProviders(debugLog, {
      client  : () => this.client,
      model   : () => this.model,
      mixer   : () => this.mixer.info(),
      settings: () => ({
        following      : this.following,
        autoSelect     : this.autoSelect,
        otherSongLoaded: this.otherSongLoaded,
        deviceTask     : this.task,
        deviceView     : this.deviceView,
        deviceConnected: this.port != null,
        status         : this.hud.statusText()
      })
    })
    watchPage(debugLog, () => this.playback.tracker.playing)
    debugLog.event('start', {
      song  : this.model.name,
      source: this.model.source
    })
  }

  /** Double click on the ? button: the debug log opens in the log analyzer, or is saved as a JSON file when that cannot be. */
  private async exportDebugLog(): Promise<void> {
    debugLog.event('debug-export')
    // The analyzer's tab opens inside the click; the log (permission queries take a moment) follows.
    const report  = debugLog.report()
    const opened  = await openInAnalyzer(report)
    const data    = await report
    const summary = `${data.events.length} events, ${data.problems.length} problems`
    if (opened) return this.hud.notify(`Debug log opened in the analyzer (${summary})`, 'info', 5000, false)
    const file = downloadDebugReport(data, this.model.name)
    this.hud.notify(`Debug log saved: ${file} (${summary})`, 'info', 5000, false)
  }

  /** A handle for the console and for automated checks. */
  private exposeDebugHandle(): void {
    const app = this
    Object.assign(window as object, {
      __m8explorer: {
        world: this.world,
        debugLog,
        get model() {
          return app.model
        },
        hex2,
        /** Try a theme without the device: roles as '#rrggbb'. */
        setTheme(colors: Partial<ThemeColors>) {
          app.theme.observe(colors)
          app.refreshPalette()
        }
      },
    })
  }
}

/** "M8 connected · M8 Model:02", plus how, when this page holds the device itself. */
function connectedStatus(client: M8Client): string {
  const how = client.mode === 'standalone' ? ` · ${client.deviceTransport ?? 'direct'}${client.isAudioConnected ? ' + audio' : ''}` : ''
  return `M8 connected · ${client.state.deviceModel ?? 'device'}${how}`
}
