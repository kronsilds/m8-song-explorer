// What a selected cell means: the SDK's technical reading, adapted for the panel. The cell is drawn on a
// screen the way the M8 draws it and the SDK reads it as if the device cursor were on it, so FX values,
// REP lanes, relative commands and ARP intervals keep their device meaning.

import { getSemanticContext, type M8DescriptionPart, type M8State, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X, fxLaneOf, phraseColumnX, tableColumnX } from '../model/columns'
import type { CellDescription, Fact } from '../model/description'
import { hex2, hexDigit } from '../model/hex'
import { cellAt, type InstrumentCell, type InstrumentScreen, instrumentPage, type ModSlot, modulatorsOf, tableTicOf } from '../model/instrumentPage'
import { modSummary } from '../model/modShapes'
import {
  analyzePhrase,
  degreeOf,
  formatTranspose,
  keyName,
  ordinal,
  type PhraseHarmony,
  pitchList,
  playedNote,
  type ScaleMap,
  scaleLabel,
  scalePitches,
  transposeSemitones,
} from '../model/music/harmony'
import { chordBankAt, chordFacts, chordOfBank, chordOverNoteFacts, hypersynthSettings, scaleShapeOf } from '../model/music/hypersynthChord'
import { noteNumber, PITCH_NAMES, pitchClass } from '../model/music/pitch'
import { type RepRow, repeatLanes, repeatText } from '../model/music/repeats'
import { DEFAULT_TIC } from '../model/music/tablePlayback'
import {
  arpeggioText,
  chordName,
  describeWalk,
  intervalsText,
  playedRows,
  type TableUse,
  tableUses,
  ticText,
  walkTable
} from '../model/music/tableWalk'
import { chainScreen, FIRST_CONTENT_ROW, phraseScreen, SCREEN_HEIGHT, SCREEN_WIDTH, storedScreen, TITLE_ROW, tableScreen } from '../model/screens'
import type { Selection } from '../model/selection'
import { emptyTable, type FxCell, type SongModel, type Table } from '../model/song'
import { effectiveInstrumentAt, type SongContext } from '../model/songContext'
import type { PhraseInstance } from '../model/timeline'
import { selectionParts } from './selectionCopy'

type StepSelection = Extract<Selection, { kind: 'step' }>
type ChainSelection = Extract<Selection, { kind: 'chain' }>
type TableSelection = Extract<Selection, { kind: 'table' }>
type InstrumentSelection = Extract<Selection, { kind: 'instrument' }>
type InstParamSelection = Extract<Selection, { kind: 'instParam' }>

/** What a selected cell means, in the song `song` (a step's instrument is the one it plays, see effectiveInstrumentAt). */
export function describeSelection(song: SongContext, selection: Selection): CellDescription {
  const { model } = song
  switch (selection.kind) {
    case 'step':
      return new PhraseCellDescriber(model, selection, song.scales, repeatLanes(song).get(selection.instance.key)).describe(effectiveInstrumentAt(song, selection.instance.key, selection.step))
    case 'chain':
      return new PhraseCellDescriber(model, selection, song.scales, undefined).describe(null)
    case 'table':
      return describeTableCell(model, selection, song)
    case 'instrument':
      return describeInstrumentPanel(model, selection)
    case 'instParam':
      return describeInstrumentCell(model, selection)
  }
}

// ---------------------------------------------------------------------------
// The SDK's reading of a cell

/** The device state the SDK would report with the cursor on screen cell (x, y). */
function stateWithCursorAt(viewName: string, title: string, lines: string[], x: number, y: number, width: number): M8State {
  const line = lines[y] ?? ''
  return {
    viewName,
    viewTitle      : title,
    minimapKey     : null,
    cursorPos      : { x, y },
    cursorRect     : null,
    selectionMode  : false,
    highlightColor : null,
    titleColor     : null,
    backgroundColor: null,
    cursorColor    : null,
    textUnderCursor: line.slice(x, x + width).trim() || null,
    currentLine    : line.trim() || null,
    deviceModel    : null,
    fontMode       : 0,
    systemInfo     : null,
    macroRunning   : false
  }
}

