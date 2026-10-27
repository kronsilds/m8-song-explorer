// The flat UI over the 3D view: toolbar, options menu, exploration progress, the selected
// cell's meaning, notices, confirmations and key hints. Plain DOM; colours come from the same
// palette as the scene. User actions go out through onAction.

import type { CellDescription } from '../m8/semantics'
import { debugLog } from '../model/debugLog'
import type { Palette } from '../scene/palette'

export type Action =
  | 'device'
  | 'explore'
  | 'cancel'
  | 'theme'
  | 'follow'
  | 'autoselect'
  | 'front'
  | 'angle'
  | 'side'
  | 'overview'
  | 'expand'
  | 'dramatic'
  | 'played'
  | 'export'
  | 'import'
  | 'demo'
  | 'show'
  | 'help'

/** A toolbar or menu button: its action, label and tooltip. */
type ButtonSpec = [action: Action, label: string, title: string]

const element           = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag)
  if (className) created.className = className
  if (text != null) created.textContent = text
  return created
}

const HELP_HTML         = `
  <div class="help-title">NAVIGATE</div>
  <dl>
    <dt>Drag</dt><dd>turn around the song: the track under the pointer opens (FX and tables)</dd>
    <dt>Right drag · Shift drag</dt><dd>pan</dd>
    <dt>Wheel</dt><dd>scroll the song · Ctrl/pinch zooms</dd>
    <dt>Click · Double click</dt><dd>select · focus</dd>
    <dt>Arrows · PgUp/PgDn</dt><dd>move the selection · scroll 16 rows</dd>
    <dt>Shift+Arrows</dt><dd>a whole phrase up / down · the same cell in the next / previous track</dd>
    <dt>0 1 2 3</dt><dd>all · front · turn · side</dd>
    <dt>E · F</dt><dd>open every wall · focus selection</dd>
    <dt>I</dt><dd>turn the selected instrument panel over: its table or its instrument (parameters and modulators). It turns by itself while the M8 shows that instrument</dd>
    <dt>X</dt><dd>dramatic angles: each cut to front, turn or side takes a skewed angle</dd>
    <dt>T</dt><dd>played notes: transposed phrases show the notes they play instead of the notes written</dd>
    <dt>A</dt><dd>auto select: the selection follows the M8 cursor</dd>
    <dt>Enter</dt><dd>show the selection on the M8</dd>
    <dt>Space · Shift Space</dt><dd>play / stop the M8 · continue from the cursor</dd>
    <dt>M</dt><dd>check the song's MIDI sync (offers to set it)</dd>
    <dt>Esc</dt><dd>clear selection</dd>
  </dl>`

/** CSS custom properties set from the palette. */
const PALETTE_VARIABLES : [variable: string, color: keyof Palette][] = [
  ['--bg', 'background'],
  ['--panel', 'panel'],
  ['--panel-header', 'panelHeader'],
  ['--rule', 'rule'],
  ['--label', 'label'],
  ['--title', 'title'],
  ['--value', 'value'],
  ['--empty', 'empty'],
  ['--hot', 'hot'],
  ['--hover', 'hover'],
  ['--link', 'link'],
  ['--table-link', 'tableLink'],
  ['--device', 'device'],
]

export class Hud {
  onAction     : (action: Action) => void = () => {}
  /** The mute / solo MIDI channel was changed (1..16). */
  onChannel    : (channel: number) => void = () => {}
  /** The selection panel was pinned open or unpinned. */
  onInfoPinned : (pinned: boolean) => void = () => {}
  /** The ? button was double clicked: save the debug log. */
  onDebugExport: () => void = () => {}

