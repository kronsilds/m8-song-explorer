// What the 3D view is about: the selection, the place of the followed M8 cursor, a track pressed by
// hand, else the track in the middle of the view. The framings centre on its track and the
// headers take their height from it.

import { type Selection, selectionTrack } from '../../model/selection'

export class ViewFocus {
  selection         : Selection | null = null
  /** Track the view is centred on and guided by when nothing is selected: the one in the middle of the view. */
  middleTrack       = 0
  /** Track pressed by hand (a turn started on it); wins until the next selection, pan or cursor move. */
  handTrack         : number | null = null
  /** Track the M8 cursor is on while following it; wins over the selection. */
  followedTrack     : number | null = null
  /** The device place last followed: the same place again (a screen refresh) changes nothing, so a click wins until the cursor moves. */
  followedSelection : Selection | null = null

  /** The track the view centres on: the one pressed by hand, else the followed one, else the selected one, else the one in the middle of the view. */
  track(): number {
    if (this.handTrack != null) return this.handTrack
    if (this.followedTrack != null) return this.followedTrack
    return this.selection ? selectionTrack(this.selection) : this.middleTrack
  }

  /** A track was chosen (pressed by hand, followed or selected) rather than being the one in the middle of the view. */
  chosen(): boolean {
    return this.handTrack != null || this.followedTrack != null || this.selection != null
  }
}
