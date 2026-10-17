// Chain and project transpose and what they do to a phrase: the notes as played (moved, then
// quantized to the track's scale as read from the Scale view), and a guess of the key the
// phrase's notes fit.

import type { Instrument, PhraseStep, Scale, SongModel, Timeline } from './song'

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** A chain TSP byte as signed semitones (80-FF are negative, as on the device). */
export const transposeSemitones = (raw: number | null | undefined): number => (raw == null ? 0 : raw < 0x80 ? raw : raw - 0x100)

/** '+5', '-12', '0'. */
export const formatTranspose = (st: number): string => (st > 0 ? `+${st}` : `${st}`)

/** 'C-4' -> 48, 'C#A' -> 121 (the octave is one hex digit); null for OFF, '---' or text that is not a note. */
export function noteNumber(note: string | null): number | null {
  const m = /^([A-G])([-#])([0-9A-F])$/.exec(note ?? '')
  if (!m) return null
  const pc = PITCH_NAMES.indexOf(`${m[1]}${m[2] === '#' ? '#' : ''}` as (typeof PITCH_NAMES)[number])
  return pc < 0 ? null : Number.parseInt(m[3], 16) * 12 + pc
}

/** 48 -> 'C-4', the way the M8 writes it. */
export function noteText(n: number): string {
  const name = PITCH_NAMES[((n % 12) + 12) % 12]
  return `${name[0]}${name[1] ?? '-'}${Math.floor(n / 12).toString(16).toUpperCase()}`
}

/** Highest note the M8 plays (G-A). */
const MAX_NOTE = 10 * 12 + 7

/** The note moved by `st` semitones; the text unchanged for OFF or empty steps, null out of range. */
export function transposeNote(note: string | null, st: number): string | null {
  const n = noteNumber(note)
  if (n == null || st === 0) return note
  const out = n + st
  return out < 0 || out > MAX_NOTE ? null : noteText(out)
}

/** False when the instrument's TRANSP. is OFF (it ignores chain transpose); true when ON or not read. */
export function instrumentTransposes(inst: Instrument | null | undefined): boolean {
  for (const line of inst?.lines ?? []) {
    const m = /TRANSP\.\s+(ON|OFF)\b/.exec(line)
    if (m) return m[1] === 'ON'
  }
  return true
}

// ---------------------------------------------------------------------------
// Track scales

/** The scale a track plays with at some point of the song, and where it comes from. */
export interface ScaleChoice {
  scale: number
  /** Key (root pitch class); null when neither the SCA/SCG value nor the Scale view gave one. */
  key: number | null
  source: 'project' | 'SCA' | 'SCG'
  /** Timeline row of the SCA / SCG that set it. */
  row: number | null
}

/** Key and scale of an SCA / SCG value: X is the key, Y the scale number. */
const scaleCommand = (val: number, source: 'SCA' | 'SCG', row: number): ScaleChoice => {
  const key = val >> 4
  return { scale: val & 0x0f, key: key < 12 ? key : null, source, row }
}

/**
 * Which scale each track plays with along the song: the last SCA on the track or SCG on any
 * track before the step (the step's own included), else the project SCALE with the KEY of its
 * Scale view. Table FX and playback order other than top to bottom (HOP, live mode) are not followed.
 */
export class ScaleMap {
  private readonly byTrack: ScaleChoice[][]
  private readonly global: ScaleChoice[] = []
  private readonly fallback: ScaleChoice

  constructor(model: SongModel, timeline: Timeline) {
    const scale = model.projectScale ?? 0
    this.fallback = { scale, key: model.projectKey ?? model.scales?.[scale]?.key ?? null, source: 'project', row: null }
    this.byTrack = timeline.byTrack.map(() => [])
    for (const inst of timeline.instances) {
      model.phrases[inst.phrase]?.steps.forEach((step, s) => {
        for (const f of step.fx) {
          if (f.val == null) continue
          if (f.cmd === 'SCA') this.byTrack[inst.track].push(scaleCommand(f.val, 'SCA', inst.row + s))
          if (f.cmd === 'SCG') this.global.push(scaleCommand(f.val, 'SCG', inst.row + s))
        }
      })
    }
    const byRow = (a: ScaleChoice, b: ScaleChoice) => (a.row as number) - (b.row as number)
    for (const list of this.byTrack) list.sort(byRow)
    this.global.sort(byRow)
  }

  at(track: number, row: number): ScaleChoice {
    const last = (list: ScaleChoice[]) => {
      let hit: ScaleChoice | null = null
      for (const c of list) if ((c.row as number) <= row) hit = c
      return hit
    }
    const own = last(this.byTrack[track] ?? [])
    const all = last(this.global)
    if (own && (!all || (own.row as number) >= (all.row as number))) return own
    return all ?? this.fallback
  }

  /** Scale numbers SCA / SCG point at anywhere in the song. */
  static referenced(model: SongModel): number[] {
    const out = new Set<number>()
    const scan = (fx: { cmd: string | null; val: number | null }[]) => {
      for (const f of fx) if ((f.cmd === 'SCA' || f.cmd === 'SCG') && f.val != null) out.add(f.val & 0x0f)
    }
    for (const phrase of Object.values(model.phrases)) for (const step of phrase.steps) scan(step.fx)
    for (const table of Object.values(model.tables)) for (const row of table.rows) scan(row.fx)
    return [...out].sort((a, b) => a - b)
  }
}

/** Pitch classes a scale lets through from its key; null when it lets all twelve through or is unknown. */
export function scalePitches(scale: Scale | undefined, key: number | null): Set<number> | null {
  if (!scale) return null
  const root = key ?? scale.key ?? 0
  const on = scale.notes.flatMap((n, i) => (n.enabled === true ? [(root + i) % 12] : []))
  return on.length === 12 || on.length === 0 ? null : new Set(on)
}

/**
 * A transposed note brought into the scale. Not checked on the device: which way the M8 moves a
 * note that falls between two scale notes. This takes the scale note below.
 */
export function quantize(n: number, pitches: Set<number> | null): number {
  if (!pitches) return n
  let out = n
  while (out > 0 && !pitches.has(out % 12)) out -= 1
  return out
}

export interface PlayedNote {
  /** Semitones the transposes add (chain + project); 0 when the instrument's TRANSP. is OFF. */
  shift: number
  /** The note after the shift and the scale; the written text for OFF / empty; null out of range. */
  note: string | null
  /** Semitones the scale moved it after the shift (0 or negative). */
  snapped: number
  /** Detune the scale gives that note, in semitones. */
  detune: number
  /** False when the instrument's TRANSP. is OFF (no transpose, no scale). */
  transposes: boolean
  scale: ScaleChoice
}

/**
 * What a step plays: its note moved by the chain and project transpose, then quantized to the
 * track's scale. Notes are quantized only when a transpose moves them (the M8 quantizes note
 * entry, so written notes are taken as already in the scale).
 */
export function playedNote(
  model: SongModel,
  written: string | null,
  chainSt: number,
  inst: number | null | undefined,
  scale: ScaleChoice,
): PlayedNote {
  const transposes = inst == null || instrumentTransposes(model.instruments[inst])
  const shift = transposes ? chainSt + transposeSemitones(model.projectTranspose) : 0
  const n = noteNumber(written)
  const info = model.scales?.[scale.scale]
  const pitches = transposes ? scalePitches(info, scale.key) : null
  if (n == null || shift === 0) {
    const detune = n != null && transposes && info ? (info.notes[(n - (scale.key ?? info.key ?? 0) + 120) % 12]?.offset ?? 0) : 0
    return { shift, note: written, snapped: 0, detune, transposes, scale }
  }
  const moved = n + shift
  const out = quantize(moved, pitches)
  const detune = info && transposes ? (info.notes[(out - (scale.key ?? info.key ?? 0) + 120) % 12]?.offset ?? 0) : 0
  return { shift, note: moved < 0 || out > MAX_NOTE ? null : noteText(out), snapped: out - moved, detune, transposes, scale }
}

/** 'SCALE 01 MINOR · key A (SCA)' */
export function scaleLabel(model: SongModel, choice: ScaleChoice): string {
  const info = model.scales?.[choice.scale]
  const key = choice.key ?? info?.key ?? null
  const id = choice.scale.toString(16).toUpperCase().padStart(2, '0')
  return [`${id}${info?.name ? ` ${info.name}` : info ? '' : ' (not read)'}`, key != null ? `key ${PITCH_NAMES[key]}` : null, choice.source === 'project' ? 'project' : choice.source]
    .filter(Boolean)
    .join(' · ')
}

// ---------------------------------------------------------------------------
// Key guess

/** Scales a key is read in, most usual first (earlier ones win close calls). */
const SCALES: { name: string; steps: number[] }[] = [
  { name: 'major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
  { name: 'blues', steps: [0, 3, 5, 6, 7, 10] },
  { name: 'whole tone', steps: [0, 2, 4, 6, 8, 10] },
  { name: 'diminished', steps: [0, 2, 3, 5, 6, 8, 9, 11] },
]

const ORDINALS = ['root', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th']

export interface PhraseKey {
  root: number
  scale: string
  steps: number[]
}

export interface PhraseHarmony {
  /** Pitch classes the phrase plays, in order from C. */
  pitches: number[]
  /** The key they fit best, null with fewer than three pitch classes or none that fits. */
  key: PhraseKey | null
}

export const keyName = (key: PhraseKey, st = 0): string => `${PITCH_NAMES[(((key.root + st) % 12) + 12) % 12]} ${key.scale}`

/** 'C E G' for a set of pitch classes moved by `st`, sorted from C. */
export const pitchList = (pitches: number[], st = 0): string =>
  [...new Set(pitches.map((p) => (((p + st) % 12) + 12) % 12))]
    .sort((a, b) => a - b)
    .map((p) => PITCH_NAMES[p])
    .join(' ')

/** '3rd' for a note of the key (the degree is the same after a transpose). */
export function degreeOf(key: PhraseKey, note: number): string | null {
  const i = key.steps.indexOf((((note - key.root) % 12) + 12) % 12)
  return i < 0 ? null : (ORDINALS[i] ?? `${i + 1}th`)
}

/**
 * The key a phrase's notes fit: every scale and root that holds all of them, scored by how
 * strongly the root is heard (how often it plays, first note, lowest note) and how usual the
 * scale is. A guess from 16 steps, shown as "fits".
 */
export function analyzePhrase(steps: PhraseStep[] | undefined): PhraseHarmony {
  const notes = (steps ?? []).map((s) => noteNumber(s.note)).filter((n): n is number => n != null)
  const count = new Array(12).fill(0)
  for (const n of notes) count[n % 12] += 1
  const pitches = count.flatMap((c, pc) => (c ? [pc] : []))
  if (pitches.length < 3) return { pitches, key: null }
  const first = notes[0] % 12
  const lowest = Math.min(...notes) % 12
  let best: { key: PhraseKey; score: number } | null = null
  SCALES.forEach((scale, order) => {
    for (let root = 0; root < 12; root += 1) {
      if (!pitches.every((pc) => scale.steps.includes((pc - root + 12) % 12))) continue
      const weight = count[root] / notes.length + (root === first ? 0.35 : 0) + (root === lowest ? 0.25 : 0)
      const score = weight - order * 0.04 - (scale.steps.length - pitches.length) * 0.01
      if (!best || score > best.score) best = { key: { root, scale: scale.name, steps: scale.steps }, score }
    }
  })
  return { pitches, key: (best as { key: PhraseKey } | null)?.key ?? null }
}
