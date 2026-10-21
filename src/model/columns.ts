// The grid columns of the Song, Chain, Phrase and Table views: their field keys (as the SDK
// names them) and the screen x of each, counted without the one-column margin.

import { TRACKS } from './song'

export type PhraseColumn = 'note' | 'vel' | 'inst' | 'fx1cmd' | 'fx1val' | 'fx2cmd' | 'fx2val' | 'fx3cmd' | 'fx3val'
export type TableColumn = 'transpose' | 'volume' | 'fx1cmd' | 'fx1val' | 'fx2cmd' | 'fx2val' | 'fx3cmd' | 'fx3val'
export type FxColumn = Extract<PhraseColumn, `fx${number}${'cmd' | 'val'}`>

/** Left to right, the order the arrow keys walk them. */
export const PHRASE_COLUMNS: readonly PhraseColumn[] = ['note', 'vel', 'inst', 'fx1cmd', 'fx1val', 'fx2cmd', 'fx2val', 'fx3cmd', 'fx3val']
export const TABLE_COLUMNS : readonly TableColumn[] = ['transpose', 'volume', 'fx1cmd', 'fx1val', 'fx2cmd', 'fx2val', 'fx3cmd', 'fx3val']

export const isPhraseColumn = (key: string | null): key is PhraseColumn => (PHRASE_COLUMNS as readonly (string | null)[]).includes(key)
export const isTableColumn  = (key: string | null): key is TableColumn => (TABLE_COLUMNS as readonly (string | null)[]).includes(key)

/** Screen x of every grid column the app draws or navigates to. */
export const COLUMN_X       = {
  song  : {
    row  : 0,
    track: (track: number) => 3 + 3 * track
  },
  chain : {
    row      : 0,
    phrase   : 2,
    transpose: 5
  },
  phrase: {
    row  : 0,
    note : 2,
    vel  : 6,
    inst : 9,
    fxCmd: [12, 18, 24],
    fxVal: [15, 21, 27]
  },
  table : {
    row      : 0,
    transpose: 2,
    volume   : 5,
    fxCmd    : [8, 14, 20],
    fxVal    : [11, 17, 23]
  }
} as const

/** The FX lane (0..2) of an FX column and which half of it, null for other columns. */
export function fxLaneOf(column: string): { lane: number; part: 'cmd' | 'val' } | null {
  const match = /^fx(\d)(cmd|val)$/.exec(column)
  return match ? {
    lane: Number(match[1]) - 1,
    part: match[2] as 'cmd' | 'val'
  } : null
}

/** The FX column of a lane (0..2). */
export const fxColumn = (lane: number, part: 'cmd' | 'val'): FxColumn => `fx${lane + 1}${part}` as FxColumn

export function phraseColumnX(column: PhraseColumn): number {
  const fx = fxLaneOf(column)
  if (fx) return (fx.part === 'cmd' ? COLUMN_X.phrase.fxCmd : COLUMN_X.phrase.fxVal)[fx.lane]
  return COLUMN_X.phrase[column as 'note' | 'vel' | 'inst']
}

export function tableColumnX(column: TableColumn): number {
  const fx = fxLaneOf(column)
  if (fx) return (fx.part === 'cmd' ? COLUMN_X.table.fxCmd : COLUMN_X.table.fxVal)[fx.lane]
  return COLUMN_X.table[column as 'transpose' | 'volume']
}

/** Field key and screen x of every grid column, per view. */
export const GRID_FIELDS: Record<'song' | 'chain' | 'phrase' | 'table', { key: string; x: number }[]> = {
  song  : Array.from({ length: TRACKS }, (_, track) => ({
    key: `track${track + 1}`,
    x  : COLUMN_X.song.track(track)
  })),
  chain : [{
    key: 'phrase',
    x  : COLUMN_X.chain.phrase
  }, {
    key: 'transpose',
    x  : COLUMN_X.chain.transpose
  }],
  phrase: PHRASE_COLUMNS.map((key) => ({
    key,
    x: phraseColumnX(key)
  })),
  table : TABLE_COLUMNS.map((key) => ({
    key,
    x: tableColumnX(key)
  }))
}
