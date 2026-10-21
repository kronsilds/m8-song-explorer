// A made-up song with the shape of a real one (sections, shared chains, tables, TBX/INS
// references), shown when no M8 is connected and used by the tests.

import { instrumentLines, instrumentModsLines, type ModSpec } from './screens'
import {
  type Chain,
  emptyFx,
  emptyModel,
  emptyStep,
  emptyTableRow,
  type FxCell,
  type Instrument,
  type Phrase,
  type PhraseStep,
  type SongModel,
  type Table,
  TRACKS,
} from './song'

/** Small deterministic generator so the demo (and the tests) are the same every time. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a     = (a + 0x6d2b79f5) >>> 0
    let t = a
    t     = Math.imul(t ^ (t >>> 15), t | 1)
    t     ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']
const noteName   = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

const fx          = (cmd: string, val: number): FxCell => ({ cmd, val })

const INSTRUMENTS : [number, string, string][] = [
  [0x00, 'KICK', 'SAMPLER'],
  [0x01, 'SNARE', 'SAMPLER'],
  [0x02, 'HATS', 'SAMPLER'],
  [0x03, 'SUBBASS', 'MACROSYN'],
  [0x04, 'GLASSPAD', 'HYPERSYN'],
  [0x05, 'LEAD', 'FMSYNTH'],
  [0x06, 'PLUCKARP', 'WAVSYNTH'],
  [0x07, 'NOISEFX', 'MACROSYN'],
  [0x08, 'OPENHAT', 'SAMPLER'],
]

type ModRows = [label: string, value: string][]
const ahd     = (dest: string, amt: string, atk: string, hold: string, dec: string): ModSpec => ({
  type: '00AHD ENV',
  rows: [['DEST', dest], ['AMT', amt], ['ATK', atk], ['HOLD', hold], ['DEC', dec]] as ModRows
})
const adsr    = (dest: string, amt: string, atk: string, dec: string, sus: string, rel: string): ModSpec => ({
  type: '01ADSR ENV',
  rows: [['DEST', dest], ['AMT', amt], ['ATK', atk], ['DEC', dec], ['SUS', sus], ['REL', rel]] as ModRows
})
const drum    = (dest: string, amt: string, peak: string, body: string, dec: string): ModSpec => ({
  type: '02DRUM ENV',
  rows: [['DEST', dest], ['AMT', amt], ['PEAK', peak], ['BODY', body], ['DEC', dec]] as ModRows
})
const lfo     = (dest: string, amt: string, osc: string, trig: string, freq: string): ModSpec => ({
  type: '03LFO',
  rows: [['DEST', dest], ['AMT', amt], ['OSC', osc], ['TRIG', trig], ['FREQ', freq]] as ModRows
})
const trig    = (dest: string, amt: string, atk: string, hold: string, dec: string, src: string): ModSpec => ({
  type: '04TRIG ENV',
  rows: [['DEST', dest], ['AMT', amt], ['ATK', atk], ['HOLD', hold], ['DEC', dec], ['SRC', src]] as ModRows
})
const track   = (dest: string, amt: string, src: string, low: string, high: string): ModSpec => ({
  type: '05TRACKING',
  rows: [['DEST', dest], ['AMT', amt], ['SRC', src], ['LVAL', low], ['HVAL', high]] as ModRows
})
/** An unused slot: the device's default modulator with DEST OFF. */
const unused  = (spec: ModSpec): ModSpec => ({
  ...spec,
  rows: spec.rows.map(([label, value]): [string, string] => (label === 'DEST' ? [label, '00OFF'] : [label, value]))
})
const idleLfo = (): ModSpec => unused(lfo('', 'FF', '00TRI', '00FREE', '10'))
const idleAhd = (): ModSpec => unused(ahd('', 'FF', '00', '00', '80'))