/** What the SDK says about the cell at schema x on content row `row` of a drawn screen. */
function sdkParts(viewName: string, title: string, lines: string[], x: number, row: number, width: number): M8DescriptionPart[] {
  const state   = stateWithCursorAt(viewName, title, lines, x + SCREEN_MARGIN, FIRST_CONTENT_ROW + row, width)
  const context = getSemanticContext(state, {
    width : SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    lines
  })
  return context ? selectionParts(context) : []
}

// ---------------------------------------------------------------------------
// Labels

function instrumentLabel(model: SongModel, id: number | null): string {
  if (id == null) return '--'
  const instrument = model.instruments[id]
  return [hex2(id), instrument?.name, instrument?.type].filter(Boolean).join(' · ')
}

const fxTitle = (lane: number, fx: FxCell | null | undefined): string => `FX${lane + 1} · ${fx?.cmd ?? '---'} ${hex2(fx?.val ?? null, '00')}`

const plural       = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const semitoneText = (value: number): string => `${formatTranspose(value)} ${Math.abs(value) === 1 ? 'semitone' : 'semitones'}`

// ---------------------------------------------------------------------------
// Phrase steps and chain rows

/** A step or chain row as played at one place of the song: its transposes, scale and key. */
class PhraseCellDescriber {
  private readonly instance         : PhraseInstance
  private readonly chainTransposeRaw: number
  private readonly chainSemitones   : number
  private readonly projectSemitones : number
  private readonly harmony          : PhraseHarmony
  private readonly facts            : Fact[] = []

  constructor(
    private readonly model: SongModel,
    private readonly selection: StepSelection | ChainSelection,
    private readonly scales: ScaleMap,
    /** REP state per FX lane and step of the phrase here (what the previous phrase hands over included). */
    private readonly repeats: RepRow[][] | undefined,
  ) {
    this.instance          = selection.instance
    this.chainTransposeRaw = model.chains[this.instance.chain]?.rows[this.instance.chainRow]?.transpose ?? 0
    this.chainSemitones    = transposeSemitones(this.chainTransposeRaw)
    this.projectSemitones  = transposeSemitones(model.projectTranspose)
    this.harmony           = analyzePhrase(this.phrase?.steps)
  }

  private get phrase() {
    return this.model.phrases[this.instance.phrase]
  }

  private get transposed(): boolean {
    return this.chainSemitones !== 0 || this.projectSemitones !== 0
  }

  describe(effectiveInstrument: number | null): CellDescription {
    const { instance, model } = this
    const path                = [
      `Song row ${hex2(instance.songRow)}`,
      `Track ${instance.track + 1}`,
      `Chain ${hex2(instance.chain)} row ${hexDigit(instance.chainRow)}`,
      `Phrase ${hex2(instance.phrase)}`,
    ]
    // The phrase's usage, scale and transposes say nothing about a velocity, instrument or FX cell.
    if (this.selection.kind === 'chain' || this.selection.column === 'note') this.addPhraseFacts()
    if (this.selection.kind === 'chain') {
      const chain = model.chains[instance.chain]
      const parts = chain ? sdkParts('chain', `CHAIN ${hex2(chain.id)}`, chainScreen(chain), COLUMN_X.chain.phrase, instance.chainRow, 2) : []
      return {
        path,
        title: `Chain ${hex2(instance.chain)} › Phrase ${hex2(instance.phrase)}`,
        parts,
        facts: this.facts
      }
    }
    return this.describeStep(this.selection, path, effectiveInstrument)
  }

