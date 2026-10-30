// Instruments of a .m8s file as the stored screen lines the explorer keeps (Instrument and
// Inst. Mods views). Layouts of WAVSYNTH, MACROSYN, FMSYNTH and HYPERSYN checked against a device
// exploration of one song (fw 6.5 / 6.6.2). A value whose name was never observed shows as its
// hex value alone. SAMPLER, MIDI OUT and EXTERNAL were checked on one instrument each; their sample
// name, BANK:PG and Inst. Mods are not read.

import { hex2 } from './hex'
import { instrumentLines, instrumentModsLines, MOD_ROWS, type ModSpec } from './screens'
import type { Instrument } from './song'

export const INSTRUMENT_SIZE = 215
const NAME_SIZE              = 12
const MODS_AT                = 0x3f
const MOD_SIZE               = 6

const KINDS = ['WAVSYNTH', 'MACROSYN', 'SAMPLER', 'MIDI OUT', 'FMSYNTH', 'HYPERSYN', 'EXTERNAL']

/** Names seen on a device, by value. */
const FILTERS        = ['OFF', 'LOWPASS']
const LIMITS         : Record<number, string> = {
  0: 'CLIP',
  8: 'POST:W3'
}
const PLAYS          : Record<number, string> = {
  0: 'FWD',
  2: 'FWDLOOP'
}
const INPUTS         : Record<number, string> = { 0: 'LINE-IN STEREO' }
const EXTERNAL_PORTS : Record<number, string> = {
  1: 'MIDI+USB',
  2: 'MIDI'
}
const MIDI_PORTS     : Record<number, string> = {
  0: 'MIDI+USB',
  2: 'USB'
}
const SHAPES         : Record<string, Record<number, string>> = {
  WAVSYNTH: {
    0: 'PULSE 12%',
    2: 'PULSE 50%',
    5: 'TRIANGLE',
    6: 'SINE',
    7: 'NOISE PITCHED',
    8: 'NOISE'
  },
  MACROSYN: {
    0 : 'CSAW',
    22: 'VOWEL',
    25: 'FM'
  },
  HYPERSYN: { 0: 'SAW' }
}
const ALGOS          = {
  0: 'A>B>C>D',
  7: '[A>B]+[C>D]'
}
const OSCILLATORS    = ['TRI', 'SIN', 'RAMP DN', 'RAMP UP', 'EXP DN', 'EXP UP', 'SQR DN', 'SQR UP', 'RANDOM', 'DRUNK', 'TRI T', 'SIN T', 'RAMPDN T']
const TRIGGERS       = ['FREE', 'RETRIG', 'HOLD', 'ONCE']
const MOD_TYPES      = ['AHD ENV', 'ADSR ENV', 'DRUM ENV', 'LFO', 'TRIG ENV', 'TRACKING']

/** The four parameters of the first block, in the order of the modulator destinations 03-06. */
const PARAMETERS: Record<string, string[]> = {
  WAVSYNTH: ['SIZE', 'MULT', 'WARP', 'SCAN'],
  MACROSYN: ['TIMBRE', 'COLOR', 'DEGRADE', 'REDUX'],
  FMSYNTH : ['MOD 1', 'MOD 2', 'MOD 3', 'MOD 4'],
  HYPERSYN: ['SHIFT', 'SWARM', 'WIDTH', 'SUBOSC']
}

const named = (value: number, names: ArrayLike<string> | Record<number, string>): string => {
  const name = (names as Record<number, string | undefined>)[value]
  return name ? `${hex2(value)}${name}` : hex2(value)
}

function destinations(type: string): string[] {
  const [first, second, third, fourth] = PARAMETERS[type] ?? []
  return ['OFF', 'VOLUME', 'PITCH', first, second, third, fourth, 'CUTOFF', 'RES', 'AMP', 'PAN', 'MFX', 'DEL', 'REV']
}

const FM_MOD_ROUTES: Record<number, string> = {
  0 : '-----',
  1 : '1>LEV',
  14: '2>FBK'
}

