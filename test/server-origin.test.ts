import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originsForProject } from '../src/shared/runtime.ts'
import { PTYServer } from '../src/web/server/server.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pty-origin-test-'))
  process.env.PTY_RUNTIME_DIR = dir
})

afterEach(() => {
  delete process.env.PTY_RUNTIME_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('PTYServer origin publication', () => {
  test('publishes the bound address for its project, and removes it on dispose', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1', directory: '/proj' })
    try {
      const records = originsForProject('/proj')
      expect(records).toHaveLength(1)
      // The BOUND address is what matters — a reader connects to it.
      expect(records[0]?.port).toBe(server.server.port)
      expect(records[0]?.hostname).toBe('127.0.0.1')
      expect(records[0]?.pid).toBe(process.pid)
    } finally {
      server[Symbol.dispose]()
    }
    // Disposal is what keeps the directory from growing across restarts.
    expect(originsForProject('/proj')).toEqual([])
  })

  test('publishes nothing when the project is unknown', async () => {
    const server = await PTYServer.createServer({ hostname: '127.0.0.1' })
    try {
      expect(originsForProject('/proj')).toEqual([])
    } finally {
      server[Symbol.dispose]()
    }
  })
})
