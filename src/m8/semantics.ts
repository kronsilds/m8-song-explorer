// What a selected cell means, in the SDK's words: the cell is drawn on a screen the way the
// M8 draws it and the SDK reads it as if the device cursor were on it, so FX values,
// REP lanes, relative commands and ARP intervals are explained exactly as on the device.

import { describeContextParts, getSemanticContext, type M8DescriptionPart, type M8State, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { COLUMN_X, fxLaneOf, phraseColumnX, tableColumnX } from '../model/columns'
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
  ScaleMap,
  scaleLabel,
  scalePitches,
  transposeSemitones,
} from '../model/music/harmony'
import { noteNumber, PITCH_NAMES, pitchClass } from '../model/music/pitch'
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
import { buildTimeline, effectiveInstruments, type PhraseInstance, type Timeline } from '../model/timeline'

export interface CellDescription {
  /** Breadcrumb from the song down to the cell. */
  path : string[]
  /** Short title, e.g. "FX2 · KIL 03". */
  title: string
  parts: M8DescriptionPart[]
  /** Extra facts the app knows from the whole song (instrument name, uses...). */
  facts: Fact[]
}

type Fact = [label: string, value: string]

type StepSelection = Extract<Selection, { kind: 'step' }>
type ChainSelection = Extract<Selection, { kind: 'chain' }>
type TableSelection = Extract<Selection, { kind: 'table' }>
type InstrumentSelection = Extract<Selection, { kind: 'instrument' }>
type InstParamSelection = Extract<Selection, { kind: 'instParam' }>

/** What the app already worked out about the song (the scene layout holds it). */
export interface SongContext {
  timeline : Timeline
  /** Instrument each step plays, per instance key (see effectiveInstruments). */
  effective: Map<string, (number | null)[]>
  /** The track scales along the song. */
  scales   : ScaleMap
}

function songContext(model: SongModel): SongContext {
  const timeline = buildTimeline(model)
  return {
    timeline,
    effective: effectiveInstruments(model, timeline),
    scales   : new ScaleMap(model, timeline)
  }
}

/**
 * @param effectiveInstrument the instrument the step plays (its I column or the last one before it)
 * @param song timeline, instruments and scales of the song, built from the model when not given
 */