/** Parameters and modulators of the demo instruments (in the layouts the device draws). */
const INSTRUMENT_SOUNDS: Record<number, { values: Record<string, string>; mods: ModSpec[] }> = {
  0: {
    values: {
      AMP   : '30',
      LIM   : '01SIN',
      DRY   : 'D0',
      REV   : '10',
      LENGTH: 'A0',
      FILTER: '01LOWPASS',
      CUTOFF: 'C8',
      RES   : '30'
    },
    mods  : [drum('02PITCH', 'C0', '90', '08', '30'), ahd('01VOLUME', 'FF', '00', '04', '40'), idleLfo(), idleLfo()]
  },
  1: {
    values: {
      AMP    : '18',
      DRY    : 'B0',
      REV    : '48',
      DEL    : '20',
      START  : '08',
      DEGRADE: '18'
    },
    mods  : [ahd('01VOLUME', 'FF', '00', '02', '28'), drum('07CUTOFF', 'A0', '60', '04', '20'), idleLfo(), idleLfo()]
  },
  2: {
    values: {
      DRY   : '90',
      PAN   : '68',
      FILTER: '02HIGHPASS',
      CUTOFF: '70',
      LENGTH: '40'
    },
    mods  : [ahd('01VOLUME', 'FF', '00', '00', '0C'), trig('07CUTOFF', '60', '00', '02', '10', '06WAVSYNTH'), lfo('08RES', '40', '08RANDOM', '00FREE', '02'), idleLfo()]
  },
  3: {
    values: {
      TIMBRE: '40',
      COLOR : '60',
      AMP   : '20',
      LIM   : '04POST',
      FILTER: '01LOWPASS',
      CUTOFF: '48',
      RES   : '58',
      DRY   : 'E0'
    },
    mods  : [adsr('01VOLUME', 'FF', '00', '20', 'C0', '18'), ahd('07CUTOFF', '90', '00', '06', '30'), track('08RES', '50', '00NOTE', '20', 'A0'), lfo('02PITCH', '08', '01SIN', '00FREE', '20')]
  },
  4: {
    values: {
      SWARM : '60',
      WIDTH : 'C0',
      SUBOSC: '40',
      FILTER: '01LOWPASS',
      CUTOFF: '90',
      RES   : '40',
      MFX   : '60',
      DEL   : '50',
      REV   : 'C0'
    },
    mods  : [adsr('01VOLUME', 'FF', '40', '60', 'B0', '80'), lfo('07CUTOFF', '50', '01SIN', '00FREE', '40'), lfo('05PAN', '30', '00TRI', '00FREE', '18'), ahd('10SWARM', '80', '30', '20', 'A0')]
  },
  5: {
    values: {
      ALGO  : '02[A>B+C]>D',
      MOD1  : '70',
      FILTER: '01LOWPASS',
      CUTOFF: 'B0',
      RES   : '30',
      AMP   : '10',
      DEL   : '60',
      REV   : '40'
    },
    mods  : [ahd('01VOLUME', 'CF', '00', '10', '50'), lfo('02PITCH', '10', '01SIN', '01RETRIG', '0C'), adsr('07CUTOFF', 'A0', '04', '30', '60', '20'), idleLfo()]
  },
  6: {
    values: {
      SHAPE : '02PULSE 50%',
      SIZE  : '2A',
      MULT  : '11',
      WARP  : '19',
      FILTER: '01LOWPASS',
      CUTOFF: '40',
      RES   : '90',
      DEL   : 'A0',
      REV   : '30'
    },
    mods  : [ahd('01VOLUME', 'FF', '00', '13', '01'), ahd('07CUTOFF', '7F', '00', '02', '1E'), lfo('11WARP', '60', '03RAMP UP', '01RETRIG', '08'), track('07CUTOFF', '40', '01VELOCITY', '00', 'FF')]
  },
  7: {
    values: {
      SHAPE  : '2BNOISE',
      TIMBRE : 'C0',
      COLOR  : '20',
      DEGRADE: '40',
      REDUX  : '30',
      FILTER : '03BANDPASS',
      CUTOFF : '60',
      RES    : 'C0',
      REV    : 'E0',
      DEL    : '80'
    },
    mods  : [ahd('01VOLUME', 'FF', '60', '20', 'FF'), lfo('07CUTOFF', 'C0', '09DRUNK', '00FREE', '06'), lfo('05PAN', 'FF', '07SQU UP', '00FREE', '04'), idleAhd()]
  },
  8: {
    values: {
      DRY   : 'A0',
      PAN   : '98',
      FILTER: '02HIGHPASS',
      CUTOFF: '90',
      LENGTH: 'C0',
      REV   : '20'
    },
    mods  : [adsr('01VOLUME', 'FF', '00', '30', '60', '30'), idleAhd(), idleLfo(), idleLfo()]
  }
}

