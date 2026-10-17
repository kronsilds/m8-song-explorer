// What a selected cell means, in the SDK's words: the cell is drawn on a screen the way the
// M8 draws it and the SDK reads it as if the device cursor were on it, so FX values,
// REP lanes, relative commands and ARP intervals are explained exactly as on the device.

import { describeContextParts, getSemanticContext, type M8DescriptionPart, type M8State, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { chainScreen, FIRST_CONTENT_ROW, phraseScreen, SCREEN_HEIGHT, SCREEN_WIDTH, tableScreen } from '../model/screens'
import {
  analyzePhrase,
  degreeOf,
  formatTranspose,
  keyName,
  noteNumber,
  PITCH_NAMES,
  pitchList,
  playedNote,
  ScaleMap,
  scaleLabel,
  scalePitches,
  transposeSemitones,
} from '../model/harmony'
import { buildTimeline } from '../model/song'
import type { Selection } from '../model/selection'
import { emptyTableRow, hex2, type SongModel } from '../model/song'
import { phraseColumnX, tableColumnX } from './device'

export interface CellDescription {
  /** Breadcrumb from the song down to the cell. */
  path: string[]
  /** Short title, e.g. "FX2 · KIL 03". */
  title: string
  parts: M8DescriptionPart[]
  /** Extra facts the app knows from the whole song (instrument name, uses...). */
  facts: [string, string][]
}

function stateFor(viewName: string, title: string, lines: string[], x: number, y: number, width: number): M8State {
  const line = lines[y] ?? ''
  return {
    viewName,
    viewTitle: title,
    minimapKey: null,
    cursorPos: { x, y },
    cursorRect: null,
    selectionMode: false,
    highlightColor: null,
    titleColor: null,
    backgroundColor: null,
    cursorColor: null,
    textUnderCursor: line.slice(x, x + width).trim() || null,
    currentLine: line.trim() || null,
    deviceModel: null,
    fontMode: 0,
    systemInfo: null,
    macroRunning: false,
  }
}

function sdkParts(viewName: string, title: string, lines: string[], schemaX: number, row: number, width: number): M8DescriptionPart[] {
  const y = FIRST_CONTENT_ROW + row
  const state = stateFor(viewName, title, lines, schemaX + SCREEN_MARGIN, y, width)
  const ctx = getSemanticContext(state, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, lines })
  return ctx ? describeContextParts(ctx).filter((p) => p.kind !== 'location') : []
}

const instrumentLabel = (model: SongModel, id: number | null): string => {
  if (id == null) return '--'
  const inst = model.instruments[id]
  return [hex2(id), inst?.name, inst?.type].filter(Boolean).join(' · ')
}

const ORDINAL = (i: number) => (i === 0 ? 'root' : `${i + 1}${i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}`)

