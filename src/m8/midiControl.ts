// Track mute and solo over MIDI, on the M8's CC MAP CHAN (MIDI Settings, 11 by default). A
// track stays muted (or soloed) while its note is held: note on mutes, note off unmutes, so a
// track is muted without moving the cursor to it. The notes go out on the M8's own USB MIDI
// output port, through Web MIDI from this page (yam8d's External Apps iframe allows "midi").

export type TrackToggle = 'mute' | 'solo'

// Checked on the M8 (Model:02, fw 6.5): mute C-0..G-0 (12-19), solo G#0..D#1 (20-27).
const BASE: Record<TrackToggle, number> = { mute: 12, solo: 20 }

/** The MIDI note that holds a track's mute or solo (track 0..7). */
export const holdNote = (kind: TrackToggle, track: number): number => BASE[kind] + track

/** M8 default of CC MAP CHAN. */
export const DEFAULT_CHANNEL = 11

export class MidiControl {
  /** MIDI channel 1..16: the M8's CC MAP CHAN. */
  private ch: number
  private output: MIDIOutput | null = null
  private opening: Promise<MIDIOutput> | null = null
  /** Notes held now, with the channel they went out on (released on that channel). */
  private readonly held = new Map<number, number>()

  constructor(channel = DEFAULT_CHANNEL) {
    this.ch = channel
  }

  get channel(): number {
    return this.ch
  }

  /** Changes the channel; mutes and solos held on the old one are released first. */
  set channel(channel: number) {
    if (channel === this.ch) return
    this.releaseAll()
    this.ch = channel
  }

  /** Finds the M8's MIDI output (asks for Web MIDI access the first time). */
  private async open(): Promise<MIDIOutput> {
    if (this.output?.state === 'connected') return this.output
    if (!('requestMIDIAccess' in navigator)) throw new Error('Web MIDI is not available in this browser')
    this.opening ??= (async () => {
      const access = await navigator.requestMIDIAccess()
      const out = [...access.outputs.values()].find((o) => o.name === 'M8') ?? [...access.outputs.values()].find((o) => /\bM8\b/.test(o.name ?? ''))
      if (!out) throw new Error('no MIDI output named M8 (is the M8 plugged in over USB?)')
      await out.open()
      return out
    })()
    try {
      this.output = await this.opening
      return this.output
    } finally {
      this.opening = null
    }
  }

  /** Holds (on) or releases (off) the note of `kind` on `track`. */
  async set(kind: TrackToggle, track: number, on: boolean): Promise<void> {
    const out = await this.open()
    const note = holdNote(kind, track)
    if (on) {
      const ch = (this.ch - 1) & 0x0f
      out.send([0x90 | ch, note, 0x7f])
      this.held.set(note, ch)
    } else {
      const ch = this.held.get(note) ?? (this.ch - 1) & 0x0f
      out.send([0x80 | ch, note, 0])
      this.held.delete(note)
    }
  }

  /** Releases every held note (all mutes and solos sent from here end). */
  releaseAll(): void {
    if (this.output) for (const [note, ch] of this.held) this.output.send([0x80 | ch, note, 0])
    this.held.clear()
  }
}