export function demoSong(seed = 8): SongModel {
  const rand  = rng(seed)
  const pick  = <T>(items: T[]) => items[Math.floor(rand() * items.length)]
  const model = emptyModel('demo')
  model.name  = 'NEON DRIFT'
  model.tempo = 128

  let nextPhrase  = 0
  let nextChain   = 0
  const addPhrase = (build: (steps: PhraseStep[]) => void): number => {
    const steps = Array.from({ length: 16 }, emptyStep)
    build(steps)
    const phrase             : Phrase = {
      id: nextPhrase,
      steps
    }
    model.phrases[phrase.id] = phrase
    nextPhrase               += 1
    return phrase.id
  }
  const addChain  = (phrases: number[], transpose: number[] = []): number => {
    const chain            : Chain = {
      id  : nextChain,
      rows: Array.from({ length: 16 }, (_, i) => ({
        phrase   : phrases[i] ?? null,
        transpose: phrases[i] != null ? (transpose[i] ?? 0) : 0
      }))
    }
    model.chains[chain.id] = chain
    nextChain              += 1
    return chain.id
  }

  // --- Phrases -----------------------------------------------------------
  const kick      = addPhrase((s) => {
    for (let i = 0; i < 16; i += 4) s[i] = {
      ...emptyStep(),
      note: 'C-4',
      vel : 0x7f,
      inst: 0x00
    }
    s[0].fx[0] = fx('KIL', 0x0c)
  })
  const kickFill  = addPhrase((s) => {
    for (let i = 0; i < 16; i += 4) s[i] = {
      ...emptyStep(),
      note: 'C-4',
      vel : 0x7f,
      inst: 0x00
    }
    s[14] = {
      ...emptyStep(),
      note: 'C-4',
      vel : 0x50,
      inst: 0x00,
      fx  : [fx('RET', 0x23), emptyFx(), emptyFx()]
    }
    s[15] = {
      ...emptyStep(),
      note: 'C-4',
      vel : 0x60,
      fx  : [fx('DEL', 0x03), emptyFx(), emptyFx()]
    }
  })
  const snare     = addPhrase((s) => {
    s[4]  = {
      ...emptyStep(),
      note: 'D-4',
      vel : 0x70,
      inst: 0x01,
      fx  : [fx('SRV', 0x40), emptyFx(), emptyFx()]
    }
    s[12] = {
      ...emptyStep(),
      note: 'D-4',
      vel : 0x74,
      inst: 0x01
    }
  })
  const snareRoll = addPhrase((s) => {
    for (let i = 8; i < 16; i += 1) s[i] = {
      ...emptyStep(),
      note: 'D-4',
      vel : 0x30 + i * 6,
      inst: i === 8 ? 0x01 : null
    }
    s[8].fx[0]  = fx('VOL', 0x20)
    s[9].fx[0]  = fx('REP', 0x04)
    s[15].fx[1] = fx('RET', 0x41)
  })
  const hats      = addPhrase((s) => {
    for (let i = 0; i < 16; i += 2) {
      s[i] = {
        ...emptyStep(),
        note: 'F#4',
        vel : i % 4 === 0 ? 0x60 : 0x38,
        inst: i === 0 ? 0x02 : null
      }
      if (i % 4 === 2) s[i].fx[0] = fx('CHA', 0x8f)
    }
    s[14] = {
      ...emptyStep(),
      note: 'A#4',
      vel : 0x55,
      inst: 0x08,
      fx  : [fx('KIL', 0x06), emptyFx(), emptyFx()]
    }
  })
  const bassRoots = [45, 41, 48, 43]
  const bass      = bassRoots.map((root, k) =>
    addPhrase((s) => {
      const pattern = [0, 3, 6, 8, 10, 14]
      for (const i of pattern) {
        const oct = i === 8 ? 12 : 0
        s[i]      = {
          ...emptyStep(),
          note: noteName(root - 12 + oct),
          vel : 0x68,
          inst: i === 0 ? 0x03 : null
        }
      }
      s[0].fx[0] = fx('TBX', 0x80)
      s[8].fx[0] = fx('PSL', 0x04)
      if (k === 3) s[14].fx[1] = fx('PIT', 0xf4)
      s[6].fx[2] = fx('CUT', 0x30 + k * 8)
    }),
  )
  const chordSets = [
    [57, 60, 64],
    [53, 57, 60],
    [60, 64, 67],
    [55, 59, 62],
  ]
  const pads      = chordSets.map((chord) =>
    addPhrase((s) => {
      s[0]  = {
        ...emptyStep(),
        note: noteName(chord[0]),
        vel : 0x50,
        inst: 0x04,
        fx  : [fx('CRD', 0x37), fx('SDL', 0x30), emptyFx()]
      }
      s[8]  = {
        ...emptyStep(),
        note: noteName(chord[1]),
        vel : 0x48,
        fx  : [fx('CVO', 0x80), emptyFx(), emptyFx()]
      }
      s[15] = {
        ...emptyStep(),
        note: 'OFF'
      }
    }),
  )
  const scale     = [57, 59, 60, 62, 64, 65, 67, 69, 71, 72]
  const leads     = [0, 1, 2].map((k) =>
    addPhrase((s) => {
      let first = true
      for (let i = 0; i < 16; i += pick([1, 2, 2, 3])) {
        if (rand() < 0.25) continue
        s[i] = {
          ...emptyStep(),
          note: noteName(pick(scale) + (k === 2 ? 12 : 0)),
          vel : 0x58 + Math.floor(rand() * 0x20),
          inst: first ? 0x05 : null
        }
        if (rand() < 0.3) s[i].fx[0] = fx(pick(['PVB', 'PSL', 'DEL']), pick([0x22, 0x04, 0x02, 0x48]))
        if (rand() < 0.2) s[i].fx[1] = fx('SDL', 0x50)
        first = false
      }
      s[0].fx[2] = fx('TBL', 0x81)
      // The lead plays in A minor from its second step (key A, scale 01).
      s[1].fx[2] = fx('SCA', 0x91)
    }),
  )
  const arps      = chordSets.map((chord, k) =>
    addPhrase((s) => {
      for (let i = 0; i < 16; i += 4) {
        s[i]       = {
          ...emptyStep(),
          note: noteName(chord[0] + 12),
          vel : 0x40 + (i % 8 === 0 ? 0x18 : 0),
          inst: i === 0 ? 0x06 : null
        }
        s[i].fx[0] = fx('ARP', k % 2 ? 0x47 : 0x37)
      }
      s[0].fx[1] = fx('ARC', 0x12)
      s[0].fx[2] = fx('INS', 0x06)
    }),
  )
  const riser     = addPhrase((s) => {
    s[0]       = {
      ...emptyStep(),
      note: 'C-3',
      vel : 0x30,
      inst: 0x07,
      fx  : [fx('PIT', 0x00), fx('VOL', 0x10), emptyFx()]
    }
    s[1].fx[0] = fx('REP', 0x08)
    s[1].fx[1] = fx('REP', 0x06)
    s[15]      = {
      ...emptyStep(),
      note: 'OFF'
    }
  })
  const impact    = addPhrase((s) => {
    s[0] = {
      ...emptyStep(),
      note: 'C-2',
      vel : 0x7f,
      inst: 0x07,
      fx  : [fx('SRV', 0xc0), fx('KIL', 0x30), emptyFx()]
    }
  })
  const silence   = addPhrase(() => {})

  // --- Chains ------------------------------------------------------------
  const cKick      = addChain([kick, kick, kick, kickFill])
  const cKickIntro = addChain([kick, kick])
  const cSnare     = addChain([snare, snare, snare, snareRoll])
  const cHats      = addChain([hats, hats, hats, hats])
  const cBass      = addChain(bass)
  const cBassUp    = addChain(bass, [0, 0, 5, 5])
  const cPad       = addChain(pads)
  const cLead      = addChain([leads[0], leads[1], leads[0], leads[2]], [0, 0, 0xfe, 0])
  const cArp       = addChain(arps)
  const cRiser     = addChain([silence, silence, riser, riser])
  const cImpact    = addChain([impact, silence, silence, silence])
  const cMute      = addChain([silence])

  // --- Song: intro, verse, build, drop, break, outro ------------------------
  const rows     : (number | null)[][] = [
    [cKickIntro, null, cHats, null, cPad, null, null, cImpact],
    [cKickIntro, null, cHats, null, cPad, null, null, cMute],
    [cKick, cSnare, cHats, cBass, cPad, null, null, null],
    [cKick, cSnare, cHats, cBass, cPad, cLead, null, null],
    [cKick, cSnare, cHats, cBass, cPad, cLead, cArp, null],
    [cKick, cSnare, cHats, cBassUp, cPad, cLead, cArp, cRiser],
    [cKick, cSnare, cHats, cBass, cPad, cLead, cArp, cImpact],
    [cKick, cSnare, cHats, cBassUp, cPad, cLead, cArp, null],
    [null, null, cHats, null, cPad, null, cArp, cRiser],
    [cKick, cSnare, cHats, cBass, cPad, cLead, cArp, cImpact],
    [cKickIntro, null, null, null, cPad, null, null, null],
  ]
  model.song     = rows.map((r) => Array.from({ length: TRACKS }, (_, t) => r[t] ?? null))
  // An isolated idea below the song, the way the manual suggests keeping experiments.
  model.song[13] = [null, null, null, cBassUp, null, cLead, null, null]
  for (let r = 0; r < model.song.length; r += 1) model.song[r] ??= Array(TRACKS).fill(null)

  // --- Instruments and tables ---------------------------------------------------
  for (const [id, name, type] of INSTRUMENTS) {
    const sound           = INSTRUMENT_SOUNDS[id]
    const inst            : Instrument = {
      id,
      name,
      type,
      lines: instrumentLines(id, type, name, sound?.values),
      mods : sound ? instrumentModsLines(id, sound.mods) : undefined
    }
    model.instruments[id] = inst
    const table           : Table = {
      id,
      rows: Array.from({ length: 16 }, emptyTableRow)
    }
    if (type === 'SAMPLER') {
      table.rows[0] = {
        transpose: 0,
        volume   : null,
        fx       : [fx('VOL', 0x00), emptyFx(), emptyFx()]
      }
      table.rows[1] = {
        transpose: 0,
        volume   : null,
        fx       : [fx('VOL', 0xf8), emptyFx(), emptyFx()]
      }
      table.rows[2] = {
        transpose: 0,
        volume   : null,
        fx       : [fx('HOP', 0x01), emptyFx(), emptyFx()]
      }
    } else {
      for (let i = 0; i < 4; i += 1)
        table.rows[i] = {
          transpose: [0, 12, 7, 0][i],
          volume   : null,
          fx       : [fx('PIT', [0, 2, 0xfe, 0][i]), emptyFx(), emptyFx()]
        }
      table.rows[4] = {
        transpose: 0,
        volume   : null,
        fx       : [fx('HOP', 0x00), fx('TIC', 0x02), emptyFx()]
      }
    }
    model.tables[id] = table
  }
  model.tables[0x80] = {
    id  : 0x80,
    rows: Array.from({ length: 16 }, (_, i) =>
      i < 8 ? {
        transpose: 0,
        volume   : null,
        fx       : [fx('CUT', 0x10 + i * 0x10), i === 0 ? fx('TIC', 0x03) : emptyFx(), emptyFx()]
      } : emptyTableRow(),
    )
  }
  model.tables[0x81] = {
    id  : 0x81,
    rows: Array.from({ length: 16 }, (_, i) =>
      i < 3 ? {
        transpose: [0, 12, 0][i],
        volume   : [null, 0x40, null][i],
        fx       : [fx('PVB', 0x24), emptyFx(), emptyFx()]
      } : emptyTableRow(),
    )
  }

  // --- Scales: chromatic for the song, natural minor for the lead (SCA 91) --------
  const scaleOf          = (id: number, name: string, steps: number[]) => ({
    id,
    name,
    key  : 0,
    notes: Array.from({ length: 12 }, (_, i) => ({
      enabled: steps.includes(i),
      offset : steps.includes(i) ? 0 : null
    }))
  })
  model.projectTranspose = 0
  model.projectScale     = 0
  model.projectKey       = 0
  model.scales           = {
    0: scaleOf(0, 'CHROMATIC', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    1: scaleOf(1, 'MINOR', [0, 2, 3, 5, 7, 8, 10])
  }
  return model
}
