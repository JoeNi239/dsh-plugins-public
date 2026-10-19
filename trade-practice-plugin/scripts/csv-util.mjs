import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const CSV_HEADER = 'openTime,open,high,low,close,volume'

/** Canonical per-minute key: YYYY-MM-DDTHH:MM:SSZ */
export function normalizeOpenTime(openTime) {
  const ms = Date.parse(openTime)
  if (!Number.isFinite(ms)) return null
  const floored = Math.floor(ms / 60000) * 60000
  return new Date(floored).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function parseCsvMap(text) {
  const map = new Map()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  let start = 0
  if (lines[0]?.toLowerCase().startsWith('opentime')) start = 1
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 5) continue
    const openTime = normalizeOpenTime(parts[0].trim())
    if (!openTime) continue
    map.set(openTime, {
      openTime,
      open: parts[1],
      high: parts[2],
      low: parts[3],
      close: parts[4],
      volume: parts[5] ?? '0',
    })
  }
  return map
}

export function serialiseCsv(map) {
  const rows = [...map.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime))
  return [CSV_HEADER, ...rows.map((r) => [r.openTime, r.open, r.high, r.low, r.close, r.volume].join(','))].join('\n') + '\n'
}

export function mergeRows(map, rows) {
  let added = 0
  for (const row of rows) {
    const openTime = normalizeOpenTime(row.openTime)
    if (!openTime) continue
    const normalized = { ...row, openTime }
    if (!map.has(openTime)) added++
    map.set(openTime, normalized)
  }
  return added
}

export function loadCsvMap(csvPath) {
  if (!existsSync(csvPath)) return new Map()
  return parseCsvMap(readFileSync(csvPath, 'utf8'))
}

export function writeCsvMap(csvPath, map) {
  mkdirSync(dirname(csvPath), { recursive: true })
  writeFileSync(csvPath, serialiseCsv(map), 'utf8')
}

export function barRowFromIso(openTime, o, h, l, c, volume = 0) {
  return {
    openTime: normalizeOpenTime(openTime) || openTime,
    open: Number(o).toFixed(5),
    high: Number(h).toFixed(5),
    low: Number(l).toFixed(5),
    close: Number(c).toFixed(5),
    volume: String(volume),
  }
}