  private readonly channelSelect = element('select', 'channel-select')
  private readonly status        = element('div', 'status')
  private readonly summary       = element('div', 'summary')
  private readonly buttons       = new Map<Action, HTMLButtonElement>()
  private readonly progress      = element('div', 'progress hidden')
  private readonly progressText  = element('div', 'progress-text')
  private readonly progressBar   = element('div', 'progress-bar')
  /** The selection panel: a tab on the right edge that slides out on hover, or stays out when pinned. */
  private readonly info          = element('aside', 'info empty')
  private readonly infoTab       = element('div', 'info-tab')
  private readonly infoTabTitle  = element('span', 'info-tab-title')
  private readonly infoBody      = element('div', 'info-body')
  /** The options panel: a tab on the left edge that slides out on hover, or stays out when clicked. */
  private readonly menu          = element('aside', 'menu')
  private readonly hoverLine     = element('div', 'hover-line')
  private readonly toast         = element('div', 'toast hidden')
  private readonly confirmBox    = element('div', 'confirm hidden')
  private readonly help          = element('div', 'help hidden')
  private toastTimer             = 0

  constructor(root: HTMLElement, infoPinned = false) {
    const topBar = element('header', 'topbar')
    const brand  = element('div', 'brand')
    brand.append(element('span', 'brand-mark', 'M8'), element('span', 'brand-name', 'SONG EXPLORER'))
    const left = element('div', 'top-left')
    left.append(brand, this.status, this.summary)
    topBar.append(left, this.buildToolbar())
    this.buildMenu()
    this.buildInfoPanel(infoPinned)

    const cancel = element('button', 'tool danger', 'Cancel')
    cancel.addEventListener('click', () => this.onAction('cancel'))
    const progressTrack = element('div', 'progress-track')
    progressTrack.append(this.progressBar)
    this.progress.append(this.progressText, progressTrack, cancel)

    this.help.innerHTML = HELP_HTML
    this.help.addEventListener('click', () => this.help.classList.add('hidden'))

    const footer = element('footer', 'footer')
    footer.append(this.hoverLine, element('div', 'hints', 'drag to turn · wheel to scroll · ctrl+wheel to zoom · click a cell · ? for keys'))

    root.append(topBar, this.menu, this.info, this.progress, this.confirmBox, this.toast, this.help, footer)
    this.renderInfo(null)
  }

  private button([action, label, title]: ButtonSpec): HTMLButtonElement {
    const button          = element('button', 'tool', label)
    button.title          = title
    button.dataset.action = action
    button.addEventListener('click', () => this.onAction(action))
    this.buttons.set(action, button)
    return button
  }

  private buildToolbar(): HTMLElement {
    const tools = element('nav', 'tools')
    const group = (...specs: ButtonSpec[]) => {
      const buttons = element('div', 'tool-group')
      for (const spec of specs) buttons.append(this.button(spec))
      tools.append(buttons)
    }
    group(['device', 'Connect M8', 'Connect to the M8 from this page (Web Serial, WebUSB or Web MIDI), with its audio'])
    group(
      ['explore', 'Explore song', 'Walk song, chains, phrases, instruments and tables on the M8 (moves around, never edits)'],
      ['follow', 'Follow M8', 'Highlight and follow what the M8 cursor is on'],
      [
        'autoselect',
        'Auto select',
        'Select what the M8 cursor is on and show what it means; instrument, FX, table and instrument panel cells turn the view (A)',
      ],
    )
    group(
      ['overview', 'All', 'Whole song, all tracks (0)'],
      ['front', 'Front', 'Tracker view (1)'],
      ['angle', 'Turn', 'Turn to see FX and tables (2)'],
      ['side', 'Side', 'Face the open wall (3)'],
      ['expand', 'Open all', 'Open the walls of every track (E)'],
    )
    group(['help', '?', 'Keys and mouse · double click: save the debug log'])
    this.buttons.get('help')?.addEventListener('dblclick', () => this.onDebugExport())
    this.setButton('device', { hidden: true })
    return tools
  }

