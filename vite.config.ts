import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, normalizePath, type Plugin, searchForWorkspaceRoot } from 'vite'

/** The installed SDK's version, for the debug log. */
function sdkVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(new URL('./node_modules/@yam8d/m8-sdk/package.json', import.meta.url), 'utf8')) as { version: string }).version
  } catch {
    return null
  }
}

/**
 * Restarts the dev server when `bun install` rewrites the lockfile. A running server keeps serving the
 * SDK bundle it made at start (and the version it put in the debug log), so an SDK update would not
 * reach the page until someone restarts it; the restart re-reads the config and rebuilds the bundle.
 */
function restartOnInstall(): Plugin {
  return {
    name: 'restart-on-install',
    configureServer(server) {
      const lockfile = normalizePath(fileURLToPath(new URL('./bun.lock', import.meta.url)))
      server.watcher.add(lockfile)
      server.watcher.on('change', (file) => {
        if (file !== lockfile) return
        server.config.logger.info('bun.lock changed: restarting to pick up the installed packages', { timestamp: true })
        void server.restart()
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [restartOnInstall()],
  define: {
    __SDK_VERSION__: JSON.stringify(sdkVersion()),
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // three.js and the SDF text renderer are most of the bundle.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // The SDK is linked from ../yam8d/packages/m8-sdk
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../yam8d/packages/m8-sdk'] },
  },
})
