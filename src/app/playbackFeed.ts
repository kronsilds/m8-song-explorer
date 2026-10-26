// Feeds the playback tracker: screen reads (often while the song plays, rarely otherwise) and
// the M8's MIDI clock and transport, and hands the playheads to the 3D view each frame. What
// the playback goes through (starts, stops, drifts, clock gaps) is written to the debug log.

import type { M8Client } from '@yam8d/m8-sdk'
import { type PlaybackEvent, PlaybackTracker } from '../m8/playback'
import { viewOf } from '../m8/screen/screenReader'
import { type DebugLog, debugLog, type EventData } from '../model/debugLog'
import { CLOCK_PPQ } from '../model/music/groove'
import type { SongModel } from '../model/song'
import type { SongLayout } from '../scene/layout'
import type { World } from '../scene/world'

const PLAYING_POLL_MS  = 60
const IDLE_POLL_MS     = 500
/** The clock event comes once per sixteenth; this many sixteenths without one is a gap. */
const CLOCK_GAP_STEPS  = 2.5
/** While playing with MIDI clock enabled, no clock event for this long is worth a note. */
const CLOCK_SILENT_MS  = 2000
/** The tempo is the smoothed clock: a change smaller than this (BPM) is jitter. */
const TEMPO_CHANGE_BPM = 2
/** The tempo is read from this many of the latest clock measurements (events come about 8 times a second). */
const TEMPO_WINDOW     = 24
const DRIFT_LOG_MS     = 250
const REANCHOR_LOG_MS  = 250

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const sum       = (values: number[]): number => values.reduce((a, b) => a + b, 0)
const round1    = (value: number): number => Math.round(value * 10) / 10

/** What one stretch of playing went through, written out when it ends. */
interface PlaySession {
  startedAt  : number
  source     : 'transport' | 'screen'
  corrections: number
  reanchors  : number
  /** Corrections per track. */
  byTrack    : number[]
  /** The largest correction, in steps. */
  maxSteps   : number
  clockGaps  : number
}

/** The M8's MIDI clock as it arrived, for the debug log. */
interface ClockStats {
  events   : number
  firstAt  : number | null
  /** performance.now() of the last clock event. */
  lastAt   : number | null
  msPerTick: number | null
  bpm      : number | null
  gaps     : number
  maxGapMs : number
  /** What enableMidiTransport answered, null before it was asked. */
  enabled  : { ok: boolean; error: string | null } | null
  /** performance.now() when it answered ok. */
  enabledAt: number | null
}

export class PlaybackFeed {
  readonly tracker            : PlaybackTracker
  /** What the app is doing (Follow M8, a device task ...), written into the start and stop events. */
  appState                    : () => EventData = () => ({})
  private trackedLayout       : SongLayout | null
  private session             : PlaySession | null = null
  private lastView            : { kind: string; id: number | null } | null = null
  private readonly clockStats : ClockStats = {
    events   : 0,
    firstAt  : null,
    lastAt   : null,
    msPerTick: null,
    bpm      : null,
    gaps     : 0,
    maxGapMs : 0,
    enabled  : null,
    enabledAt: null
  }
  private readonly totals     = {
    sessions   : 0,
    corrections: 0,
    reanchors  : 0
  }
  private loggedBpm           : number | null = null
  /** The latest msPerTick the clock reported, restarted after a pause (a new clock, maybe another tempo). */
  private recentMsPerTick     : number[] = []

  /**
   * @param currentModel the song shown now
   * @param readableClient the client to read the screen from, null while reads must wait (not connected, busy, another song)
   * @param paused true while another song is loaded: transport messages are ignored
   */
  constructor(
    world: World,
    private readonly currentModel: () => SongModel,
    private readonly readableClient: () => M8Client | null,
    private readonly paused: () => boolean,
    private readonly log: DebugLog = debugLog,
  ) {
    const layout              = world.layout as SongLayout
    this.tracker              = new PlaybackTracker(currentModel(), layout.timeline)
    this.trackedLayout        = layout
    this.tracker.onCorrection = (track, predicted, actual, clocked, songRow) => {
      const difference = actual - predicted
      console.debug(
        `[playback] track ${track + 1}: predicted step ${predicted}, the M8 shows ${actual} (${difference > 0 ? '+' : ''}${difference}) · ${clocked ? 'MIDI clock' : 'tempo'}`,
      )
      this.noteCorrection(track, predicted, actual, clocked, songRow)
    }
    this.tracker.onEvent      = (event) => this.noteEvent(event)
    world.setPlayheadSource(() => {
      // A new layout (another song, or edits folded in) means new step lengths.
      if (world.layout && world.layout !== this.trackedLayout) {
        this.trackedLayout = world.layout
        this.tracker.setSong(this.currentModel(), world.layout.timeline)
      }
      return this.tracker.playheads(performance.now())
    })
    this.log.provide('playback', () => this.describe())
  }

  // ---------------------------------------------------------------------------
  // Debug log

