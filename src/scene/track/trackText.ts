// The text of a track, coloured like the device: the front column (chain / phrase tree,
// notes, instruments), the step details on the wall, and the instrument / table panels.

import { fxColumn } from '../../model/columns'
import { hex2, hexDigit } from '../../model/hex'
import { formatTranspose, playedNote, transposeSemitones } from '../../model/music/harmony'
import { FX_LANES, type FxCell, type PhraseStep, ROWS_PER_PHRASE, ROWS_PER_TABLE, type TableRow } from '../../model/song'
import type { PhraseInstance } from '../../model/timeline'
import type { Panel, SongLayout } from '../layout'
import type { CellColors, Palette } from '../palette'
import { RichText } from '../text'

/** 'KIL', '03'; '---', '00' for an empty lane. */
export const fxCellText      = (fx: FxCell | undefined): [command: string, value: string] =>
  fx?.cmd ? [fx.cmd.padEnd(3).slice(0, 3), hex2(fx.val, '00')] : ['---', '00']

/** Panel width the instrument type takes in the subtitle, and the most of it shown. */
const TYPE_WIDTH             = 14
const INSTRUMENT_NAME_LENGTH = 12

export class TrackTextBuilder {
  constructor(
    private readonly layout: SongLayout,
    private readonly palette: Palette,
    /** Transposed phrases show the notes they play rather than the notes written. */
    private readonly playedNotes: boolean,
  ) {}

  /**
   * Chain and phrase labels, notes and instruments of one phrase instance. A transposed phrase
   * gets its transpose under the phrase number ('+5', '-12'; the third character takes the
   * bracket's place) and, with playedNotes, the notes it plays in the transpose colour (or the scale colour when only the scale moved them).
   */
  frontText(instance: PhraseInstance): RichText {
    const { palette, layout } = this
    const { model }           = layout
    const steps               = model.phrases[instance.phrase]?.steps
    const semitones           = transposeSemitones(model.chains[instance.chain]?.rows[instance.chainRow]?.transpose)
    const instruments         = layout.effective.get(instance.key)
    const rich                = new RichText()
    for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
      if (s) rich.newLine()
      rich.add(s === 0 && instance.chainRow === 0 ? hex2(instance.chain) : '  ', palette.chainLabel).add(' ', palette.empty)
      if (s === 1 && semitones !== 0) rich.add(formatTranspose(semitones).padEnd(3), palette.transpose)
      else rich.add(s === 0 ? hex2(instance.phrase) : '  ', palette.phraseLabel).add(' ', palette.empty)
      const step   = steps?.[s]
      const played = this.playedNotes
        ? playedNote(model, step?.note ?? null, semitones, instruments?.[s], layout.scales.at(instance.track, instance.row + s))
        : null
      if (played && step?.note && played.sounding !== step.note) rich.add(played.sounding ?? '???', played.shift ? palette.transpose : palette.quantized)
      else addValue(rich, step?.note ?? '---', step?.note != null, palette.phrase.note)
      rich.add(' ', palette.empty)
      addValue(rich, hex2(step?.inst ?? null), step?.inst != null, palette.phrase.inst)
    }
    return rich
  }

  /** Velocity, instrument and FX of each step, for the wall. */
  sideText(steps: PhraseStep[] | undefined): RichText {
    const { palette } = this
    const rich        = new RichText()
    for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
      if (s) rich.newLine()
      const step = steps?.[s]
      addValue(rich, hex2(step?.vel ?? null), step?.vel != null, palette.phrase.vel).add(' ', palette.empty)
      addValue(rich, hex2(step?.inst ?? null), step?.inst != null, palette.phrase.inst)
      this.addFxLanes(rich, step?.fx, palette.phrase)
    }
    return rich
  }

  /** A panel's table face: its title lines, then its first `rows` rows; a folded panel names how many rows with content it hides. */
  panelText(panel: Panel, rows = ROWS_PER_TABLE): RichText {
    const { palette }                         = this
    const { model }                           = this.layout
    const { instrument: instrumentId, table } = panel
    const instrument                          = instrumentId != null ? model.instruments[instrumentId] : null
    const tableRows                           : TableRow[] | undefined = model.tables[table]?.rows
    const rich                                = new RichText()
    if (instrumentId != null) {
      rich.add(`I${hex2(instrumentId)} `, palette.title)
      addValue(rich, (instrument?.name ?? '-'.repeat(INSTRUMENT_NAME_LENGTH)).slice(0, INSTRUMENT_NAME_LENGTH), !!instrument?.name, {
        filled: palette.value,
        empty : palette.empty
      })
    } else {
      rich.add(`TABLE ${hex2(table)}`, palette.title)
    }
    const type = instrument?.type ?? (instrumentId != null ? '?' : 'AUX TABLE')
    rich
      .newLine()
      .add(type.slice(0, TYPE_WIDTH - 1).padEnd(TYPE_WIDTH), palette.label)
      // Bright when the table has something in it, dim when it is empty.
      .add(`TBL ${hex2(table)}`, panel.contentRows > 0 ? palette.value : palette.empty)
    // Ø: an empty table (the font has no ∅); +N: rows with something in them that a folded panel hides.
    if (panel.contentRows === 0) rich.add(' Ø', palette.label)
    else if (rows < panel.contentRows) rich.add(` +${panel.contentRows - rows}`, palette.label)
    for (let i = 0; i < rows; i += 1) {
      rich.newLine()
      const row = tableRows?.[i]
      rich.add(hexDigit(i), palette.table.rowIndex.filled).add(' ', palette.empty)
      if (!row) {
        rich.add(i === 0 ? 'not read' : '', palette.empty)
        continue
      }
      addValue(rich, hex2(row.transpose ?? 0), !!row.transpose, palette.table.transpose).add(' ', palette.empty)
      addValue(rich, hex2(row.volume), row.volume != null, palette.table.volume)
      this.addFxLanes(rich, row.fx, palette.table)
    }
    return rich
  }

  private addFxLanes(rich: RichText, fx: FxCell[] | undefined, colors: Record<ReturnType<typeof fxColumn>, CellColors>): void {
    for (let lane = 0; lane < FX_LANES; lane += 1) {
      const cell             = fx?.[lane]
      const [command, value] = fxCellText(cell)
      const filled           = !!cell?.cmd
      rich.add(' ', this.palette.empty)
      addValue(rich, command, filled, colors[fxColumn(lane, 'cmd')])
      addValue(rich, value, filled, colors[fxColumn(lane, 'val')])
    }
  }
}

/** Adds a value in its column's filled or empty colour. */
const addValue = (rich: RichText, text: string, filled: boolean, colors: CellColors): RichText =>
  rich.add(text, filled ? colors.filled : colors.empty)
