// Which face each instrument panel turns to: the instrument face while the M8 shows that
// instrument (Instrument or Inst. Mods view), else its table; a panel turned by hand keeps its
// face until the M8 moves to another instrument or leaves it. State only.

import type { Panel } from '../layout'
import type { PanelFace } from './panelCards'

export class PanelFaces {
  /** The instrument the M8 shows, null on any other view. */
  private deviceInstrument : number | null = null
  /** Panels turned by hand ('track:table'). */
  private readonly byHand  = new Map<string, PanelFace>()

  /** The face a panel turns to: as turned by hand, else the instrument face while the M8 shows that instrument. */
  goal(panel: Panel): PanelFace {
    const byHand = this.byHand.get(`${panel.track}:${panel.table}`)
    if (byHand) return byHand
    return panel.instrument != null && panel.instrument === this.deviceInstrument ? 'inst' : 'table'
  }

  /** The instrument the M8 shows (null on any other view): the panels turned by hand turn back. True when it changed. */
  setDeviceInstrument(instrument: number | null): boolean {
    if (instrument === this.deviceInstrument) return false
    this.deviceInstrument = instrument
    this.byHand.clear()
    return true
  }

  /** Turns a panel over by hand. */
  toggle(panel: Panel): void {
    this.byHand.set(`${panel.track}:${panel.table}`, this.goal(panel) === 'inst' ? 'table' : 'inst')
  }
}