  /** Uses, track scale, the notes and the transposes of the phrase. */
  private addPhraseFacts(): void {
    const { instance, model, harmony, facts } = this
    const uses                                = Object.values(model.chains).filter((chain) => chain.rows.some((row) => row.phrase === instance.phrase)).length
    facts.push(['Phrase usage', plural(uses, 'chain')])
    // The track's scale (read from the Scale view) where the phrase starts; the key the notes
    // fit is a guess, shown when the scale lets every note through.
    const choice   = this.scales.at(instance.track, instance.row)
    const allNotes = !scalePitches(model.scales?.[choice.scale], choice.key)
    if (model.scales) facts.push(['Track scale', `${scaleLabel(model, choice)}${allNotes ? ' (all notes)' : ''}`])
    const keyGuess = allNotes && harmony.key
    if (harmony.pitches.length)
      facts.push(['Notes in phrase', [pitchList(harmony.pitches), keyGuess && `likely key ${keyName(keyGuess)}`].filter(Boolean).join(' · ')])
    if (this.projectSemitones) facts.push(['Project transpose', semitoneText(this.projectSemitones)])
    if (this.chainSemitones) facts.push(['Chain transpose', `${semitoneText(this.chainSemitones)}`])
    if (this.transposed && harmony.pitches.length) {
      const playedPitches = (this.phrase?.steps ?? []).flatMap((step, s) => {
        const played = noteNumber(playedNote(model, step.note, this.chainSemitones, null, this.scales.at(instance.track, instance.row + s)).note)
        return played == null || noteNumber(step.note) == null ? [] : [played % 12]
      })
      const shift         = this.chainSemitones + this.projectSemitones
      facts.push(['Notes after transpose', [pitchList(playedPitches), keyGuess && `likely key ${keyName(keyGuess, shift)}`].filter(Boolean).join(' · ')])
    }
  }

  private describeStep(selection: StepSelection, path: string[], effectiveInstrument: number | null): CellDescription {
    const { instance, model, facts } = this
    const step                       = this.phrase?.steps[selection.step]
    const written                    = noteNumber(step?.note ?? null)
    const played                     = playedNote(
      model,
      step?.note ?? null,
      this.chainSemitones,
      effectiveInstrument,
      this.scales.at(instance.track, instance.row + selection.step),
    )
    if (selection.column === 'note' && written != null) this.addNoteFacts(step?.note ?? null, written, played)
    // The chord shows on the note, and on a CRD command, which picks its bank.
    const lane = fxLaneOf(selection.column)?.lane
    if (selection.column === 'note' || (lane != null && step?.fx[lane]?.cmd === 'CRD')) this.addChordFacts(effectiveInstrument, selection.step)
    this.addCarriedRepeat(selection)
    path.push(`Step ${hexDigit(selection.step)}`)
    const phrase = this.phrase
    const width  = selection.column === 'note' ? 3 : 2
    const parts  = phrase
      ? sdkParts('phrase', `PHRASE ${hex2(phrase.id)}`, phraseScreen(phrase), phraseColumnX(selection.column), selection.step, width)
      : []
    if (effectiveInstrument != null) facts.unshift(['Instrument', instrumentLabel(model, effectiveInstrument)])
    return {
      path,
      title: this.stepTitle(selection, played),
      parts,
      facts
    }
  }

  /** What a REP does to its parameter on this row, in decimal (a step is in quarters); a REP from the previous phrase is the '^^' lane of the M8, which the SDK cannot see on the drawn screen. */
  private addCarriedRepeat(selection: StepSelection): void {
    const lane = fxLaneOf(selection.column)?.lane
    const text = lane == null ? null : repeatText(this.repeats?.[lane]?.[selection.step])
    if (text) this.facts.push(['Repeat', text])
  }

  private stepTitle(selection: StepSelection, played: ReturnType<typeof playedNote>): string {
    const step = this.phrase?.steps[selection.step]
    switch (selection.column) {
      case 'note': {
        const changed = noteNumber(step?.note ?? null) != null && played.sounding !== step?.note
        // A note only the scale moved (no transpose) says so.
        const moved   = changed ? ` → ${played.sounding ?? 'out of range'}${played.shift ? '' : ' (scale)'}` : ''
        return `Note ${step?.note ?? '---'}${moved}`
      }
      case 'vel':
        return `Velocity ${hex2(step?.vel ?? null)}`
      case 'inst':
        return `Instrument ${hex2(step?.inst ?? null)}`
      default: {
        const lane = fxLaneOf(selection.column)?.lane ?? 0
        return fxTitle(lane, step?.fx[lane])
      }
    }
  }