function readName(bytes: Uint8Array, at: number): string {
  let text = ''
  for (const byte of bytes.subarray(at, at + NAME_SIZE)) {
    if (byte === 0 || byte === 0xff) break
    text += String.fromCharCode(byte)
  }
  return text.trimEnd()
}

/** The modulators at 0x3F: type and destination in one byte, then the values in the order the rows show. */
function readMods(bytes: Uint8Array, at: number, type: string): ModSpec[] {
  const dests = destinations(type)
  return [0, 1, 2, 3].map((slot) => {
    const start = at + MODS_AT + slot * MOD_SIZE
    const kind  = bytes[start] >> 4
    const label = MOD_TYPES[kind] ?? ''
    const rows  = MOD_ROWS[label] ?? MOD_ROWS['AHD ENV']
    const byte  = (index: number): number => bytes[start + index]
    return {
      type: `${hex2(kind)}${label}`,
      rows: rows.map((row, index): [string, string] => {
        if (index === 0) return [row, named(byte(0) & 15, dests)]
        const value = byte(index)
        if (row === 'OSC') return [row, named(value, OSCILLATORS)]
        if (row === 'TRIG') return [row, named(value, TRIGGERS)]
        return [row, hex2(value)]
      })
    }
  })
}

function setLine(lines: string[], prefix: string, text: string): void {
  const at = lines.findIndex((line) => line.startsWith(prefix))
  if (at >= 0) lines[at] = text
}

