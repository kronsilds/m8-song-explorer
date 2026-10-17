// A made-up song with the shape of a real one (sections, shared chains, tables, TBX/INS
// references), shown when no M8 is connected and used by the tests.

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
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']
const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

const fx = (cmd: string, val: number): FxCell => ({ cmd, val })

const INSTRUMENTS: [number, string, string][] = [
  [0x00, 'KICK', 'SAMPLER'],
  [0x01, 'SNARE', 'SAMPLER'],
  [0x02, 'HATS', 'SAMPLER'],
  [0x03, 'SUBBASS', 'MACROSYN'],
  [0x04, 'GLASSPAD', 'HYPERSYNTH'],
  [0x05, 'LEAD', 'FMSYNTH'],
  [0x06, 'PLUCKARP', 'WAVSYNTH'],
  [0x07, 'NOISEFX', 'MACROSYN'],
  [0x08, 'OPENHAT', 'SAMPLER'],
]

export function demoSong(seed = 8): SongModel {
  const rand = rng(seed)
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]
  const model = emptyModel('demo')
  model.name = 'NEON DRIFT'
  model.tempo = 128

  let nextPhrase = 0
  let nextChain = 0
  const addPhrase = (build: (steps: PhraseStep[]) => void): number => {
    const steps = Array.from({ length: 16 }, emptyStep)
    build(steps)
    const phrase: Phrase = { id: nextPhrase, steps }
    model.phrases[phrase.id] = phrase
    nextPhrase += 1
    return phrase.id
  }
  const addChain = (phrases: number[], transpose: number[] = []): number => {
    const chain: Chain = {
      id: nextChain,
      rows: Array.from({ length: 16 }, (_, i) => ({ phrase: phrases[i] ?? null, transpose: phrases[i] != null ? (transpose[i] ?? 0) : 0 })),
    }
    model.chains[chain.id] = chain
    nextChain += 1
    return chain.id
  }

  // --- Phrases -----------------------------------------------------------
  const kick = addPhrase((s) => {
    for (let i = 0; i < 16; i += 4) s[i] = { ...emptyStep(), note: 'C-4', vel: 0x7f, inst: 0x00 }
    s[0].fx[0] = fx('KIL', 0x0c)
  })
  const kickFill = addPhrase((s) => {
    for (let i = 0; i < 16; i += 4) s[i] = { ...emptyStep(), note: 'C-4', vel: 0x7f, inst: 0x00 }
    s[14] = { ...emptyStep(), note: 'C-4', vel: 0x50, inst: 0x00, fx: [fx('RET', 0x23), emptyFx(), emptyFx()] }
    s[15] = { ...emptyStep(), note: 'C-4', vel: 0x60, fx: [fx('DEL', 0x03), emptyFx(), emptyFx()] }
  })
  const snare = addPhrase((s) => {
    s[4] = { ...emptyStep(), note: 'D-4', vel: 0x70, inst: 0x01, fx: [fx('SRV', 0x40), emptyFx(), emptyFx()] }
    s[12] = { ...emptyStep(), note: 'D-4', vel: 0x74, inst: 0x01 }
  })
  const snareRoll = addPhrase((s) => {
    for (let i = 8; i < 16; i += 1) s[i] = { ...emptyStep(), note: 'D-4', vel: 0x30 + i * 6, inst: i === 8 ? 0x01 : null }
    s[8].fx[0] = fx('VOL', 0x20)
    s[9].fx[0] = fx('REP', 0x04)
    s[15].fx[1] = fx('RET', 0x41)
  })
  const hats = addPhrase((s) => {
    for (let i = 0; i < 16; i += 2) {
      s[i] = { ...emptyStep(), note: 'F#4', vel: i % 4 === 0 ? 0x60 : 0x38, inst: i === 0 ? 0x02 : null }
      if (i % 4 === 2) s[i].fx[0] = fx('CHA', 0x8f)
    }
    s[14] = { ...emptyStep(), note: 'A#4', vel: 0x55, inst: 0x08, fx: [fx('KIL', 0x06), emptyFx(), emptyFx()] }
  })
  const bassRoots = [45, 41, 48, 43]
  const bass = bassRoots.map((root, k) =>
    addPhrase((s) => {
      const pattern = [0, 3, 6, 8, 10, 14]
      for (const i of pattern) {
        const oct = i === 8 ? 12 : 0
        s[i] = { ...emptyStep(), note: noteName(root - 12 + oct), vel: 0x68, inst: i === 0 ? 0x03 : null }
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
  const pads = chordSets.map((chord) =>
    addPhrase((s) => {
      s[0] = { ...emptyStep(), note: noteName(chord[0]), vel: 0x50, inst: 0x04, fx: [fx('CRD', 0x37), fx('SDL', 0x30), emptyFx()] }
      s[8] = { ...emptyStep(), note: noteName(chord[1]), vel: 0x48, fx: [fx('CVO', 0x80), emptyFx(), emptyFx()] }
      s[15] = { ...emptyStep(), note: 'OFF' }
    }),
  )
  const scale = [57, 59, 60, 62, 64, 65, 67, 69, 71, 72]
  const leads = [0, 1, 2].map((k) =>
    addPhrase((s) => {
      let first = true
      for (let i = 0; i < 16; i += pick([1, 2, 2, 3])) {
        if (rand() < 0.25) continue
        s[i] = { ...emptyStep(), note: noteName(pick(scale) + (k === 2 ? 12 : 0)), vel: 0x58 + Math.floor(rand() * 0x20), inst: first ? 0x05 : null }
        if (rand() < 0.3) s[i].fx[0] = fx(pick(['PVB', 'PSL', 'DEL']), pick([0x22, 0x04, 0x02, 0x48]))
        if (rand() < 0.2) s[i].fx[1] = fx('SDL', 0x50)
        first = false
      }
      s[0].fx[2] = fx('TBL', 0x81)
      // The lead plays in A minor from its second step (key A, scale 01).
      s[1].fx[2] = fx('SCA', 0x91)
    }),
  )
  const arps = chordSets.map((chord, k) =>
    addPhrase((s) => {
      for (let i = 0; i < 16; i += 4) {
        s[i] = { ...emptyStep(), note: noteName(chord[0] + 12), vel: 0x40 + (i % 8 === 0 ? 0x18 : 0), inst: i === 0 ? 0x06 : null }
        s[i].fx[0] = fx('ARP', k % 2 ? 0x47 : 0x37)
      }
      s[0].fx[1] = fx('ARC', 0x12)
      s[0].fx[2] = fx('INS', 0x06)
    }),
  )
  const riser = addPhrase((s) => {
    s[0] = { ...emptyStep(), note: 'C-3', vel: 0x30, inst: 0x07, fx: [fx('PIT', 0x00), fx('VOL', 0x10), emptyFx()] }
    s[1].fx[0] = fx('REP', 0x08)
    s[1].fx[1] = fx('REP', 0x06)
    s[15] = { ...emptyStep(), note: 'OFF' }
  })
  const impact = addPhrase((s) => {
    s[0] = { ...emptyStep(), note: 'C-2', vel: 0x7f, inst: 0x07, fx: [fx('SRV', 0xc0), fx('KIL', 0x30), emptyFx()] }
  })
  const silence = addPhrase(() => {})

  // --- Chains ------------------------------------------------------------
  const cKick = addChain([kick, kick, kick, kickFill])
  const cKickIntro = addChain([kick, kick])
  const cSnare = addChain([snare, snare, snare, snareRoll])
  const cHats = addChain([hats, hats, hats, hats])
  const cBass = addChain(bass)
  const cBassUp = addChain(bass, [0, 0, 5, 5])
  const cPad = addChain(pads)
  const cLead = addChain([leads[0], leads[1], leads[0], leads[2]], [0, 0, 0xfe, 0])
  const cArp = addChain(arps)
  const cRiser = addChain([silence, silence, riser, riser])
  const cImpact = addChain([impact, silence, silence, silence])
  const cMute = addChain([silence])

  // --- Song: intro, verse, build, drop, break, outro ------------------------
  const rows: (number | null)[][] = [
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
  model.song = rows.map((r) => Array.from({ length: TRACKS }, (_, t) => r[t] ?? null))
  // An isolated idea below the song, the way the manual suggests keeping experiments.
  model.song[13] = [null, null, null, cBassUp, null, cLead, null, null]
  for (let r = 0; r < model.song.length; r += 1) model.song[r] ??= Array(TRACKS).fill(null)

  // --- Instruments and tables ---------------------------------------------------
  for (const [id, name, type] of INSTRUMENTS) {
    const inst: Instrument = { id, name, type, lines: [] }
    model.instruments[id] = inst
    const table: Table = { id, rows: Array.from({ length: 16 }, emptyTableRow) }
    if (type === 'SAMPLER') {
      table.rows[0] = { transpose: 0, volume: null, fx: [fx('VOL', 0x00), emptyFx(), emptyFx()] }
      table.rows[1] = { transpose: 0, volume: null, fx: [fx('VOL', 0xf8), emptyFx(), emptyFx()] }
      table.rows[2] = { transpose: 0, volume: null, fx: [fx('HOP', 0x01), emptyFx(), emptyFx()] }
    } else {
      for (let i = 0; i < 4; i += 1) table.rows[i] = { transpose: [0, 12, 7, 0][i], volume: null, fx: [fx('PIT', [0, 2, 0xfe, 0][i]), emptyFx(), emptyFx()] }
      table.rows[4] = { transpose: 0, volume: null, fx: [fx('HOP', 0x00), fx('TIC', 0x02), emptyFx()] }
    }
    model.tables[id] = table
  }
  model.tables[0x80] = {
    id: 0x80,
    rows: Array.from({ length: 16 }, (_, i) =>
      i < 8 ? { transpose: 0, volume: null, fx: [fx('CUT', 0x10 + i * 0x10), i === 0 ? fx('TIC', 0x03) : emptyFx(), emptyFx()] } : emptyTableRow(),
    ),
  }
  model.tables[0x81] = {
    id: 0x81,
    rows: Array.from({ length: 16 }, (_, i) =>
      i < 3 ? { transpose: [0, 12, 0][i], volume: [null, 0x40, null][i], fx: [fx('PVB', 0x24), emptyFx(), emptyFx()] } : emptyTableRow(),
    ),
  }

  // --- Scales: chromatic for the song, natural minor for the lead (SCA 91) --------
  const scaleOf = (id: number, name: string, steps: number[]) => ({
    id,
    name,
    key: 0,
    notes: Array.from({ length: 12 }, (_, i) => ({ enabled: steps.includes(i), offset: steps.includes(i) ? 0 : null })),
  })
  model.projectTranspose = 0
  model.projectScale = 0
  model.projectKey = 0
  model.scales = {
    0: scaleOf(0, 'CHROMATIC', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    1: scaleOf(1, 'MINOR', [0, 2, 3, 5, 7, 8, 10]),
  }
  return model
}
