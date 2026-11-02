// What the explorer runs on the M8, one task at a time and only when the user asks (with a
// confirmation where it presses Edit): exploring the song, the MIDI sync check, reading the theme,
// showing the selection on the device. The buttons follow while a task runs, and the live view
// catches up after.

import { ExploreCancelled } from '../m8/driver'
import type { M8Port } from '../m8/port'
import { exploreSong, moveToSongTop } from '../m8/tasks/explorer'
import { type ChannelPlan, planChannel, readMidiSync, SYNC_OUT_TARGET, setCcMapChannel, setMidiSyncOut } from '../m8/tasks/midiSync'
import { deviceTargetOf, showOnDevice } from '../m8/tasks/showOnDevice'
import { readDeviceTheme } from '../m8/tasks/themeReader'
import { debugLog, type RunHandle } from '../model/debugLog'
import { lastSongRow, type MidiSync } from '../model/song'
import { rememberSong, saveModel, saveTheme } from '../model/storage'
import type { World } from '../scene/world'
import type { Hud } from '../ui/hud'
import { connectedStatus } from './deviceLink'
import type { DeviceSession, DeviceTask } from './deviceSession'
import { messageOf } from './errorText'
import type { LiveSync } from './liveSync'
import type { ShownSong } from './shownSong'
import type { ThemeColorsSource } from './themeColors'
import type { TrackMixer } from './trackMixer'

/** While exploring, the view is redrawn at most this often. */
const EXPLORE_REDRAW_MS = 1200

const CONFIRM_EXPLORE =
  'The M8 will walk through the Song, Chain, Phrase, Instrument, Table, Scale and Groove views to read the whole song. It only presses arrows, Shift+arrows and Option+arrows, so nothing is edited; at the end it opens Project › MIDI SETTINGS (Edit on that entry) to check the sync setting, then puts the cursor on the first cell of the Song view. Keep your hands off the M8 until it finishes; Cancel stops it and keeps what was read.'
const CONFIRM_THEME   =
  'The M8 will open Project › System Settings › Theme (Edit is pressed on SYSTEM SETTINGS and on EDIT THEME, after checking the cursor is on them), read the 13 colours, then leave with Option and go back to the current view.'

/** A message of a device task: to the console, and to the run it belongs to in the debug log. */
const logTo = (tag: string, run?: RunHandle) => (message: string) => {
  console.info(tag, message)
  run?.message(`${tag} ${message}`)
}

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

/** What the device tasks tell the app. */
export interface DeviceTasksHooks {
  /** A task started or ended: the buttons follow. */
  buttons(): void
  /** A task ended: the live view catches up. */
  schedule(): void
}

export class DeviceTasks {
  /** The exploration under way (Cancel aborts it). */
  private exploration : AbortController | null = null

  constructor(
    private readonly session: DeviceSession,
    private readonly song: ShownSong,
    private readonly world: World,
    private readonly hud: Hud,
    private readonly theme: ThemeColorsSource,
    private readonly mixer: TrackMixer,
    private readonly live: LiveSync,
    private readonly hooks: DeviceTasksHooks,
  ) {}

  /** Stops the exploration under way; what was read is kept. */
  cancel(): void {
    this.exploration?.abort()
  }

  /** Runs one task on the device at a time; the buttons follow, and the live view catches up after. */
  private async run(task: DeviceTask, run: (port: M8Port) => Promise<void>): Promise<void> {
    const { session, hooks } = this
    const port               = session.port
    if (!port || session.task) return
    session.task = task
    hooks.buttons()
    try {
      await run(port)
    } finally {
      session.task = null
      this.hud.hideProgress()
      hooks.buttons()
      hooks.schedule()
    }
  }

