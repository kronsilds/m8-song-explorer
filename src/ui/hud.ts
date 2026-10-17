// The flat UI over the 3D view: toolbar, exploration progress, the selected cell's
// meaning, and key hints. Plain DOM; colours come from the same palette as the scene.

import type { CellDescription } from '../m8/semantics'
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

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text != null) el.textContent = text
  return el
}

export class Hud {
  onAction: (action: Action) => void = () => {}
  private readonly status = h('div', 'status')
  private readonly summary = h('div', 'summary')
  private readonly buttons = new Map<Action, HTMLButtonElement>()
  private readonly progress = h('div', 'progress hidden')
  private readonly progressText = h('div', 'progress-text')
  private readonly progressBar = h('div', 'progress-bar')
  /** The selection panel: a tab on the right edge that slides out on hover, or stays out when pinned. */
  private readonly info = h('aside', 'info empty')
  private readonly infoTab = h('div', 'info-tab')
  private readonly infoTabTitle = h('span', 'info-tab-title')
  private readonly infoBody = h('div', 'info-body')
  private readonly hoverLine = h('div', 'hover-line')
  private readonly toast = h('div', 'toast hidden')
  private readonly confirmBox = h('div', 'confirm hidden')
  private readonly help = h('div', 'help hidden')
  private toastTimer = 0

  constructor(root: HTMLElement) {
    const top = h('header', 'topbar')
    const brand = h('div', 'brand')
    brand.append(h('span', 'brand-mark', 'M8'), h('span', 'brand-name', 'SONG EXPLORER'))
    const left = h('div', 'top-left')
    left.append(brand, this.status, this.summary)

    const tools = h('nav', 'tools')
    const group = (...items: [Action, string, string][]) => {
      const g = h('div', 'tool-group')
      for (const [action, label, title] of items) {
        const b = h('button', 'tool', label)
        b.title = title
        b.dataset.action = action
        b.addEventListener('click', () => this.onAction(action))
        this.buttons.set(action, b)
        g.append(b)
      }
      tools.append(g)
    }
    group(['device', 'Connect M8', 'Connect to the M8 from this page (Web Serial, WebUSB or Web MIDI), with its audio'])
    this.setButton('device', { hidden: true })
    group(
      ['explore', 'Explore song', 'Walk song, chains, phrases, instruments and tables on the M8 (moves around, never edits)'],
      ['theme', 'Read theme', 'Open the Theme View on the M8 and use its exact colours'],
      ['follow', 'Follow M8', 'Highlight and follow what the M8 cursor is on'],
      ['autoselect', 'Auto select', 'Select what the M8 cursor is on and show what it means; instrument, FX, table and instrument panel cells turn the view (A)'],
    )
    group(
      ['overview', 'All', 'Whole song, all tracks (0)'],
      ['front', 'Front', 'Tracker view (1)'],
      ['angle', 'Turn', 'Turn to see FX and tables (2)'],
      ['side', 'Side', 'Look along the wall (3)'],
      ['expand', 'Open all', 'Open the walls of every track (E)'],
      ['dramatic', 'Dramatic', 'Skewed, tilted camera angles for front, turn, side and the turns toward a wall (X)'],
      ['played', 'Played notes', 'Transposed phrases show the notes they play, in the transpose colour, instead of the notes written (T)'],
    )
    group(
      ['export', 'Export', 'Save the explored song as JSON'],
      ['import', 'Import', 'Load a song JSON'],
      ['demo', 'Demo', 'Show the demo song'],
      ['help', '?', 'Keys and mouse'],
    )
    top.append(left, tools)

    const cancel = h('button', 'tool danger', 'Cancel')
    cancel.addEventListener('click', () => this.onAction('cancel'))
    const track = h('div', 'progress-track')
    track.append(this.progressBar)
    this.progress.append(this.progressText, track, cancel)

    this.help.innerHTML = `
      <div class="help-title">NAVIGATE</div>
      <dl>
        <dt>Drag</dt><dd>turn around the song (reveals FX and tables)</dd>
        <dt>Right drag · Shift drag</dt><dd>pan</dd>
        <dt>Wheel</dt><dd>scroll the song · Ctrl/pinch zooms</dd>
        <dt>Click · Double click</dt><dd>select · focus</dd>
        <dt>Arrows · PgUp/PgDn</dt><dd>move the selection · scroll 16 rows</dd>
        <dt>0 1 2 3</dt><dd>all · front · turn · side</dd>
        <dt>E · F</dt><dd>open every wall · focus selection</dd>
        <dt>X</dt><dd>dramatic angles: each cut to front, turn or side takes a skewed angle</dd>
        <dt>T</dt><dd>played notes: transposed phrases show the notes they play instead of the notes written</dd>
        <dt>A</dt><dd>auto select: the selection follows the M8 cursor</dd>
        <dt>Enter</dt><dd>show the selection on the M8</dd>
        <dt>Space · Shift Space</dt><dd>play / stop the M8 · continue from the cursor</dd>
        <dt>M</dt><dd>check the song's MIDI sync (offers to set it)</dd>
        <dt>Esc</dt><dd>clear selection</dd>
      </dl>`
    this.help.addEventListener('click', () => this.help.classList.add('hidden'))

    const footer = h('footer', 'footer')
    footer.append(this.hoverLine, h('div', 'hints', 'drag to turn · wheel to scroll · ctrl+wheel to zoom · click a cell · ? for keys'))

    const pinned = (() => {
      try {
        return localStorage.getItem('m8-song-explorer:info-pinned') === '1'
      } catch {
        return false
      }
    })()
    this.info.classList.toggle('pinned', pinned)
    this.infoTab.append(h('span', 'info-tab-kicker', 'SELECTION'), this.infoTabTitle)
    this.infoTab.title = 'Hover to open · click to pin'
    this.infoTab.addEventListener('click', () => this.togglePin())
    this.info.append(this.infoTab, this.infoBody)

    root.append(top, this.info, this.progress, this.confirmBox, this.toast, this.help, footer)
    this.renderInfo(null)
  }

