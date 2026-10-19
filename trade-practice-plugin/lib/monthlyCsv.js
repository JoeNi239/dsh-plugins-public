import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function floorMinuteIso(ms) {
  const floored = Math.floor(ms / 60000) * 60000
  return new Date(floored).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) return []
  let start = 0
  if (lines[0].toLowerCase().startsWith('opentime')) start = 1
  // Last write wins per server-time minute (guards mixed .000Z / Z keys from old merges).
  const byMinute = new Map()
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 5) continue
    const ms = Date.parse(parts[0].trim())
    if (!Number.isFinite(ms)) continue
    const time = Math.floor(ms / 60000) * 60
    const openTime = floorMinuteIso(ms)
    byMinute.set(time, {
      openTime,
      time,
      open: Number(parts[1]),
      high: Number(parts[2]),
      low: Number(parts[3]),
      close: Number(parts[4]),
      volume: Number(parts[5]) || 0,
    })
  }
  return [...byMinute.values()].sort((a, b) => a.time - b.time)
}

export function monthlyDir(dataRoot, symbol, interval) {
  return join(dataRoot, String(symbol).toUpperCase(), interval)
}

export function legacyCsvPath(dataRoot, symbol, interval) {
  return join(dataRoot, String(symbol).toUpperCase(), `${interval}.csv`)
}

export function listMonthKeys(dataRoot, symbol, interval) {
  const dir = monthlyDir(dataRoot, symbol, interval)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}\.csv$/.test(n))
    .map((n) => n.replace('.csv', ''))
    .sort()
}

function monthKeysInRange(fromMs, toMs) {
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return null
  const start = Number.isFinite(fromMs) ? new Date(fromMs) : new Date('2020-01-01')
  const end = Number.isFinite(toMs) ? new Date(toMs) : new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const keys = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const pad = (n) => String(n).padStart(2, '0')
    keys.push(`${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return keys
}

export function loadMonthlyBars(dataRoot, symbol, interval, fromMs, toMs, limit, direction = 'backward') {
  const keys = listMonthKeys(dataRoot, symbol, interval)
  const rangeKeys = monthKeysInRange(fromMs, toMs)
  const useKeys = rangeKeys ? keys.filter((k) => rangeKeys.includes(k)) : keys
  let mtimeMs = 0
  let size = 0
  let monthsRead = 0
  let truncated = false
  const chunks = []
  let collected = 0
  // Only the newest `limit` bars are returned, so walk months newest-first and
  // stop early instead of parsing every month since 2020 on each request.
  const indexes = direction === 'forward'
    ? useKeys.map((_, index) => index)
    : useKeys.map((_, index) => useKeys.length - index - 1)
  for (const i of indexes) {
    if (limit > 0 && collected >= limit) {
      truncated = true
      break
    }
    const path = join(monthlyDir(dataRoot, symbol, interval), `${useKeys[i]}.csv`)
    if (!existsSync(path)) continue
    const info = statSync(path)
    mtimeMs = Math.max(mtimeMs, info.mtimeMs)
    size += info.size
    monthsRead += 1
    const chunk = parseCsv(readFileSync(path, 'utf8')).filter((bar) => {
      const ms = bar.time * 1000
      if (Number.isFinite(fromMs) && ms < fromMs) return false
      if (Number.isFinite(toMs) && ms > toMs) return false
      return true
    })
    chunks.push(chunk)
    collected += chunk.length
  }
  if (direction !== 'forward') {
    chunks.reverse()
  }
  const bars = chunks.flat()
  bars.sort((a, b) => a.time - b.time)
  if (limit > 0 && bars.length > limit) {
    truncated = true
    if (direction === 'forward') {
      bars.splice(limit)
    } else {
      bars.splice(0, bars.length - limit)
    }
  }
  return { bars, mtimeMs, size, months: monthsRead, truncated, storage: 'monthly' }
}

export function loadLegacyBars(dataRoot, symbol, interval, fromMs, toMs, limit, direction = 'backward') {
  const path = legacyCsvPath(dataRoot, symbol, interval)
  if (!existsSync(path)) return { bars: [], mtimeMs: 0, size: 0, months: 0, truncated: false, storage: 'legacy' }
  const info = statSync(path)
  let bars = parseCsv(readFileSync(path, 'utf8'))
  if (Number.isFinite(fromMs)) bars = bars.filter((b) => b.time * 1000 >= fromMs)
  if (Number.isFinite(toMs)) bars = bars.filter((b) => b.time * 1000 <= toMs)
  let truncated = false
  if (limit > 0 && bars.length > limit) {
    truncated = true
    bars = direction === 'forward' ? bars.slice(0, limit) : bars.slice(-limit)
  }
  return { bars, mtimeMs: info.mtimeMs, size: info.size, months: 1, truncated, storage: 'legacy', path }
}

export function loadBars(dataRoot, symbol, interval, fromMs, toMs, limit, direction = 'backward') {
  const monthly = loadMonthlyBars(dataRoot, symbol, interval, fromMs, toMs, limit, direction)
  if (monthly.bars.length || listMonthKeys(dataRoot, symbol, interval).length) {
    return { ...monthly, path: monthlyDir(dataRoot, symbol, interval) }
  }
  return loadLegacyBars(dataRoot, symbol, interval, fromMs, toMs, limit, direction)
}

/** path -> { mtimeMs, size, count, first, last }; one entry per CSV file on disk. */
const fileSummaryCache = new Map()

function summariseCsvFile(path, info) {
  const cached = fileSummaryCache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached
  }
  const bars = parseCsv(readFileSync(path, 'utf8'))
  const summary = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    count: bars.length,
    first: bars.length ? bars[0].openTime : null,
    last: bars.length ? bars[bars.length - 1].openTime : null,
  }
  fileSummaryCache.set(path, summary)
  return summary
}

export function aggregateMeta(dataRoot, symbol, interval) {
  const keys = listMonthKeys(dataRoot, symbol, interval)
  if (keys.length) {
    let total = 0
    let mtimeMs = 0
    let first = null
    let last = null
    const dir = monthlyDir(dataRoot, symbol, interval)
    const livePaths = new Set()
    for (const key of keys) {
      const path = join(dir, `${key}.csv`)
      if (!existsSync(path)) continue
      livePaths.add(path)
      const info = statSync(path)
      mtimeMs = Math.max(mtimeMs, info.mtimeMs)
      const summary = summariseCsvFile(path, info)
      total += summary.count
      if (summary.count) {
        if (!first) first = summary.first
        last = summary.last
      }
    }
    for (const cachedPath of fileSummaryCache.keys()) {
      if (cachedPath.startsWith(dir) && !livePaths.has(cachedPath)) {
        fileSummaryCache.delete(cachedPath)
      }
    }
    return {
      exists: total > 0,
      bars: total,
      months: keys.length,
      first,
      last,
      mtimeMs,
      path: monthlyDir(dataRoot, symbol, interval),
      layout: 'monthly',
    }
  }
  const legacy = legacyCsvPath(dataRoot, symbol, interval)
  if (!existsSync(legacy)) {
    return { exists: false, bars: 0, months: 0, first: null, last: null, mtimeMs: 0, path: legacy, layout: 'none' }
  }
  const legacyInfo = statSync(legacy)
  const summary = summariseCsvFile(legacy, legacyInfo)
  return {
    exists: summary.count > 0,
    bars: summary.count,
    months: 1,
    first: summary.first,
    last: summary.last,
    mtimeMs: legacyInfo.mtimeMs,
    path: legacy,
    layout: 'legacy',
  }
}
