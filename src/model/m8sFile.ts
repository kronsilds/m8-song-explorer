// Reads a Dirtywave M8 .m8s song file into the song model: header, project name and tempo, the
// song grid, chains and phrases. Layout checked on two files (fw 6.5.0 and 6.6.2). Instruments
// and the tables of the instruments the song uses, the scales and the grooves it points at are read, and FX command bytes are kept as '?XX' until their
// names are compared with a device. Pure: bytes in, model out.

import { INSTRUMENT_SIZE, readInstrument } from './m8sInstruments'
import { referencedGrooves } from './music/groove'
import { referencedScales } from './music/harmony'
import { noteText } from './music/pitch'
import { type Chain, emptyFx, emptyModel, type FxCell, type Groove, type Instrument, type Phrase, type PhraseStep, ROWS_PER_CHAIN, ROWS_PER_PHRASE, ROWS_PER_TABLE, type Scale, SONG_ROWS, type SongModel, type Table, TRACKS } from './song'

const MAGIC           = 'M8VERSION\0'
const NAME_AT         = 0x94
const NAME_SIZE       = 12
const TRANSPOSE_AT    = 0x8e
const TEMPO_AT        = 0x8f
/** After the 27 MIDI settings bytes that start at 0xA0: key (high nibble) and scale (low nibble), then the groove. Checked on a file saved with SCALE 2, KEY D, GROOVE 5. */
const KEY_SCALE_AT    = 0xbb
const GROOVE_AT       = 0xbc
/** One byte per groove, an index into 24, 48, 96, 192 ticks per quarter note (groove 5 set to 48 changed byte 0x1B6AB). */
const GROOVE_PPQ_AT   = 0x1b6a6
const PPQS            = [24, 48, 96, 192]
const SONG_AT         = 0x2ee
const PHRASES_AT      = 0xaee
const STEP_SIZE       = 9
const PHRASE_SIZE     = ROWS_PER_PHRASE * STEP_SIZE
const SLOTS           = 255
const CHAINS_AT       = PHRASES_AT + SLOTS * PHRASE_SIZE
const CHAIN_ROW_SIZE  = 2
const CHAIN_SIZE      = ROWS_PER_CHAIN * CHAIN_ROW_SIZE
const FILE_END        = CHAINS_AT + SLOTS * CHAIN_SIZE
const TABLE_ROW_SIZE  = 8
const TABLE_SIZE      = ROWS_PER_TABLE * TABLE_ROW_SIZE
const TABLES_AT       = FILE_END
const TABLES_SIZE     = 256 * TABLE_SIZE
const INSTRUMENTS_AT  = TABLES_AT + TABLES_SIZE
const GROOVES_AT      = 0xee
const GROOVE_SIZE     = 16
const SCALES_AT       = INSTRUMENTS_AT + 128 * INSTRUMENT_SIZE + 0x4c0
const SCALE_SIZE      = 46
const SCALE_COUNT     = 16
const SCALE_NAME_AT   = 26
const SCALE_NAME_SIZE = 16
const EMPTY           = 0xff
const NOTE_OFF        = 0x80
/** Files count octaves from 0 where the M8 screen starts at 1: file note 0x24 shows as C-4. */
const NOTE_BASE       = 12

export const isM8sFile = (bytes: Uint8Array): boolean => MAGIC.split('').every((char, index) => bytes[index] === char.charCodeAt(0))

const orNull = (byte: number): number | null => (byte === EMPTY ? null : byte)

/**
 * Sequencer command ids of fw 6.5.0 and 6.6.2 (the same song saved on both gave the same ids), in file order. Checked against a device exploration at 00 ARP,
 * 08 RET, 0D PBN and 13 SNG; the ones between follow the manual's order. Higher ids (TBL and up,
 * and the instrument commands from 20) are not known yet, and 6.6 numbers differently.
 */
const FX_NAMES_65 = ['ARP', 'CHA', 'DEL', 'GRV', 'HOP', 'KIL', 'RND', 'RNL', 'RET', 'REP', 'RMX', 'NTH', 'PSL', 'PBN', 'PVB', 'PVX', 'SCA', 'SCG', 'SED', 'SNG']

