// Track mute / solo from the track header buttons: a held MIDI note mutes or solos a track on
// the M8, its release ends it. The buttons show the notes held from here (mutes and solos made
// on the M8 are not seen).

import { MidiControl, type TrackToggle } from '../m8/midiControl'
import { TRACKS } from '../model/song'
import type { World } from '../scene/world'
import type { Hud } from '../ui/hud'
import { preferences } from './preferences'

export class TrackMixer {
  private readonly midi = new MidiControl(preferences.ccMapChannel.get())
  private readonly held : Record<TrackToggle, boolean[]> = {
    mute: Array(TRACKS).fill(false),
    solo: Array(TRACKS).fill(false)
  }

  constructor(
    private readonly world: World,
    private readonly hud: Hud,
  ) {
    hud.setChannel(this.midi.channel)
    hud.onChannel       = (channel) => this.changeChannel(channel)
    world.onTrackButton = (track, kind) => this.toggle(track, kind)
    // Leaving the page lets go of every held mute and solo, so none stays stuck on the M8.
    window.addEventListener('pagehide', () => this.midi.releaseAll())
  }

  /** The channel the mute / solo notes go out on. */
  get channel(): number {
    return this.midi.channel
  }

  /** Switches to `channel` and shows it in the picker (the M8's CC MAP CHAN was read or set to it). */
  useChannel(channel: number): void {
    this.hud.setChannel(channel)
    this.changeChannel(channel)
  }

  /** The notes held on the old channel are released. */
  private changeChannel(channel: number): void {
    this.midi.channel = channel
    this.held.mute.fill(false)
    this.held.solo.fill(false)
    this.showHeld()
    preferences.ccMapChannel.set(channel)
  }

  private toggle(track: number, kind: TrackToggle): void {
    const on = !this.held[kind][track]
    this.midi.set(kind, track, on).then(
      () => {
        this.held[kind][track] = on
        this.showHeld()
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.hud.notify(`Could not ${on ? '' : 'un'}${kind} track ${track + 1}: ${message}`, 'warn')
      },
    )
  }

  private showHeld(): void {
    this.world.setTrackModes(this.held.mute, this.held.solo)
  }
}