  applyPalette(p: Palette): void {
    const s = document.documentElement.style
    s.setProperty('--bg', p.background)
    s.setProperty('--panel', p.panel)
    s.setProperty('--panel-header', p.panelHeader)
    s.setProperty('--rule', p.rule)
    s.setProperty('--label', p.label)
    s.setProperty('--title', p.title)
    s.setProperty('--value', p.value)
    s.setProperty('--empty', p.empty)
    s.setProperty('--hot', p.hot)
    s.setProperty('--hover', p.hover)
    s.setProperty('--link', p.link)
    s.setProperty('--table-link', p.tableLink)
    s.setProperty('--device', p.device)
  }

  setStatus(text: string, kind: 'ok' | 'off' | 'busy' = 'off'): void {
    this.status.textContent = text
    this.status.dataset.kind = kind
  }

  setSummary(text: string): void {
    this.summary.textContent = text
  }

  setEnabled(action: Action, enabled: boolean): void {
    const b = this.buttons.get(action)
    if (b) b.disabled = !enabled
  }

  setButton(action: Action, { label, hidden }: { label?: string; hidden?: boolean }): void {
    const b = this.buttons.get(action)
    if (!b) return
    if (label != null) b.textContent = label
    // Hide the whole group when its only button is hidden
    if (hidden != null) (b.parentElement?.childElementCount === 1 ? b.parentElement : b)?.classList.toggle('hidden', hidden)
  }

  setActive(action: Action, active: boolean): void {
    this.buttons.get(action)?.classList.toggle('active', active)
  }

  showProgress(text: string, fraction: number | null): void {
    this.progress.classList.remove('hidden')
    this.progressText.textContent = text
    this.progressBar.style.width = fraction == null ? '100%' : `${Math.round(fraction * 100)}%`
    this.progressBar.classList.toggle('indeterminate', fraction == null)
  }

  hideProgress(): void {
    this.progress.classList.add('hidden')
  }

  notify(text: string, kind: 'info' | 'warn' = 'info', ms = 4200): void {
    this.toast.textContent = text
    this.toast.dataset.kind = kind
    this.toast.classList.remove('hidden')
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), ms)
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden')
  }

  /** A yes/no question over the view; resolves true on Continue. */
  confirm(title: string, body: string, ok = 'Continue'): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmBox.replaceChildren()
      const card = h('div', 'confirm-card')
      const yes = h('button', 'tool primary', ok)
      const no = h('button', 'tool', 'Cancel')
      const row = h('div', 'confirm-actions')
      row.append(no, yes)
      card.append(h('div', 'confirm-title', title), h('p', 'confirm-body', body), row)
      this.confirmBox.append(card)
      this.confirmBox.classList.remove('hidden')
      const done = (value: boolean) => {
        this.confirmBox.classList.add('hidden')
        resolve(value)
      }
      yes.addEventListener('click', () => done(true))
      no.addEventListener('click', () => done(false))
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
    try {
      localStorage.setItem('m8-song-explorer:info-pinned', pinned ? '1' : '0')
    } catch {
      // Not remembered.
    }
  }

  renderInfo(desc: CellDescription | null, canShow = false): void {
    const body = this.infoBody
    body.replaceChildren()
    this.info.classList.toggle('empty', !desc)
    this.infoTabTitle.textContent = desc?.title ?? ''
    if (desc) {
      // A short flash on the tab says the selection changed while the panel is closed.
      this.info.classList.remove('flash')
      void this.info.offsetWidth
      this.info.classList.add('flash')
    }
    const pin = h('button', 'info-pin', this.info.classList.contains('pinned') ? 'Unpin' : 'Pin')
    pin.addEventListener('click', () => this.togglePin())
    const head = h('div', 'info-head')
    head.append(h('div', 'info-kicker', 'SELECTION'), pin)
    if (!desc) {
      body.append(
        head,
        h('div', 'info-placeholder', 'Click a note, an FX cell or a table row. Turn the view (drag, or key 2) to reveal the FX columns and the instrument tables of the track.'),
      )
      return
    }
    const path = h('div', 'info-path')
    desc.path.forEach((p, i) => {
      if (i) path.append(h('span', 'sep', '›'))
      path.append(h('span', 'crumb', p))
    })
    body.append(head, path, h('div', 'info-title', desc.title))
    if (desc.parts.length) {
      const list = h('ul', 'info-parts')
      for (const part of desc.parts) {
        const li = h('li', `part part-${part.kind}`)
        li.append(h('span', 'part-kind', part.kind), h('span', 'part-text', part.text))
        list.append(li)
      }
      body.append(list)
    }
    if (desc.facts.length) {
      const dl = h('dl', 'info-facts')
      for (const [k, v] of desc.facts) dl.append(h('dt', '', k), h('dd', '', v))
      body.append(dl)
    }
    const show = h('button', 'tool primary show', 'Show on M8  ↵')
    show.disabled = !canShow
    show.title = canShow ? 'Move the M8 to this cell' : 'Connect through yam8d to drive the M8'
    show.addEventListener('click', () => this.onAction('show'))
    body.append(show)
  }
}