  /** The global part of the log: where the playback stands now. */
  private describe() {
    const { tracker, clockStats } = this
    const now                     = performance.now()
    return {
      playing      : tracker.playing,
      bpm          : tracker.bpm,
      timeBase     : this.clockIsRunning() ? 'MIDI clock' : 'tempo shown on the screen',
      cursorContext: tracker.context,
      lastView     : this.lastView,
      session      : this.session,
      totals       : this.totals,
      midiTransport: clockStats.enabled,
      clock        : {
        events      : clockStats.events,
        msPerTick   : clockStats.msPerTick == null ? null : round1(clockStats.msPerTick),
        bpm         : clockStats.bpm,
        gaps        : clockStats.gaps,
        maxGapMs    : round1(clockStats.maxGapMs),
        lastEventAgo: clockStats.lastAt == null ? null : Math.round(now - clockStats.lastAt)
      }
    }
  }

  /** Clock events keep coming (it runs even while the song is stopped). */
  private clockIsRunning(): boolean {
    const { lastAt } = this.clockStats
    return lastAt != null && performance.now() - lastAt < CLOCK_SILENT_MS
  }

  private noteCorrection(track: number, predicted: number, actual: number, clocked: boolean, songRow: number): void {
    const difference        = actual - predicted
    this.totals.corrections += 1
    const { session }       = this
    if (session) {
      session.corrections    += 1
      session.byTrack[track] = (session.byTrack[track] ?? 0) + 1
      session.maxSteps       = Math.max(session.maxSteps, Math.abs(difference))
    }
    this.log.throttled(`drift:${track}`, DRIFT_LOG_MS, 'drift', {
      track    : track + 1,
      songRow,
      predicted,
      actual,
      difference,
      timeBase : clocked ? 'MIDI clock' : 'tempo',
      stepTicks: this.tracker.ticksAt(songRow, track, actual),
      playedMs : session ? Math.round(performance.now() - session.startedAt) : null,
      view     : this.lastView
    })
  }

  private noteEvent(event: PlaybackEvent): void {
    const { tracker, log } = this
    if (event.kind === 'started') {
      this.totals.sessions += 1
      this.session         = {
        startedAt  : performance.now(),
        source     : event.source,
        corrections: 0,
        reanchors  : 0,
        byTrack    : [],
        maxSteps   : 0,
        clockGaps  : 0
      }
      log.event('play-start', {
        source   : event.source,
        spp      : event.spp,
        startRow : event.startRow,
        cursor   : tracker.context,
        view     : this.lastView,
        app      : this.appState(),
        bpm      : tracker.bpm,
        timeBase : this.clockIsRunning() ? 'MIDI clock' : 'tempo shown on the screen',
        otherSong: this.paused(),
        tracks   : tracker.describeTracks()
      })
    } else if (event.kind === 'clock-lost') {
      log.event('clock-lost', {
        silentMs: event.silentMs,
        playing : tracker.playing,
        bpm     : tracker.bpm
      })
    } else if (event.kind === 'stopped') {
      const { session } = this
      this.session      = null
      log.event('play-stop', {
        reason  : event.reason,
        playedMs: session ? Math.round(performance.now() - session.startedAt) : null,
        app     : this.appState(),
        session
      })
    } else {
      this.totals.reanchors += 1
      if (this.session) this.session.reanchors += 1
      log.throttled(`reanchor:${event.track}`, REANCHOR_LOG_MS, 'reanchor', {
        track   : event.track + 1,
        reason  : event.reason,
        offTicks: event.offTicks,
        from    : event.from,
        to      : event.to
      })
    }
  }

  // ---------------------------------------------------------------------------
  // MIDI clock

  /**
   * MIDI clock from the M8 (needs SYNC OUT on in the M8's MIDI Settings): when it runs, each
   * track moves on by clock ticks (six per step, or what its groove gives) instead of by the
   * tempo. Registered once; the clock itself is enabled per device connection (enableClock).
   */
  listenToClock(client: M8Client): void {
    const toLocalMs  = (epochMs: number) => epochMs - performance.timeOrigin
    // Play on the M8 sends the Song Position Pointer, then Continue (or Start, from the top).
    let songPosition = 0
    client.onTransport((event) => {
      const tracker = this.tracker
      tracker.clockTick(event.ticks, toLocalMs(event.at), event.msPerTick ?? 60000 / tracker.bpm / CLOCK_PPQ)
      if (event.kind === 'clock') this.noteClock(event.ticks, toLocalMs(event.at), event.msPerTick)
      else this.log.event('transport', {
        kind     : event.kind,
        spp      : event.spp ?? null,
        ticks    : event.ticks,
        msPerTick: event.msPerTick == null ? null : round1(event.msPerTick)
      })
      if (event.kind === 'position') songPosition = event.spp ?? 0
      if ((event.kind === 'start' || event.kind === 'continue') && !this.paused()) {
        const from   = event.kind === 'start' ? 0 : songPosition
        const placed = tracker.transportStart(from, toLocalMs(event.at))
        console.info(`[transport] ${event.kind} at song position ${from}${placed ? '' : ' (no song row starts there: following the screen)'}`)
        if (!placed) this.log.event('play-not-placed', {
          kind  : event.kind,
          spp   : from,
          cursor: tracker.context
        })
      }
      if (event.kind === 'stop') tracker.transportReset('transport-stop')
    })
  }

