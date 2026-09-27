import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RUNTIME_DIR_NAME,
  candidateOrigins,
  originsForProject,
  projectKey,
  readOrigins,
  removeOrigin,
  runtimeDir,
  writeOrigin,
} from '../src/shared/runtime.ts'

// A pid that cannot be running: it exceeds any practical pid_max, so the kernel
// reports ESRCH/EINVAL rather than a live process.
const DEAD_PID = 9_999_999

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pty-runtime-test-'))
  process.env.PTY_RUNTIME_DIR = dir
})

afterEach(() => {
  delete process.env.PTY_RUNTIME_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('runtimeDir', () => {
  test('honours the PTY_RUNTIME_DIR override', () => {
    expect(runtimeDir()).toBe(dir)
  })

  test('defaults to a per-user directory named for the plugin', () => {
    delete process.env.PTY_RUNTIME_DIR
    const saved = process.env.XDG_RUNTIME_DIR
    delete process.env.XDG_RUNTIME_DIR
    expect(runtimeDir().endsWith(RUNTIME_DIR_NAME)).toBe(true)
    if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved
  })
})

describe('projectKey', () => {
  test('is stable for the same path and differs for another', () => {
    expect(projectKey('/a/b')).toBe(projectKey('/a/b'))
    expect(projectKey('/a/b')).not.toBe(projectKey('/a/c'))
  })

  test('is filesystem-safe', () => {
    expect(projectKey('/a/b c\\d')).toMatch(/^[a-f0-9]+$/)
  })
})

describe('writeOrigin / readOrigins', () => {
  test('round-trips a record for this process', () => {
    const file = writeOrigin({ directory: '/proj', hostname: '::1', port: 45037 })
    expect(file).not.toBeNull()
    const records = readOrigins()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      pid: process.pid,
      hostname: '::1',
      port: 45037,
      directory: '/proj',
    })
  })

  test('refuses to record without a project path to key on', () => {
    expect(writeOrigin({ hostname: '::1', port: 1 })).toBeNull()
  })

  test('refuses a non-string project path — the V2 host hands over an object', () => {
    // V2's ctx.worktree is a domain object, not a path. Passing it through used
    // to reach createHash and throw, taking server creation down with it.
    expect(writeOrigin({ worktree: { directory: '/proj' }, hostname: '::1', port: 1 })).toBeNull()
    expect(writeOrigin({ directory: 42, hostname: '::1', port: 1 })).toBeNull()
    expect(readOrigins()).toEqual([])
  })

  test('is atomic — no temp file survives the write', () => {
    expect(writeOrigin({ directory: '/proj', hostname: '::1', port: 1 })).not.toBeNull()
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('records the project path canonically, so a symlinked view still matches', () => {
    const real = mkdtempSync(join(tmpdir(), 'pty-runtime-real-'))
    const link = join(dir, 'link-to-real')
    symlinkSync(real, link)
    try {
      writeOrigin({ directory: link, hostname: '::1', port: 7 })
      expect(originsForProject(real)).toHaveLength(1)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  test('keeps a record whose owner is gone — a probe decides, not a pid', () => {
    // PID liveness is namespace-sensitive (a container's pid is invisible from
    // the host) and a partial read is indistinguishable from corruption, so a
    // reader never deletes. /health is what filters it.
    const file = join(dir, `${projectKey('/dead')}-${DEAD_PID}.json`)
    writeFileSync(
      file,
      JSON.stringify({ pid: DEAD_PID, hostname: '::1', port: 1, directory: '/dead' })
    )
    expect(readOrigins()).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
  })

  test('ignores a malformed record instead of deleting it', () => {
    const file = join(dir, 'broken.json')
    writeFileSync(file, 'not json at all')
    expect(readOrigins()).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  test('ignores a well-formed JSON file missing the required fields', () => {
    const file = join(dir, 'partial.json')
    writeFileSync(file, JSON.stringify({ hostname: '::1' }))
    expect(readOrigins()).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  test('ignores non-json files', () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    expect(readOrigins()).toEqual([])
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  test('returns nothing when the directory does not exist', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(readOrigins()).toEqual([])
  })

  test('removeOrigin tolerates null and a missing file', () => {
    expect(() => removeOrigin(null)).not.toThrow()
    expect(() => removeOrigin(join(dir, 'nope.json'))).not.toThrow()
  })
})

describe('originsForProject', () => {
  test('an exact directory match wins over a shared worktree', () => {
    // Two instances of one worktree differ only by directory. Returning both
    // would leave the panel idle on an unattended poll, unable to tell them apart.
    writeOrigin({ directory: '/repo/subA', worktree: '/repo', hostname: '::1', port: 1 })
    writeOrigin({ directory: '/repo/subB', worktree: '/repo', hostname: '::1', port: 2 })
    const mine = originsForProject('/repo/subA', '/repo')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.port).toBe(1)
  })

  test('falls back to the worktree when no directory matches', () => {
    writeOrigin({ directory: '/repo/subA', worktree: '/repo', hostname: '::1', port: 1 })
    const mine = originsForProject('/somewhere-else', '/repo')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.port).toBe(1)
  })

  test('keeps a record that matches only on the worktree', () => {
    writeOrigin({ worktree: '/proj-b', hostname: '::1', port: 2 })
    const mine = originsForProject('/proj-b/sub', '/proj-b')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.port).toBe(2)
  })

  test('excludes another project', () => {
    writeOrigin({ directory: '/proj-a', hostname: '::1', port: 1 })
    expect(originsForProject('/proj-other')).toEqual([])
  })

  test('returns nothing when asked with no path at all', () => {
    writeOrigin({ directory: '/proj-a', hostname: '::1', port: 1 })
    expect(originsForProject()).toEqual([])
  })
})

describe('candidateOrigins', () => {
  test('brackets an IPv6 literal', () => {
    expect(candidateOrigins({ hostname: '::1', port: 45037 })).toEqual(['http://[::1]:45037'])
  })

  test('leaves an IPv4 literal alone', () => {
    expect(candidateOrigins({ hostname: '127.0.0.1', port: 1 })).toEqual(['http://127.0.0.1:1'])
  })

  test('probes loopback when the server bound a wildcard', () => {
    expect(candidateOrigins({ hostname: '0.0.0.0', port: 1 })).toEqual([
      'http://[::1]:1',
      'http://127.0.0.1:1',
    ])
    expect(candidateOrigins({ hostname: '::', port: 1 })).toEqual([
      'http://[::1]:1',
      'http://127.0.0.1:1',
    ])
  })
})

// Guard: the suite must be able to create the directory the module writes into.
test('writeOrigin creates the runtime directory when missing', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(tmpdir(), { recursive: true })
  expect(writeOrigin({ directory: '/proj', hostname: '::1', port: 3 })).not.toBeNull()
  expect(existsSync(dir)).toBe(true)
})
