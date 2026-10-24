// Chain and project transpose and what they do to a phrase: the notes as played (moved, then
// quantized to the track's scale as read from the Scale view), and a guess of the key the
// phrase's notes fit.

import { hex2 } from '../hex'
import { type Instrument, type PhraseStep, referencedValues, type Scale, type SongModel } from '../song'
import type { Timeline } from '../timeline'
import { HIGHEST_NOTE, noteNumber, noteText, PITCH_NAMES, pitchClass } from './pitch'

/** A chain TSP byte as signed semitones (80-FF are negative, as on the device). */
export const transposeSemitones = (raw: number | null | undefined): number => (raw == null ? 0 : raw < 0x80 ? raw : raw - 0x100)

/** '+5', '-12', '0'. */
export const formatTranspose    = (semitones: number): string => (semitones > 0 ? `+${semitones}` : `${semitones}`)

/** The note moved by `semitones`; the text unchanged for OFF or empty steps, null out of range. */
export function transposeNote(note: string | null, semitones: number): string | null {
  const number = noteNumber(note)
  if (number == null || semitones === 0) return note
  const moved = number + semitones
  return moved < 0 || moved > HIGHEST_NOTE ? null : noteText(moved)
}

/** False when the instrument's TRANSP. is OFF (it ignores chain transpose); true when ON or not read. */
export function instrumentTransposes(instrument: Instrument | null | undefined): boolean {
  for (const line of instrument?.lines ?? []) {
    const match = /TRANSP\.\s+(ON|OFF)\b/.exec(line)
    if (match) return match[1] === 'ON'
  }
  return true
}

// ---------------------------------------------------------------------------
// Track scales

type ScaleSource = 'project' | 'SCA' | 'SCG'

/** The scale a track plays with at some point of the song, and where it comes from. */
export interface ScaleChoice {
  scale : number
  /** Key (root pitch class); null when neither the SCA/SCG value nor the Scale view gave one. */
  key   : number | null
  source: ScaleSource
  /** Timeline row of the SCA / SCG that set it. */
  row   : number | null
}

type ScaleCommand = ScaleChoice & { row: number }

/** Key and scale of an SCA / SCG value: X is the key, Y the scale number. */
function scaleCommand(value: number, source: 'SCA' | 'SCG', row: number): ScaleCommand {
  const key = value >> 4
  return {
    scale: value & 0x0f,
    key  : key < 12 ? key : null,
    source,
    row
  }
}

/** The last command at or before `row` in a list sorted by row. */
function lastCommandAt(commands: ScaleCommand[], row: number): ScaleCommand | null {
  let last: ScaleCommand | null = null
  for (const command of commands) if (command.row <= row) last = command
  return last
}

/**
 * Which scale each track plays with along the song: the last SCA on the track or SCG on any
 * track before the step (the step's own included), else the project SCALE with the KEY of its
 * Scale view. Table FX and playback order other than top to bottom (HOP, live mode) are not followed.
 */
export class ScaleMap {
  private readonly trackCommands : ScaleCommand[][]
  private readonly globalCommands: ScaleCommand[] = []
  private readonly projectChoice : ScaleChoice

  constructor(model: SongModel, timeline: Timeline) {
    const scale        = model.projectScale ?? 0
    this.projectChoice = {
      scale,
      key   : model.projectKey ?? model.scales?.[scale]?.key ?? null,
      source: 'project',
      row   : null
    }
    this.trackCommands = timeline.byTrack.map(() => [])
    for (const instance of timeline.instances) {
      model.phrases[instance.phrase]?.steps.forEach((step, s) => {
        const row = instance.row + s
        for (const fx of step.fx) {
          if (fx.val == null) continue
          if (fx.cmd === 'SCA') this.trackCommands[instance.track].push(scaleCommand(fx.val, 'SCA', row))
          if (fx.cmd === 'SCG') this.globalCommands.push(scaleCommand(fx.val, 'SCG', row))
        }
      })
    }
    const byRow = (a: ScaleCommand, b: ScaleCommand) => a.row - b.row
    for (const commands of this.trackCommands) commands.sort(byRow)
    this.globalCommands.sort(byRow)
  }

  at(track: number, row: number): ScaleChoice {
    const ownTrack = lastCommandAt(this.trackCommands[track] ?? [], row)
    const anyTrack = lastCommandAt(this.globalCommands, row)
    if (ownTrack && (!anyTrack || ownTrack.row >= anyTrack.row)) return ownTrack
    return anyTrack ?? this.projectChoice
  }
}

