// Feeds the playback tracker: screen reads (often while the song plays, rarely otherwise) and
// the M8's MIDI clock and transport, and hands the playheads to the 3D view each frame.

import type { M8Client } from '@yam8d/m8-sdk'
import { PlaybackTracker } from '../m8/playback'
import { CLOCK_PPQ } from '../model/music/groove'
import type { SongModel } from '../model/song'
import type { SongLayout } from '../scene/layout'
import type { World } from '../scene/world'

const PLAYING_POLL_MS = 60
const IDLE_POLL_MS    = 500

export class PlaybackFeed {
  readonly tracker     : PlaybackTracker
  private trackedLayout: SongLayout | null

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
  ) {
    const layout              = world.layout as SongLayout
    this.tracker              = new PlaybackTracker(currentModel(), layout.timeline)
    this.trackedLayout        = layout
    this.tracker.onCorrection = (track, predicted, actual, clocked) => {
      const difference = actual - predicted
      console.debug(
        `[playback] track ${track + 1}: predicted step ${predicted}, the M8 shows ${actual} (${difference > 0 ? '+' : ''}${difference}) · ${clocked ? 'MIDI clock' : 'tempo'}`,
      )
    }
    world.setPlayheadSource(() => {
      // A new layout (another song, or edits folded in) means new step lengths.
      if (world.layout && world.layout !== this.trackedLayout) {
        this.trackedLayout = world.layout
        this.tracker.setSong(this.currentModel(), world.layout.timeline)
      }
      return this.tracker.playheads(performance.now())
    })
  }

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
      if (event.kind === 'position') songPosition = event.spp ?? 0
      if ((event.kind === 'start' || event.kind === 'continue') && !this.paused()) {
        const from   = event.kind === 'start' ? 0 : songPosition
        const placed = tracker.transportStart(from, toLocalMs(event.at))
        console.info(`[transport] ${event.kind} at song position ${from}${placed ? '' : ' (no song row starts there: following the screen)'}`)
      }
      if (event.kind === 'stop') tracker.transportReset()
    })
  }

  /** Asks for the clock: yam8d forwards it, a standalone page opens the M8's MIDI input itself. */
  async enableClock(client: M8Client): Promise<void> {
    try {
      const result = await client.enableMidiTransport()
      console.info('[transport]', result.ok ? 'listening to the M8 MIDI clock' : `no MIDI clock: ${result.error}`)
    } catch {
      console.info('[transport] this yam8d does not forward MIDI clock')
    }
  }

  /** Reads the screen often while the song plays (to catch every chain change), rarely otherwise. */
  async poll(): Promise<void> {
    const client = this.readableClient()
    if (client) {
      try {
        this.tracker.observe(await client.getScreen(), performance.now())
      } catch {
        // Next time.
      }
    }
    window.setTimeout(() => void this.poll(), this.tracker.playing ? PLAYING_POLL_MS : IDLE_POLL_MS)
  }
}
