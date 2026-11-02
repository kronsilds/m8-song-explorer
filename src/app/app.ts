// The app: wires the song shown, the 3D view, the HUD and the M8 together, and turns HUD actions
// and keys into commands. Its parts do the work: the song shown (shownSong), the connection
// (deviceLink), what the M8 shows now (liveSync), the tasks run on it (deviceTasks), the view
// options (viewToggles), the playheads (playbackFeed) and the mute / solo buttons (trackMixer).

import { describeSelection } from '../m8/semantics'
import { debugLog } from '../model/debugLog'
import { demoSong } from '../model/demo'
import { hex2 } from '../model/hex'
import type { ThemeColors } from '../model/palette'
import type { Selection } from '../model/selection'
import type { SongModel } from '../model/song'
import { loadModel, loadTheme, rememberSong, saveModel } from '../model/storage'
import { preloadText } from '../scene/text'
import { World } from '../scene/world'
import { downloadDebugReport, openInAnalyzer } from '../ui/debugFile'
import { type Action, Hud } from '../ui/hud'
import { downloadSong, pickSongFile } from '../ui/songFile'
import { registerDebugProviders, watchPage } from './debugReport'
import { DeviceCursor } from './deviceCursor'
import { DeviceLink } from './deviceLink'
import { DeviceSession } from './deviceSession'
import { DeviceTasks } from './deviceTasks'
import { dumpScreen } from './diagnostics'
import { bindKeyboard, type KeyCommands } from './keyboard'
import { LiveSync } from './liveSync'
import { PlaybackFeed } from './playbackFeed'
import { preferences } from './preferences'
import { ShownSong } from './shownSong'
import { ThemeColorsSource } from './themeColors'
import { TrackMixer } from './trackMixer'
import { ViewToggles } from './viewToggles'

/** Actions whose own events say more than "the button was pressed". */
const SILENT_ACTIONS : Action[] = ['help', 'follow', 'autoselect', 'explore', 'theme']