export function describeSelection(model: SongModel, selection: Selection, effectiveInstrument?: number | null, song?: SongContext): CellDescription {
  switch (selection.kind) {
    case 'step':
    case 'chain':
      return new PhraseCellDescriber(model, selection, (song ?? songContext(model)).scales).describe(effectiveInstrument)
    case 'table':
      return describeTableCell(model, selection, song ?? songContext(model))
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
  return context ? describeContextParts(context).filter((part) => part.kind !== 'location') : []
}

// ---------------------------------------------------------------------------
// Labels

function instrumentLabel(model: SongModel, id: number | null): string {
  if (id == null) return '--'
  const instrument = model.instruments[id]
  return [hex2(id), instrument?.name, instrument?.type].filter(Boolean).join(' · ')
}

const fxTitle = (lane: number, fx: FxCell | null | undefined): string => `FX${lane + 1} · ${fx?.cmd ?? '---'} ${hex2(fx?.val ?? null, '00')}`

const plural  = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

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

  describe(effectiveInstrument: number | null | undefined): CellDescription {
    const { instance, model } = this
    const path                = [
      `Song row ${hex2(instance.songRow)}`,
      `Track ${instance.track + 1}`,
      `Chain ${hex2(instance.chain)} row ${hexDigit(instance.chainRow)}`,
      `Phrase ${hex2(instance.phrase)}`,
    ]
    this.addPhraseFacts()
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
    facts.push(['Phrase used in', plural(uses, 'chain')])
    // The track's scale (read from the Scale view) where the phrase starts; the key the notes
    // fit is a guess, shown when the scale lets every note through.
    const choice   = this.scales.at(instance.track, instance.row)
    const allNotes = !scalePitches(model.scales?.[choice.scale], choice.key)
    if (model.scales) facts.push(['Track scale', `${scaleLabel(model, choice)}${allNotes ? ' (all notes)' : ''}`])
    const keyGuess = allNotes && harmony.key
    if (harmony.pitches.length)
      facts.push(['Phrase notes', [pitchList(harmony.pitches), keyGuess && `fits ${keyName(keyGuess)}`].filter(Boolean).join(' · ')])
    if (this.projectSemitones) facts.push(['Project transpose', `${formatTranspose(this.projectSemitones)} st`])
    if (this.chainSemitones) facts.push(['Chain transpose', `${formatTranspose(this.chainSemitones)} st (TSP ${hex2(this.chainTransposeRaw)})`])
    if (this.transposed && harmony.pitches.length) {
      const playedPitches = (this.phrase?.steps ?? []).flatMap((step, s) => {
        const played = noteNumber(playedNote(model, step.note, this.chainSemitones, null, this.scales.at(instance.track, instance.row + s)).note)
        return played == null || noteNumber(step.note) == null ? [] : [played % 12]
      })
      const shift         = this.chainSemitones + this.projectSemitones
      facts.push(['Played as', [pitchList(playedPitches), keyGuess && keyName(keyGuess, shift)].filter(Boolean).join(' · ')])
    }
  }

  private describeStep(selection: StepSelection, path: string[], effectiveInstrument: number | null | undefined): CellDescription {
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
    path.push(`Step ${hexDigit(selection.step)}`)
    const phrase = this.phrase
    const width  = selection.column === 'note' ? 3 : 2
    const parts  = phrase
      ? sdkParts('phrase', `PHRASE ${hex2(phrase.id)}`, phraseScreen(phrase), phraseColumnX(selection.column), selection.step, width)
      : []
    if (effectiveInstrument != null) facts.unshift(['Instrument playing', instrumentLabel(model, effectiveInstrument)])
    return {
      path,
      title: this.stepTitle(selection, played),
      parts,
      facts
    }
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
    const how       = [
      played.shift ? `${writtenText} ${formatTranspose(played.shift)}` : writtenText,
      played.snapped ? `scale ${formatTranspose(played.snapped)}` : null,
      detuned ? `scale offset ${formatTranspose(detuned)}` : null
    ]
      .filter(Boolean)
      .join(', ')
    if (played.snapped && !played.shift && played.transposes) {
      facts.push(['Quantized', `${writtenText} is not in ${scaleLabel(this.model, played.scale)}: no transpose, the scale moves it ${formatTranspose(played.snapped)} st up to ${played.note ?? 'out of range'}`])
    }
    if (this.transposed && !played.transposes) facts.push(['Plays', `${writtenText} (instrument TRANSP. OFF: not transposed)`])
    else if (played.shift || played.snapped || detuned) facts.push(['Plays', `${played.sounding ?? 'out of range'} (${how})${degree ? ` · ${degree}` : ''}`])
    else if (degree) facts.push(['Degree', degree])
    if (played.detune) facts.push(['Scale detune', `${played.detune > 0 ? '+' : ''}${played.detune.toFixed(2)} st`])
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
    facts: tableFacts(model, selection, table, song)
  }
}

