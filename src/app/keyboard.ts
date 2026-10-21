// Keyboard shortcuts: each key runs a command of the app. Keys typed into inputs, and
// Ctrl / Cmd combinations, are left to the browser.

export type KeyCommands = Record<string, () => void>

/** Space plays / stops the M8 (Shift+Space continues from the cursor), as it does in yam8d. */
export function bindKeyboard(commands: KeyCommands, play: (fromCursor: boolean) => void): void {
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey) return
    if (event.code === 'Space') {
      event.preventDefault()
      if (!event.repeat) play(event.shiftKey)
      return
    }
    const command = commands[event.key]
    if (!command) return
    event.preventDefault()
    command()
  })
}