export class ExplorerApp {
  private readonly hud      : Hud
  private readonly world    : World
  private readonly theme    : ThemeColorsSource
  private readonly song     : ShownSong
  private readonly session  = new DeviceSession()
  private readonly cursor   = new DeviceCursor()
  private readonly playback : PlaybackFeed
  private readonly live     : LiveSync
  private readonly mixer    : TrackMixer
  private readonly tasks    : DeviceTasks
  private readonly link     : DeviceLink
  private readonly toggles  : ViewToggles

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
    this.hud           = hud
    this.world         = world
    this.theme         = theme
    this.toggles       = new ViewToggles(world, hud)
    const { session }  = this
    hud.onInfoPinned   = (pinned) => preferences.infoPinned.set(pinned)
    hud.onDebugExport  = () => void this.exportDebugLog()
    hud.onTopBarResize = (bottom) => world.setTopInset(bottom)
    hud.onCoveredAreas = (areas) => world.setCoveredAreas(areas)
    world.coverage     = () => hud.coveredAreas()
    hud.onWallDegrees  = (degrees) => this.toggles.setWallDegrees(degrees)
    world.onFolds      = () => this.showFolds()
    world.setTopInset(hud.topBarBottom())
    world.setCoveredAreas(hud.coveredAreas())
    this.song              = new ShownSong(model, world, hud, theme)
    this.playback          = new PlaybackFeed(
      world,
      () => this.song.context,
      () => session.readableClient(),
      () => session.otherSongLoaded,
    )
    this.live              = new LiveSync(session, this.song, world, hud, theme, this.playback, this.cursor, {
      buttons        : () => this.updateButtons(),
      renderSelection: (selection) => this.renderSelection(selection)
    })
    this.playback.appState = () => ({
      following : this.live.following,
      autoSelect: this.live.autoSelect,
      task      : session.task
    })
    this.song.updateSummary()
    this.updateButtons()
    this.song.refreshPalette()
    this.bindSelection()
    this.toggles.apply()
    this.mixer        = new TrackMixer(world, hud)
    this.tasks        = new DeviceTasks(session, this.song, world, hud, theme, this.mixer, this.live, {
      buttons : () => this.updateButtons(),
      schedule: () => this.live.schedule()
    })
    this.link         = new DeviceLink(session, hud, this.playback, {
      activity: () => this.live.schedule(),
      up      : () => {
        this.updateButtons()
        this.live.schedule()
      },
      down    : () => {
        this.live.deviceGone()
        this.updateButtons()
      }
    })
    const commands    = this.commands()
    this.hud.onAction = (action) => {
      const on = commands[action]()
      // A toggle says which way it went; a plain button has no state.
      if (!SILENT_ACTIONS.includes(action)) debugLog.event('action', typeof on === 'boolean' ? { action, on } : { action })
    }
    bindKeyboard(this.keyCommands(commands), (fromCursor) => this.play(fromCursor))
    this.exposeDebugHandle()
    this.setUpDebugLog()
  }

  /** Connects to the M8 (through yam8d, or straight to a device granted before). */
  connect(): Promise<void> {
    return this.link.connect()
  }

  // ---------------------------------------------------------------------------
  // Commands

  /** What a button does; a toggle returns whether it is on now. */
  private commands(): Record<Action, () => unknown> {
    const { world, hud, live, tasks, toggles } = this
    return {
      device    : () => void this.link.toggleDevice(),
      explore   : () => void tasks.explore(),
      cancel    : () => tasks.cancel(),
      theme     : () => void tasks.readTheme(),
      follow    : () => live.toggleFollow(),
      autoselect: () => live.toggleAutoSelect(),
      front     : () => world.view('front'),
      angle     : () => world.view('angle'),
      side      : () => world.view('side'),
      overview  : () => world.view('overview'),
      expand    : () => world.toggleAllFolds(),
      allfx     : () => world.toggleAllFolds('fx'),
      allpanels : () => world.toggleAllFolds('panels'),
      dramatic  : () => toggles.toggleDramatic(),
      played    : () => toggles.togglePlayedNotes(),
      trim      : () => toggles.toggleTrimTables(),
      export    : () => downloadSong(this.song.model),
      import    : () => void this.importSong(),
      demo      : () => this.song.show(demoSong(), false),
      show      : () => void tasks.showSelection(),
      help      : () => hud.toggleHelp()
    }
  }

  private keyCommands(command: Record<Action, () => unknown>): KeyCommands {
    const { world, session } = this
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
      p                 : () => {
        if (!world.jumpToPlayhead()) this.hud.notify('The song is not playing: no playhead to jump to', 'info', 2500, false)
      },
      Enter             : command.show,
      Escape            : () => world.select(null),
      '+'               : () => world.zoom(0.8),
      '='               : () => world.zoom(0.8),
      '-'               : () => world.zoom(1.25),
      '?'               : command.help,
      d                 : () => void dumpScreen(session.client, session.port),
      m                 : () => void this.tasks.checkSyncNow()
    }
  }

  /** Space: play / stop the M8; Shift+Space continues from the cursor. */
  private play(fromCursor: boolean): void {
    const { client, task } = this.session
    debugLog.event('play-key', {
      fromCursor,
      connected: client?.isConnected ?? false,
      playing  : this.playback.tracker.playing,
      cursor   : this.playback.tracker.context,
      task
    })
    if (client?.isConnected) void client.sendKeyPress(fromCursor ? ['shift', 'play'] : ['play'])
  }

  /** A song file chosen by hand replaces the song shown. */
  private async importSong(): Promise<void> {
    const picked = await pickSongFile()
    if (picked.kind === 'cancelled') return
    if (picked.kind === 'invalid') return this.hud.notify(picked.reason, 'warn', 6000)
    const { model } = picked
    debugLog.event('import', {
      name  : model.name,
      chains: Object.keys(model.chains).length
    })
    // The file was asked for: the library does not swap it for a remembered song of the M8.
    this.live.recallPaused = true
    this.song.show(model, false)
    saveModel(model)
    rememberSong(model)
    this.hud.notify(`Loaded ${model.name ?? 'the song'} from file`)
  }

  // ---------------------------------------------------------------------------
  // Buttons and the selection's meaning

  /** Lights the top bar's fold buttons for how far each part is unfolded across the tracks. */
  private showFolds(): void {
    const { world, hud } = this
    hud.setFoldCoverage('allfx', world.foldCoverage('fx'))
    hud.setFoldCoverage('allpanels', world.foldCoverage('panels'))
  }

  /** The buttons that need the M8 (and no task running), Follow and Auto select lit, the selection's panel. */
  private updateButtons(): void {
    const { hud, session, live } = this
    const connected              = session.port != null
    hud.setEnabled('explore', connected && !session.task)
    hud.setEnabled('theme', connected && !session.task)
    hud.setEnabled('follow', connected)
    hud.setActive('follow', live.following)
    hud.setEnabled('autoselect', connected)
    hud.setActive('autoselect', live.autoSelect)
    this.renderSelection(this.world.getSelection())
  }

  private bindSelection(): void {
    this.world.onSelect = (selection) => this.renderSelection(selection)
    this.world.onHover  = (selection) => {
      const description = selection ? this.describe(selection) : null
      this.hud.setHover(description ? [...description.path, description.title].join(' › ') : null)
    }
  }

  private describe(selection: Selection) {
    return describeSelection(this.song.context, selection)
  }

  private renderSelection(selection: Selection | null): void {
    this.hud.renderInfo(selection ? this.describe(selection) : null, this.session.port != null && !this.session.task)
  }

  // ---------------------------------------------------------------------------
  // Debugging

  /** The debug log's global sections and page watchers; the rolling events are written where things happen. */
  private setUpDebugLog(): void {
    const { session, live } = this
    registerDebugProviders(debugLog, {
      client  : () => session.client,
      model   : () => this.song.model,
      mixer   : () => this.mixer.info(),
      settings: () => ({
        following      : live.following,
        autoSelect     : live.autoSelect,
        otherSongLoaded: session.otherSongLoaded,
        deviceTask     : session.task,
        deviceView     : live.lastDeviceView,
        deviceConnected: session.port != null,
        status         : this.hud.statusText()
      })
    })
    watchPage(debugLog, () => this.playback.tracker.playing)
    debugLog.event('start', {
      song  : this.song.model.name,
      source: this.song.model.source
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
    const file = downloadDebugReport(data, this.song.model.name)
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
          return app.song.model
        },
        hex2,
        /** Try a theme without the device: roles as '#rrggbb'. */
        setTheme(colors: Partial<ThemeColors>) {
          app.theme.observe(colors)
          app.song.refreshPalette()
        }
      },
    })
  }
}
