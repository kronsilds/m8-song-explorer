// Reads a Dirtywave M8 .m8s song file into the song model: header, project name and tempo, the
// song grid, chains and phrases. Layout checked on files saved by fw 6.5.0 and 6.6.2. Like a device
// exploration it also reads the instruments the song uses, their tables and the tables TBL / TBX
// point at, and the scales and grooves it points at. FX commands are named by m8sFx.ts.
// Pure: bytes in, model out.

import { fxName } from './m8sFx'
import { INSTRUMENT_SIZE, readInstrument } from './m8sInstruments'
import { referencedGrooves } from './music/groove'
import { referencedScales } from './music/harmony'
import { noteText } from './music/pitch'
import { type Chain, emptyFx, emptyModel, type FxCell, type Groove, type Instrument, type Phrase, type PhraseStep, ROWS_PER_CHAIN, ROWS_PER_PHRASE, ROWS_PER_TABLE, referencedTables, type Scale, SONG_ROWS, type SongModel, type Table, TRACKS, usedItems } from './song'

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

/** Names a command byte for the instrument that plays it (null when none is known). */
type FxNamer = (cmd: number, instrument: number | null) => string

function readFx(bytes: Uint8Array, at: number, name: FxNamer, instrument: number | null): FxCell {
  if (bytes[at] === EMPTY) return emptyFx()
  return {
    cmd: name(bytes[at], instrument),
    val: bytes[at + 1]
  }
}

/**
 * A phrase. Instrument commands are named after the instrument of their step, else the last one
 * above it in the phrase, else the first one below (an assumption: the M8 names them after the
 * instrument the track plays).
 */
function readPhrase(bytes: Uint8Array, id: number, name: FxNamer): Phrase {
  const at    = PHRASES_AT + id * PHRASE_SIZE
  const insts = Array.from({ length: ROWS_PER_PHRASE }, (_, step) => orNull(bytes[at + step * STEP_SIZE + 2]))
  let playing = insts.find((inst) => inst != null) ?? null
  return {
    id,
    steps: insts.map((inst, step): PhraseStep => {
      const start = at + step * STEP_SIZE
      const note  = bytes[start]
      playing     = inst ?? playing
      return {
        note: note === EMPTY ? null : note === NOTE_OFF ? 'OFF' : note < NOTE_OFF ? noteText(note + NOTE_BASE) : null,
        vel : orNull(bytes[start + 1]),
        inst,
        fx  : [0, 1, 2].map((lane) => readFx(bytes, start + 3 + lane * 2, name, playing))
      }
    })
  }
}

/** For each table a phrase's TBL / TBX points at, the instrument playing that step (as in readPhrase). */
function tableInstruments(phrases: Record<number, Phrase>): Map<number, number> {
  const owners = new Map<number, number>()
  for (const phrase of Object.values(phrases)) {
    let playing = phrase.steps.find((step) => step.inst != null)?.inst ?? null
    for (const step of phrase.steps) {
      playing = step.inst ?? playing
      for (const table of referencedTables(step.fx)) if (playing != null && !owners.has(table)) owners.set(table, playing)
    }
  }
  return owners
}

/** A table: per row a transpose byte, a volume byte (FF = none) and three FX pairs, named for `instrument`. */
function readTable(bytes: Uint8Array, id: number, name: FxNamer, instrument: number | null): Table {
  return {
    id,
    rows: Array.from({ length: ROWS_PER_TABLE }, (_, row) => {
      const at = TABLES_AT + id * TABLE_SIZE + row * TABLE_ROW_SIZE
      return {
        transpose: bytes[at],
        volume   : orNull(bytes[at + 1]),
        fx       : [0, 1, 2].map((lane) => readFx(bytes, at + 2 + lane * 2, name, instrument))
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
    const id = instrument.lines.map((line) => /^SCALE\s+([0-9A-F]{2})/i.exec(line)?.[1]).find(Boolean)
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
  // Command ids were read from fw 6.6.2 files; the 6.5.0 sample agrees on every command it uses.
  const hasInstruments = bytes.length >= INSTRUMENTS_AT + 128 * INSTRUMENT_SIZE
  const fxNamer        : FxNamer = (cmd, instrument) => (major === 6 ? fxName(bytes, cmd, INSTRUMENTS_AT, hasInstruments ? instrument : null) : `?${cmd.toString(16).toUpperCase().padStart(2, '0')}`)
  const chains         : Record<number, Chain>   = {}
  const phrases        : Record<number, Phrase> = {}
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
      phrases[phrase] = readPhrase(bytes, phrase, fxNamer)
    }
  }
  model.chains      = chains
  model.phrases     = phrases
  // As the exploration: the instruments the phrases play or INS picks, the table of each (same
  // number), then the tables TBL / TBX point at, named after the instrument playing the TBL / TBX
  // step (else the instrument of the same number).
  const instruments : Record<number, Instrument> = {}
  const tables      : Record<number, Table>      = {}
  model.instruments = instruments
  model.tables      = tables
  if (hasInstruments) {
    for (const id of usedItems(model).instruments) {
      const instrument = id < 128 ? readInstrument(bytes, id, INSTRUMENTS_AT) : null
      if (instrument) instruments[instrument.id] = instrument
    }
    for (const instrument of Object.values(instruments)) tables[instrument.id] = readTable(bytes, instrument.id, fxNamer, instrument.id)
    const owners = tableInstruments(phrases)
    for (const id of usedItems(model).tables) {
      if (!tables[id] && id < 256) tables[id] = readTable(bytes, id, fxNamer, owners.get(id) ?? (id < 128 ? id : null))
    }
  }
  if (bytes.length >= SCALES_AT + SCALE_COUNT * SCALE_SIZE) {
    // The same scales and grooves an exploration reads: the project's, the ones SCA / SCG / GRV point at and Hypersynth SCALE picks.
    const scaleIds = new Set([model.projectScale ?? 0, ...referencedScales(model), ...hyperScales(instruments)])
    model.scales   = Object.fromEntries([...scaleIds].filter((id) => id < SCALE_COUNT).sort((a, b) => a - b).map((id) => [id, readScale(bytes, id, model.projectKey ?? null)]))
    model.grooves  = Object.fromEntries(referencedGrooves(model).filter((id) => id < 32).map((id) => [id, readGroove(bytes, id)]))
  }
  model.warnings    = [
    `Read from a .m8s file (firmware ${major}.${minor}.${patch}): the Sampler, MIDI OUT and External instruments' sample, bank and program settings are not read from files yet, instrument values show their hex when the name is not known, and FX commands with an unknown id show as ?XX.`
  ]
  return model
}