export function describeSelection(model: SongModel, sel: Selection, effectiveInst?: number | null, scales?: ScaleMap): CellDescription {
  switch (sel.kind) {
    case 'step':
    case 'chain': {
      const { instance } = sel
      const path = [
        `Song row ${hex2(instance.songRow)}`,
        `Track ${instance.track + 1}`,
        `Chain ${hex2(instance.chain)} row ${instance.chainRow.toString(16).toUpperCase()}`,
        `Phrase ${hex2(instance.phrase)}`,
      ]
      const chain = model.chains[instance.chain]
      const raw = chain?.rows[instance.chainRow]?.transpose ?? 0
      const st = transposeSemitones(raw)
      const phrase = model.phrases[instance.phrase]
      const harmony = analyzePhrase(phrase?.steps)
      const facts: [string, string][] = []
      const uses = Object.values(model.chains).filter((c) => c.rows.some((r) => r.phrase === instance.phrase)).length
      facts.push(['Phrase used in', `${uses} chain${uses === 1 ? '' : 's'}`])
      // The track's scale (read from the Scale view) where the phrase starts; the key the notes
      // fit is a guess, shown when the scale lets every note through.
      const map = scales ?? new ScaleMap(model, buildTimeline(model))
      const choice = map.at(instance.track, instance.row)
      const pitches = scalePitches(model.scales?.[choice.scale], choice.key)
      if (model.scales) facts.push(['Track scale', `${scaleLabel(model, choice)}${pitches ? '' : ' (all notes)'}`])
      if (harmony.pitches.length) {
        facts.push(['Phrase notes', [pitchList(harmony.pitches), !pitches && harmony.key && `fits ${keyName(harmony.key)}`].filter(Boolean).join(' · ')])
      }
      const projectSt = transposeSemitones(model.projectTranspose)
      if (projectSt) facts.push(['Project transpose', `${formatTranspose(projectSt)} st`])
      if (st) facts.push(['Chain transpose', `${formatTranspose(st)} st (TSP ${hex2(raw)})`])
      if ((st || projectSt) && harmony.pitches.length) {
        const played = (phrase?.steps ?? []).flatMap((step, s) => {
          const out = noteNumber(playedNote(model, step.note, st, null, map.at(instance.track, instance.row + s)).note)
          return out == null || noteNumber(step.note) == null ? [] : [out % 12]
        })
        const shift = st + projectSt
        facts.push(['Played as', [pitchList(played), !pitches && harmony.key && keyName(harmony.key, shift)].filter(Boolean).join(' · ')])
      }
      if (sel.kind === 'chain') {
        const parts = chain
          ? sdkParts('chain', `CHAIN ${hex2(chain.id)}`, chainScreen(chain), 2, instance.chainRow, 2)
          : []
        return { path, title: `Chain ${hex2(instance.chain)} › Phrase ${hex2(instance.phrase)}`, parts, facts }
      }
      const step = phrase?.steps[sel.step]
      const n = noteNumber(step?.note ?? null)
      const stepScale = map.at(instance.track, instance.row + sel.step)
      const result = playedNote(model, step?.note ?? null, st, effectiveInst, stepScale)
      const { shift } = result
      const played = result.note
      if (sel.column === 'note' && n != null) {
        const out = noteNumber(played)
        const stepPitches = scalePitches(model.scales?.[stepScale.scale], stepScale.key)
        let inKey = ''
        if (stepPitches && out != null) {
          // Degree in the track's scale: the place of the note among the scale's notes from the key.
          const root = stepScale.key ?? model.scales?.[stepScale.scale]?.key ?? 0
          const order = [...stepPitches].map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
          const i = order.indexOf((out - root + 120) % 12)
          if (i >= 0) inKey = ` · ${ORDINAL(i)} of ${PITCH_NAMES[root]} ${model.scales?.[stepScale.scale]?.name ?? `scale ${hex2(stepScale.scale)}`}`
        } else if (harmony.key) {
          const degree = degreeOf(harmony.key, n)
          if (degree) inKey = ` · ${degree} of ${keyName(harmony.key, shift)}`
        }
        const how = [`${step?.note} ${formatTranspose(shift)}`, result.snapped ? `scale ${formatTranspose(result.snapped)}` : null].filter(Boolean).join(', ')
        if ((st || projectSt) && !result.transposes) facts.push(['Plays', `${step?.note} (instrument TRANSP. OFF: not transposed)`])
        else if (shift) facts.push(['Plays', `${played ?? 'out of range'} (${how})${inKey}`])
        else if (inKey) facts.push(['Degree', inKey.slice(3)])
        if (result.detune) facts.push(['Scale detune', `${result.detune > 0 ? '+' : ''}${result.detune.toFixed(2)} st`])
      }
      path.push(`Step ${sel.step.toString(16).toUpperCase()}`)
      const parts = phrase
        ? sdkParts('phrase', `PHRASE ${hex2(phrase.id)}`, phraseScreen(phrase), phraseColumnX(sel.column), sel.step, sel.column === 'note' ? 3 : 2)
        : []
      if (effectiveInst != null) facts.unshift(['Instrument playing', instrumentLabel(model, effectiveInst)])
      const lane = /^fx(\d)/.exec(sel.column)
      const fx = lane ? step?.fx[Number(lane[1]) - 1] : null
      const title =
        sel.column === 'note'
          ? `Note ${step?.note ?? '---'}${shift && n != null ? ` → ${played ?? 'out of range'}` : ''}`
          : sel.column === 'vel'
            ? `Velocity ${hex2(step?.vel ?? null)}`
            : sel.column === 'inst'
              ? `Instrument ${hex2(step?.inst ?? null)}`
              : `FX${lane?.[1]} · ${fx?.cmd ?? '---'} ${hex2(fx?.val ?? null, '00')}`
      return { path, title, parts, facts }
    }
    case 'table': {
      const table = model.tables[sel.table] ?? { id: sel.table, rows: Array.from({ length: 16 }, emptyTableRow) }
      const path = [`Track ${sel.track + 1}`, sel.inst != null ? `Instrument ${instrumentLabel(model, sel.inst)}` : 'Table', `Table ${hex2(sel.table)}`, `Row ${sel.row.toString(16).toUpperCase()}`]
      const parts = sdkParts('table', `TABLE ${hex2(table.id)}`, tableScreen(table), tableColumnX(sel.column), sel.row, sel.column.endsWith('cmd') ? 3 : 2)
      const row = table.rows[sel.row]
      const lane = /^fx(\d)/.exec(sel.column)
      const fx = lane ? row?.fx[Number(lane[1]) - 1] : null
      const title =
        sel.column === 'transpose'
          ? `Transpose ${hex2(row?.transpose ?? 0)}`
          : sel.column === 'volume'
            ? `Volume ${hex2(row?.volume ?? null)}`
            : `FX${lane?.[1]} · ${fx?.cmd ?? '---'} ${hex2(fx?.val ?? null, '00')}`
      return { path, title, parts, facts: [] }
    }
    case 'instrument': {
      const inst = sel.inst != null ? model.instruments[sel.inst] : null
      const facts: [string, string][] = []
      if (inst?.type) facts.push(['Type', inst.type])
      if (inst?.name) facts.push(['Name', inst.name])
      const tracks = new Set<number>()
      for (const [phraseId, phrase] of Object.entries(model.phrases)) {
        if (!phrase.steps.some((s) => s.inst === sel.inst || s.fx.some((f) => f.cmd === 'INS' && f.val === sel.inst))) continue
        model.song.forEach((row) =>
          row.forEach((chainId, t) => {
            if (chainId != null && model.chains[chainId]?.rows.some((r) => r.phrase === Number(phraseId))) tracks.add(t + 1)
          }),
        )
      }
      if (tracks.size) facts.push(['Played on tracks', [...tracks].sort().join(', ')])
      const lines = inst?.lines.filter((l) => l.trim()) ?? []
      return {
        path: [`Track ${sel.track + 1}`, sel.inst != null ? `Instrument ${hex2(sel.inst)}` : `Table ${hex2(sel.table)}`],
        title: sel.inst != null ? `Instrument ${instrumentLabel(model, sel.inst)}` : `Table ${hex2(sel.table)}`,
        parts: lines.slice(1).map((text) => ({ kind: 'line', text })),
        facts,
      }
    }
  }
}