/** One instrument of the file, or null when its slot is empty. */
export function readInstrument(bytes: Uint8Array, id: number, start: number): Instrument | null {
  const at   = start + id * INSTRUMENT_SIZE
  const kind = bytes[at]
  const type = KINDS[kind]
  if (!type) return null
  const name   = readName(bytes, at + 1)
  const b      = (offset: number): number => bytes[at + offset]
  const values : Record<string, string> = {}
  const common = (filter: number): void => {
    values.FILTER = named(b(filter), FILTERS)
    values.CUTOFF = hex2(b(filter + 1))
    values.RES    = hex2(b(filter + 2))
    values.AMP    = hex2(b(filter + 3))
    values.LIM    = named(b(filter + 4), LIMITS)
    values.PAN    = hex2(b(filter + 5))
    values.DRY    = hex2(b(filter + 6))
    values.MFX    = hex2(b(filter + 7))
    values.DEL    = hex2(b(filter + 8))
    values.REV    = hex2(b(filter + 9))
  }
  let lines    : string[]
  if (type === 'WAVSYNTH' || type === 'MACROSYN') {
    const shape = named(b(0x12), SHAPES[type])
    PARAMETERS[type].forEach((label, index) => {
      values[label] = hex2(b(0x13 + index))
    })
    common(0x17)
    lines = instrumentLines(id, type, name, values)
    setLine(lines, 'SHAPE', `SHAPE   ${shape}`)
  } else if (type === 'FMSYNTH') {
    common(0x33)
    ;['MOD1', 'MOD2', 'MOD3', 'MOD4'].forEach((label, index) => {
      values[label] = hex2(b(0x2f + index))
    })
    lines           = instrumentLines(id, type, name, values)
    const operators = [0, 1, 2, 3].map((op) => `${'ABCD'[op]} ${b(0x13 + op) === 0 ? 'SIN' : hex2(b(0x13 + op))}`)
    setLine(lines, 'ALGO', `ALGO    ${named(b(0x12), ALGOS)}`)
    setLine(lines, '        A ', `        ${operators.join(' ')}`)
    setLine(lines, 'RATIO', `RATIO   ${[0, 1, 2, 3].map((op) => `${hex2(b(0x17 + op * 2))}.${hex2(b(0x18 + op * 2))}`).join(' ')}`)
    setLine(lines, 'LEV/FB', `LEV/FB  ${[0, 1, 2, 3].map((op) => `${hex2(b(0x1f + op * 2))}/${hex2(b(0x20 + op * 2))}`).join(' ')}`)
    const routes = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => FM_MOD_ROUTES[b(0x27 + index)] ?? hex2(b(0x27 + index)).padEnd(5))
    setLine(lines, 'MOD     ', `MOD     ${routes.slice(0, 4).join(' ')}`)
    const mod = lines.findIndex((line) => line.startsWith('MOD     '))
    if (mod >= 0) lines[mod + 1] = `        ${routes.slice(4).join(' ')}`
  } else if (type === 'HYPERSYN') {
    values.SHIFT  = hex2(b(0x1a))
    values.SWARM  = hex2(b(0x1b))
    values.WIDTH  = hex2(b(0x1c))
    values.SUBOSC = hex2(b(0x1d))
    common(0x1e)
    lines = instrumentLines(id, type, name, values)
    setLine(lines, 'SHAPE', `SHAPE   ${named(b(0x12), SHAPES.HYPERSYN)}`)
    setLine(lines, 'SCALE',`SCALE   ${named(b(0x19), { 0: 'DEFAULT' })}`)
    setLine(lines, 'CHORD', `CHORD   00> ${[0, 1, 2, 3, 4, 5].map((index) => hex2(b(0x13 + index))).join(' ')}`)
  } else if (type === 'SAMPLER') {
    values.DETUNE     = hex2(b(0x11))
    values.PLAY       = named(b(0x12), PLAYS)
    values.SLICE      = b(0x13) === 0 ? '00OFF' : `${hex2(b(0x13))}(${String(b(0x13)).padStart(3, '0')})`
    values.START      = hex2(b(0x14))
    values['LOOP ST'] = hex2(b(0x15))
    values.LENGTH     = hex2(b(0x16))
    values.DEGRADE    = hex2(b(0x17))
    common(0x18)
    lines = instrumentLines(id, type, name, values)
  } else if (type === 'EXTERNAL') {
    common(0x1f)
    lines = instrumentLines(id, type, name, values)
    setLine(lines, 'INPUT', `INPUT   ${named(b(0x12), INPUTS)}`)
    setLine(lines, 'PORT', `PORT    ${named(b(0x13), EXTERNAL_PORTS)}`)
    setLine(lines, 'CHANNEL', `CHANNEL ${hex2(b(0x14))}`)
    for (const [index, letter] of ['A', 'B', 'C', 'D'].entries()) {
      const at   = lines.findIndex((line) => line.startsWith(`CC${letter} `))
      const left = `CC${letter} ${String(b(0x17 + index * 2)).padStart(3, '0')}:${b(0x18 + index * 2) === 0xff ? '--' : hex2(b(0x18 + index * 2))}`
      if (at >= 0) lines[at] = `${left.padEnd(18)}${lines[at].slice(18)}`.trimEnd()
    }
  } else if (type === 'MIDI OUT') {
    lines = instrumentLines(id, type, name)
    setLine(lines, 'PORT', `PORT        ${named(b(0x0f), MIDI_PORTS)}`)
    setLine(lines, 'CHANNEL', `CHANNEL     ${hex2(b(0x10))}`)
    for (const [index, letter] of 'ABCDEFGHIJ'.split('').entries()) {
      const number = b(0x18 + index * 2)
      const value  = b(0x19 + index * 2)
      setLine(lines, `CC${letter} `, `CC${letter} CC:VAL  ${number === 0xff ? '---' : String(number).padStart(3, '0')}:${value === 0xff ? '--' : hex2(value)}`)
    }
  } else {
    lines = instrumentLines(id, type, name)
  }
  lines[4]         = `TRANSP. ${b(0x0d) ? 'ON ' : 'OFF'}  TBL.TIC ${hex2(b(0x0e))}   EQ --`
  const instrument : Instrument = {
    id,
    name: name || null,
    type,
    lines
  }
  if (PARAMETERS[type]) instrument.mods = instrumentModsLines(id, readMods(bytes, at, type)).filter((line, index, all) => line !== '' || all.slice(index).some((rest) => rest !== ''))
  return instrument
}