/** Table-only ids and instrument commands (from 0x80, they depend on the instrument type); only the ones seen on a device are named. */
const TABLE_FX     : Record<number, string> = {
  21: 'THO',
  22: 'TIC'
}
const INSTRUMENT_FX: Record<string, Record<number, string>> = {
  WAVSYNTH: {
    129: 'PIT',
    130: 'FIN',
    131: 'OSC',
    159: 'LF3',
    160: 'LT3'
  },
  FMSYNTH : { 132: 'FM1' }
}

function readFx(bytes: Uint8Array, at: number, names: readonly string[]): FxCell {
  if (bytes[at] === EMPTY) return emptyFx()
  return {
    cmd: names[bytes[at]] ?? `?${bytes[at].toString(16).toUpperCase().padStart(2, '0')}`,
    val: bytes[at + 1]
  }
}

function readStep(bytes: Uint8Array, at: number, names: readonly string[]): PhraseStep {
  const note = bytes[at]
  return {
    note: note === EMPTY ? null : note === NOTE_OFF ? 'OFF' : note < NOTE_OFF ? noteText(note + NOTE_BASE) : null,
    vel : orNull(bytes[at + 1]),
    inst: orNull(bytes[at + 2]),
    fx  : [0, 1, 2].map((lane) => readFx(bytes, at + 3 + lane * 2, names))
  }
}

/** A table: per row a transpose byte, a volume byte (FF = none) and three FX pairs. */
function readTable(bytes: Uint8Array, id: number, names: readonly string[], type: string | null): Table {
  const typeNames = INSTRUMENT_FX[type ?? ''] ?? {}
  return {
    id,
    rows: Array.from({ length: ROWS_PER_TABLE }, (_, row) => {
      const at = TABLES_AT + id * TABLE_SIZE + row * TABLE_ROW_SIZE
      return {
        transpose: bytes[at],
        volume   : orNull(bytes[at + 1]),
        fx       : [0, 1, 2].map((lane): FxCell => {
          const cmd = bytes[at + 2 + lane * 2]
          const fx  = readFx(bytes, at + 2 + lane * 2, names)
          return cmd === EMPTY ? fx : {
            cmd: TABLE_FX[cmd] ?? typeNames[cmd] ?? fx.cmd,
            val: fx.val
          }
        })
      }
    })
  }
}

/** A groove: 16 tick counts as the Groove view shows them at its PPQ, FF where the groove loops. */
const readGroove = (bytes: Uint8Array, id: number): Groove => ({
  id,
  ticks: Array.from({ length: 16 }, (_, step) => orNull(bytes[GROOVES_AT + id * GROOVE_SIZE + step])),
  ppq  : PPQS[bytes[GROOVE_PPQ_AT + id]] ?? null
})

/**
 * A scale: a 12-bit mask of the enabled intervals (bit 0 = the key), 12 offset pairs, the name.
 * Each note's offset is a signed 16-bit little-endian count of hundredths of a semitone (+1.50 is 96 00, -24.00 is A0 F6).
 */
function readScale(bytes: Uint8Array, id: number, key: number | null): Scale {
  const at   = SCALES_AT + id * SCALE_SIZE
  const mask = bytes[at] | (bytes[at + 1] << 8)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const name = String.fromCharCode(...bytes.subarray(at + SCALE_NAME_AT, at + SCALE_NAME_AT + SCALE_NAME_SIZE).filter((byte) => byte !== 0 && byte !== EMPTY)).trim()
  return {
    id,
    name : name || null,
    notes: Array.from({ length: 12 }, (_, note) => ({
      enabled: (mask & (1 << note)) !== 0,
      offset : view.getInt16(at + 2 + note * 2, true) / 100
    })),
    key
  }
}

/** Scales Hypersynth instruments pick with their SCALE parameter (00 uses the song scale). */
function hyperScales(instruments: Record<number, Instrument>): number[] {
  const ids: number[] = []
  for (const instrument of Object.values(instruments)) {
    if (instrument.type !== 'HYPERSYN') continue
    const id = instrument.lines.map((line) => /^SCALEs+([0-9A-F]{2})/i.exec(line)?.[1]).find(Boolean)
    if (id && Number.parseInt(id, 16) > 0) ids.push(Number.parseInt(id, 16) & 0x0f)
  }
  return ids
}