/** The TIC the song starts a table at most often, else its instrument's TBL.TIC; and the other TICs it is started at. */
function tableTic(model: SongModel, table: number, uses: TableUse[]): { tic: number; others: number[] } {
  const counts = new Map<number, number>()
  for (const use of uses) counts.set(use.tic, (counts.get(use.tic) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).map(([tic]) => tic)
  return {
    tic   : sorted[0] ?? tableTicOf(model.instruments[table]) ?? DEFAULT_TIC,
    others: sorted.slice(1)
  }
}

/** True when the scale where the table starts lets every note through, so the N column counts semitones. */
function chromaticAt(model: SongModel, song: SongContext, use: TableUse): boolean {
  const choice = song.scales.at(use.track, use.row)
  return !scalePitches(model.scales?.[choice.scale], choice.key)
}

/** How the table plays: how fast, where the column of the selected cell goes, and the chord of the N column. */
function tableFacts(model: SongModel, selection: TableSelection, table: Table, song: SongContext): Fact[] {
  const facts           = [] as Fact[]
  const uses            = tableUses(model, song.timeline, song.effective, selection.table)
  const { tic, others } = tableTic(model, selection.table, uses)
  const tempo           = model.tempo ?? null
  const also            = others.length ? ` (also started at TIC ${others.map((other) => hex2(other)).join(', ')})` : ''
  facts.push(['Speed', `TIC ${hex2(tic)}: ${ticText(tic, tempo)}${also}`])
  const notes    = uses.filter((use) => !use.aux).length
  const auxSteps = uses.length - notes
  const tracks   = [...new Set(uses.map((use) => use.track + 1))].sort()
  facts.push(['Started by', uses.length
    ? `${[notes && plural(notes, 'note'), auxSteps && plural(auxSteps, 'TBX step')].filter(Boolean).join(', ')} on track${tracks.length === 1 ? '' : 's'} ${tracks.join(', ')}`
    : 'nothing in the song'])
  const walk            = walkTable(table.rows, tic)
  if (!walk) return facts
  const lane   = fxLaneOf(selection.column)?.lane
  const column = lane == null ? 'N and V' : `FX${lane + 1}`
  const cursor = walk.cursors[lane == null ? 0 : lane + 1]
  facts.push([column, describeWalk(cursor, walk.unit, tempo)])
  if (cursor.kind !== 'still' && !playedRows(cursor).includes(selection.row)) {
    facts.push(['Not played', `${column} never ${lane == null ? 'reach' : 'reaches'} row ${hexDigit(selection.row)}`])
  }
  // The transposes the N column plays, in order: a chord when it spells one.
  const main      = walk.cursors[0]
  const semitones = (main.loop.length ? main.loop : main.intro).map((row) => transposeSemitones(table.rows[row]?.transpose))
  if (new Set(semitones).size > 1) {
    const chord = chordName(semitones)
    facts.push(['N column', `${intervalsText(semitones)} st${chord ? `: ${chord}` : ''}`])
    const start    = uses.find((use) => noteNumber(use.note) != null && chromaticAt(model, song, use))
    const arpeggio = start?.note ? arpeggioText(start.note, semitones) : null
    if (start?.note && arpeggio) facts.push([`On ${start.note}`, arpeggio])
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
  return context ? describeContextParts(context).filter((part) => part.kind !== 'location') : []
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
      if (slot.dest?.startsWith('MOD')) facts.push(['Modulates', `MOD${(slot.slot % 4) + 1} (${slot.dest})`])
    }
    return {
      path : instrumentPath(model, selection.instrument, selection.track, 'Modulators', `MOD${cell.slot ?? '?'}`),
      title: `${label} · ${cell.text}`,
      parts: instrumentParts(instrument.mods ?? [], 'mods', cell),
      facts
    }
  }
  if (cell.operator) facts.push(['Operator', cell.operator])
  for (const slot of modulatorsOf(page, cell.label)) facts.push(['Modulated by', `MOD${slot.slot} · ${modSummary(slot)}`])
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
  if (tracks.length) facts.push(['Played on tracks', tracks.join(', ')])
  if (instrument) {
    const page   = instrumentPage(instrument)
    const header = (label: string) => page.cells.find((cell) => cell.label === label)?.text
    const transp = header('TRANSP')
    if (transp) facts.push(['Transpose', `${transp} (scales, chain and project transpose ${transp === 'ON' ? 'apply' : 'do not apply'})`])
    const tic = header('TBL.TIC')
    if (tic) facts.push(['Table tick', tic])
    for (const slot of page.slots) if (slot.dest) facts.push(slotFact(slot))
    if (!instrument.mods?.length) facts.push(['Modulators', 'not read yet (explore the song again)'])
  }
  const isInstrument = selection.instrument != null
  return {
    path : [`Track ${selection.track + 1}`, isInstrument ? `Instrument ${hex2(selection.instrument)}` : `Table ${hex2(selection.table)}`],
    title: isInstrument ? `Instrument ${instrumentLabel(model, selection.instrument)}` : `Table ${hex2(selection.table)}`,
    parts: [],
    facts
  }
}