/** Scale numbers SCA / SCG point at anywhere in the song. */
export const referencedScales = (model: SongModel): number[] => referencedValues(model, ['SCA', 'SCG'], 0x0f)

/** Pitch classes a scale lets through from its key; null when it lets all twelve through or is unknown. */
export function scalePitches(scale: Scale | undefined, key: number | null): Set<number> | null {
  if (!scale) return null
  const root    = key ?? scale.key ?? 0
  const enabled = scale.notes.flatMap((note, interval) => (note.enabled === true ? [(root + interval) % 12] : []))
  return enabled.length === 12 || enabled.length === 0 ? null : new Set(enabled)
}

/**
 * A transposed note brought into the scale: a note the scale does not let through plays as the
 * next scale note above it. Measured on the device (scale C, E, G; C-4 transposed by +1 played
 * E-4, +2 E-4, +5 G-4, +8 C-5), so it is the next note up, not the nearest.
 */
export function quantize(note: number, pitches: Set<number> | null): number {
  if (!pitches) return note
  let quantized = note
  for (let step = 0; step < 12 && !pitches.has(quantized % 12); step += 1) quantized += 1
  return quantized
}

/** Detune the scale gives a note, in semitones. */
function scaleDetune(scale: Scale, key: number | null, note: number): number {
  return scale.notes[pitchClass(note - (key ?? scale.key ?? 0))]?.offset ?? 0
}

export interface PlayedNote {
  /** Semitones the transposes add (chain + project); 0 when the instrument's TRANSP. is OFF. */
  shift     : number
  /** The note after the shift and the scale; the written text for OFF / empty; null out of range. */
  note      : string | null
  /** Semitones the scale moved it after the shift (0 or positive). */
  snapped   : number
  /** Detune the scale gives that note, in semitones (the OFFSET column of the Scale view). */
  detune    : number
  /** The note the M8 sounds and shows on its note monitor: `note` plus the whole semitones of the detune. */
  sounding  : string | null
  /** False when the instrument's TRANSP. is OFF (no transpose, no scale). */
  transposes: boolean
  scale     : ScaleChoice
}

/**
 * What a step plays: its note moved by the chain and project transpose, then quantized to the
 * track's scale. The M8 quantizes at play time, written notes too: with no transpose, an E-4 in
 * a scale of D, F#, A played F#4 (checked on the device). Entering a note quantizes it as well,
 * so a note is only out of the scale after the scale or key was edited. The scale's OFFSET of the
 * note it landed on then adds its whole semitones (C-5 in a scale of C# F G#, C# at +1, played D-5
 * on the note monitor); the cents are not heard in the note name.
 */
export function playedNote(
  model: SongModel,
  writtenNote: string | null,
  chainSemitones: number,
  instrument: number | null | undefined,
  scale: ScaleChoice,
): PlayedNote {
  const transposes = instrument == null || instrumentTransposes(model.instruments[instrument])
  const shift      = transposes ? chainSemitones + transposeSemitones(model.projectTranspose) : 0
  const written    = noteNumber(writtenNote)
  const scaleInfo  = transposes ? model.scales?.[scale.scale] : undefined
  if (written == null) {
    return {
      shift,
      note    : writtenNote,
      snapped : 0,
      detune  : 0,
      sounding: writtenNote,
      transposes,
      scale
    }
  }
  const moved     = written + shift
  const quantized = quantize(moved, scalePitches(scaleInfo, scale.key))
  const detune    = scaleInfo ? scaleDetune(scaleInfo, scale.key, quantized) : 0
  const note      = moved < 0 || quantized > HIGHEST_NOTE ? null : noteText(quantized)
  const heard     = quantized + Math.trunc(detune)
  return {
    shift,
    note,
    snapped : quantized - moved,
    detune,
    sounding: note == null || heard < 0 || heard > HIGHEST_NOTE ? null : noteText(heard),
    transposes,
    scale
  }
}

