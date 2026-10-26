// A small M8 for the tests: draws the song, chain, phrase, instrument and table views the
// way the device does (lower case text, track panel on the right) and answers the keys the
// explorer uses. It records any key that could change the song.

import type { M8KeyName, M8Screen, M8ScreenCells, M8State } from '@yam8d/m8-sdk'
import type { M8Port } from '../src/m8/port'
import { COLUMN_X } from '../src/model/columns'
import {
  chainScreen,
  FIRST_CONTENT_ROW,
  grooveScreen,
  instrumentModsScreen,
  instrumentScreen,
  phraseScreen,
  projectScreen,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  scaleScreen,
  songScreen,
  tableScreen,
  VISIBLE_SONG_ROWS,
} from '../src/model/screens'
import { emptyTableRow, type SongModel } from '../src/model/song'

type View = 'song' | 'chain' | 'phrase' | 'inst' | 'instmods' | 'table' | 'scale' | 'groove' | 'project' | 'mixer' | 'midisettings'

export const SYNC_OUT_VALUES = ['OFF', 'CLOCK', 'TRANSPORT', 'CLOCK+TRANSP', 'TRANSPORT+SPP', 'CLK+TRANSP+SPP']

const channelText = (channel: number): string => (channel === 0 ? 'ALL' : String(channel).padStart(2, '0'))

export interface FakeOptions {
  /** Reads after a view change that return a half-drawn screen (title only). */
  partialReads?          : number
  /** Option+Down in a phrase does nothing (to exercise the explorer's fallback). */
  phraseOptionDownBroken?: boolean
  /** Option+Up/Down on Instrument/Table steps the other way than the device does (to exercise the swap). */
  invertedBigSteps?      : boolean
  /** Cells that change on every read on `view` (a live indicator the M8 draws while the song plays). */
  flicker?               : { view: View; cells: { x: number; y: number }[] }
  /** The text under the cursor stays 'NONE' for this many ms after a key or a move (it lags the cursor on the device). */
  lateCursorText?        : number
  /** Presses the device misses: the first `count` presses of `keys` ('shift+right') on `view` do nothing. */
  missedPresses?         : { view: View; keys: string; count: number }[]
}

export class FakeM8 implements M8Port {
  view              : View = 'mixer'
  songTop           = 0
  songRow           = 0
  songTrack         = 0
  chain             = 0
  chainRow          = 0
  chainCol          = 0
  phrase            = 0
  phraseRow         = 0
  phraseCol         = 0
  inst              = 0x10
  table             = 0x10
  scale             = 0x03
  groove            = 0x02
  /** Cursor on the label/value views (Project, MIDI Settings), in screen cells. */
  free              = {
    x: 14,
    y: 5
  }
  syncOut           = 0
  /** CC MAP CHAN and SONG ROW CUE CHAN: 0 is ALL, else the channel. */
  ccMapChan         = 0
  songRowCueChan    = 0
  private held      : M8KeyName[] = []
  /** Keys that would edit or play: the explorer must never send them. */
  forbidden         : string[] = []
  presses           = 0
  /** Presses dropped through missedPresses. */
  missed            = 0
  private pending   = 0
  private reads     = 0
  private lastKeyAt = 0

  constructor(
    readonly model: SongModel,
    readonly options: FakeOptions = {},
  ) {}

  private changeView(view: View) {
    this.view    = view
    this.pending = this.options.partialReads ?? 0
  }

  private songLength() {
    return 256
  }

