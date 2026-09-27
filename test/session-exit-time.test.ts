import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { manager } from '../src/plugin/pty/manager.ts'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { ManagedTestServer } from './utils.ts'

/** Poll until `check` yields a value, or give up. Keeps the test free of fixed sleeps. */
async function waitFor<T>(check: () => T | undefined, ms = 4000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  let value = check()
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = check()
  }
  return value
}

describe('session exit time', () => {
  let server: ManagedTestServer
  const stack = new DisposableStack()

  beforeAll(async () => {
    server = await ManagedTestServer.create()
    stack.use(server)
  })

  afterAll(() => {
    stack.dispose()
    manager.clearAllSessions()
  })

  async function spawn(command: string, args: string[]) {
    const title = `exit-time-${crypto.randomUUID()}`
    await ptySpawn.execute(
      { command, args, title, description: 'exit-time test' },
      {
        sessionID: 'test-parent-session',
        messageID: 'msg-1',
        agent: 'test-agent',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
        directory: '/tmp',
        worktree: '/tmp',
      }
    )
    const info = await waitFor(() => manager.list().find((s) => s.title === title))
    if (!info) throw new Error('session was never registered')
    return info
  }

  it('records when a session exited, and leaves it unset while running', async () => {
    const running = await spawn('sleep', ['30'])
    expect(running.status).toBe('running')
    // A running process has no end yet — the reader measures to "now" instead.
    expect(running.exitAt).toBeUndefined()
    expect(Number.isFinite(Date.parse(running.createdAt))).toBe(true)

    try {
      const started = await spawn('true', [])
      const exited = await waitFor(() => {
        const session = manager.get(started.id)
        return session && session.status !== 'running' && session.status !== 'killing'
          ? session
          : undefined
      })
      expect(exited?.status).toBe('exited')

      const createdAt = exited?.createdAt
      const exitAt = exited?.exitAt
      if (!createdAt || !exitAt) throw new Error('expected both timestamps on a finished session')
      expect(Date.parse(exitAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    } finally {
      manager.kill(running.id, true)
    }
  })
})
