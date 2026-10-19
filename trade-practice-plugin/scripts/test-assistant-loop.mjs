import assert from 'node:assert/strict'
import { runAssistant } from '../index.js'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok ${name}`)
    })
    .catch((error) => {
      failed += 1
      console.log(`FAIL ${name}: ${error.message}`)
    })
}

function collect() {
  const events = []
  const res = {
    write(chunk) {
      const line = String(chunk).split('\n').find((part) => part.startsWith('data: '))
      if (line) events.push(JSON.parse(line.slice(6)))
    },
  }
  return { res, events }
}

const range = { first: 1760000000, last: 1760003600 }
const input = {
  symbol: 'XAUUSD',
  interval: '5m',
  mode: 'view',
  replayTime: '2026-10-19T01:00:00Z',
  visibleBars: 12,
  question: '画一条 3340 支撑线',
  viewport: { range, priceRange: { min: 3300, max: 3400 }, bars: [] },
  drawings: [],
}

function toolRound() {
  return (async function* () {
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'call-1',
      name: 'add_drawing',
      argumentsDelta: '{"type":"hline","price":3340}',
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
}

function textRound(text) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

await test('tool call becomes a drawing event, tool result, and final text', async () => {
  const seen = []
  let round = 0
  const llm = {
    stream(options) {
      seen.push(options)
      round += 1
      return round === 1 ? toolRound() : textRound('已画好水平线。')
    },
  }
  const { res, events } = collect()
  await runAssistant({
    llm,
    res,
    provider: 'test',
    model: 'test-model',
    input,
    signal: new AbortController().signal,
    imageRef: null,
  })

  assert.equal(seen.length, 2)
  assert.equal(seen[0].tools.length, 3)
  assert.match(seen[0].messages[0].content[0].text, /画一条 3340 支撑线/)
  assert.match(seen[0].messages[0].content[0].text, /【视图时间范围】/)
  assert.equal(seen[1].messages.length, 3)
  assert.equal(seen[1].messages[1].role, 'assistant')
  assert.equal(seen[1].messages[1].content[0].type, 'tool-call')
  assert.equal(seen[1].messages[2].role, 'tool')
  assert.equal(seen[1].messages[2].toolCallId, 'call-1')

  const drawing = events.find((event) => event.type === 'drawing')
  assert.equal(drawing.command.action, 'add')
  assert.equal(drawing.command.drawing.type, 'hline')
  assert.equal(drawing.command.drawing.price, 3340)
  assert.ok(events.some((event) => event.type === 'tool' && event.ok === true))
  assert.ok(events.some((event) => event.type === 'delta' && event.text.includes('已画好')))
})

await test('stops after the tool-round cap and asks for a final answer', async () => {
  const seen = []
  const llm = {
    stream(options) {
      seen.push(options)
      return toolRound()
    },
  }
  const { res, events } = collect()
  await runAssistant({
    llm,
    res,
    provider: 'test',
    model: 'test-model',
    input: { ...input, question: '画三条线' },
    signal: new AbortController().signal,
    imageRef: null,
  })

  assert.equal(seen.length, 4)
  assert.equal(seen[3].tools, undefined)
  const drawings = events.filter((event) => event.type === 'drawing')
  assert.equal(drawings.length, 3)
})

await test('model error event is forwarded', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
      })()
    },
  }
  const { res, events } = collect()
  await runAssistant({
    llm,
    res,
    provider: 'test',
    model: 'test-model',
    input,
    signal: new AbortController().signal,
    imageRef: null,
  })
  assert.ok(events.some((event) => event.type === 'error' && event.message === 'boom'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
