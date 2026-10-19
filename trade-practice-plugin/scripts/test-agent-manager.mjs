import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentManager, deriveTitle } from '../lib/agentManager.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tp-agent-'))
  const archived = new Set()
  const sessions = new Map()
  const agents = new Map()
  const created = []
  const resumed = []
  const followed = []
  const titles = new Map()
  const handlers = new Map()
  let nextId = 0
  const registry = {
    async archiveSession(id) {
      archived.add(id)
    },
    async unarchiveSession(id) {
      archived.delete(id)
    },
  }
  const loop = {
    async createAgent(ownerCtx, options) {
      const id = options.sessionId
      const session = {
        id,
        snapshotEvents: () => [],
        append() {},
      }
      const agent = {
        id,
        session,
        status: 'idle',
        followup(message) {
          followed.push(message)
        },
        cancel() {},
      }
      agents.set(id, agent)
      sessions.set(id, session)
      created.push({ id, options })
      nextId += 1
      return {
        agent,
        async dispose() {
          agents.delete(id)
        },
      }
    },
    async resume(ownerCtx, options) {
      const id = options.resumeSessionId
      const session = sessions.get(id) || { id, snapshotEvents: () => [] }
      const agent = {
        id,
        session,
        status: 'idle',
        followup(message) {
          followed.push(message)
        },
        cancel() {},
      }
      agents.set(id, agent)
      resumed.push({ id, options })
      return {
        agent,
        async dispose() {
          agents.delete(id)
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'agentLoop') return loop
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'sessionTitle') {
        return {
          get: (session) => (titles.has(session.id) ? { title: titles.get(session.id) } : undefined),
          rename: (session, rawTitle) => {
            const title = String(rawTitle || '').trim()
            if (!title) throw new Error('empty title')
            titles.set(session.id, title)
            handlers.get('session/event')?.(session, {
              type: 'session/title',
              data: { title, source: { kind: 'user' } },
            })
            return { title }
          },
        }
      }
      return undefined
    },
    // Services are reachable only through ctx.get(), like a Cordis context that
    // did not declare them in `inject`; property access would throw there.
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { warn() {} },
  }
  const manager = new AgentManager({ ctx, root, dataRoot: () => join(root, 'data') })
  manager.attach()
  return {
    root,
    manager,
    archived,
    created,
    resumed,
    followed,
    sessions,
    agents,
    titles,
    emit(event, ...args) {
      handlers.get(event)?.(...args)
    },
    cleanup() {
      manager.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

await test('bootstrap creates one agent and reuses it', async () => {
  const h = harness()
  try {
    const first = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    assert.equal(first.available, true)
    assert.ok(first.activeId.startsWith('tp-'))
    assert.equal(first.agents.length, 1)
    const second = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    assert.equal(second.activeId, first.activeId)
    assert.equal(h.created.length, 1)
    const index = JSON.parse(readFileSync(join(h.root, 'agents.json'), 'utf8'))
    assert.equal(index.activeId, first.activeId)
  } finally {
    h.cleanup()
  }
})

await test('new agent archives the previous one, switch resumes it', async () => {
  const h = harness()
  try {
    const first = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const second = await h.manager.newAgent({ provider: 'p', model: 'm', symbol: 'GBPUSD' })
    assert.notEqual(second.activeId, first.activeId)
    assert.equal(h.archived.has(first.activeId), true)
    assert.equal(second.agents.length, 2)

    const switched = await h.manager.switchTo(first.activeId)
    assert.equal(switched.activeId, first.activeId)
    assert.equal(h.archived.has(first.activeId), false)
    assert.equal(h.archived.has(second.activeId), true)
    assert.equal(h.resumed.at(-1).id, first.activeId)
  } finally {
    h.cleanup()
  }
})

await test('delete removes the entry and archives the session', async () => {
  const h = harness()
  try {
    const first = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const snapshot = await h.manager.deleteAgent(first.activeId)
    assert.equal(snapshot.activeId, null)
    assert.equal(snapshot.agents.length, 0)
    assert.equal(h.archived.has(first.activeId), true)
  } finally {
    h.cleanup()
  }
})

await test('delete removes an archived agent without touching the active one', async () => {
  const h = harness()
  try {
    const first = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const second = await h.manager.newAgent({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const snapshot = await h.manager.deleteAgent(first.activeId)
    assert.equal(snapshot.activeId, second.activeId)
    assert.deepEqual(snapshot.agents.map((item) => item.id), [second.activeId])
    assert.equal(h.archived.has(first.activeId), true)
    const index = JSON.parse(readFileSync(join(h.root, 'agents.json'), 'utf8'))
    assert.deepEqual(index.agents.map((item) => item.id), [second.activeId])
  } finally {
    h.cleanup()
  }
})

await test('a function root is resolved per use so the index follows the workspace', async () => {
  const h = harness()
  try {
    const dir = join(h.root, 'late-workspace')
    const manager = new AgentManager({
      ctx: h.manager.ctx,
      root: () => join(dir, '.trade-practice'),
      dataRoot: () => join(dir, 'data'),
    })
    manager.attach()
    try {
      const snapshot = await manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
      assert.equal(snapshot.available, true)
      assert.equal(existsSync(join(dir, '.trade-practice', 'agents.json')), true)
    } finally {
      manager.dispose()
    }
  } finally {
    h.cleanup()
  }
})

await test('new agent is unnamed until its first message', async () => {
  const h = harness()
  try {
    const first = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    assert.equal(first.agents.length, 1)
    assert.equal(first.agents[0].title, '')
    assert.doesNotMatch(JSON.stringify(first.agents[0]), /交易练习/)
    const index = JSON.parse(readFileSync(join(h.root, 'agents.json'), 'utf8'))
    assert.equal(index.agents[0].title, '')
  } finally {
    h.cleanup()
  }
})

await test('first prompt names the session after the question, not the chart context', async () => {
  const h = harness()
  try {
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    await h.manager.sendPrompt({
      text: '【品种】XAUUSD · 1h\n【模式】逐 K 练习\n【问题】\n黄金现在怎么看？',
      imageRef: null,
      state: { question: '黄金现在怎么看？', mode: 'practice', cutoff: 1, drawings: [] },
    })
    assert.equal(h.manager.entryFor(snapshot.activeId).title, '黄金现在怎么看？')
    assert.equal(h.titles.get(snapshot.activeId), '黄金现在怎么看？')
    const index = JSON.parse(readFileSync(join(h.root, 'agents.json'), 'utf8'))
    assert.equal(index.agents[0].title, '黄金现在怎么看？')

    await h.manager.sendPrompt({
      text: 'x',
      imageRef: null,
      state: { question: '第二个问题', mode: 'view', drawings: [] },
    })
    assert.equal(h.manager.entryFor(snapshot.activeId).title, '黄金现在怎么看？')
  } finally {
    h.cleanup()
  }
})

await test('derived titles keep five words and 40 bytes', () => {
  assert.equal(deriveTitle('  画出 3340 支撑线 并 说明 依据 '), '画出 3340 支撑线 并 说明')
  assert.equal(deriveTitle('一'.repeat(60)).length, 13)
  assert.equal(deriveTitle(''), '')
})

await test('session title event names the agent, persists it, and notifies panels', async () => {
  const h = harness()
  try {
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const session = h.sessions.get(snapshot.activeId)
    let written = ''
    const res = {
      writableEnded: false,
      write(line) {
        written += line
      },
      on() {},
      end() {},
    }
    h.manager.addConnection(snapshot.activeId, res)
    h.emit('session/event', session, { type: 'session/title', data: { title: '黄金短线怎么做' } })
    assert.equal(h.manager.entryFor(snapshot.activeId).title, '黄金短线怎么做')
    assert.match(written, /"type":"title"/)
    assert.match(written, /黄金短线怎么做/)
    const index = JSON.parse(readFileSync(join(h.root, 'agents.json'), 'utf8'))
    assert.equal(index.agents[0].title, '黄金短线怎么做')
  } finally {
    h.cleanup()
  }
})

await test('legacy timestamp titles are treated as unnamed and switching adopts the stored title', async () => {
  const h = harness()
  try {
    const legacyId = 'tp-legacy'
    writeFileSync(join(h.root, 'agents.json'), JSON.stringify({
      version: 1,
      activeId: null,
      agents: [{
        id: legacyId,
        title: '交易练习 · XAUUSD · 2026/10/20 01:21:53',
        createdAt: 1,
        updatedAt: 1,
        provider: 'p',
        model: 'm',
        symbol: 'XAUUSD',
        archived: true,
      }],
    }))
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    assert.equal(h.manager.entryFor(legacyId).title, '')
    h.titles.set(snapshot.activeId, '黄金复盘')
    assert.equal(h.manager.snapshot().agents.find((item) => item.id === snapshot.activeId).title, '黄金复盘')

    h.titles.set(legacyId, '旧会话标题')
    await h.manager.switchTo(legacyId)
    assert.equal(h.manager.entryFor(legacyId).title, '旧会话标题')
  } finally {
    h.cleanup()
  }
})

await test('sendPrompt stores viewport state and asks the agent with a short history label', async () => {
  const h = harness()
  try {
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    await h.manager.sendPrompt({
      text: '【视图】full context\n【问题】\n现在怎么做？',
      imageRef: null,
      state: {
        question: '现在怎么做？',
        mode: 'practice',
        cutoff: 1760000000,
        viewRange: { first: 1759990000, last: 1760000000 },
        priceRange: { min: 3300, max: 3400 },
        symbol: 'XAUUSD',
        interval: '1h',
        dataStart: 1700000000,
        drawings: [],
      },
    })
    assert.equal(h.followed.length, 1)
    const message = h.followed[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.displayText, '现在怎么做？')
    assert.match(message.content[0].text, /现在怎么做/)
    assert.equal(h.manager.states.get(snapshot.activeId).cutoff, 1760000000)
  } finally {
    h.cleanup()
  }
})

await test('history shows the short user label, not the full prompt', async () => {
  const h = harness()
  try {
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    const session = h.sessions.get(snapshot.activeId)
    session.snapshotEvents = () => [
      { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user', displayText: '简短问题' }, content: [{ type: 'text', text: 'full prompt' }] } },
      { type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }] } } },
    ]
    const history = h.manager.history(snapshot.activeId)
    assert.deepEqual(history, [
      { role: 'user', text: '简短问题' },
      { role: 'assistant', text: '回答' },
    ])
  } finally {
    h.cleanup()
  }
})

await test('drawing command is sent over SSE and resolved by ack', async () => {
  const h = harness()
  try {
    const snapshot = await h.manager.bootstrap({ provider: 'p', model: 'm', symbol: 'XAUUSD' })
    let written = ''
    const res = {
      writableEnded: false,
      write(line) {
        written += line
      },
      on() {},
      end() {},
    }
    h.manager.addConnection(snapshot.activeId, res)
    const pending = h.manager.sendDrawing(snapshot.activeId, { action: 'add', drawing: { id: 'agent-1', type: 'hline', price: 3340 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const match = written.match(/"commandId":"([^"]+)"/)
    assert.ok(match)
    assert.match(written, /"type":"drawing"/)
    h.manager.ack(match[1], true)
    await pending
  } finally {
    h.cleanup()
  }
})

await test('setup registers scoped drawing/data tools, web allowlist, guard, and rules', async () => {
  const h = harness()
  try {
    const tools = []
    let restriction = null
    let guard = null
    let section = null
    const fakeCtx = {
      tools: {
        register(tool) {
          tools.push(tool)
        },
        restrict(filter) {
          restriction = filter
        },
        guard(fn) {
          guard = fn
        },
      },
      systemPrompt: {
        section(value) {
          section = value
        },
      },
    }
    h.manager.setupAgent(fakeCtx)
    assert.deepEqual(tools.map((tool) => tool.name), ['add_drawing', 'delete_drawing', 'clear_drawings', 'get_bars'])
    for (const tool of tools) {
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(tool.output.schema.type, 'object')
    }
    assert.deepEqual(restriction, { allow: ['web_search', 'web_fetch'] })
    assert.equal(typeof guard, 'function')
    assert.equal(section.name, 'trade-practice:rules')
    assert.match(section.text, /cutoff/)
    assert.equal(guard({ name: 'web_search', agent: { session: { id: 'view' } } }), undefined)
    h.manager.states.set('practice', { mode: 'practice' })
    assert.match(guard({ name: 'web_search', agent: { session: { id: 'practice' } } }), /练习模式禁用联网/)
    assert.equal(guard({ name: 'get_bars', agent: { session: { id: 'practice' } } }), undefined)
  } finally {
    h.cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