  /** What the note plays and its degree in the track's scale (or in the guessed key). */
  private addNoteFacts(writtenText: string | null, written: number, played: ReturnType<typeof playedNote>): void {
    const { facts } = this
    const degree    = this.degreeText(written, played)
    const detuned   = Math.trunc(played.detune)
    // The title already shows the note that sounds; this says why it differs from the written one.
    const reasons   = [
      played.shift ? `transposed by ${semitoneText(played.shift)}` : null,
      played.snapped ? `${played.shift ? 'then ' : `${writtenText} is outside the scale, so it is `}moved up ${semitoneText(played.snapped)} to fit ${scaleLabel(this.model, played.scale)}` : null,
      detuned && !played.snapped && !played.shift ? 'detuned by the scale' : null,
    ].filter(Boolean)
    if (this.transposed && !played.transposes) facts.push(['Transposition', 'Off for this instrument (TRANSP. OFF): chain and project transposes do not apply.'])
    else if (reasons.length) facts.push(['Why it changes', `${reasons.join(', ').replace(/^./, (letter) => letter.toUpperCase())}${played.sounding ? '' : '. Out of range'}.`])
    if (degree) facts.push(['Scale degree', degree])
    if (played.detune) facts.push(['Scale detune', `${played.detune > 0 ? '+' : ''}${played.detune.toFixed(2)} ${Math.abs(played.detune) === 1 ? 'semitone' : 'semitones'}`])
  }

  /**
   * The chord a Hypersynth plays on a step: over the note the step plays, or the last one above it
   * in the phrase (a CRD on a row without a note). Its voices are rounded to the scale; its place is
   * given in that scale, or in the guessed key. A CRD in force picks the bank; a bank other than
   * the one the Instrument view shows is known once "Read chord banks" has read it.
   */
  private addChordFacts(instrument: number | null, stepIndex: number): void {
    const source   = this.model.instruments[instrument ?? -1]
    const settings = hypersynthSettings(source)
    if (!settings) return
    const steps = this.phrase?.steps
    const bank  = chordBankAt(steps, stepIndex)
    const chord = bank == null ? settings.chord : chordOfBank(source, bank)
    if (bank != null) {
      const unknown = `its notes are not known: only bank ${settings.chord.bank}, the one the Instrument view shows, has been read. Read chord banks (Options) reads the others from the M8`
      this.facts.push(['Chord bank', `${hex2(bank)}, picked by a CRD command${chord ? '' : ` (${unknown})`}`])
    }
    if (!chord) return
    let noteStep = stepIndex
    while (noteStep > 0 && noteNumber(steps?.[noteStep]?.note ?? null) == null) noteStep -= 1
    const { instance, model } = this
    const played              = playedNote(model, steps?.[noteStep]?.note ?? null, this.chainSemitones, instrument, this.scales.at(instance.track, instance.row + noteStep))
    const note                = noteNumber(played.note)
    if (note == null) return
    const shape = scaleShapeOf(this.model, played.scale, settings.scale)
    const named = this.model.scales?.[settings.scale || played.scale.scale]?.name ?? ''
    const guess = this.harmony.key
    const key   = shape ? null : guess && {
      root : pitchClass(guess.root + played.shift),
      steps: guess.steps,
      name : `${guess.scale} (guessed)`
    }
    const facts = chordOverNoteFacts(chord, note, shape ?? (key ? {
      root : key.root,
      steps: key.steps
    } : null), key ? key.name : named, shape != null)
    const over  = noteStep === stepIndex ? '' : ` (over ${played.note}, step ${hexDigit(noteStep)})`
    this.facts.push(...facts.map(([label, value]): Fact => [label, label === 'Chord played' ? `${value}${over}` : value]))
  }