  lines(): string[] {
    let lines: string[]
    switch (this.view) {
      case 'song':
        lines = songScreen(this.model, this.songTop)
        break
      case 'chain':
        lines = chainScreen(
          this.model.chains[this.chain] ?? {
            id  : this.chain,
            rows: Array.from({ length: 16 }, () => ({
              phrase   : null,
              transpose: 0
            }))
          },
        )
        break
      case 'phrase':
        lines = phraseScreen(this.model.phrases[this.phrase])
        break
      case 'inst':
        lines = instrumentScreen(this.model.instruments[this.inst] ?? {
          id   : this.inst,
          name : null,
          type : 'NONE',
          lines: []
        })
        break
      case 'instmods':
        lines = instrumentModsScreen(this.model.instruments[this.inst] ?? {
          id   : this.inst,
          name : null,
          type : 'NONE',
          lines: []
        })
        break
      case 'table':
        lines = tableScreen(this.model.tables[this.table] ?? {
          id  : this.table,
          rows: Array.from({ length: 16 }, emptyTableRow)
        })
        break
      case 'scale':
        lines = scaleScreen(
          this.model.scales?.[this.scale] ?? {
            id   : this.scale,
            name : null,
            key  : 0,
            notes: Array.from({ length: 12 }, () => ({
              enabled: true,
              offset : 0
            }))
          },
        )
        break
      case 'groove':
        lines = grooveScreen(this.model.grooves?.[this.groove] ?? {
          id   : this.groove,
          ticks: [6, 6, ...Array(14).fill(null)],
          ppq  : 24
        })
        break
      case 'project': {
        const scale = this.model.projectScale ?? 0
        lines       = projectScreen(this.model.name, this.model.tempo ?? null, {
          transpose: this.model.projectTranspose,
          groove   : this.model.projectGroove,
          scale,
          key      : this.model.projectKey,
          scaleName: this.model.scales?.[scale]?.name
        })
        break
      }
      case 'midisettings':
        lines    = Array.from({ length: SCREEN_HEIGHT }, () => '')
        lines[3] = ' MIDI SETTINGS'
        lines[6] = ` SYNC IN${' '.repeat(7)}OFF`
        lines[7] = ` SYNC OUT${' '.repeat(6)}${SYNC_OUT_VALUES[this.syncOut]}`
        lines[8] = ` CC MAP CHAN${' '.repeat(4)}${channelText(this.ccMapChan)}`
        lines[9] = ` SONGROW CUE CH ${channelText(this.songRowCueChan)}`
        break
      default:
        lines    = Array.from({ length: SCREEN_HEIGHT }, () => '')
        lines[3] = ` ${this.view.toUpperCase()}`
    }
    lines    = lines.map((l) => l.toLowerCase())
    // The track panel shares the rows on the right, from screen column 34.
    lines[5] = `${lines[5].padEnd(34)}t>120`
    return lines
  }

  async getScreen(): Promise<M8Screen> {
    let lines = this.lines()
    if (this.pending > 0) {
      this.pending -= 1
      lines        = lines.map((l, y) => (y === 3 ? l : ''))
    }
    const flicker = this.options.flicker
    if (flicker && flicker.view === this.view) {
      this.reads += 1
      lines      = lines.map((line, y) => {
        let padded = line
        for (const cell of flicker.cells) {
          if (cell.y !== y) continue
          padded = padded.padEnd(cell.x + 1)
          padded = `${padded.slice(0, cell.x)}${this.reads % 10}${padded.slice(cell.x + 1)}`
        }
        return padded
      })
    }
    return {
      width : SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      lines
    }
  }

  async getScreenCells(): Promise<M8ScreenCells> {
    const lines = this.lines()
    const fg    = lines.map((l) =>
      Array.from({ length: SCREEN_WIDTH }, (_, x) => (l[x] && l[x] !== ' ' ? (/-/.test(l[x]) ? '#444444' : '#ffffff') : null)),
    )
    const bg    = lines.map(() => Array.from({ length: SCREEN_WIDTH }, () => '#000000'))
    return {
      width : SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      lines,
      fg,
      bg
    }
  }

  /** Cursor cell (x counted with the margin, like cursorPos) and its width. */
  cursor(): { x: number; y: number; w: number } {
    switch (this.view) {
      case 'song':
        return {
          x: COLUMN_X.song.track(this.songTrack) + 1,
          y: FIRST_CONTENT_ROW + this.songRow - this.songTop,
          w: 2
        }
      case 'chain':
        return {
          x: (this.chainCol === 0 ? COLUMN_X.chain.phrase : COLUMN_X.chain.transpose) + 1,
          y: FIRST_CONTENT_ROW + this.chainRow,
          w: 2
        }
      case 'phrase': {
        const xs = [COLUMN_X.phrase.note, COLUMN_X.phrase.vel, COLUMN_X.phrase.inst, ...COLUMN_X.phrase.fxCmd]
        return {
          x: xs[this.phraseCol] + 1,
          y: FIRST_CONTENT_ROW + this.phraseRow,
          w: this.phraseCol === 0 ? 3 : 2
        }
      }
      case 'project':
      case 'midisettings': {
        const line  = this.lines()[this.free.y] ?? ''
        const token = /^\S+/.exec(line.slice(this.free.x))?.[0] ?? ' '
        return {
          x: this.free.x,
          y: this.free.y,
          w: token.length
        }
      }
      default:
        return {
          x: 9,
          y: FIRST_CONTENT_ROW,
          w: 4
        }
    }
  }

