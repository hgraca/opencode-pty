import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// opencode resolves a package's TUI plugin through the LITERAL
// `exports["./tui"]` key — a wildcard export does not satisfy it — and then
// imports the file that key points at. Pinning that contract here is what stops
// the sidebar from silently never loading: a missing or renamed key produces no
// error at all, the panel just never appears.

const root = join(import.meta.dir, '..')
const pkg = (await Bun.file(join(root, 'package.json')).json()) as {
  exports?: Record<string, { types?: string; default?: string }>
}

describe('package TUI plugin contract', () => {
  test('declares an explicit ./tui export', () => {
    expect(pkg.exports?.['./tui']).toBeDefined()
  })

  test('./tui points at the built sidebar entry, with types', () => {
    const entry = pkg.exports?.['./tui']
    expect(entry?.default).toBe('./dist/src/tui/index.js')
    expect(entry?.types).toBe('./dist/src/tui/index.d.ts')
  })

  test('the source the build emits from exists', () => {
    expect(existsSync(join(root, 'src/tui/index.ts'))).toBe(true)
  })

  // That the build actually EMITS this entry is asserted in
  // npm-pack-structure.test.ts, against the packed tarball. Asserting dist/ on
  // disk here would race the `npm pack` those tests run, whose prepack does
  // `bun clean` (rm -rf dist).
})