  /** '4th of A MINOR': the place of the played note among the scale's notes from the key; '' when unknown. */
  private degreeText(written: number, played: ReturnType<typeof playedNote>): string {
    const { model, harmony } = this
    const playedNumber       = noteNumber(played.note)
    const scale              = model.scales?.[played.scale.scale]
    const pitches            = scalePitches(scale, played.scale.key)
    if (pitches && playedNumber != null) {
      const root      = played.scale.key ?? scale?.key ?? 0
      const intervals = [...pitches].map((pitch) => pitchClass(pitch - root)).sort((a, b) => a - b)
      const degree    = intervals.indexOf(pitchClass(playedNumber - root))
      return degree >= 0 ? `${ordinal(degree)} of ${PITCH_NAMES[root]} ${scale?.name ?? `scale ${hex2(played.scale.scale)}`}` : ''
    }
    if (harmony.key) {
      const degree = degreeOf(harmony.key, written)
      return degree ? `${degree} of ${keyName(harmony.key, played.shift)}` : ''
    }
    return ''
  }
}

// ---------------------------------------------------------------------------
// Table rows and panels

function describeTableCell(model: SongModel, selection: TableSelection, song: SongContext): CellDescription {
  const table = model.tables[selection.table] ?? emptyTable(selection.table)
  const path  = [
    `Track ${selection.track + 1}`,
    selection.instrument != null ? `Instrument ${instrumentLabel(model, selection.instrument)}` : 'Table',
    `Table ${hex2(selection.table)}`,
    `Row ${hexDigit(selection.row)}`,
  ]
  const width = selection.column.endsWith('cmd') ? 3 : 2
  const parts = sdkParts('table', `TABLE ${hex2(table.id)}`, tableScreen(table), tableColumnX(selection.column), selection.row, width)
  const row   = table.rows[selection.row]
  const lane  = fxLaneOf(selection.column)?.lane
  const title =
    selection.column === 'transpose'
      ? `Transpose ${hex2(row?.transpose ?? 0)}`
      : selection.column === 'volume'
        ? `Volume ${hex2(row?.volume ?? null)}`
        : fxTitle(lane ?? 0, row?.fx[lane ?? 0])
  return {
    path,
    title,
    parts,
    facts: [...(selection.column === 'transpose' ? tableChordFacts(model, selection, row?.transpose ?? null, song) : []), ...tableFacts(model, selection, table, song)]
  }
}

/** The chord a Hypersynth plays when this row's N transposes the note that starts the table (the first note of the song that does). */
function tableChordFacts(model: SongModel, selection: TableSelection, transpose: number | null, song: SongContext): Fact[] {
  const settings = hypersynthSettings(model.instruments[selection.instrument ?? -1])
  if (!settings) return []
  const start = tableUses(model, song.timeline, song.effective, selection.table).find((use) => !use.aux && noteNumber(use.note) != null)
  const base  = start && noteNumber(start.note)
  if (!start || base == null) return []
  const shift  = transposeSemitones(transpose)
  const choice = song.scales.at(start.track, start.row)
  const shape  = scaleShapeOf(model, choice, settings.scale)
  const name   = model.scales?.[settings.scale || choice.scale]?.name ?? ''
  const over   = `over ${start.note}${shift ? ` ${formatTranspose(shift)}` : ''}`
  return chordOverNoteFacts(settings.chord, base + shift, shape, name).map(([label, value]): Fact => [label, `${value} (${over})`])
}