  /** The options panel: a tab on the left edge with the settings used less often. */
  private buildMenu(): void {
    const body    = element('div', 'menu-body')
    const section = (heading: string, ...items: (HTMLElement | ButtonSpec)[]) => {
      const list = element('div', 'menu-items')
      for (const item of items) list.append(Array.isArray(item) ? this.button(item) : item)
      body.append(element('div', 'menu-heading', heading), list)
    }
    section(
      'VIEW',
      ['dramatic', 'Dramatic', 'Skewed, tilted camera angles for front, turn, side and the turns toward a wall (X)'],
      ['played', 'Played notes', 'Notes show what they play instead of what is written: moved by a transpose in the transpose colour, moved only by the scale in the scale colour (T)'],
    )
    section('M8', ['theme', 'Read theme', 'Open the Theme View on the M8 and use its exact colours'], this.buildChannelPicker())
    section(
      'SONG FILE',
      ['export', 'Export', 'Save the explored song as JSON'],
      ['import', 'Import', 'Load a song JSON'],
      ['demo', 'Demo', 'Show the demo song'],
    )
    const tab = element('div', 'menu-tab')
    tab.append(element('span', 'menu-tab-kicker', 'OPTIONS'))
    tab.title = 'Hover to open · click to keep open'
    tab.addEventListener('click', () => this.menu.classList.toggle('pinned'))
    this.menu.append(body, tab)
  }

  /** The MIDI channel the track mute / solo buttons send on: the M8's CC MAP CHAN. */
  private buildChannelPicker(): HTMLElement {
    const label = element('label', 'tool channel', 'CC MAP CH ')
    label.title = "MIDI channel of the track mute / solo buttons: CC MAP CHAN in the M8's MIDI Settings (11 by default)"
    for (let channel = 1; channel <= 16; channel += 1) this.channelSelect.append(new Option(String(channel), String(channel)))
    this.channelSelect.addEventListener('change', () => this.onChannel(Number(this.channelSelect.value)))
    label.append(this.channelSelect)
    return label
  }

  private buildInfoPanel(pinned: boolean): void {
    this.info.classList.toggle('pinned', pinned)
    this.infoTab.append(element('span', 'info-tab-kicker', 'SELECTION'), this.infoTabTitle)
    this.infoTab.title = 'Hover to open · click to pin'
    this.infoTab.addEventListener('click', () => this.togglePin())
    this.info.append(this.infoTab, this.infoBody)
  }

  applyPalette(palette: Palette): void {
    const style = document.documentElement.style
    for (const [variable, color] of PALETTE_VARIABLES) style.setProperty(variable, palette[color] as string)
  }

  setStatus(text: string, kind: 'ok' | 'off' | 'busy' = 'off'): void {
    this.status.textContent  = text
    this.status.dataset.kind = kind
  }

  statusText(): string {
    return this.status.textContent ?? ''
  }

  setSummary(text: string): void {
    this.summary.textContent = text
  }

  setEnabled(action: Action, enabled: boolean): void {
    const button = this.buttons.get(action)
    if (button) button.disabled = !enabled
  }

  setButton(action: Action, { label, hidden }: { label?: string; hidden?: boolean }): void {
    const button = this.buttons.get(action)
    if (!button) return
    if (label != null) button.textContent = label
    // Hide the whole group when its only button is hidden.
    if (hidden != null) (button.parentElement?.childElementCount === 1 ? button.parentElement : button)?.classList.toggle('hidden', hidden)
  }

  setChannel(channel: number): void {
    this.channelSelect.value = String(channel)
  }

  setActive(action: Action, active: boolean): void {
    this.buttons.get(action)?.classList.toggle('active', active)
  }

  /** Shows the progress bar; a null fraction shows it running without a measure. */
  showProgress(text: string, fraction: number | null): void {
    this.progress.classList.remove('hidden')
    this.progressText.textContent = text
    this.progressBar.style.width  = fraction == null ? '100%' : `${Math.round(fraction * 100)}%`
    this.progressBar.classList.toggle('indeterminate', fraction == null)
  }

  hideProgress(): void {
    this.progress.classList.add('hidden')
  }