  async getState(): Promise<M8State> {
    return this.stateNow(this.options.lateCursorText != null && Date.now() - this.lastKeyAt < this.options.lateCursorText)
  }

  /** The state as the fake itself knows it; `late` gives the lagging text under the cursor. */
  private stateNow(late: boolean): M8State {
    const lines = this.lines()
    const c     = this.cursor()
    const line  = lines[c.y] ?? ''
    return {
      viewName       : this.view,
      viewTitle      : lines[3]?.trim() ?? null,
      minimapKey     : null,
      cursorPos      : {
        x: c.x,
        y: c.y
      },
      cursorRect     : null,
      selectionMode  : false,
      highlightColor : null,
      titleColor     : null,
      backgroundColor: null,
      cursorColor    : null,
      textUnderCursor: late ? 'NONE' : line.slice(c.x, c.x + c.w).trim() || null,
      currentLine    : line.trim() || null,
      deviceModel    : 'Fake',
      fontMode       : 0,
      systemInfo     : null,
      macroRunning   : false
    }
  }

  async navigateToView(view: string): Promise<boolean> {
    if (!['song', 'inst', 'table', 'scale', 'groove', 'project', 'mixer', 'chain', 'phrase'].includes(view)) return false
    this.changeView(view as View)
    return true
  }

  async navigateTo(x: number, y: number): Promise<void> {
    this.lastKeyAt = Date.now()
    switch (this.view) {
      case 'project':
      case 'midisettings':
        this.free = { x, y }
        return
      case 'song': {
        const row   = this.songTop + y - FIRST_CONTENT_ROW
        const track = [...Array(8).keys()].find((t) => x - 1 >= COLUMN_X.song.track(t) && x - 1 < COLUMN_X.song.track(t) + 2)
        if (row >= this.songTop && row < this.songTop + VISIBLE_SONG_ROWS && track != null) [this.songRow, this.songTrack] = [row, track]
        return
      }
      case 'chain':
        if (y >= FIRST_CONTENT_ROW && y < FIRST_CONTENT_ROW + 16) this.chainRow = y - FIRST_CONTENT_ROW
        this.chainCol = x - 1 >= COLUMN_X.chain.transpose ? 1 : 0
        return
      case 'phrase': {
        if (y >= FIRST_CONTENT_ROW && y < FIRST_CONTENT_ROW + 16) this.phraseRow = y - FIRST_CONTENT_ROW
        const xs  = [COLUMN_X.phrase.note, COLUMN_X.phrase.vel, COLUMN_X.phrase.inst, ...COLUMN_X.phrase.fxCmd]
        const col = xs.findLastIndex((cx) => x - 1 >= cx)
        if (col >= 0) this.phraseCol = col
        return
      }
    }
  }

  /** Edit held + Right steps the SYNC OUT value under the cursor (on the Right press). */
  async keyDown(keys: M8KeyName[]): Promise<void> {
    this.lastKeyAt = Date.now()
    const pressed  = keys.filter((k) => !this.held.includes(k))
    this.held      = [...keys]
    const onValue  = (y: number, x: number) => this.view === 'midisettings' && this.free.y === y && this.free.x === x
    const side     = pressed.includes('right') ? 1 : pressed.includes('left') ? -1 : 0
    if (side === 1 && keys.includes('edit') && onValue(7, 15)) this.syncOut = Math.min(SYNC_OUT_VALUES.length - 1, this.syncOut + 1)
    else if (side && keys.includes('edit') && onValue(8, 16)) this.ccMapChan = Math.max(0, Math.min(16, this.ccMapChan + side))
    else if (pressed.some((k) => k !== 'edit')) this.forbidden.push(`${this.view}: hold ${keys.join('+')}`)
  }

  async keyUp(): Promise<void> {
    this.held = []
  }

  private scrollSong(row: number) {
    this.songRow = Math.max(0, Math.min(this.songLength() - 1, row))
    if (this.songRow < this.songTop) this.songTop = this.songRow
    if (this.songRow >= this.songTop + VISIBLE_SONG_ROWS) this.songTop = this.songRow - VISIBLE_SONG_ROWS + 1
  }