/** The song in a .m8s file; null when the bytes are not one or are cut short. */
export function readM8sFile(bytes: Uint8Array): SongModel | null {
  if (!isM8sFile(bytes) || bytes.length < FILE_END) return null
  const view             = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const model            = emptyModel('file')
  const name             = new TextDecoder('latin1').decode(bytes.subarray(NAME_AT, NAME_AT + NAME_SIZE)).replace(/\0.*$/, '').trim()
  const major            = bytes[11]
  const minor            = bytes[10] >> 4
  const patch            = bytes[10] & 15
  model.name             = name || null
  model.tempo            = Math.round(view.getFloat32(TEMPO_AT, true) * 100) / 100
  model.projectTranspose = bytes[TRANSPOSE_AT]
  model.projectKey       = bytes[KEY_SCALE_AT] >> 4 < 12 ? bytes[KEY_SCALE_AT] >> 4 : null
  model.projectScale     = bytes[KEY_SCALE_AT] & 15
  model.projectGroove    = bytes[GROOVE_AT] < 32 ? bytes[GROOVE_AT] : null

  let lastRow = -1
  const rows  : (number | null)[][] = []
  for (let row = 0; row < SONG_ROWS; row += 1) {
    const cells = Array.from({ length: TRACKS }, (_, track) => orNull(bytes[SONG_AT + row * TRACKS + track]))
    rows.push(cells)
    if (cells.some((cell) => cell != null)) lastRow = row
  }
  model.song = rows.slice(0, lastRow + 1)

  // Like an exploration, only the chains the song uses and the phrases those chains use.
  const names   = major === 6 && minor <= 6 ? FX_NAMES_65 : []
  const chains  : Record<number, Chain>   = {}
  const phrases : Record<number, Phrase> = {}
  for (const id of new Set(model.song.flat().filter((cell): cell is number => cell != null && cell < SLOTS))) {
    const chainRows = Array.from({ length: ROWS_PER_CHAIN }, (_, row) => {
      const at = CHAINS_AT + id * CHAIN_SIZE + row * CHAIN_ROW_SIZE
      return {
        phrase   : orNull(bytes[at]),
        transpose: bytes[at + 1]
      }
    })
    chains[id]      = {
      id,
      rows: chainRows
    }
    for (const { phrase } of chainRows) {
      if (phrase == null || phrase >= SLOTS || phrases[phrase]) continue
      phrases[phrase] = {
        id   : phrase,
        steps: Array.from({ length: ROWS_PER_PHRASE }, (_, step) => readStep(bytes, PHRASES_AT + phrase * PHRASE_SIZE + step * STEP_SIZE, names))
      }
    }
  }
  const instruments: Record<number, Instrument> = {}
  if (bytes.length >= INSTRUMENTS_AT + 128 * INSTRUMENT_SIZE) {
    const used = new Set(Object.values(phrases).flatMap((phrase) => phrase.steps.map((step) => step.inst)))
    for (const id of used) {
      const instrument = id != null && id < 128 ? readInstrument(bytes, id, INSTRUMENTS_AT) : null
      if (instrument) instruments[instrument.id] = instrument
    }
  }
  // The exploration reads the table of each used instrument (same number); tables only reached through TBL / TBX are not found.
  const tables: Record<number, Table> = {}
  if (bytes.length >= INSTRUMENTS_AT) {
    for (const instrument of Object.values(instruments)) tables[instrument.id] = readTable(bytes, instrument.id, names, instrument.type)
  }
  model.chains      = chains
  model.phrases     = phrases
  model.instruments = instruments
  model.tables      = tables
  if (bytes.length >= SCALES_AT + SCALE_COUNT * SCALE_SIZE) {
    // The same scales and grooves an exploration reads: the project's, the ones SCA / SCG / GRV point at and Hypersynth SCALE picks.
    const scaleIds = new Set([model.projectScale ?? 0, ...referencedScales(model), ...hyperScales(instruments)])
    model.scales   = Object.fromEntries([...scaleIds].filter((id) => id < SCALE_COUNT).sort((a, b) => a - b).map((id) => [id, readScale(bytes, id, model.projectKey ?? null)]))
    model.grooves  = Object.fromEntries(referencedGrooves(model).filter((id) => id < 32).map((id) => [id, readGroove(bytes, id)]))
  }
  model.warnings    = [
    `Read from a .m8s file (firmware ${major}.${minor}.${patch}): tables only reached through TBL/TBX and the Sampler, MIDI OUT and External instruments' sample, bank and program settings are not read from files yet, instrument values show their hex when the name is not known, and FX commands above 13 show as ?XX.`
  ]
  return model
}
