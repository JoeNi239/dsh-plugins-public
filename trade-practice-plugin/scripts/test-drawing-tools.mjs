import assert from 'node:assert/strict'
import { DRAWING_TOOLS, describeDrawing, executeDrawingTool, parseDrawingTime } from '../lib/drawingTools.js'

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

const barsRange = {
  first: Date.parse('2026-10-19T10:00:00Z') / 1000,
  last: Date.parse('2026-10-19T12:00:00Z') / 1000,
}
const context = { barsRange }

test('tool schemas exist', () => {
  const names = DRAWING_TOOLS.map((tool) => tool.name)
  assert.deepEqual(names, ['add_drawing', 'delete_drawing', 'clear_drawings'])
  for (const tool of DRAWING_TOOLS) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 10)
  }
})

test('hline needs only price', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline', price: 3340.5 }, context)
  assert.equal(result.ok, true)
  assert.equal(result.command.action, 'add')
  assert.equal(result.command.drawing.type, 'hline')
  assert.equal(result.command.drawing.price, 3340.5)
  assert.equal(result.command.drawing.color, '#f0b429')
  assert.ok(result.command.drawing.id.startsWith('agent-'))
  assert.match(result.message, /水平线/)
})

test('hline rejects missing price', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline' }, context)
  assert.equal(result.ok, false)
  assert.match(result.message, /price/)
})

test('vline uses ISO time', () => {
  const result = executeDrawingTool(
    'add_drawing',
    { type: 'vline', time: '2026-10-19T11:00:00Z' },
    context,
  )
  assert.equal(result.ok, true)
  assert.equal(result.command.drawing.t, Date.parse('2026-10-19T11:00:00Z') / 1000)
})

test('ISO time without zone is treated as UTC', () => {
  assert.equal(parseDrawingTime('2026-10-19T11:00:00'), Date.parse('2026-10-19T11:00:00Z') / 1000)
})

test('numeric milliseconds convert to seconds', () => {
  assert.equal(parseDrawingTime(barsRange.last * 1000), barsRange.last)
})

test('numeric string seconds accepted', () => {
  assert.equal(parseDrawingTime(String(barsRange.last)), barsRange.last)
})

test('trend builds both anchors', () => {
  const result = executeDrawingTool('add_drawing', {
    type: 'trend',
    time: '2026-10-19T10:30:00Z',
    price: 3330,
    time2: '2026-10-19T11:30:00Z',
    price2: 3350,
  }, context)
  assert.equal(result.ok, true)
  const drawing = result.command.drawing
  assert.equal(drawing.t1, Date.parse('2026-10-19T10:30:00Z') / 1000)
  assert.equal(drawing.p1, 3330)
  assert.equal(drawing.t2, Date.parse('2026-10-19T11:30:00Z') / 1000)
  assert.equal(drawing.p2, 3350)
  assert.equal(drawing.type, 'trend')
})

test('trend requires second anchor', () => {
  const result = executeDrawingTool('add_drawing', {
    type: 'trend',
    time: '2026-10-19T10:30:00Z',
    price: 3330,
  }, context)
  assert.equal(result.ok, false)
  assert.match(result.message, /time2/)
})

test('channel requires third anchor', () => {
  const base = {
    type: 'channel',
    time: '2026-10-19T10:30:00Z',
    price: 3330,
    time2: '2026-10-19T11:00:00Z',
    price2: 3340,
  }
  assert.equal(executeDrawingTool('add_drawing', base, context).ok, false)
  const result = executeDrawingTool('add_drawing', { ...base, time3: '2026-10-19T11:30:00Z', price3: 3345 }, context)
  assert.equal(result.ok, true)
  assert.equal(result.command.drawing.t3, Date.parse('2026-10-19T11:30:00Z') / 1000)
})

test('time after the replay cutoff is rejected', () => {
  const result = executeDrawingTool('add_drawing', {
    type: 'vline',
    time: '2026-10-20T00:00:00Z',
  }, context)
  assert.equal(result.ok, false)
  assert.match(result.message, /回放截止时间|未来数据/)
})

