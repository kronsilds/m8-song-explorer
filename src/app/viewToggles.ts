// The view options the HUD toggles and the browser remembers: dramatic angles, the notes played
// or written, trimmed tables, and how far the walls are turned.

import type { World } from '../scene/world'
import type { Hud } from '../ui/hud'
import { preferences } from './preferences'

export class ViewToggles {
  constructor(
    private readonly world: World,
    private readonly hud: Hud,
  ) {}

  /** Applies the remembered options to the 3D view and lights their buttons. */
  apply(): void {
    const { world, hud } = this
    const dramatic       = preferences.dramatic.get()
    world.setDramatic(dramatic)
    hud.setActive('dramatic', dramatic)
    const playedNotes = preferences.playedNotes.get()
    world.setPlayedNotes(playedNotes)
    hud.setActive('played', playedNotes)
    const trimTables = preferences.trimTables.get()
    world.setTrimTables(trimTables)
    hud.setActive('trim', trimTables)
    const wallDegrees = preferences.wallDegrees.get()
    world.setWallDegrees(wallDegrees)
    hud.setWallDegrees(wallDegrees)
  }

  /** The toggles return the state they switched to. */
  toggleDramatic(): boolean {
    const dramatic = !preferences.dramatic.get()
    preferences.dramatic.set(dramatic)
    this.world.setDramatic(dramatic)
    this.hud.setActive('dramatic', dramatic)
    return dramatic
  }

  togglePlayedNotes(): boolean {
    const playedNotes = !preferences.playedNotes.get()
    preferences.playedNotes.set(playedNotes)
    this.world.setPlayedNotes(playedNotes)
    this.hud.setActive('played', playedNotes)
    return playedNotes
  }

  toggleTrimTables(): boolean {
    const trimTables = !preferences.trimTables.get()
    preferences.trimTables.set(trimTables)
    this.world.setTrimTables(trimTables)
    this.hud.setActive('trim', trimTables)
    return trimTables
  }

  /** The Options panel's wall angle slider. */
  setWallDegrees(degrees: number): void {
    preferences.wallDegrees.set(degrees)
    this.world.setWallDegrees(degrees)
  }
}