/** The TIC the song starts a table at most often, else its instrument's TBL.TIC; and the other TICs it is started at. */
function tableTic(model: SongModel, table: number, uses: TableUse[]): { tic: number; others: number[]; instrument: number | null } {
  const counts = new Map<number, number>()
  for (const use of uses) counts.set(use.tic, (counts.get(use.tic) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).map(([tic]) => tic)
  const own    = tableTicOf(model.instruments[table])
  return {
    tic       : sorted[0] ?? own ?? DEFAULT_TIC,
    others    : sorted.slice(1),
    // The instrument's own TBL.TIC when the song starts the table only at other speeds.
    instrument: sorted.length && own != null && !sorted.includes(own) ? own : null
  }
}

/** True when the scale where the table starts lets every note through, so the N column counts semitones. */
function chromaticAt(model: SongModel, song: SongContext, use: TableUse): boolean {
  const choice = song.scales.at(use.track, use.row)
  return !scalePitches(model.scales?.[choice.scale], choice.key)
}

/** How the table plays: how fast, where the column of the selected cell goes, and the chord of the N column. */
function tableFacts(model: SongModel, selection: TableSelection, table: Table, song: SongContext): Fact[] {
  const facts                       = [] as Fact[]
  const uses                        = tableUses(model, song.timeline, song.effective, selection.table)
  const { tic, others, instrument } = tableTic(model, selection.table, uses)
  const tempo                       = model.tempo ?? null
  const also                        = others.length ? ` Other triggers use TIC ${others.map((other) => hex2(other)).join(', ')}.` : ''
  facts.push(['Playback speed', `TIC ${hex2(tic)}: ${ticText(tic, tempo)}.${also}`])
  if (instrument != null) facts.push(['Instrument default speed', `TBL.TIC ${hex2(instrument)} on instrument ${hex2(selection.table)}, but the song always starts this table at another speed.`])
  const notes    = uses.filter((use) => !use.aux).length
  const auxSteps = uses.length - notes
  const tracks   = [...new Set(uses.map((use) => use.track + 1))].sort()
  const triggers = [notes && plural(notes, 'note'), auxSteps && plural(auxSteps, 'extra start (TBX)')].filter(Boolean).join(' and ')
  facts.push(['Playback triggered by', uses.length
    ? `${triggers} on track${tracks.length === 1 ? '' : 's'} ${tracks.join(', ')}`
    : 'Not triggered anywhere in this song.'])
  const walk = walkTable(table.rows, tic)
  if (!walk) return facts
  const lane   = fxLaneOf(selection.column)?.lane
  const column = lane == null ? 'Note and volume' : `FX${lane + 1}`
  const cursor = walk.cursors[lane == null ? 0 : lane + 1]
  facts.push([`${column} playback`, describeWalk(cursor, walk.unit, tempo)])
  if (cursor.kind !== 'still' && !playedRows(cursor).includes(selection.row)) {
    facts.push(['This row', `Never played: ${column.toLowerCase()} playback does not reach row ${hexDigit(selection.row)}.`])
  }
  // The transposes the N column plays, in order: a chord when it spells one.
  const main      = walk.cursors[0]
  const semitones = (main.loop.length ? main.loop : main.intro).map((row) => transposeSemitones(table.rows[row]?.transpose))
  if (lane == null && new Set(semitones).size > 1) {
    const chord = chordName(semitones)
    facts.push(['Note intervals', `${intervalsText(semitones).split(' ').join(', ')} semitones${chord ? ` · ${chord}` : ''}`])
    const start    = uses.find((use) => noteNumber(use.note) != null && chromaticAt(model, song, use))
    const arpeggio = start?.note ? arpeggioText(start.note, semitones) : null
    if (start?.note && arpeggio) facts.push([`Notes from ${start.note}`, arpeggio])
  }
  return facts
}

/** Tracks (1-8) whose chains play a phrase that uses the instrument. */
function tracksPlaying(model: SongModel, instrument: number | null): number[] {
  const tracks = new Set<number>()
  for (const [phraseId, phrase] of Object.entries(model.phrases)) {
    const uses = phrase.steps.some((step) => step.inst === instrument || step.fx.some((fx) => fx.cmd === 'INS' && fx.val === instrument))
    if (!uses) continue
    for (const row of model.song) {
      row.forEach((chainId, track) => {
        if (chainId != null && model.chains[chainId]?.rows.some((chainRow) => chainRow.phrase === Number(phraseId))) tracks.add(track + 1)
      })
    }
  }
  return [...tracks].sort()
}

/** Instrument label for a path: '01 · GRAYSATURN · FMSYNTH'. */
function instrumentPath(model: SongModel, id: number, track: number, ...rest: string[]): string[] {
  return [`Track ${track + 1}`, `Instrument ${instrumentLabel(model, id)}`, ...rest]
}

/** What the SDK says about a value of the Instrument or Inst. Mods view, read from the stored screen. */
function instrumentParts(stored: string[], screen: InstrumentScreen, cell: InstrumentCell): M8DescriptionPart[] {
  const lines   = storedScreen(stored)
  const state   = stateWithCursorAt(
    screen === 'inst' ? 'inst' : 'instmods',
    stored[0] ?? '',
    lines,
    cell.x + SCREEN_MARGIN,
    TITLE_ROW + cell.line,
    cell.width,
  )
  const context = getSemanticContext(state, {
    width : SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    lines
  })
  return context ? selectionParts(context) : []
}

const slotFact = (slot: ModSlot): Fact => [`MOD${slot.slot}`, modSummary(slot)]

function describeInstrumentCell(model: SongModel, selection: InstParamSelection): CellDescription {
  const instrument = model.instruments[selection.instrument]
  const page       = instrument ? instrumentPage(instrument) : null
  const cell       = page ? cellAt(page, selection.screen, selection.line, selection.x) : null
  const label      = cell ? `${cell.label}${cell.operator ? ` ${cell.operator}` : ''}` : '?'
  const facts      : Fact[] = []
  if (!instrument || !page || !cell) {
    return {
      path : instrumentPath(model, selection.instrument, selection.track),
      title: label,
      parts: [],
      facts
    }
  }
  if (selection.screen === 'mods') {
    const slot = page.slots.find((s) => s.slot === cell.slot)
    if (slot) {
      facts.push(slotFact(slot))
      // MOD AMT / RATE / BOTH act on the next slot (4 on 1).
      if (slot.dest?.startsWith('MOD')) facts.push(['Target modulator', `MOD${(slot.slot % 4) + 1} (${slot.dest})`])
    }
    return {
      path : instrumentPath(model, selection.instrument, selection.track, 'Modulators', `MOD${cell.slot ?? '?'}`),
      title: `${label} · ${cell.text}`,
      parts: instrumentParts(instrument.mods ?? [], 'mods', cell),
      facts
    }
  }
  if (cell.operator) facts.push(['Operator', cell.operator])
  if (cell.label === 'CHORD') facts.push(...chordFacts(cell.text))
  for (const slot of modulatorsOf(page, cell.label)) facts.push(['Modulators', `MOD${slot.slot} · ${modSummary(slot)}`])
  return {
    path : instrumentPath(model, selection.instrument, selection.track),
    title: `${label} · ${cell.text}`,
    parts: instrumentParts(instrument.lines, 'inst', cell),
    facts
  }
}

function describeInstrumentPanel(model: SongModel, selection: InstrumentSelection): CellDescription {
  const instrument = selection.instrument != null ? model.instruments[selection.instrument] : null
  const facts      : Fact[] = []
  if (instrument?.type) facts.push(['Type', instrument.type])
  if (instrument?.name) facts.push(['Name', instrument.name])
  const tracks = tracksPlaying(model, selection.instrument)
  if (tracks.length) facts.push(['Used on tracks', tracks.join(', ')])
  if (instrument) {
    const page   = instrumentPage(instrument)
    const header = (label: string) => page.cells.find((cell) => cell.label === label)?.text
    const transp = header('TRANSP')
    if (transp) facts.push(['TRANSP.', transp === 'ON' ? 'Scale, chain, and project transposition apply.' : 'Scale, chain, and project transposition do not apply.'])
    const tic = header('TBL.TIC')
    if (tic) facts.push(['Table speed (TBL.TIC)', tic])
    for (const slot of page.slots) if (slot.dest) facts.push(slotFact(slot))
    if (!instrument.mods?.length) facts.push(['Modulators', 'Settings unavailable. Explore the song again to read the modulators.'])
  }
  const isInstrument = selection.instrument != null
  return {
    path : [`Track ${selection.track + 1}`, isInstrument ? `Instrument ${hex2(selection.instrument)}` : `Table ${hex2(selection.table)}`],
    title: isInstrument ? `Instrument ${instrumentLabel(model, selection.instrument)}` : `Table ${hex2(selection.table)}`,
    parts: [],
    facts
  }
}
