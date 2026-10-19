import assert from 'node:assert/strict'
import { buildAskPrompt, sampleBars } from '../index.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

const start = Date.parse('2026-10-19T00:00:00Z') / 1000
const bars = Array.from({ length: 500 }, (_, index) => {
  const time = start + index * 300
  const open = 3300 + index * 0.1
  return {
    time,
    openTime: new Date(time * 1000).toISOString(),
    open,
    high: open + 3,
    low: open - 2,
    close: open + 1,
  }
})

test('sampleBars keeps first/last and bounds rows', () => {
  const sampled = sampleBars(bars, 320)
  assert.equal(sampled.sampled, true)
  assert.equal(sampled.bars.length, 320)
  assert.equal(sampled.bars[0].time, bars[0].time)
  assert.equal(sampled.bars.at(-1).time, bars.at(-1).time)
})

test('sampleBars returns the input when it fits', () => {
  const short = bars.slice(0, 100)
  const sampled = sampleBars(short, 320)
  assert.equal(sampled.sampled, false)
  assert.equal(sampled.bars, short)
})

test('prompt uses the viewport range, price range and sampled bars', () => {
  const prompt = buildAskPrompt({
    symbol: 'XAUUSD',
    interval: '5m',
    mode: 'view',
    replayTime: '2026-10-19T05:00:00Z',
    visibleBars: 500,
    viewport: {
      range: { first: bars[0].time, last: bars.at(-1).time },
      priceRange: { min: 3298, max: 3355 },
      bars,
    },
    drawings: [{ id: 'agent-1', type: 'hline', price: 3340 }],
    question: '如果是你会怎么画？',
  }, { imageAttached: true })

  assert.match(prompt, /【视图时间范围】2026-10-19T00:00:00.000Z/)
  assert.match(prompt, /【视图价格范围】3298 ～ 3355/)
  assert.match(prompt, /【当前视图截图】已附带/)
  assert.match(prompt, /【视图内 K 线】已抽样 320\/500 根/)
  assert.match(prompt, /id=agent-1/)
  assert.match(prompt, /如果是你会怎么画？/)
})

test('prompt without a viewport falls back to recent bars', () => {
  const prompt = buildAskPrompt({
    symbol: 'XAUUSD',
    interval: '1m',
    mode: 'practice',
    visibleBars: 12,
    recentBars: bars.slice(0, 12),
    question: '结构如何？',
  }, { imageAttached: false })

  assert.match(prompt, /【当前视图截图】未附带/)
  assert.match(prompt, /【视图内 K 线】OHLC/)
  assert.doesNotMatch(prompt, /已抽样/)
  assert.equal(prompt.includes('2026-10-19T00:00:00.000Z'), true)
})

test('prompt labels user and AI drawings with view state', () => {
  const prompt = buildAskPrompt({
    symbol: 'XAUUSD',
    interval: '1h',
    mode: 'practice',
    cutoff: bars.at(-1).time,
    visibleBars: 100,
    viewport: {
      range: { first: bars[0].time, last: bars.at(-1).time },
      priceRange: { min: 3300, max: 3400 },
      bars: bars.slice(0, 100),
    },
    drawings: [
      { id: 'agent-1', type: 'hline', price: 3340, source: 'agent', color: '#f0b429', inView: true },
      { id: 123, type: 'trend', t1: bars[0].time, p1: 3300, t2: bars[1].time, p2: 3310, source: 'user', color: '#64b5f6', inView: false },
    ],
    question: '分析我画的线',
  }, { imageAttached: true })

  assert.match(prompt, /【回放截止 cutoff】/)
  assert.match(prompt, /AI · id=agent-1 · hline/)
  assert.match(prompt, /用户 · id=123 · trend/)
  assert.match(prompt, /当前视图内/)
  assert.match(prompt, /视图外/)
})

test('prompt handles an empty drawing list', () => {
  const prompt = buildAskPrompt({ question: 'test' }, { imageAttached: false })
  assert.match(prompt, /【图上画线】无/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