/** '01 MINOR · key A · SCA' */
export function scaleLabel(model: SongModel, choice: ScaleChoice): string {
  const scale = model.scales?.[choice.scale]
  const key   = choice.key ?? scale?.key ?? null
  const name  = scale?.name ? ` ${scale.name}` : scale ? '' : ' (not read)'
  return [`${hex2(choice.scale)}${name}`, key != null ? `key ${PITCH_NAMES[key]}` : null, choice.source].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------
// Key guess

/** Scales a key is read in, most usual first (earlier ones win close calls). */
const KEY_GUESS_SCALES    : { name: string; steps: number[] }[] = [{
  name : 'major',
  steps: [0, 2, 4, 5, 7, 9, 11]
}, {
  name : 'minor',
  steps: [0, 2, 3, 5, 7, 8, 10]
}, {
  name : 'harmonic minor',
  steps: [0, 2, 3, 5, 7, 8, 11]
}, {
  name : 'melodic minor',
  steps: [0, 2, 3, 5, 7, 9, 11]
}, {
  name : 'dorian',
  steps: [0, 2, 3, 5, 7, 9, 10]
}, {
  name : 'mixolydian',
  steps: [0, 2, 4, 5, 7, 9, 10]
}, {
  name : 'phrygian',
  steps: [0, 1, 3, 5, 7, 8, 10]
}, {
  name : 'lydian',
  steps: [0, 2, 4, 6, 7, 9, 11]
}, {
  name : 'locrian',
  steps: [0, 1, 3, 5, 6, 8, 10]
}, {
  name : 'phrygian dominant',
  steps: [0, 1, 4, 5, 7, 8, 10]
}, {
  name : 'blues',
  steps: [0, 3, 5, 6, 7, 10]
}, {
  name : 'whole tone',
  steps: [0, 2, 4, 6, 8, 10]
}, {
  name : 'diminished',
  steps: [0, 2, 3, 5, 6, 8, 9, 11]
}]

/** Score bonuses of the key guess: how strongly a root is heard, and how usual a scale is. */
const FIRST_NOTE_BONUS    = 0.35
const LOWEST_NOTE_BONUS   = 0.25
const SCALE_ORDER_PENALTY = 0.04
const UNUSED_STEP_PENALTY = 0.01

/** 'root', '2nd', '3rd', '4th'... for a 0-based degree. */
export const ordinal      = (degree: number): string => (degree === 0 ? 'root' : `${degree + 1}${degree === 1 ? 'nd' : degree === 2 ? 'rd' : 'th'}`)

export interface PhraseKey {
  root : number
  scale: string
  steps: number[]
}

export interface PhraseHarmony {
  /** Pitch classes the phrase plays, in order from C. */
  pitches: number[]
  /** The key they fit best, null with fewer than three pitch classes or none that fits. */
  key    : PhraseKey | null
}

/** 'A minor', moved by `semitones`. */
export const keyName   = (key: PhraseKey, semitones = 0): string => `${PITCH_NAMES[pitchClass(key.root + semitones)]} ${key.scale}`

/** 'C E G' for a set of pitch classes moved by `semitones`, sorted from C. */
export const pitchList = (pitches: number[], semitones = 0): string =>
  [...new Set(pitches.map((pitch) => pitchClass(pitch + semitones)))]
    .sort((a, b) => a - b)
    .map((pitch) => PITCH_NAMES[pitch])
    .join(' ')

/** '3rd' for a note of the key (the degree is the same after a transpose). */
export function degreeOf(key: PhraseKey, note: number): string | null {
  const degree = key.steps.indexOf(pitchClass(note - key.root))
  return degree < 0 ? null : ordinal(degree)
}

/**
 * The key a phrase's notes fit: every scale and root that holds all of them, scored by how
 * strongly the root is heard (how often it plays, first note, lowest note) and how usual the
 * scale is. A guess from 16 steps, shown as "fits".
 */
export function analyzePhrase(steps: PhraseStep[] | undefined): PhraseHarmony {
  const notes         = (steps ?? []).map((step) => noteNumber(step.note)).filter((note): note is number => note != null)
  const countPerPitch = new Array<number>(12).fill(0)
  for (const note of notes) countPerPitch[note % 12] += 1
  const pitches = countPerPitch.flatMap((count, pitch) => (count ? [pitch] : []))
  if (pitches.length < 3) return {
    pitches,
    key: null
  }

  const firstPitch  = notes[0] % 12
  const lowestPitch = Math.min(...notes) % 12
  let best          : { key: PhraseKey; score: number } | null = null
  for (const [order, scale] of KEY_GUESS_SCALES.entries()) {
    for (let root = 0; root < 12; root += 1) {
      if (!pitches.every((pitch) => scale.steps.includes(pitchClass(pitch - root)))) continue
      const heard = countPerPitch[root] / notes.length + (root === firstPitch ? FIRST_NOTE_BONUS : 0) + (root === lowestPitch ? LOWEST_NOTE_BONUS : 0)
      const score = heard - order * SCALE_ORDER_PENALTY - (scale.steps.length - pitches.length) * UNUSED_STEP_PENALTY
      if (!best || score > best.score) best = {
        key: {
          root,
          scale: scale.name,
          steps: scale.steps
        },
        score
      }
    }
  }
  return {
    pitches,
    key: best?.key ?? null
  }
}