test('older anchors are allowed when they are before the current view', () => {
  const result = executeDrawingTool('add_drawing', {
    type: 'trend',
    time: '2026-10-19T10:00:00Z',
    price: 3330,
    time2: '2026-10-19T10:30:00Z',
    price2: 3340,
  }, { ...context, viewRange: { first: Date.parse('2026-10-19T11:00:00Z') / 1000, last: Date.parse('2026-10-19T12:00:00Z') / 1000 } })
  assert.equal(result.ok, true)
  assert.match(result.message, /当前视图之前/)
})

test('text drawing needs text content', () => {
  const base = { type: 'text', time: '2026-10-19T11:00:00Z', price: 3340 }
  assert.equal(executeDrawingTool('add_drawing', base, context).ok, false)
  const result = executeDrawingTool('add_drawing', { ...base, text: '阻力' }, context)
  assert.equal(result.ok, true)
  assert.equal(result.command.drawing.text, '阻力')
  assert.equal(result.command.drawing.t, Date.parse('2026-10-19T11:00:00Z') / 1000)
})

test('unknown color falls back to the type default', () => {
  const result = executeDrawingTool('add_drawing', { type: 'rect', color: 'red', t: '', time: '2026-10-19T10:30:00Z' }, context)
  assert.equal(result.ok, false)
  const ok = executeDrawingTool('add_drawing', {
    type: 'rect',
    color: 'red',
    time: '2026-10-19T10:30:00Z',
    price: 3330,
    time2: '2026-10-19T11:00:00Z',
    price2: 3340,
  }, context)
  assert.equal(ok.ok, true)
  assert.equal(ok.command.drawing.color, '#ba68c8')
})

test('hex color is kept', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline', price: 1, color: '#123abc' }, context)
  assert.equal(result.command.drawing.color, '#123abc')
})

test('unknown type is rejected', () => {
  const result = executeDrawingTool('add_drawing', { type: 'squiggle' }, context)
  assert.equal(result.ok, false)
})

test('delete produces a delete command', () => {
  const result = executeDrawingTool('delete_drawing', { id: 12345 }, context)
  assert.equal(result.ok, true)
  assert.deepEqual(result.command, { action: 'delete', id: '12345' })
})

test('delete needs an id', () => {
  const result = executeDrawingTool('delete_drawing', {}, context)
  assert.equal(result.ok, false)
})

test('clear produces a clear command only when asked', () => {
  const result = executeDrawingTool('clear_drawings', {}, { ...context, question: '把图上的线全部删掉' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.command, { action: 'clear' })
})

test('clear is refused when the user did not ask', () => {
  const result = executeDrawingTool('clear_drawings', {}, { ...context, question: '帮我分析结构' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没有明确要求清空/)
})

test('unknown tool is rejected', () => {
  const result = executeDrawingTool('paint_chart', {}, context)
  assert.equal(result.ok, false)
})

test('numeric string price with thousands separator is accepted', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline', price: '3,340.5' }, context)
  assert.equal(result.ok, true)
  assert.equal(result.command.drawing.price, 3340.5)
})

test('price outside the viewport price range only warns', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline', price: 9999 }, {
    ...context,
    priceRange: { min: 3300, max: 3400 },
  })
  assert.equal(result.ok, true)
  assert.match(result.message, /视图价格范围/)
})

test('price inside the viewport price range has no warning', () => {
  const result = executeDrawingTool('add_drawing', { type: 'hline', price: 3340 }, {
    ...context,
    priceRange: { min: 3300, max: 3400 },
  })
  assert.equal(result.ok, true)
  assert.doesNotMatch(result.message, /视图价格范围/)
})

test('describeDrawing includes id, type and anchor', () => {
  const text = describeDrawing({
    id: 'agent-1',
    type: 'hline',
    price: 3340.5,
  })
  assert.match(text, /id=agent-1/)
  assert.match(text, /hline/)
  assert.match(text, /3340\.5/)
})

test('generated ids are unique', () => {
  const first = executeDrawingTool('add_drawing', { type: 'hline', price: 1 }, context)
  const second = executeDrawingTool('add_drawing', { type: 'hline', price: 2 }, context)
  assert.notEqual(first.command.drawing.id, second.command.drawing.id)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
