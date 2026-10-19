import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBarsTool } from '../lib/chartDataTools.js'

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

const root = mkdtempSync(join(tmpdir(), 'tp-bars-'))
const symbolDir = join(root, 'XAUUSD', '1m')
mkdirSync(symbolDir, { recursive: true })
const rows = ['openTime,open,high,low,close,volume']
const start = Date.parse('2026-10-19T10:00:00Z')
for (let index = 0; index < 11; index++) {
  const time = new Date(start + index * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  rows.push(`${time},${3300 + index},${3301 + index},${3299 + index},${3300.5 + index},10`)
}
writeFileSync(join(symbolDir, '2026-10.csv'), rows.join('\n'))

const cutoff = Math.floor((start + 5 * 60 * 1000) / 1000)
const state = {
  symbol: 'XAUUSD',
  cutoff,
  interval: '1m',
}
const tool = createBarsTool({
  dataRoot: () => root,
  stateFor: (sessionId) => sessionId === 's1' ? state : null,
})
const exec = { agent: { session: { id: 's1' } } }

await test('get_bars stops at the replay cutoff', async () => {
  const result = await tool.execute({ interval: '1m', limit: 100 }, exec)
  assert.match(result.text, /2026-10-19T10:05:00\.000Z/)
  assert.doesNotMatch(result.text, /2026-10-19T10:06:00Z/)
  assert.doesNotMatch(result.text, /2026-10-19T10:10:00Z/)
})

await test('get_bars clamps an explicit end after the cutoff', async () => {
  const result = await tool.execute({ interval: '1m', limit: 100, end: '2026-10-19T10:10:00Z' }, exec)
  assert.match(result.text, /已截断到 2026-10-19T10:05:00.000Z/)
  assert.doesNotMatch(result.text, /2026-10-19T10:06:00Z/)
})

await test('get_bars rejects a start after the cutoff', async () => {
  await assert.rejects(
    () => tool.execute({ interval: '1m', start: '2026-10-19T10:10:00Z' }, exec),
    /未来数据|截止时间/,
  )
})

await test('get_bars requires session context', async () => {
  await assert.rejects(
    () => tool.execute({ interval: '1m' }, { agent: { session: { id: 'missing' } } }),
    /图表上下文/,
  )
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
