// What the M8 shows now, folded into the explorer: the place under its cursor is marked (and, on
// request, followed by the view or selected), edits made on the device reach the model and the
// scene, another song loaded on it pauses all that, and a song explored before is recalled from
// the browser. The M8 is read after its events (see SyncScheduler).

import { type M8Client, type M8Screen, observeThemeColors } from '@yam8d/m8-sdk'
import { absorbEdit, deviceFocus, isOtherSong, matchesSong } from '../m8/screen/liveScreen'
import { viewOf } from '../m8/screen/screenReader'
import { debugLog } from '../model/debugLog'
import { type Selection, sameSelection } from '../model/selection'
import { rememberedSongs, rememberSong, saveModel } from '../model/storage'
import type { World } from '../scene/world'
import type { Hud } from '../ui/hud'
import type { DeviceCursor } from './deviceCursor'
import { connectedStatus } from './deviceLink'
import type { DeviceSession } from './deviceSession'
import { messageOf } from './errorText'
import type { PlaybackFeed } from './playbackFeed'
import type { ShownSong } from './shownSong'
import { type SyncKind, SyncScheduler } from './syncScheduler'
import type { ThemeColorsSource } from './themeColors'

/** A cursor read reads edits from a screen once it has shown the same item this long: the M8 has drawn it whole by then. */
const EDIT_READ_AFTER_MS = 150

/** What the live follow-up tells the app. */
export interface LiveSyncHooks {
  /** Following or auto select changed: the buttons light accordingly. */
  buttons(): void
  /** Shows what a selection means in the HUD. */
  renderSelection(selection: Selection | null): void
}

export class LiveSync {
  /** Follow M8: the view follows the M8 cursor (and the playheads while the song plays). */
  following              = false
  /** The selection (and its meaning) follows the M8 cursor. */
  autoSelect             = false
  /** A song was imported by hand: remembered songs are not swapped in until the next exploration. */
  recallPaused           = false
  /** The device place auto select chose last: a click wins until the M8 cursor moves on. */
  private autoSelected   : Selection | null = null
  /** The view the M8 was last seen on ('phrase:3'), to log its changes. */
  private deviceView     : string | null = null
  /** The item the M8 screen shows ('phrase:3') and since when (performance.now()): edits are read once it has been drawn whole. */
  private screenItem     = {
    key  : '',
    since: 0
  }
  /** Edits shown on their item but not yet in the whole scene, and edits not yet saved (see absorbEdits). */
  private sceneBehind    = false
  private unsaved        = false
  /** Reads the M8 after its events: the cursor soon, edits once the screen is quiet. */
  private readonly syncs = new SyncScheduler((kind) => this.sync(kind))

  constructor(
    private readonly session: DeviceSession,
    private readonly song: ShownSong,
    private readonly world: World,
    private readonly hud: Hud,
    private readonly theme: ThemeColorsSource,
    private readonly playback: PlaybackFeed,
    private readonly cursor: DeviceCursor,
    private readonly hooks: LiveSyncHooks,
  ) {}

  /** The view the M8 was last seen on ('phrase:3'), null when none. */
  get lastDeviceView(): string | null {
    return this.deviceView
  }

  /** Reads the M8 soon (after an event of it, or a change here). */
  schedule(): void {
    this.syncs.poke()
  }

  /** The M8 went away: nothing of it is marked any more, and the playheads stop. */
  deviceGone(): void {
    this.deviceView = null
    this.world.setDeviceInstrument(null)
    this.playback.tracker.transportReset('device-down')
    this.world.setDevicePlaces([])
  }

  /** Follow M8 on or off. */
  toggleFollow(): void {
    this.following = !this.following
    debugLog.event('follow', {
      on       : this.following,
      connected: this.session.port != null,
      playing  : this.playback.tracker.playing
    })
    this.world.followPlayback = this.following
    if (!this.following) this.world.follow(null)
    this.hooks.buttons()
    this.schedule()
  }

  /** Auto select on or off (only while the M8 is connected). */
  toggleAutoSelect(): void {
    if (!this.session.port) return
    this.autoSelect   = !this.autoSelect
    debugLog.event('auto-select', { on: this.autoSelect })
    this.autoSelected = null
    this.hooks.buttons()
    this.schedule()
  }

