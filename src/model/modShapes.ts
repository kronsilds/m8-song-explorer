// The shape of a modulator, to draw it: points (t, v) with t across the drawing (0..1) and v
// its level (0..1, 0.5 the middle of an LFO). Envelopes take their stage lengths in ticks from
// the slot (ATK, HOLD, DEC...), LFOs their shape, trigger mode and rate, tracking its range;
// AMT scales the height. These are drawings from the manual's description of each type, not a
// measure of what the M8 outputs (DRUM ENV in particular is only its outline).

import type { ModSlot } from './instrumentPage'

export type Point = [t: number, v: number]

/** Steps an LFO drawing spans: one phrase. FREQ counts steps per cycle (ticks for the 'T' shapes). */
const LFO_WINDOW_STEPS  = 16
const TICKS_PER_STEP    = 6
const MAX_LFO_CYCLES    = 8
const MIN_LFO_CYCLES    = 0.5
/** Shortest span an envelope drawing covers, in ticks, so short envelopes look short. */
const MIN_ENVELOPE_SPAN = 24
const SAMPLES           = 96

const slotValue = (slot: ModSlot, label: string, fallback = 0): number => slot.cells[label]?.value ?? fallback
const amountOf  = (slot: ModSlot): number => slotValue(slot, 'AMT', 0xff) / 0xff

/** Straight segments through (ticks, level) corners, scaled to the drawing. */
function envelope(corners: [ticks: number, level: number][], amount: number): Point[] {
  const span = Math.max(MIN_ENVELOPE_SPAN, corners[corners.length - 1][0] * 1.08)
  return corners.map(([ticks, level]) => [ticks / span, level * amount])
}

function ahd(slot: ModSlot): Point[] {
  const attack = slotValue(slot, 'ATK')
  const hold   = slotValue(slot, 'HOLD')
  const decay  = slotValue(slot, 'DEC')
  return envelope([[0, 0], [attack, 1], [attack + hold, 1], [attack + hold + decay, 0]], amountOf(slot))
}

function adsr(slot: ModSlot): Point[] {
  const attack  = slotValue(slot, 'ATK')
  const decay   = slotValue(slot, 'DEC')
  const sustain = slotValue(slot, 'SUS') / 0xff
  const release = slotValue(slot, 'REL')
  // The note is held for a while between decay and release.
  const held    = Math.max(12, (attack + decay) * 0.5)
  const end     = attack + decay + held
  return envelope([[0, 0], [attack, 1], [attack + decay, sustain], [end, sustain], [end + release, 0]], amountOf(slot))
}

/** A sharp peak with a duck after it, a body, then the decay (the manual's outline). */
function drum(slot: ModSlot): Point[] {
  const peak  = slotValue(slot, 'PEAK') / 0xff
  const body  = slotValue(slot, 'BODY')
  const decay = slotValue(slot, 'DEC')
  const duck  = 1 - 0.55 * peak
  const peakT = 1 + peak * 4
  return envelope([[0, 1], [peakT, duck], [peakT + 2, 0.82], [peakT + 2 + body, 0.82], [peakT + 2 + body + decay, 0]], amountOf(slot))
}

