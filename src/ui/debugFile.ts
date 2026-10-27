// Debug log export: opened in the log analyzer page, or through the browser's download.

import type { DebugReport } from '../model/debugLog'

/** The analyzer is a static page next to the app (public/debug-log-analyzer.html). */
const ANALYZER_PAGE    = 'debug-log-analyzer.html'
/** Messages between the two pages: the analyzer says it is ready, the explorer answers with the log. */
const ANALYZER_READY   = 'm8-analyzer-ready'
const ANALYZER_REPORT  = 'm8-debug-log'
/** How long the analyzer gets to say it is ready (a dev server may compile it first). */
const ANALYZER_WAIT_MS = 4000

/**
 * Opens the analyzer in a new tab and hands it the log. The tab is opened at once, inside the
 * user's click (popup blockers allow it); the log follows when it is built and the page says it
 * is ready. False when the browser refuses the tab (a sandboxed iframe, a blocker) or the page
 * never answers: the caller then saves the file instead.
 */
export function openInAnalyzer(report: Promise<DebugReport>): Promise<boolean> {
  const win = window.open(new URL(ANALYZER_PAGE, document.baseURI).href, '_blank')
  if (!win) return Promise.resolve(false)
  const origin = location.origin === 'null' ? '*' : location.origin
  const ready  = new Promise<boolean>((resolve) => {
    const finish    = (value: boolean) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(value)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source === win && event.data?.type === ANALYZER_READY) finish(true)
    }
    const timer     = setTimeout(() => finish(false), ANALYZER_WAIT_MS)
    window.addEventListener('message', onMessage)
  })
  return Promise.all([report, ready]).then(([data, isReady]) => {
    if (!isReady) return false
    win.postMessage({
      type  : ANALYZER_REPORT,
      report: data
    }, origin)
    return true
  })
}

/** Saves the log as 'm8-explorer-debug-<song>-<date>-<time>.json'; returns the file name. */
export function downloadDebugReport(report: DebugReport, songName: string | null): string {
  const blob    = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' })
  const link    = document.createElement('a')
  const name    = (songName ?? 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const stamp   = report.exportedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  link.href     = URL.createObjectURL(blob)
  link.download = `m8-explorer-debug-${name}-${stamp}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  return link.download
}
