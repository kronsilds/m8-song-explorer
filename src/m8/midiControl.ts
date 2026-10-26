// Track mute and solo over MIDI, on the M8's CC MAP CHAN (MIDI Settings, 11 by default). A
// track stays muted (or soloed) while its note is held: note on mutes, note off unmutes, so a
// track is muted without moving the cursor to it. The notes go out on the M8's own USB MIDI
// output port, through Web MIDI from this page (yam8d's External Apps iframe allows "midi").

export type TrackToggle = 'mute' | 'solo'

// Checked on the M8 (Model:02, fw 6.5): mute C-0..G-0 (12-19), solo G#0..D#1 (20-27).
const FIRST_NOTE             : Record<TrackToggle, number> = {
  mute: 12,
  solo: 20
}

const NOTE_ON       = 0x90
const NOTE_OFF      = 0x80
const FULL_VELOCITY = 0x7f

/** The MIDI note that holds a track's mute or solo (track 0..7). */
export const holdNote        = (kind: TrackToggle, track: number): number => FIRST_NOTE[kind] + track

/** M8 default of CC MAP CHAN. */
export const DEFAULT_CHANNEL = 11

/** Where the mute / solo notes go, for the debug log. */
export interface MidiInfo {
  channel  : number
  available: boolean
  /** The M8's output once found. */
  output   : { name: string | null; state: string; connection: string } | null
  /** Notes held now. */
  held     : number[]
  /** Why the output could not be opened the last time. */
  lastError: string | null
}

export class MidiControl {
  /** MIDI channel 1..16: the M8's CC MAP CHAN. */
  private currentChannel     : number
  private output             : MIDIOutput | null = null
  private opening            : Promise<MIDIOutput> | null = null
  /** Notes held now, with the channel nibble they went out on (released on that channel). */
  private readonly heldNotes = new Map<number, number>()
  private lastError          : string | null = null

  constructor(channel = DEFAULT_CHANNEL) {
    this.currentChannel = channel
  }

  get channel(): number {
    return this.currentChannel
  }

  /** Changes the channel; mutes and solos held on the old one are released first. */
  set channel(channel: number) {
    if (channel === this.currentChannel) return
    this.releaseAll()
    this.currentChannel = channel
  }

  info(): MidiInfo {
    const { output } = this
    return {
      channel  : this.currentChannel,
      available: 'requestMIDIAccess' in navigator,
      output   : output ? {
        name      : output.name,
        state     : output.state,
        connection: output.connection
      } : null,
      held     : [...this.heldNotes.keys()].sort((a, b) => a - b),
      lastError: this.lastError
    }
  }

  /** Finds the M8's MIDI output (asks for Web MIDI access the first time). */
  private async open(): Promise<MIDIOutput> {
    if (this.output?.state === 'connected') return this.output
    if (!('requestMIDIAccess' in navigator)) throw new Error('Web MIDI is not available in this browser')
    this.opening ??= (async () => {
      const access  = await navigator.requestMIDIAccess()
      const outputs = [...access.outputs.values()]
      const m8      = outputs.find((output) => output.name === 'M8') ?? outputs.find((output) => /\bM8\b/.test(output.name ?? ''))
      if (!m8) throw new Error('no MIDI output named M8 (is the M8 plugged in over USB?)')
      await m8.open()
      return m8
    })()
    try {
      this.output    = await this.opening
      this.lastError = null
      return this.output
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.opening = null
    }
  }

  /** Holds (on) or releases (off) the note of `kind` on `track`. */
  async set(kind: TrackToggle, track: number, on: boolean): Promise<void> {
    const output        = await this.open()
    const note          = holdNote(kind, track)
    const channelNibble = (this.currentChannel - 1) & 0x0f
    if (on) {
      output.send([NOTE_ON | channelNibble, note, FULL_VELOCITY])
      this.heldNotes.set(note, channelNibble)
    } else {
      output.send([NOTE_OFF | (this.heldNotes.get(note) ?? channelNibble), note, 0])
      this.heldNotes.delete(note)
    }
  }

  /** Releases every held note (all mutes and solos sent from here end). */
  releaseAll(): void {
    if (this.output) for (const [note, channelNibble] of this.heldNotes) this.output.send([NOTE_OFF | channelNibble, note, 0])
    this.heldNotes.clear()
  }
}