/** Seeded pseudo random numbers (0..1), so a random LFO looks the same every time. */
function random(seed: number): () => number {
  let state = seed * 2654435761
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

/** One cycle of an LFO shape at phase p (0..1). */
function lfoLevel(shape: string, p: number, held: number): number {
  if (shape.startsWith('TRI')) return 1 - Math.abs(2 * p - 1)
  if (shape.startsWith('SIN')) return 0.5 + 0.5 * Math.sin(2 * Math.PI * p)
  if (shape.startsWith('RAMP DN')) return 1 - p
  if (shape.startsWith('RAMP UP')) return p
  if (shape.startsWith('EXP DN')) return (1 - p) ** 3
  if (shape.startsWith('EXP UP')) return p ** 3
  if (shape.startsWith('SQU DN')) return p < 0.5 ? 1 : 0
  if (shape.startsWith('SQU UP')) return p < 0.5 ? 0 : 1
  return held
}

function lfo(slot: ModSlot): Point[] {
  const shape    = (slot.cells.OSC?.option ?? 'TRI').toUpperCase()
  const trigger  = (slot.cells.TRIG?.option ?? 'FREE').toUpperCase()
  const freq     = Math.max(1, slotValue(slot, 'FREQ', 0x10))
  // The tick-rate variants end in 'T' (no plain shape name does).
  const perTick  = shape.endsWith('T')
  const steps    = perTick ? freq / TICKS_PER_STEP : freq
  const cycles   = Math.min(MAX_LFO_CYCLES, Math.max(MIN_LFO_CYCLES, LFO_WINDOW_STEPS / steps))
  const once     = trigger.startsWith('ONCE') || trigger.startsWith('HOLD')
  const amount   = amountOf(slot)
  const next     = random(slot.slot + freq)
  const randomly = shape.startsWith('RANDOM') || shape.startsWith('DRUNK')
  const drunk    = shape.startsWith('DRUNK')
  // Random shapes hold a value for an eighth of a cycle.
  const holds    = Math.ceil(cycles * 8) + 1
  const levels   : number[] = []
  let walk       = 0.5
  for (let i = 0; i < holds; i += 1) {
    walk = drunk ? Math.min(1, Math.max(0, walk + (next() - 0.5) * 0.35)) : next()
    levels.push(walk)
  }
  const points: Point[] = []
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t     = i / SAMPLES
    const phase = t * cycles
    // ONCE goes back to the start after one cycle; HOLD keeps the last value.
    let level   : number
    if (once && phase >= 1) level = trigger.startsWith('HOLD') ? lfoLevel(shape, 0.9999, levels[7]) : lfoLevel(shape, 0, levels[0])
    else level = lfoLevel(shape, phase % 1, randomly ? levels[Math.floor(phase * 8)] : 0)
    points.push([t, 0.5 + (level - 0.5) * amount])
  }
  return points
}

/** Note or velocity mapped from LVAL to HVAL. */
function tracking(slot: ModSlot): Point[] {
  return [[0, slotValue(slot, 'LVAL') / 0xff], [1, slotValue(slot, 'HVAL', 0x7f) / 0xff]]
}

/** The drawing of a modulator; empty when its type is unknown. */
export function modShape(slot: ModSlot): Point[] {
  switch (slot.kind) {
    case 'AHD':
    case 'TRIG':
      return ahd(slot)
    case 'ADSR':
      return adsr(slot)
    case 'DRUM':
      return drum(slot)
    case 'LFO':
      return lfo(slot)
    case 'TRACKING':
      return tracking(slot)
    default:
      return []
  }
}

/** A short description of a modulator's shape, for the Selection panel. */
export function modSummary(slot: ModSlot): string {
  const value = (label: string) => slot.cells[label]?.text ?? '--'
  const parts : string[] = [slot.type ?? '?', `→ ${slot.dest ?? 'OFF'}`, `AMT ${value('AMT')}`]
  switch (slot.kind) {
    case 'AHD':
      parts.push(`ATK ${value('ATK')}`, `HOLD ${value('HOLD')}`, `DEC ${value('DEC')}`)
      break
    case 'TRIG':
      parts.push(`ATK ${value('ATK')}`, `HOLD ${value('HOLD')}`, `DEC ${value('DEC')}`, `SRC ${value('SRC')}`)
      break
    case 'ADSR':
      parts.push(`ATK ${value('ATK')}`, `DEC ${value('DEC')}`, `SUS ${value('SUS')}`, `REL ${value('REL')}`)
      break
    case 'DRUM':
      parts.push(`PEAK ${value('PEAK')}`, `BODY ${value('BODY')}`, `DEC ${value('DEC')}`)
      break
    case 'LFO':
      parts.push(`OSC ${slot.cells.OSC?.option ?? value('OSC')}`, `TRIG ${slot.cells.TRIG?.option ?? value('TRIG')}`, `FREQ ${value('FREQ')}`)
      break
    case 'TRACKING':
      parts.push(`SRC ${slot.cells.SRC?.option ?? value('SRC')}`, `LVAL ${value('LVAL')}`, `HVAL ${value('HVAL')}`)
      break
  }
  return parts.join(' · ')
}
