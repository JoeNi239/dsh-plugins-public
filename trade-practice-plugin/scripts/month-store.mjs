import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { barRowFromIso, loadCsvMap, mergeRows, serialiseCsv, writeCsvMap } from './csv-util.mjs'

export function monthKeyFromMs(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

export function monthRange(fromIso, toIso) {
  const keys = []
  const start = new Date(fromIso)
  const end = new Date(toIso)
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  while (start <= end) {
    keys.push(monthKeyFromMs(start.getTime()))
    start.setUTCMonth(start.getUTCMonth() + 1)
  }
  return keys
}

export function monthlyCsvPath(dataRoot, symbol, interval, monthKey) {
  return join(dataRoot, symbol, interval, `${monthKey}.csv`)
}

export function appendRowsToMonth(dataRoot, symbol, interval, rows) {
  const byMonth = new Map()
  for (const row of rows) {
    const ms = Date.parse(row.openTime)
    if (!Number.isFinite(ms)) continue
    const key = monthKeyFromMs(ms)
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key).push(row)
  }
  let added = 0
  for (const [key, monthRows] of byMonth) {
    const path = monthlyCsvPath(dataRoot, symbol, interval, key)
    const map = loadCsvMap(path)
    added += mergeRows(map, monthRows)
    writeCsvMap(path, map)
  }
  return { added, months: [...byMonth.keys()] }
}

export function listMonthFiles(dataRoot, symbol, interval) {
  const dir = join(dataRoot, symbol, interval)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}\.csv$/.test(name))
    .map((name) => name.replace('.csv', ''))
    .sort()
}

export function loadMonthFile(path) {
  if (!existsSync(path)) return { bars: [], mtimeMs: 0, size: 0 }
  const info = statSync(path)
  const map = loadCsvMap(path)
  const bars = [...map.values()]
    .map((row) => {
      const ms = Date.parse(row.openTime)
      return {
        openTime: row.openTime,
        time: Math.floor(ms / 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume) || 0,
      }
    })
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time)
  return { bars, mtimeMs: info.mtimeMs, size: info.size }
}

export function writeProgress(statePath, payload) {
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
}

export function readProgress(statePath) {
  if (!existsSync(statePath)) return null
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}

export function appendLog(logPath, line) {
  mkdirSync(join(logPath, '..'), { recursive: true })
  writeFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
}
