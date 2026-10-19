/**
 * Aggregate 1m OHLC bars into higher timeframes.
 * Bucket boundaries use the stored MT5 server time: epoch-aligned for fixed
 * sizes, calendar math for 1M (UTC getters over server-time-as-UTC labels).
 */

export const CHART_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']

/** Approximate 1m bars needed to produce one higher-TF bar (for raw limit sizing). */
export const INTERVAL_MINUTE_FACTOR = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
  '1M': 44640,
}

const FIXED_PERIOD_SEC = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function isoFromSec(sec) {
  return new Date(sec * 1000).toISOString()
}

function bucketStartSec(timeSec, interval) {
  if (interval === '1M') {
    const d = new Date(timeSec * 1000)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
  }
  if (interval === '1w') {
    // Weeks start Monday 00:00 UTC (ISO).
    const d = new Date(timeSec * 1000)
    const day = d.getUTCDay() // 0=Sun … 6=Sat
    const daysFromMonday = day === 0 ? 6 : day - 1
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday)
    return monday / 1000
  }
  const period = FIXED_PERIOD_SEC[interval]
  if (!period) {
    return timeSec
  }
  return Math.floor(timeSec / period) * period
}

/**
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume?:number,openTime?:string}>} bars1m
 * @param {string} interval
 */
export function aggregateBars(bars1m, interval) {
  if (!interval || interval === '1m') {
    return bars1m || []
  }
  if (!CHART_INTERVALS.includes(interval)) {
    throw new Error('不支持的周期：' + interval)
  }
  const out = []
  let cur = null
  for (const bar of bars1m || []) {
    const start = bucketStartSec(bar.time, interval)
    if (!cur || cur.time !== start) {
      if (cur) {
        out.push(cur)
      }
      cur = {
        openTime: isoFromSec(start),
        time: start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      }
    } else {
      if (bar.high > cur.high) {
        cur.high = bar.high
      }
      if (bar.low < cur.low) {
        cur.low = bar.low
      }
      cur.close = bar.close
      cur.volume = (cur.volume || 0) + (bar.volume || 0)
    }
  }
  if (cur) {
    out.push(cur)
  }
  return out
}

/** Cap 1m rows read per request so high-TF aggregation stays bounded. */
const MAX_RAW_1M = 120000

/** How many 1m bars to request in order to fill `limit` aggregated bars. */
export function rawLimitForInterval(interval, limit) {
  if (!limit || limit <= 0) {
    return limit
  }
  const factor = INTERVAL_MINUTE_FACTOR[interval] || 1
  // Extra factor bars so the first/last partial buckets still fill.
  return Math.min(MAX_RAW_1M, limit * factor + factor)
}

export function intervalLabel(interval) {
  const map = {
    '1m': '1分',
    '5m': '5分',
    '15m': '15分',
    '30m': '30分',
    '1h': '1小时',
    '4h': '4小时',
    '1d': '1天',
    '1w': '1周',
    '1M': '1月',
  }
  return map[interval] || interval
}

/**
 * Load chart bars: always read 1m CSV, aggregate when interval !== 1m.
 * @param {typeof import('./monthlyCsv.js').loadBars} loadBarsFn
 */
export function loadChartBars(loadBarsFn, dataRoot, symbol, interval, fromMs, toMs, limit, direction = 'backward') {
  const tf = interval || '1m'
  if (!CHART_INTERVALS.includes(tf)) {
    throw new Error('不支持的周期：' + tf)
  }
  if (tf === '1m') {
    return loadBarsFn(dataRoot, symbol, '1m', fromMs, toMs, limit, direction)
  }
  const rawLimit = rawLimitForInterval(tf, limit)
  const loaded = loadBarsFn(dataRoot, symbol, '1m', fromMs, toMs, rawLimit, direction)
  let bars = aggregateBars(loaded.bars, tf)
  let truncated = Boolean(loaded.truncated)
  // A truncated edge leaves a partial bucket; remove the edge nearest the cut.
  if (truncated && bars.length > 1) {
    bars = direction === 'forward' ? bars.slice(0, -1) : bars.slice(1)
  }
  if (limit > 0 && bars.length > limit) {
    truncated = true
    bars = direction === 'forward' ? bars.slice(0, limit) : bars.slice(bars.length - limit)
  }
  return {
    ...loaded,
    bars,
    truncated,
    aggregatedFrom: '1m',
  }
}