  async press(keys: M8KeyName[]): Promise<void> {
    this.lastKeyAt = Date.now()
    this.presses   += 1
    const has      = (k: M8KeyName) => keys.includes(k)
    const combo    = keys.join('+')
    const missed   = this.options.missedPresses?.find((m) => m.view === this.view && m.keys === combo && m.count > 0)
    if (missed) {
      missed.count -= 1
      this.missed  += 1
      return
    }
    // Edit on MIDI > SETTINGS opens the MIDI Settings: a menu entry, not an edit.
    if (this.view === 'project' && keys.length === 1 && has('edit')) {
      const state = this.stateNow(false)
      if (/^midi/.test(state.currentLine ?? '') && state.textUnderCursor === 'settings') {
        this.free = {
          x: 15,
          y: 6
        }
        this.changeView('midisettings')
        return
      }
    }
    if (this.view === 'midisettings' && keys.length === 1 && has('opt')) {
      this.changeView('project')
      return
    }
    if (has('edit') || has('play')) {
      this.forbidden.push(`${this.view}: ${combo}`)
      return
    }
    const dir  = has('up') ? -1 : has('down') ? 1 : 0
    const side = has('left') ? -1 : has('right') ? 1 : 0
    switch (this.view) {
      case 'song':
        if (has('opt') && side) this.forbidden.push(`song: ${combo} (solo)`)
        else if (has('shift') && side === -1) this.forbidden.push('song: shift+left (live mode)')
        else if (has('shift') && side === 1) {
          const chain = this.model.song[this.songRow]?.[this.songTrack]
          if (chain != null) {
            this.chain    = chain
            this.chainRow = 0
            this.changeView('chain')
          }
        } else if (has('opt') && dir) this.scrollSong(this.songRow + dir * 16)
        else if (dir) this.scrollSong(this.songRow + dir)
        else if (side) this.songTrack = Math.max(0, Math.min(7, this.songTrack + side))
        return
      case 'chain':
        if (has('shift') && side === -1) this.changeView('song')
        else if (has('shift') && side === 1) {
          const phrase = this.model.chains[this.chain]?.rows[this.chainRow]?.phrase
          if (phrase != null) {
            this.phrase    = phrase
            this.phraseRow = 0
            this.changeView('phrase')
          }
        } else if (!has('opt') && dir) this.chainRow = Math.max(0, Math.min(15, this.chainRow + dir))
        else if (!has('opt') && side) this.chainCol = Math.max(0, Math.min(1, this.chainCol + side))
        return
      case 'phrase':
        if (has('shift') && side === -1) this.changeView('chain')
        else if (has('shift') && side === 1) this.changeView('inst')
        else if (has('opt') && dir && !this.options.phraseOptionDownBroken) {
          const next = this.model.chains[this.chain]?.rows[this.chainRow + dir]?.phrase
          if (next != null) {
            this.chainRow += dir
            this.phrase   = next
            this.changeView('phrase')
          }
        } else if (!has('opt') && dir) this.phraseRow = Math.max(0, Math.min(15, this.phraseRow + dir))
        else if (!has('opt') && side) this.phraseCol = Math.max(0, Math.min(5, this.phraseCol + side))
        return
      case 'scale':
        // Option+Left/Right: previous / next scale; Option+Up/Down: first / last (the manual).
        if (has('opt') && side) this.scale = Math.max(0, Math.min(0x0f, this.scale + side))
        else if (has('opt') && dir) this.scale = dir < 0 ? 0 : 0x0f
        if (has('opt')) this.changeView('scale')
        return
      case 'groove':
        // Option+Left/Right: previous / next groove; Option+Up/Down: 16 grooves (the manual).
        if (has('opt') && (side || dir)) {
          this.groove = Math.max(0, Math.min(0x1f, this.groove + (dir ? dir * 16 : side)))
          this.changeView('groove')
        }
        return
      case 'instmods':
        // Shift+Down goes back to the Instrument view it was entered from.
        if (has('shift') && dir === 1) this.changeView('inst')
        return
      case 'inst':
      case 'table': {
        const isInst = this.view === 'inst'
        if (has('shift') && dir === -1 && isInst) this.changeView('instmods')
        else if (has('shift') && side === 1 && isInst) {
          this.table = this.inst
          this.changeView('table')
        } else if (has('shift') && side === -1) {
          if (isInst) this.changeView('phrase')
          else {
            this.inst = this.table & 0x7f
            this.changeView('inst')
          }
        } else if (has('opt')) {
          // As measured: Option+Down is +16 on Instruments, Option+Up on Tables.
          const big     = (this.options.invertedBigSteps === isInst ? -dir : dir) * 16
          const max     = isInst ? 0x7f : 0xff
          const current = isInst ? this.inst : this.table
          const next    = Math.max(0, Math.min(max, current + (dir ? big : side)))
          if (isInst) this.inst = next
          else this.table = next
          this.changeView(this.view)
        }
        return
      }
    }
  }
}
