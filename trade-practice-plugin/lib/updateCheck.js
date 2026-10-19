import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateMeta, listMonthKeys, monthlyDir } from './monthlyCsv.js'

const DEFAULT_FROM_YEAR = 2020
/** 历史完整月 CSV 通常 > 500KB；明显偏小视为可能不完整 */
const MIN_PAST_MONTH_BYTES = 180_000
/** 当前月最后一根 K 距现在超过该小时数 → 建议补数 */
const STALE_CURRENT_MONTH_HOURS = 36

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function expectedMonthKeys(fromYear, now = new Date()) {
  const keys = []
  const endYear = now.getUTCFullYear()
  const endMonth = now.getUTCMonth() + 1
  for (let year = fromYear; year <= endYear; year++) {
    const monthStart = 1
    const monthEnd = year === endYear ? endMonth : 12
    for (let month = monthStart; month <= monthEnd; month++) {
      keys.push(`${year}-${pad2(month)}`)
    }
  }
  return keys
}

function readLastOpenTimeFromCsv(path) {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length <= 1) return null
  const last = lines[lines.length - 1]
  const openTime = last.split(',')[0]?.trim()
  if (!openTime || openTime.toLowerCase() === 'opentime') return null
  const ms = Date.parse(openTime)
  return Number.isFinite(ms) ? { openTime, ms } : null
}

function uniqueYears(monthKeys) {
  return [...new Set(monthKeys.map((k) => k.slice(0, 4)))].sort()
}

function buildDownloadPlan({ missingMonths, thinMonths, staleMonths, fromYear, now }) {
  const touch = [...missingMonths, ...thinMonths.map((t) => t.month), ...staleMonths.map((s) => s.month)]
  const onlyMonths = [...new Set(touch)].sort()
  if (!onlyMonths.length) {
    return { onlyMonths: [], fromYear: null, toYear: null, mode: 'none' }
  }
  const years = uniqueYears(onlyMonths).map(Number)
  const minY = Math.min(...years)
  const maxY = Math.max(...years)
  const currentYear = now.getUTCFullYear()
  const spansFullYear = years.some((y) => y < currentYear && onlyMonths.filter((m) => m.startsWith(`${y}-`)).length >= 10)
  return {
    onlyMonths,
    fromYear: Math.max(fromYear, minY),
    toYear: maxY,
    mode: spansFullYear ? 'mixed' : 'targeted',
  }
}

/**
 * 本地对比「应有月份 / 文件体量 / 当前月新鲜度」，不下载 HistData。
 */
export function assessHistdataUpdateNeed(dataRoot, symbol, interval, options = {}) {
  const fromYear = Number(options.fromYear) || DEFAULT_FROM_YEAR
  const now = options.now instanceof Date ? options.now : new Date()
  const sym = String(symbol).toUpperCase()
  const expected = expectedMonthKeys(fromYear, now)
  const present = listMonthKeys(dataRoot, sym, interval)
  const presentSet = new Set(present)
  const missingMonths = expected.filter((key) => !presentSet.has(key))

  const currentKey = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`
  const thinMonths = []
  const staleMonths = []

  for (const key of present) {
    if (!expected.includes(key)) continue
    const path = join(monthlyDir(dataRoot, sym, interval), `${key}.csv`)
    if (!existsSync(path)) continue
    const info = statSync(path)
    if (key !== currentKey && info.size < MIN_PAST_MONTH_BYTES) {
      thinMonths.push({
        month: key,
        reason: '文件体积偏小，可能不完整',
        sizeBytes: info.size,
      })
    }
    if (key === currentKey) {
      const last = readLastOpenTimeFromCsv(path)
      if (!last) {
        staleMonths.push({ month: key, reason: '当前月无有效 K 线', lastOpenTime: null })
      } else {
        const ageHours = (now.getTime() - last.ms) / (3600 * 1000)
        if (ageHours > STALE_CURRENT_MONTH_HOURS) {
          staleMonths.push({
            month: key,
            reason: `最后一根 K 线偏旧（约 ${Math.round(ageHours)} 小时前）`,
            lastOpenTime: last.openTime,
            ageHours: Math.round(ageHours),
          })
        }
      }
    }
  }

  const reasons = []
  if (missingMonths.length) reasons.push(`缺少 ${missingMonths.length} 个月文件`)
  if (thinMonths.length) reasons.push(`${thinMonths.length} 个月文件可能不完整`)
  if (staleMonths.length) reasons.push(`当前月数据需补全（${staleMonths.length} 项）`)

  const needsUpdate = missingMonths.length > 0 || thinMonths.length > 0 || staleMonths.length > 0
  const plan = buildDownloadPlan({ missingMonths, thinMonths, staleMonths, fromYear, now })
  const meta = aggregateMeta(dataRoot, sym, interval)

  return {
    needsUpdate,
    upToDate: !needsUpdate,
    summary: needsUpdate ? reasons.join('；') : '本地分月 CSV 已覆盖预期区间，当前月足够新',
    reasons,
    missingMonths,
    thinMonths,
    staleMonths,
    expectedMonths: expected.length,
    presentMonths: present.filter((k) => expected.includes(k)).length,
    fromYear,
    currentMonth: currentKey,
    plan,
    meta: {
      bars: meta.bars,
      months: meta.months,
      first: meta.first,
      last: meta.last,
      mtimeMs: meta.mtimeMs,
      layout: meta.layout,
    },
    checkedAt: now.toISOString(),
  }
}
