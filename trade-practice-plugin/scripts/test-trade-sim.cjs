#!/usr/bin/env node
/**
 * Trade-simulator regression checks (gap-through fills).
 *
 * The simulator is embedded in client.js for the browser bundle, so this test
 * extracts the self-contained `tradeSim` IIFE and exercises it directly.
 *
 *   node scripts/test-trade-sim.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'client.js')
const text = fs.readFileSync(file, 'utf8')
const start = text.indexOf('const tradeSim = (function () {')
if (start < 0) throw new Error('tradeSim block not found in client.js')
const endMarker = '\n    })()'
const end = text.indexOf(endMarker, start)
if (end < 0) throw new Error('tradeSim block end not found in client.js')
const sim = eval(text.slice(start + 'const tradeSim = '.length, end + endMarker.length))

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra))
}
function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps
}
const spec = { contractSize: 100, spread: 0.25 }
const half = spec.spread / 2

function accountWith(overrides) {
  return {
    id: 'a',
    name: 'test',
    initial: 10000,
    balance: 10000,
    realizedPnl: 0,
    position: null,
    pendingOrders: [],
    history: [],
    ...overrides,
  }
}
function pending(over) {
  return {
    id: 'o1',
    symbol: 'XAUUSD',
    type: 'limit',
    side: 'long',
    lots: 1,
    limitPrice: 100,
    sl: 95,
    tp: 105,
    createdTime: '2026-01-01T00:00:00Z',
    ...over,
  }
}
function bar(over) {
  return {
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    openTime: '2026-01-01T00:01:00Z',
    time: 1767225660,
    ...over,
  }
}
function longPos(over) {
  return {
    position: { symbol: 'XAUUSD', side: 'long', lots: 1, entry: 100, sl: 95, tp: 105, openTime: '2026-01-01T00:00:00Z' },
    ...over,
  }
}
function shortPos(over) {
  return {
    position: { symbol: 'XAUUSD', side: 'short', lots: 1, entry: 100, sl: 105, tp: 95, openTime: '2026-01-01T00:00:00Z' },
    ...over,
  }
}

// --- SL / TP gap-through ---
let a = accountWith(longPos())
let r = sim.processBarExit(a, { open: 94, high: 94.5, low: 93, close: 93.5, openTime: '2026-01-01T00:01:00Z' }, spec)
check('long gap SL price', r && near(r.exitPrice, 94), r)
check('long gap SL reason', r && r.reason === 'sl', r)
check('long gap SL flag', r && r.gap === true, r)
check('long gap SL pnl', r && near(r.pnl, (94 - 100) * 100), r)
check('history gap flag', a.history[0] && a.history[0].gap === true)

a = accountWith(longPos())
r = sim.processBarExit(a, { open: 106, high: 107, low: 105.5, close: 106.5, openTime: '2026-01-01T00:01:00Z' }, spec)
check('long gap TP price', r && near(r.exitPrice, 106), r)
check('long gap TP flag', r && r.reason === 'tp' && r.gap === true, r)

a = accountWith(longPos())
r = sim.processBarExit(a, { open: 100.5, high: 101, low: 94.8, close: 96, openTime: '2026-01-01T00:01:00Z' }, spec)
check('long normal SL price', r && near(r.exitPrice, 95) && r.gap === false, r)

a = accountWith(longPos())
r = sim.processBarExit(a, { open: 100, high: 106, low: 94, close: 100, openTime: '2026-01-01T00:01:00Z' }, spec)
check('long both hit -> SL first', r && near(r.exitPrice, 95) && r.reason === 'sl' && r.gap === false, r)

a = accountWith(shortPos())
r = sim.processBarExit(a, { open: 106, high: 106.2, low: 105.5, close: 105.8, openTime: '2026-01-01T00:01:00Z' }, spec)
check('short gap SL price', r && near(r.exitPrice, 106) && r.reason === 'sl' && r.gap === true, r)

a = accountWith(shortPos())
r = sim.processBarExit(a, { open: 94, high: 94.5, low: 93.8, close: 94.2, openTime: '2026-01-01T00:01:00Z' }, spec)
check('short gap TP price', r && near(r.exitPrice, 94) && r.reason === 'tp' && r.gap === true, r)

a = accountWith(longPos())
r = sim.processBarExit(a, { open: 94, high: 94.5, low: 93, close: 93.5, openTime: '2026-01-01T00:01:00Z' }, spec, { gapFill: false })
check('gapFill off keeps old SL price', r && near(r.exitPrice, 95) && r.gap === false, r)

// --- pending limit entries ---
a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99, high: 100.2, low: 98, close: 99.5 }), 1, 'XAUUSD', spec)
check('long limit gap fill at open+half', r && near(r.entry, 99 + half) && r.gap === true, r)
check('position records entry gap', a.position && a.position.entryGap === true)
check('pending removed', a.pendingOrders.length === 0)

a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 100.5, high: 100.8, low: 99.9, close: 100.4 }), 1, 'XAUUSD', spec)
check('long limit touch fill at limit', r && near(r.entry, 100 + half) && r.gap === false, r)

a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99.99, high: 100.2, low: 99.9, close: 100.1 }), 1, 'XAUUSD', spec)
check('long gap fill never worse than limit', r && near(r.entry, 100) && r.gap === true, r)

a = accountWith({ pendingOrders: [pending({ side: 'short' })] })
r = sim.tryFillPendingOnBar(a, bar({ open: 101, high: 101.2, low: 100.5, close: 100.8 }), 1, 'XAUUSD', spec)
check('short limit gap fill at open-half', r && near(r.entry, 101 - half) && r.gap === true, r)

a = accountWith({ pendingOrders: [pending({ side: 'short' })] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99.5, high: 100.1, low: 99.2, close: 99.4 }), 1, 'XAUUSD', spec)
check('short limit touch fill at limit', r && near(r.entry, 100 - half) && r.gap === false, r)

a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99, high: 100.2, low: 98, close: 99.5 }), 1, 'XAUUSD', spec, { gapFill: false })
check('gapFill off keeps old limit fill', r && near(r.entry, 100 + half) && r.gap === false, r)

a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 100, high: 100.5, low: 99.5, close: 100, openTime: '2026-01-01T00:00:00Z', time: 1767225600 }), 1, 'XAUUSD', spec)
check('same-bar order not filled', r === null, r)

a = accountWith({ pendingOrders: [pending({ symbol: 'GBPUSD' })] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99, high: 100.2, low: 98, close: 99.5 }), 1, 'XAUUSD', spec)
check('other-symbol pending ignored', r === null, r)

// --- simulateBarOnAccount integration ---
a = accountWith({ pendingOrders: [pending()] })
let out = sim.simulateBarOnAccount(a, bar({ open: 99, high: 100.2, low: 98, close: 99.5 }), 1, 'XAUUSD', spec, { gapFill: true })
check('simulate fill', out.fill && out.fill.gap === true && out.account.position, out)
check('simulate original untouched', a.position === null && a.pendingOrders.length === 1)

a = accountWith(longPos())
out = sim.simulateBarOnAccount(a, bar({ open: 94, high: 94.5, low: 93, close: 93.5 }), 1, 'XAUUSD', spec, { gapFill: true })
check('simulate gap SL', out.exit && out.exit.gap === true && near(out.exit.exitPrice, 94), out)

// Defaults (options omitted) behave as gapFill: true.
a = accountWith(longPos())
r = sim.processBarExit(a, { open: 94, high: 94.5, low: 93, close: 93.5, openTime: '2026-01-01T00:01:00Z' }, spec)
check('default options gap SL', r && near(r.exitPrice, 94) && r.gap === true, r)

a = accountWith({ pendingOrders: [pending()] })
r = sim.tryFillPendingOnBar(a, bar({ open: 99, high: 100.2, low: 98, close: 99.5 }), 1, 'XAUUSD', spec)
check('default options gap fill', r && near(r.entry, 99 + half) && r.gap === true, r)

// Real 2026-04-12 weekend gap: long SL 4740, open 4634.998.
a = accountWith({
  position: { symbol: 'XAUUSD', side: 'long', lots: 0.1, entry: 4750, sl: 4740, tp: 4800, openTime: '2026-04-10T20:00:00Z' },
})
r = sim.processBarExit(a, { open: 4634.998, high: 4640, low: 4630, close: 4635, openTime: '2026-04-12T23:00:00Z' }, spec)
check('weekend gap SL fills at open', r && near(r.exitPrice, 4634.998) && r.reason === 'sl' && r.gap === true, r)
check('weekend gap loss is worse than stop price', r && r.pnl < (4740 - 4750) * 0.1 * 100, r)

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
