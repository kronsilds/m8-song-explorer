// The layers of src/ import only from the ones above them: model/ from itself, m8/ from model/,
// the 3D view (scene/) and the HUD (ui/) from model/ (never from each other or from m8/), app/
// from all of them, main.ts from app/. three.js stays in the 3D view, the device SDK out of it.

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

type Layer = 'model' | 'm8' | 'scene' | 'ui' | 'app' | 'root'

const SRC = resolve(import.meta.dir, '../src')

/** The layers each layer may import from, itself included; root is main.ts and the other files at the top of src/. */
const ALLOWED: Record<Layer, Layer[]> = {
  model: ['model'],
  m8   : ['model', 'm8'],
  scene: ['model', 'scene'],
  ui   : ['model', 'ui'],
  app  : ['model', 'm8', 'scene', 'ui', 'app'],
  root : ['app', 'root']
}

/** Packages kept to some layers. */
const PACKAGES: [pattern: RegExp, layers: Layer[]][] = [
  [/^(three|troika-three-text)(\/|$)/, ['scene', 'root']],
  [/^@yam8d\/m8-sdk$/, ['model', 'm8', 'app']],
]

/** `import ... from 'x'`, `export ... from 'x'`, `import 'x'` and `import('x')`. */
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

function layerOf(path: string): Layer {
  const [top, ...rest] = relative(SRC, path).split(/[\\/]/)
  if (rest.length === 0) return 'root'
  if (top === 'root' || !(top in ALLOWED)) throw new Error(`${relative(SRC, path)}: src/${top}/ is not a known layer`)
  return top as Layer
}

const files   = readdirSync(SRC, {
  recursive: true,
  encoding : 'utf8'
})
  .filter((file) => file.endsWith('.ts'))
  .map((file) => join(SRC, file))
const imports = files.flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => ({
    file,
    from: layerOf(file),
    spec: match[1] ?? match[2] ?? match[3] ?? ''
  })),
)
const named   = (file: string) => relative(SRC, file).replaceAll('\\', '/')

test('the scan finds the imports', () => {
  expect(files.length).toBeGreaterThan(50)
  expect(imports.length).toBeGreaterThan(300)
})

test('each layer imports only from the layers above it', () => {
  const crossing = imports
    .filter(({ spec }) => spec.startsWith('.'))
    .map((found) => ({
      ...found,
      to: layerOf(resolve(dirname(found.file), found.spec))
    }))
    .filter(({ from, to }) => !ALLOWED[from].includes(to))
    .map(({ file, from, spec, to }) => `${named(file)} (${from}) imports ${spec} (${to})`)
  expect(crossing).toEqual([])
})

test('three.js stays in the 3D view, the device SDK out of the views', () => {
  const misplaced = imports.flatMap(({ file, from, spec }) => {
    const rule = PACKAGES.find(([pattern]) => pattern.test(spec))
    return rule && !rule[1].includes(from) ? [`${named(file)} (${from}) imports ${spec}`] : []
  })
  expect(misplaced).toEqual([])
})