  /** The clock events: counts, tempo, and the stalls (a gap while the song plays moves the playheads off). */
  private noteClock(ticks: number, at: number, msPerTick: number | null): void {
    const stats    = this.clockStats
    const gap      = stats.lastAt == null ? 0 : at - stats.lastAt
    const hadPause = stats.msPerTick != null && gap > stats.msPerTick * 6 * CLOCK_GAP_STEPS
    stats.events   += 1
    stats.firstAt  ??= at
    if (hadPause) {
      // The clock came back: it may be another song's tempo, so the old measurements say nothing.
      this.recentMsPerTick = []
      this.loggedBpm       = null
    }
    if (msPerTick != null) {
      stats.msPerTick = msPerTick
      this.recentMsPerTick.push(msPerTick)
      if (this.recentMsPerTick.length > TEMPO_WINDOW) this.recentMsPerTick.shift()
      // The mean of the middle half: single measurements wobble, the first ones after a start worst.
      const sorted = [...this.recentMsPerTick].sort((a, b) => a - b)
      const cut    = Math.floor(sorted.length / 4)
      const middle = sorted.slice(cut, sorted.length - cut)
      stats.bpm    = round1(60000 / ((sum(middle) / middle.length) * CLOCK_PPQ))
    }
    stats.lastAt = at
    if (hadPause && stats.msPerTick != null) {
      stats.gaps     += 1
      stats.maxGapMs = Math.max(stats.maxGapMs, gap)
      if (this.session) this.session.clockGaps += 1
      this.log.throttled('clock-gap', 1000, 'clock-gap', {
        gapMs   : Math.round(gap),
        expected: round1(stats.msPerTick * 6),
        ticks,
        playing : this.tracker.playing
      })
    }
    if (stats.bpm != null && this.tracker.playing && (this.loggedBpm == null || Math.abs(stats.bpm - this.loggedBpm) >= TEMPO_CHANGE_BPM)) {
      this.log.throttled('tempo', 1000, 'tempo', {
        bpm : stats.bpm,
        from: this.loggedBpm
      })
      this.loggedBpm = stats.bpm
    }
  }

  /** Asks for the clock: yam8d forwards it, a standalone page opens the M8's MIDI input itself. */
  async enableClock(client: M8Client): Promise<void> {
    try {
      const result = await client.enableMidiTransport()
      console.info('[transport]', result.ok ? 'listening to the M8 MIDI clock' : `no MIDI clock: ${result.error}`)
      this.clockStats.enabled = {
        ok   : result.ok,
        error: result.error ?? null
      }
      this.log.event('midi-clock', this.clockStats.enabled)
      if (result.ok) {
        this.clockStats.enabledAt = performance.now()
        this.log.resolve('midi-clock')
      } else {
        this.log.problem('midi-clock', `no MIDI clock: ${result.error ?? 'refused'}`)
      }
    } catch (error) {
      console.info('[transport] this yam8d does not forward MIDI clock')
      this.clockStats.enabled = {
        ok   : false,
        error: `host does not forward MIDI clock (${messageOf(error)})`
      }
      this.log.event('midi-clock', this.clockStats.enabled)
      this.log.problem('midi-clock', this.clockStats.enabled.error as string)
    }
  }

  // ---------------------------------------------------------------------------
  // Screen reads

  /** Reads the screen often while the song plays (to catch every chain change), rarely otherwise. */
  async poll(): Promise<void> {
    const client = this.readableClient()
    if (client) {
      try {
        const screen = await client.getScreen()
        const view   = viewOf(screen)
        if (view.kind !== this.lastView?.kind || view.id !== this.lastView?.id) {
          this.lastView = {
            kind: view.kind,
            id  : view.id
          }
        }
        this.tracker.observe(screen, performance.now())
        this.checkClockWhilePlaying()
      } catch (error) {
        this.log.problem('screen-read', messageOf(error))
      }
    }
    window.setTimeout(() => void this.poll(), this.tracker.playing ? PLAYING_POLL_MS : IDLE_POLL_MS)
  }

  /** Playing with MIDI clock enabled, yet no clock arrives: the playheads run on the tempo the screen shows. */
  private checkClockWhilePlaying(): void {
    const { clockStats } = this
    if (!this.tracker.playing || !clockStats.enabled?.ok) return
    // Silence counts from the last clock event, or from the moment the clock was enabled.
    const silent = performance.now() - Math.max(clockStats.lastAt ?? 0, clockStats.enabledAt ?? 0)
    if (silent > CLOCK_SILENT_MS) {
      this.log.throttled('no-clock', 10000, 'no-clock-while-playing', {
        silentMs: Math.round(silent),
        hint    : 'SYNC OUT is probably not CLOCK+, or the clock is not forwarded: the playheads follow the tempo shown on screen'
      })
    }
  }
}
