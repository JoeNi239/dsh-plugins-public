/**
 * Read-only chart data tool for the trade-practice agent.
 *
 * The agent may look arbitrarily far back and across timeframes, but it must
 * never see a bar after the replay cutoff. The cutoff comes from the browser's
 * last revealed bar and is stored per agent session by AgentManager.
 */

import { CHART_INTERVALS, loadChartBars } from './aggregateBars.js'
import { loadBars } from './monthlyCsv.js'
import { parseDrawingTime } from './drawingTools.js'
import { defineTextTool } from './toolDefs.js'

const MAX_LIMIT = 800
const DEFAULT_LIMIT = 300

function formatTime(seconds) {
  return new Date(seconds * 1000).toISOString()
}

function intervalSeconds(interval) {
  switch (interval) {
    case '1m': return 60
    case '5m': return 5 * 60
    case '15m': return 15 * 60
    case '30m': return 30 * 60
    case '1h': return 60 * 60
    case '4h': return 4 * 60 * 60
    case '1d': return 24 * 60 * 60
    case '1w': return 7 * 24 * 60 * 60
    case '1M': return 31 * 24 * 60 * 60
    default: return 0
  }
}

function isCompleteBar(bar, interval, cutoff) {
  if (!bar || !Number.isFinite(bar.time)) return false
  if (interval === '1m') return bar.time <= cutoff
  if (interval === '1M') {
    const date = new Date(bar.time * 1000)
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000
    return end <= cutoff
  }
  return bar.time + intervalSeconds(interval) <= cutoff
}

function formatBars(bars, interval, cutoff) {
  const lines = []
  for (const bar of bars) {
    const time = Number.isFinite(bar.time) ? formatTime(bar.time) : bar.openTime
    const volume = Number.isFinite(Number(bar.volume)) ? ` V${bar.volume}` : ''
    lines.push(`  ${time} O${bar.open} H${bar.high} L${bar.low} C${bar.close}${volume}`)
  }
  const last = bars[bars.length - 1]
  const partial = last && !isCompleteBar(last, interval, cutoff)
  return { text: lines.join('\n'), partial }
}

/**
 * @param {object} options
 * @param {() => string} options.dataRoot
 * @param {(sessionId: string) => ({symbol?: string, cutoff?: number} | null)} options.stateFor
 */
export function createBarsTool(options) {
  const { dataRoot, stateFor } = options
  return defineTextTool({
    name: 'get_bars',
    description:
      '读取当前品种的历史 K 线，可换周期、可往前翻。'
      + 'end 默认且最大只能到当前回放截止时间；练习模式绝不能读取未来数据。'
      + '需要更早结构或更高/更低周期时调用；引用结论时写明周期和数据截止时间。',
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        interval: {
          type: 'string',
          enum: CHART_INTERVALS,
          description: '周期，默认当前图表周期。',
        },
        limit: {
          type: 'number',
          description: `返回根数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}。`,
        },
        end: {
          type: 'string',
          description: '结束时间（ISO 8601 或 Unix 秒），默认当前回放截止时间；超过截止时间会被截断。',
        },
        start: {
          type: 'string',
          description: '可选起始时间（ISO 8601 或 Unix 秒）；不传则按 limit 向前取。',
        },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const state = stateFor(exec.agent?.session?.id)
      if (!state || !state.symbol) throw new Error('缺少当前图表上下文，请先发送一条问题。')
      const symbol = state.symbol
      const cutoff = Number(state.cutoff)
      if (!Number.isFinite(cutoff)) throw new Error('缺少回放截止时间，无法读取历史数据。')

      const interval = typeof args.interval === 'string' && CHART_INTERVALS.includes(args.interval)
        ? args.interval
        : (state.interval && CHART_INTERVALS.includes(state.interval) ? state.interval : '1h')
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit)
        ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
        : DEFAULT_LIMIT
      let end = parseDrawingTime(args.end)
      if (end == null) end = cutoff
      const clamped = end > cutoff
      if (end > cutoff) end = cutoff
      const start = parseDrawingTime(args.start)
      if (start != null && start > cutoff) throw new Error('start 超过当前回放截止时间；不能读取未来数据。')

      const loaded = loadChartBars(
        loadBars,
        dataRoot(),
        symbol,
        interval,
        start == null ? NaN : start * 1000,
        end * 1000,
        limit,
        'backward',
      )
      const bars = Array.isArray(loaded.bars) ? loaded.bars : []
      if (!bars.length) {
        return `【${symbol} · ${interval}】截止 ${formatTime(end)} 没有可用 K 线。`
      }
      const formatted = formatBars(bars, interval, cutoff)
      const header = [
        `【${symbol} · ${interval}】截止 ${formatTime(end)}（回放 cutoff ${formatTime(cutoff)}）`,
        `共 ${bars.length} 根，旧→新：`,
      ]
      if (clamped) header.push(`注意：请求的 end 超过回放截止时间，已截断到 ${formatTime(cutoff)}。`)
      if (formatted.partial) header.push('注意：最后一根在当前周期下尚未收完，仅包含截止时间前的数据。')
      if (loaded.truncated) header.push('（结果已按 limit 截断，可继续用 start/end 向前翻。）')
      return `${header.join('\n')}\n${formatted.text}`
    },
  })
}