  /** Reads the whole song from the M8 (see exploreSong), then checks its MIDI sync and puts the cursor at the top of the song. */
  async explore(): Promise<void> {
    const { session, song, hud } = this
    if (!session.port || session.task) return
    if (!(await hud.confirm('EXPLORE THE SONG', CONFIRM_EXPLORE, 'Explore'))) return
    await this.run('explore', async (port) => {
      const exploration = new AbortController()
      this.exploration  = exploration
      const run         = debugLog.startRun('explore', {
        previousSong: song.model.name,
        source      : song.model.source,
        transport   : session.client?.deviceTransport ?? null,
        following   : this.live.following
      })
      hud.setStatus('Exploring the M8…', 'busy')
      hud.showProgress('Starting…', null)
      let lastDrawAt = 0
      try {
        const explored          = await exploreSong(port, {
          signal      : exploration.signal,
          onProgress  : (progress) => {
            run.phase(progress.phase, progress.message)
            hud.showProgress(progress.message, progress.total ? progress.done / progress.total : null)
          },
          onUpdate    : (model) => {
            if (performance.now() - lastDrawAt < EXPLORE_REDRAW_MS) return
            lastDrawAt = performance.now()
            song.show(model, song.model.source === 'device')
            // Keep what was read if the page goes away mid-run.
            saveModel(model)
          },
          log         : logTo('[explore]', run),
          onCursorMiss: (miss) => debugLog.event('cursor-miss', { ...miss })
        })
        explored.theme          = this.theme.exactTheme
        session.otherSongLoaded = false
        if (!exploration.signal.aborted) {
          explored.midiSync = await this.checkMidiSync(port, run)
          await this.returnToSongTop(port, run)
        }
        song.show(explored, false)
        saveModel(explored)
        if (!exploration.signal.aborted) rememberSong(explored)
        this.live.recallPaused = false
        const warnings         = explored.warnings.length
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
        hud.notify(warnings ? `Explored with ${warnings} warning(s)` : 'Song explored', warnings ? 'warn' : 'info', 4200, false)
      } catch (error) {
        if (!(error instanceof ExploreCancelled)) {
          run.finish('failed', { error: messageOf(error) })
          hud.notify(`Exploration failed: ${messageOf(error)}`, 'warn', 8000)
        } else {
          run.finish('cancelled')
        }
      } finally {
        this.exploration = null
        if (session.client) hud.setStatus(connectedStatus(session.client), 'ok')
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
    const { hud, mixer } = this
    hud.showProgress('Checking the MIDI sync setting…', null)
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
    const plan    = planChannel(sync, mixer.channel)
    const syncDue = sync.syncOut !== SYNC_OUT_TARGET
    run.message(`[sync] read ${JSON.stringify(sync)}; channel plan ${JSON.stringify(plan)}; explorer channel ${mixer.channel}`)
    if (plan.kind === 'adopt' && plan.channel !== mixer.channel) {
      mixer.useChannel(plan.channel)
      hud.notify(`Mute / solo channel set to ${plan.channel}, the M8's CC MAP CHAN`)
    }
    if (!syncDue && plan.kind !== 'set') return sync
    hud.hideProgress()
    const message = confirmMidiSettings(syncDue ? (sync.syncOut ?? 'unknown') : null, plan, sync, mixer.channel)
    if (!(await hud.confirm('MIDI SETTINGS', message, 'Apply'))) {
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
  checkSyncNow(): Promise<void> {
    const { song, hud } = this
    return this.run('sync', async (port) => {
      const run  = debugLog.startRun('sync', { previous: song.model.midiSync ?? null })
      const sync = await this.checkMidiSync(port, run)
      run.finish(sync ? 'done' : 'failed', { midiSync: sync })
      if (!sync) return
      song.model.midiSync = sync
      saveModel(song.model)
      song.updateSummary()
      if (sync.syncOut === SYNC_OUT_TARGET) hud.notify(`SYNC OUT: ${sync.syncOut}`)
    })
  }

  /** Reads the device theme (Project › System Settings › Theme) once the user confirms. */
  async readTheme(): Promise<void> {
    const { session, song, hud } = this
    if (!session.port || session.task) return
    if (!(await hud.confirm('READ THE DEVICE THEME', CONFIRM_THEME, 'Read theme'))) return
    await this.run('theme', async (port) => {
      hud.showProgress('Reading the theme…', null)
      const run = debugLog.startRun('theme')
      try {
        const theme           = await readDeviceTheme(port, { log: logTo('[theme]', run) })
        console.info('[theme] read', JSON.stringify(theme))
        this.theme.exactTheme = theme
        song.model.theme      = theme
        saveTheme(theme)
        saveModel(song.model)
        song.refreshPalette()
        run.finish('done', {
          name: theme.name ?? null,
          mode: theme.mode
        })
        hud.notify(`Theme read${theme.name ? `: ${theme.name}` : ''} (${theme.mode.toUpperCase()})`)
      } catch (error) {
        console.info('[theme] failed:', messageOf(error))
        run.finish('failed', { error: messageOf(error) })
        hud.notify(`Could not read the theme: ${messageOf(error)}`, 'warn', 8000)
      }
    })
  }

  /** Enter: takes the M8 to the selected place (see showOnDevice). */
  showSelection(): Promise<void> {
    const selection = this.world.getSelection()
    if (!selection) return Promise.resolve()
    return this.run('show', async (port) => {
      const target = deviceTargetOf(selection)
      try {
        await showOnDevice(port, this.song.model, target)
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
}