  /**
   * What the M8 shows now. Every read marks and follows the place under its cursor. A settled
   * read (the screen quiet long enough to be fully drawn) also takes the theme colours, notices
   * another song and folds edits made on the device into the model: a half-drawn screen must
   * never reach the saved song.
   */
  private async sync(kind: SyncKind): Promise<void> {
    const { session, song, world, cursor, playback } = this
    const client                                     = session.client
    if (!client?.isConnected || session.task) return
    const settled = kind === 'settled'
    try {
      const [state, screen] = await Promise.all([client.fetchState(), client.getScreen()])
      if (settled) {
        // Background and titles: a palette change rebuilds the whole scene, so only stable colours.
        if (this.theme.observe(observeThemeColors(state))) song.refreshPalette()
        const other = isOtherSong(song.model, screen)
        if (other && this.recallSong(screen)) return
        this.noteOtherSong(client, other)
      } else if (isOtherSong(song.model, screen)) {
        // Only a settled read pauses for another song; until then nothing is followed on it.
        return
      }
      if (session.otherSongLoaded) {
        world.setDevicePlaces([])
        world.setDeviceInstrument(null)
        return
      }
      this.absorbEdits(screen, settled)
      const focus                   = deviceFocus(state, screen)
      this.noteDeviceView(focus, state.viewTitle)
      // On the Instrument or Inst. Mods view, that instrument's panels turn to their instrument face.
      world.setDeviceInstrument(focus && (focus.view === 'inst' || focus.view === 'instmods') ? focus.id : null)
      const places                  = focus ? cursor.placesOf(song.context, world.layout?.tracks ?? [], focus) : []
      world.setDevicePlaces(places)
      // Choosing the place can move the context to the track or song row the M8 went to.
      const followed                = cursor.preferred(places)
      playback.tracker.context      = cursor.songContext
      playback.tracker.viewChainRow = focus?.view === 'phrase' ? cursor.chainPosition : null
      this.followCursor(followed)
    } catch (error) {
      // The next event tries again.
      debugLog.problem('sync', messageOf(error))
    }
  }

  /**
   * Edits made on the M8. The item edited shows its new values at the first read that can trust
   * the screen: a settled one, or a cursor read once the screen has shown that item for a while (a
   * screen just switched to may still be half drawn; a half-drawn edit is read again later). The
   * rest of the scene follows, and the song is saved, once the screen is quiet (a settled read).
   */
  private absorbEdits(screen: M8Screen, settled: boolean): void {
    const { song, world } = this
    const seen            = viewOf(screen)
    const key             = `${seen.kind}:${seen.id ?? ''}`
    const now             = performance.now()
    if (key !== this.screenItem.key) this.screenItem = {
      key,
      since: now
    }
    const edit            = settled || now - this.screenItem.since >= EDIT_READ_AFTER_MS ? absorbEdit(song.model, screen) : null
    if (edit) {
      debugLog.event('device-edit', {
        view   : seen.kind,
        id     : seen.id,
        title  : seen.title,
        settled,
        playing: this.playback.tracker.playing
      })
      // An edit that moves things or changes many updates the whole scene now; the others once the screen is quiet.
      const inPlace    = world.showEditInPlace(edit)
      if (!inPlace) song.update()
      this.sceneBehind = inPlace
      this.unsaved     = true
      this.hooks.renderSelection(world.getSelection())
    }
    if (!settled) return
    if (this.sceneBehind) song.update()
    this.sceneBehind = false
    if (!this.unsaved) return
    this.unsaved = false
    saveModel(song.model)
    rememberSong(song.model)
    song.updateSummary()
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
    const { session, hud } = this
    if (other == null || other === session.otherSongLoaded) return
    session.otherSongLoaded = other
    debugLog.event('other-song', {
      other,
      explored: this.song.model.name,
      playing : this.playback.tracker.playing
    })
    if (other) {
      this.playback.tracker.transportReset('other-song')
      hud.notify('The M8 has another song loaded than the one shown here: Explore song to read it. Live updates are paused meanwhile.', 'warn', 9000)
      hud.setStatus('M8 connected · another song is loaded', 'busy')
    } else {
      hud.notify('The M8 is back on the explored song.')
      hud.setStatus(connectedStatus(client), 'ok')
    }
  }

  /**
   * The M8 shows another song than the model: when the library holds one that matches the
   * screen, it is shown again instead of exploring. True when it was loaded.
   */
  private recallSong(screen: M8Screen): boolean {
    if (this.recallPaused) return false
    const remembered = rememberedSongs().find((candidate) => matchesSong(candidate, screen))
    if (!remembered) return false
    debugLog.event('recall', {
      name      : remembered.name,
      capturedAt: remembered.capturedAt,
      replaced  : this.song.model.name
    })
    this.session.otherSongLoaded = false
    this.song.show(remembered, false)
    saveModel(remembered)
    this.hud.notify(`${remembered.name} was explored before: shown from this browser. Explore song to read it again.`, 'info', 6000)
    this.schedule()
    return true
  }

  /** Auto select and Follow M8: the place under the M8 cursor. */
  private followCursor(place: Selection | null): void {
    const { world } = this
    if (this.autoSelect && place && !sameSelection(place, this.autoSelected)) {
      this.autoSelected = place
      // The HUD first, so a framing keeps clear of its selection panel at its new size.
      if (this.following) this.hooks.renderSelection(place)
      // Following scrolls by itself; alone, the selection unfolds the wall for wall cells and scrolls to them.
      world.select(place, this.following ? {
        silent: true,
        reveal: false
      } : {
        turn   : true,
        landTop: true
      })
    }
    // While the song plays, following scrolls with the playheads; the cursor still picks the open track.
    if (this.following && place) world.follow(place, { scroll: !this.playback.tracker.playing })
  }
}
