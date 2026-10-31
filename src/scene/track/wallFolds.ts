// Which parts of each track's wall are unfolded: by the track's header buttons (they stay until
// the button is pressed again) or by a navigation (they fold again once a navigation leaves the
// track). State only: the 3D view eases the walls toward it and frames what it opens.

import { TRACKS } from '../../model/song'
import type { ButtonState, FoldSection } from './trackHeader'

export type Folds = Record<FoldSection, boolean>

export const FOLD_SECTIONS = ['fx', 'panels'] as const satisfies readonly FoldSection[]

const folded = (): Folds => ({
  fx    : false,
  panels: false
})

export class WallFolds {
  /** The parts each track's header buttons unfolded. */
  private readonly byButton    : Folds[] = Array.from({ length: TRACKS }, folded)
  /** The parts a navigation (the selection, or the followed M8 cursor, going to a cell on them) unfolded, not their button. */
  private readonly byNavigation: Folds[] = Array.from({ length: TRACKS }, folded)

  /** The parts of a track's wall that are unfolded (or unfolding): by its buttons, or by a navigation. */
  opened(track: number): Folds {
    const button = this.byButton[track]
    const auto   = this.byNavigation[track]
    return {
      fx    : button.fx || auto.fx,
      panels: button.panels || auto.panels
    }
  }

  /** Something of the track's wall is unfolded (or unfolding). */
  isUnfolded(track: number): boolean {
    const opened = this.opened(track)
    return opened.fx || opened.panels
  }

  /** Something of some track's wall is unfolded. */
  anyUnfolded(): boolean {
    return this.byButton.some((_, track) => this.isUnfolded(track))
  }

  /** How a fold button is lit: on when it keeps its part unfolded, auto when a navigation unfolded it. */
  buttonState(track: number, section: FoldSection): ButtonState {
    if (this.byButton[track][section]) return 'on'
    return this.byNavigation[track][section] ? 'auto' : 'off'
  }

  /** Every part of every track's wall is unfolded by its button (or, with `section`, that part of every track's). */
  allByButton(section?: FoldSection): boolean {
    return this.byButton.every((fold) => (section ? fold[section] : fold.fx && fold.panels))
  }

  /** How far a part is unfolded across the tracks: on every track by its button (all), on some (by a button or a navigation), or on none. */
  coverage(section: FoldSection): 'off' | 'some' | 'all' {
    if (this.allByButton(section)) return 'all'
    return this.byButton.some((_, track) => this.opened(track)[section]) ? 'some' : 'off'
  }

  /** The parts of a track's wall its buttons unfolded. */
  buttonsOf(track: number): Folds {
    return { ...this.byButton[track] }
  }

  /** Every track's buttons unfold (or fold) every part (or, with `section`, that part); navigations no longer hold them. */
  setAll(open: boolean, section?: FoldSection): void {
    for (const track of this.byButton.keys()) {
      for (const part of FOLD_SECTIONS) {
        if (section && section !== part) continue
        this.byButton[track][part]     = open
        this.byNavigation[track][part] = false
      }
    }
  }

  /**
   * A track's fold button: its part unfolds until the button is pressed again (a part a navigation
   * unfolded stays unfolded, now for good), or folds. Null for no such track.
   */
  toggle(track: number, section: FoldSection): { opened: boolean; wasOpen: boolean } | null {
    const fold = this.byButton[track]
    if (!fold) return null
    const wasOpen                     = this.opened(track)[section]
    fold[section]                     = !fold[section]
    this.byNavigation[track][section] = false
    return {
      opened: fold[section],
      wasOpen
    }
  }

  /** A navigation unfolds a part of a track's wall (until a navigation leaves the track). */
  unfoldByNavigation(track: number, section: FoldSection): void {
    this.byNavigation[track][section] = true
  }

  /** The tracks but `keep` on which a navigation unfolded something. */
  unfoldedByNavigation(keep: number | null): number[] {
    return [...this.byNavigation.keys()].filter((track) => track !== keep && (this.byNavigation[track].fx || this.byNavigation[track].panels))
  }

  /** Folds again what navigations unfolded on these tracks. */
  foldNavigation(tracks: number[]): void {
    for (const track of tracks) this.byNavigation[track] = folded()
  }
}