  /** Shows a notice; it goes to the debug log too (a warning is kept for the whole session) unless `record` is false. */
  notify(text: string, kind: 'info' | 'warn' = 'info', ms = 4200, record = true): void {
    if (record) {
      if (kind === 'warn') debugLog.problem('notice', text)
      debugLog.throttled(`notice:${text}`, 3000, 'notice', {
        kind,
        text
      })
    }
    this.toast.textContent  = text
    this.toast.dataset.kind = kind
    this.toast.classList.remove('hidden')
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), ms)
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden')
  }

  /** A yes/no question over the view; resolves true on the confirming button. */
  confirm(title: string, body: string, confirmLabel = 'Continue'): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmBox.replaceChildren()
      const card    = element('div', 'confirm-card')
      const yes     = element('button', 'tool primary', confirmLabel)
      const no      = element('button', 'tool', 'Cancel')
      const actions = element('div', 'confirm-actions')
      actions.append(no, yes)
      card.append(element('div', 'confirm-title', title), element('p', 'confirm-body', body), actions)
      this.confirmBox.append(card)
      this.confirmBox.classList.remove('hidden')
      const answer = (value: boolean) => {
        this.confirmBox.classList.add('hidden')
        resolve(value)
      }
      yes.addEventListener('click', () => answer(true))
      no.addEventListener('click', () => answer(false))
      yes.focus()
    })
  }

  setHover(text: string | null): void {
    this.hoverLine.textContent = text ?? ''
  }

  private togglePin(): void {
    const pinned = this.info.classList.toggle('pinned')
    const button = this.info.querySelector('.info-pin')
    if (button) button.textContent = pinned ? 'Unpin' : 'Pin'
    this.onInfoPinned(pinned)
  }

  /** The selection panel: path, title, the SDK's reading, facts and the Show on M8 button. */
  renderInfo(description: CellDescription | null, canShow = false): void {
    const body = this.infoBody
    body.replaceChildren()
    this.info.classList.toggle('empty', !description)
    this.infoTabTitle.textContent = description?.title ?? ''
    if (description) {
      // A short flash on the tab says the selection changed while the panel is closed.
      this.info.classList.remove('flash')
      void this.info.offsetWidth
      this.info.classList.add('flash')
    }
    const pin = element('button', 'info-pin', this.info.classList.contains('pinned') ? 'Unpin' : 'Pin')
    pin.addEventListener('click', () => this.togglePin())
    const head = element('div', 'info-head')
    head.append(element('div', 'info-kicker', 'SELECTION'), pin)
    if (!description) {
      const placeholder =
        'Click a note, an FX cell, a table row or an instrument value. Turn the view (drag, or key 2) to reveal the FX columns and the instrument panels of the track; INST › on a panel (or key I) turns it over to its instrument.'
      body.append(head, element('div', 'info-placeholder', placeholder))
      return
    }
    const path = element('div', 'info-path')
    description.path.forEach((crumb, i) => {
      if (i) path.append(element('span', 'sep', '›'))
      path.append(element('span', 'crumb', crumb))
    })
    body.append(head, path, element('div', 'info-title', description.title))
    if (description.parts.length) {
      const list = element('ul', 'info-parts')
      for (const part of description.parts) {
        const item = element('li', `part part-${part.kind}`)
        item.append(element('span', 'part-kind', part.kind), element('span', 'part-text', part.text))
        list.append(item)
      }
      body.append(list)
    }
    if (description.facts.length) {
      const facts = element('dl', 'info-facts')
      for (const [label, value] of description.facts) facts.append(element('dt', '', label), element('dd', '', value))
      body.append(facts)
    }
    const show    = element('button', 'tool primary show', 'Show on M8  ↵')
    show.disabled = !canShow
    show.title    = canShow ? 'Move the M8 to this cell' : 'Connect through yam8d to drive the M8'
    show.addEventListener('click', () => this.onAction('show'))
    body.append(show)
  }
}
