window.__ModuleLoader__.load({
  id: '@local/trade-practice',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo } = React
    const h = React.createElement
    const tradeSim = (function () {
      const module = { exports: {} }
      function calcPnl(side, entry, exit, lots, spec) {
        const dir = side === 'long' ? 1 : -1
        return (exit - entry) * dir * lots * spec.contractSize
      }

      function cloneAccount(account) {
        return {
          ...account,
          position: account.position ? { ...account.position } : null,
          pendingOrders: (account.pendingOrders || []).map((o) => ({ ...o })),
          history: [...(account.history || [])],
        }
      }

      /**
       * @param {object} [options]
       * @param {boolean} [options.gapFill=true] fill at the bar open when it gaps through SL/TP
       */
      function processBarExit(account, bar, spec, options = {}) {
        const gapFill = options.gapFill !== false
        const pos = account.position
        if (!pos) {
          return null
        }
        const { side, entry, sl, tp, lots } = pos
        let exitPrice = null
        let reason = ''
        let gap = false
        if (side === 'long') {
          if (gapFill && sl != null && bar.open <= sl) {
            // Gapped below the stop: a real stop order fills at the open, not at the stop.
            exitPrice = bar.open
            reason = 'sl'
            gap = true
          } else if (gapFill && tp != null && bar.open >= tp) {
            exitPrice = bar.open
            reason = 'tp'
            gap = true
          } else {
            const hitSl = sl != null && bar.low <= sl
            const hitTp = tp != null && bar.high >= tp
            if (hitSl && hitTp) {
              exitPrice = sl
              reason = 'sl'
            } else if (hitSl) {
              exitPrice = sl
              reason = 'sl'
            } else if (hitTp) {
              exitPrice = tp
              reason = 'tp'
            }
          }
        } else {
          if (gapFill && sl != null && bar.open >= sl) {
            exitPrice = bar.open
            reason = 'sl'
            gap = true
          } else if (gapFill && tp != null && bar.open <= tp) {
            exitPrice = bar.open
            reason = 'tp'
            gap = true
          } else {
            const hitSl = sl != null && bar.high >= sl
            const hitTp = tp != null && bar.low <= tp
            if (hitSl && hitTp) {
              exitPrice = sl
              reason = 'sl'
            } else if (hitSl) {
              exitPrice = sl
              reason = 'sl'
            } else if (hitTp) {
              exitPrice = tp
              reason = 'tp'
            }
          }
        }
        if (exitPrice == null) {
          return null
        }
        const pnl = calcPnl(side, entry, exitPrice, lots, spec)
        account.balance += pnl
        account.realizedPnl += pnl
        account.history.unshift({
          symbol: pos.symbol,
          side,
          lots,
          entry,
          exit: exitPrice,
          pnl,
          reason,
          gap,
          entryGap: Boolean(pos.entryGap),
          orderType: pos.orderType || 'market',
          openTime: pos.openTime,
          closeTime: bar.openTime,
        })
        account.position = null
        return { pnl, reason, exitPrice, gap }
      }

      function isoToSec(iso) {
        const ms = Date.parse(iso || '')
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
      }

      // Bar indices shift whenever the CSV window is reloaded, so "is this bar after
      // the order/position" must be decided by bar time, not by index.
      function isBarAfter(bar, iso) {
        const sec = isoToSec(iso)
        return sec == null || bar.time > sec
      }

      /**
       * @param {object} [options]
       * @param {boolean} [options.gapFill=true] fill at the bar open when it gaps through the limit
       */
      function tryFillPendingOnBar(account, bar, barIndex, symbol, spec, options = {}) {
        const gapFill = options.gapFill !== false
        if (account.position) {
          return null
        }
        const pending = (account.pendingOrders || []).filter((o) => o.symbol === symbol)
        if (!pending.length) {
          return null
        }
        const halfSpread = spec.spread / 2
        for (let i = 0; i < pending.length; i++) {
          const order = pending[i]
          if (order.type !== 'limit' || order.limitPrice == null) {
            continue
          }
          if (!isBarAfter(bar, order.createdTime)) {
            continue
          }
          const limit = order.limitPrice
          let entry = null
          let gap = false
          if (order.side === 'long') {
            if (gapFill && bar.open <= limit) {
              // Gapped through the limit: a resting buy fills at the open (never worse than the limit).
              entry = Math.min(limit, bar.open + halfSpread)
              gap = true
            } else if (bar.low <= limit) {
              entry = limit + halfSpread
            }
          } else {
            if (gapFill && bar.open >= limit) {
              entry = Math.max(limit, bar.open - halfSpread)
              gap = true
            } else if (bar.high >= limit) {
              entry = limit - halfSpread
            }
          }
          if (entry == null) {
            continue
          }
          account.pendingOrders = account.pendingOrders.filter((o) => o.id !== order.id)
          account.position = {
            symbol,
            side: order.side,
            lots: order.lots,
            entry,
            sl: order.sl,
            tp: order.tp,
            openTime: bar.openTime,
            openBarIndex: barIndex,
            orderType: 'limit',
            entryGap: gap,
          }
          return { order, entry, gap }
        }
        return null
      }

      function hasPendingForSymbol(account, symbol) {
        return (account.pendingOrders || []).some((o) => o.symbol === symbol)
      }

      /** Returns the same `account` object when the bar changes nothing. */
      function simulateBarOnAccount(account, bar, barIndex, symbol, spec, options = {}) {
        const pos = account.position
        if (pos && pos.symbol !== symbol) {
          return { account, exit: null, fill: null }
        }
        const mayExit = Boolean(pos && isBarAfter(bar, pos.openTime))
        const mayFill = !pos && hasPendingForSymbol(account, symbol)
        if (!mayExit && !mayFill) {
          return { account, exit: null, fill: null }
        }
        const next = cloneAccount(account)
        let exit = null
        if (mayExit) {
          exit = processBarExit(next, bar, spec, options)
        }
        let fill = null
        if (!next.position) {
          fill = tryFillPendingOnBar(next, bar, barIndex, symbol, spec, options)
        }
        if (!exit && !fill) {
          return { account, exit: null, fill: null }
        }
        return { account: next, exit, fill }
      }

      function emptyAccount(initial, name, id) {
        return {
          id,
          name: name || '模拟账户',
          initial: initial,
          balance: initial,
          realizedPnl: 0,
          position: null,
          pendingOrders: [],
          history: [],
        }
      }

      module.exports = {
        calcPnl,
        cloneAccount,
        processBarExit,
        tryFillPendingOnBar,
        simulateBarOnAccount,
        emptyAccount,
      }
      return module.exports
    })()
    const { calcPnl, simulateBarOnAccount, emptyAccount } = tradeSim
    const { EXTRA_STYLES: DATA_UPDATE_STYLES, createDataUpdateControl } = (function () {
      const module = { exports: {} }
/** Auto-check / update status line — keep out of client.js merge churn when possible. */

const EXTRA_STYLES = `
.tp-data-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-data-status-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-data-status-updating{color:var(--dsw-alias-brand-primary)}
.tp-data-status-err{color:#ef5350}
`

function createPostJson() {
  return async function postJson(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText)
    return data
  }
}

function formatLastBar(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function createDataUpdateControl(deps) {
  const React = deps.React
  const { useState, useEffect, useRef, useCallback } = React
  const h = React.createElement
  const getJson = deps.getJson
  const postJson = deps.postJson || createPostJson()

  // One automatic check per plugin startup (page load). Panel remounts and
  // symbol switches do not trigger more checks; use the button for those.
  let startupCheckDone = false
  const lastBarBySymbol = new Map()

  return function DataUpdateControl(props) {
    const { symbol, interval, onRefreshChart } = props
    const [phase, setPhase] = useState('idle') // idle | checking | updating | ok | err
    const [lastBar, setLastBar] = useState(null)
    const [hint, setHint] = useState('')
    const pollRef = useRef(null)
    const startedRef = useRef(false)
    const prevRunningRef = useRef(false)

    const stopPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const applyMeta = (meta) => {
      if (meta?.last) {
        lastBarBySymbol.set(symbol, meta.last)
        setLastBar(meta.last)
      }
    }

    const pollUntilDone = useCallback(() => {
      stopPoll()
      pollRef.current = setInterval(async () => {
        try {
          const status = await getJson(
            `/trade-practice/fetch-status?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
          )
          const running = Boolean(status.fetch?.running)
          applyMeta(status.meta)
          if (running) {
            const period = status.fetch.currentPeriod || status.fetch.currentMonth || ''
            setPhase('updating')
            setHint(period ? `正在更新… ${period}` : '正在更新…')
            prevRunningRef.current = true
            return
          }
          if (prevRunningRef.current) {
            prevRunningRef.current = false
            stopPoll()
            setPhase('ok')
            setHint('')
            if (typeof onRefreshChart === 'function') onRefreshChart()
            try {
              const again = await getJson(
                `/trade-practice/update-check?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&fromYear=2020`,
              )
              applyMeta(again.check?.meta)
            } catch {}
          } else {
            stopPoll()
            setPhase('ok')
            setHint('')
          }
        } catch (err) {
          stopPoll()
          setPhase('err')
          setHint(err.message || String(err))
        }
      }, 2000)
    }, [symbol, interval, onRefreshChart, getJson])

    const boot = useCallback(async (force = false) => {
      if (!force && startupCheckDone) {
        setPhase('ok')
        setHint('')
        setLastBar(lastBarBySymbol.get(symbol) || null)
        return
      }
      if (!force) startupCheckDone = true
      setPhase('checking')
      setHint('检查数据…')
      try {
        const data = await getJson(
          `/trade-practice/update-check?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&fromYear=2020`,
        )
        const check = data.check
        applyMeta(check?.meta)

        const status = await getJson(
          `/trade-practice/fetch-status?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
        )
        if (status.fetch?.running) {
          prevRunningRef.current = true
          setPhase('updating')
          setHint('正在更新…')
          pollUntilDone()
          return
        }

        if (!check?.needsUpdate) {
          setPhase('ok')
          setHint('')
          return
        }

        setPhase('updating')
        setHint('正在更新…')
        const result = await postJson('/trade-practice/update-data', {
          symbol,
          interval,
          full: false,
        })
        if (result.skipped) {
          applyMeta(result.check?.meta)
          setPhase('ok')
          setHint('')
          return
        }
        if (result.alreadyRunning || result.started) {
          prevRunningRef.current = true
          pollUntilDone()
          return
        }
        setPhase('err')
        setHint(result.message || '未能启动更新')
      } catch (err) {
        setPhase('err')
        setHint(err.message || String(err))
      }
    }, [symbol, interval, getJson, postJson, pollUntilDone])

    useEffect(() => {
      startedRef.current = true
      boot()
      return () => stopPoll()
    }, [symbol, interval])

    const className =
      'tp-data-status' +
      (phase === 'updating' || phase === 'checking' ? ' tp-data-status-updating' : '') +
      (phase === 'err' ? ' tp-data-status-err' : '')

    const line =
      phase === 'checking'
        ? '检查数据…'
        : phase === 'updating'
          ? hint || '正在更新…'
          : phase === 'err'
            ? `更新失败：${hint}`
            : `最新 K 线（服务器时间）：${formatLastBar(lastBar)}`

    const busy = phase === 'checking' || phase === 'updating'
    return h(
      'div',
      { className },
      h('span', { className: 'tp-data-status-text', title: line }, line),
      h(
        'button',
        {
          type: 'button',
          className: 'tp-btn tp-btn-mini',
          disabled: busy,
          onClick: () => boot(true),
          title: '检查并更新当前品种的 1m 数据',
        },
        busy ? '…' : '检查更新',
      ),
    )
  }
}

module.exports = { EXTRA_STYLES, createDataUpdateControl, createPostJson }

      return module.exports
    })()

    const SYMBOLS = [
      { id: 'XAUUSD', name: 'Gold / USD' },
      { id: 'GBPUSD', name: 'GBP / USD' },
    ]
    const INTERVALS = [
      { id: '1m', label: '1分' },
      { id: '5m', label: '5分' },
      { id: '15m', label: '15分' },
      { id: '30m', label: '30分' },
      { id: '1h', label: '1小时' },
      { id: '4h', label: '4小时' },
      { id: '1d', label: '1天' },
      { id: '1w', label: '1周' },
      { id: '1M', label: '1月' },
    ]
    const SOURCE_INTERVAL = '1m'
    const DATA_FROM = '2020-01-01T00:00:00Z'
    const LWC_URL =
      'https://cdn.jsdelivr.net/npm/lightweight-charts@3.8.0/dist/lightweight-charts.standalone.production.js'
    /** Soft cap for chart series + in-memory loaded bars (scroll-back stops here). */
    const MAX_CHART_BARS = 30000
    /** Initial / refresh page size (aggregated bars). */
    const CHART_PAGE = 2500
    /** Extra history page when scrolling left. */
    const HISTORY_PAGE = 2000
    const HISTORY_EDGE = 50
    const DEFAULT_BAR_SPACING = 8
    const DEFAULT_RIGHT_OFFSET = 4
    /** Crosshair magnet radius (px) around a candle's high / body top / body bottom / low. */
    const CROSSHAIR_SNAP_PX = 5

    function addCandlestickSeries(chart, LWC, options) {
      if (typeof chart.addCandlestickSeries === 'function') {
        return chart.addCandlestickSeries(options)
      }
      if (typeof chart.addSeries === 'function' && LWC.CandlestickSeries) {
        return chart.addSeries(LWC.CandlestickSeries, options)
      }
      throw new Error('当前图表库版本不支持 K 线系列')
    }

    function barsForChart(bars) {
      const seen = new Set()
      const out = []
      for (const b of bars) {
        if (seen.has(b.time)) continue
        seen.add(b.time)
        out.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })
      }
      // Prefer keeping the left edge so scroll-back can reach unloaded history.
      if (out.length > MAX_CHART_BARS) {
        return out.slice(0, MAX_CHART_BARS)
      }
      return out
    }

    /**
     * Data-driven price precision: the most common non-zero decimal count in
     * the loaded OHLC values. Do not hard-code per-symbol digits.
     */
    function inferPriceDigits(bars) {
      if (!Array.isArray(bars) || !bars.length) return 5
      const step = Math.max(1, Math.floor(bars.length / 800))
      const counts = new Map()
      for (let index = 0; index < bars.length; index += step) {
        for (const key of ['open', 'high', 'low', 'close']) {
          const value = bars[index][key]
          if (!Number.isFinite(value)) continue
          const text = String(value)
          const dot = text.indexOf('.')
          if (dot < 0) continue
          const decimals = text.length - dot - 1
          if (decimals > 0) counts.set(decimals, (counts.get(decimals) || 0) + 1)
        }
      }
      let best = 5
      let bestCount = 0
      for (const [decimals, count] of counts) {
        if (count > bestCount || (count === bestCount && decimals > best)) {
          best = decimals
          bestCount = count
        }
      }
      return Math.max(0, Math.min(8, best))
    }

    function priceFormatFor(digits) {
      const precision = Number.isFinite(digits) ? Math.max(0, Math.min(8, Math.round(digits))) : 5
      return { type: 'price', precision, minMove: precision === 0 ? 1 : Number(`1e-${precision}`) }
    }

    function formatPrice(value, digits) {
      const precision = Number.isFinite(digits) ? digits : 5
      const number = Number(value)
      return Number.isFinite(number) ? number.toFixed(precision) : '—'
    }

    function movingAverage(bars, period) {
      const result = []
      let total = 0
      for (let index = 0; index < bars.length; index++) {
        total += bars[index].close
        if (index >= period) total -= bars[index - period].close
        if (index >= period - 1) {
          result.push({ time: bars[index].time, value: total / period })
        }
      }
      return result
    }

    function relativeStrengthIndex(bars, period = 14) {
      if (bars.length <= period) return []
      let averageGain = 0
      let averageLoss = 0
      for (let index = 1; index <= period; index++) {
        const change = bars[index].close - bars[index - 1].close
        averageGain += Math.max(change, 0)
        averageLoss += Math.max(-change, 0)
      }
      averageGain /= period
      averageLoss /= period
      const valueAt = (gain, loss) => {
        if (loss === 0) return gain === 0 ? 50 : 100
        const relativeStrength = gain / loss
        return 100 - 100 / (1 + relativeStrength)
      }
      const result = [{ time: bars[period].time, value: valueAt(averageGain, averageLoss) }]
      for (let index = period + 1; index < bars.length; index++) {
        const change = bars[index].close - bars[index - 1].close
        averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
        averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
        result.push({ time: bars[index].time, value: valueAt(averageGain, averageLoss) })
      }
      return result
    }

    function buildIndicatorData(bars, options) {
      const data = { ma20: [], ma50: [], rsi: [], rsi30: [], rsi50: [], rsi70: [], volume: [] }
      if (options.ma) {
        data.ma20 = movingAverage(bars, 20)
        data.ma50 = movingAverage(bars, 50)
      }
      if (options.rsi) {
        data.rsi = relativeStrengthIndex(bars)
        data.rsi30 = bars.map((bar) => ({ time: bar.time, value: 30 }))
        data.rsi50 = bars.map((bar) => ({ time: bar.time, value: 50 }))
        data.rsi70 = bars.map((bar) => ({ time: bar.time, value: 70 }))
      }
      if (options.volume) {
        data.volume = bars.map((bar) => ({
          time: bar.time,
          value: Number(bar.volume) || 0,
          color: bar.close >= bar.open ? 'rgba(38,166,154,.55)' : 'rgba(239,83,80,.55)',
        }))
      }
      return data
    }
    const SPECS = {
      XAUUSD: { contractSize: 100, spread: 0.25 },
      GBPUSD: { contractSize: 100000, spread: 0.00012 },
    }

    const LWC_SCRIPT_ID = 'trade-practice-lwc-3.8.0'
    let lwcPromise = null
    function loadLightweightCharts() {
      if (window.__tpLwcVersion === '3.8.0' && window.LightweightCharts) {
        return Promise.resolve(window.LightweightCharts)
      }
      if (lwcPromise) return lwcPromise
      lwcPromise = new Promise((resolve, reject) => {
        const finish = () => {
          if (!window.LightweightCharts) {
            reject(new Error('图表库未就绪'))
            return
          }
          window.__tpLwcVersion = '3.8.0'
          resolve(window.LightweightCharts)
        }
        const existing = document.getElementById(LWC_SCRIPT_ID)
        if (existing) {
          if (window.LightweightCharts) finish()
          else existing.addEventListener('load', finish, { once: true })
          existing.addEventListener('error', () => reject(new Error('无法加载图表库')), { once: true })
          return
        }
        const script = document.createElement('script')
        script.id = LWC_SCRIPT_ID
        script.src = LWC_URL
        script.async = true
        script.onload = finish
        script.onerror = () => reject(new Error('无法加载图表库'))
        document.head.appendChild(script)
      })
      return lwcPromise
    }

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText)
      return data
    }

    const DataUpdateControl = createDataUpdateControl({ React, getJson })

    // Chart/practice/chat times are MT5 server time. The CSV stores server time
    // with a Z suffix (server-time-as-UTC), so format/parse with UTC getters.
    function formatServerInput(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    }

    function parseServerInput(value) {
      if (!value) return null
      const text = String(value)
      const ms = Date.parse(text.endsWith('Z') ? text : `${text}Z`)
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    }

    function alignPracticeTime(iso, interval) {
      const time = Math.floor(Date.parse(iso) / 1000)
      if (interval === '1M') {
        const date = new Date(time * 1000)
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
      }
      if (interval === '1w') {
        const date = new Date(time * 1000)
        const daysSinceMonday = (date.getUTCDay() + 6) % 7
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday) / 1000
      }
      const seconds = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }[interval]
      return seconds ? Math.floor(time / seconds) * seconds : time
    }

    const REGISTRY_KEY = 'dsh.trade-practice.registry.v2'
    const MODEL_CHOICE_KEY = 'dsh.trade-practice.modelChoice.v1'
    const GAP_FILL_KEY = 'dsh.trade-practice.gapFill.v1'
    const SERVER_TIME_SHIFT_KEY = 'dsh.trade-practice.serverTimeShift.v1'
    const SERVER_TIME_SHIFT_SECONDS = 2 * 60 * 60
    const LEGACY_ACCOUNT_PREFIX = 'dsh.trade-practice.acct.v1.'

    function shiftIsoTime(iso, seconds) {
      const ms = Date.parse(iso || '')
      return Number.isFinite(ms) ? new Date(ms + seconds * 1000).toISOString() : iso
    }

    function shiftAccountTimes(account) {
      if (account.position && account.position.openTime) {
        account.position.openTime = shiftIsoTime(account.position.openTime, SERVER_TIME_SHIFT_SECONDS)
      }
      for (const order of account.pendingOrders || []) {
        if (order.createdTime) order.createdTime = shiftIsoTime(order.createdTime, SERVER_TIME_SHIFT_SECONDS)
      }
      for (const trade of account.history || []) {
        if (trade.openTime) trade.openTime = shiftIsoTime(trade.openTime, SERVER_TIME_SHIFT_SECONDS)
        if (trade.closeTime) trade.closeTime = shiftIsoTime(trade.closeTime, SERVER_TIME_SHIFT_SECONDS)
      }
    }

    // The CSV moved from "HistData local +5" to MT5 server time (+2h). Shift any
    // state saved before this change once, so open positions/orders/drawings stay
    // on the same bars.
    function migrateStoredTimesOnce() {
      try {
        if (localStorage.getItem(SERVER_TIME_SHIFT_KEY)) return
        // Mark first: a malformed entry must not cause a double shift on reload.
        localStorage.setItem(SERVER_TIME_SHIFT_KEY, 'mt5-server')
        const rawRegistry = localStorage.getItem(REGISTRY_KEY)
        if (rawRegistry) {
          const parsed = JSON.parse(rawRegistry)
          for (const account of parsed.accounts || []) shiftAccountTimes(account)
          localStorage.setItem(REGISTRY_KEY, JSON.stringify(parsed))
        }
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith(LEGACY_ACCOUNT_PREFIX)) {
            const legacy = JSON.parse(localStorage.getItem(key) || '{}')
            shiftAccountTimes(legacy)
            localStorage.setItem(key, JSON.stringify(legacy))
            continue
          }
          if (!key.startsWith('dsh.trade-practice.draw.')) continue
          const items = JSON.parse(localStorage.getItem(key) || '[]')
          if (!Array.isArray(items)) continue
          for (const drawing of items) {
            for (const field of ['t', 't1', 't2', 't3']) {
              if (typeof drawing[field] === 'number') drawing[field] += SERVER_TIME_SHIFT_SECONDS
            }
          }
          localStorage.setItem(key, JSON.stringify(items))
        }
      } catch {}
    }

    migrateStoredTimesOnce()

    function newAccountId() {
      return `acct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    }

    function normaliseAccount(raw, fallbackId) {
      const initial = Number(raw.initial)
      const balance = Number(raw.balance)
      return {
        id: raw.id || fallbackId || newAccountId(),
        name: String(raw.name || '模拟账户'),
        initial: Number.isFinite(initial) ? initial : 10000,
        balance: Number.isFinite(balance) ? balance : Number.isFinite(initial) ? initial : 10000,
        realizedPnl: Number(raw.realizedPnl) || 0,
        position: raw.position ? { ...raw.position } : null,
        pendingOrders: Array.isArray(raw.pendingOrders) ? raw.pendingOrders.map((o) => ({ ...o })) : [],
        history: Array.isArray(raw.history) ? [...raw.history] : [],
      }
    }

    function defaultRegistry() {
      const account = emptyAccount(10000, '默认账户', 'default')
      return { activeId: account.id, accounts: [account] }
    }

    function readRegistry() {
      try {
        const raw = localStorage.getItem(REGISTRY_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length) {
            const accounts = parsed.accounts.map((a) => normaliseAccount(a))
            const activeId = accounts.some((a) => a.id === parsed.activeId) ? parsed.activeId : accounts[0].id
            return { activeId, accounts }
          }
        }
      } catch {}
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(LEGACY_ACCOUNT_PREFIX)) {
          continue
        }
        try {
          const legacy = JSON.parse(localStorage.getItem(key))
          const account = normaliseAccount(
            {
              ...legacy,
              id: 'default',
              name: '默认账户',
              pendingOrders: legacy.pendingOrders || [],
            },
            'default',
          )
          return { activeId: account.id, accounts: [account] }
        } catch {}
      }
      return defaultRegistry()
    }

    function writeRegistry(registry) {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
    }

    function updateActiveAccount(registry, updater) {
      const idx = registry.accounts.findIndex((a) => a.id === registry.activeId)
      if (idx < 0) {
        return registry
      }
      const nextAccount = updater(normaliseAccount(registry.accounts[idx]))
      const accounts = [...registry.accounts]
      accounts[idx] = nextAccount
      return { ...registry, accounts }
    }

    function positionForSymbol(account, symbol) {
      const pos = account.position
      if (!pos || pos.symbol !== symbol) {
        return null
      }
      return pos
    }

    function pendingForSymbol(account, symbol) {
      return (account.pendingOrders || []).filter((o) => o.symbol === symbol)
    }

    function loadDrawingsKey(symbol) {
      return `dsh.trade-practice.draw.v2.${symbol}`
    }

    function readDrawingsForSymbol(symbol) {
      const current = localStorage.getItem(loadDrawingsKey(symbol))
      if (current) {
        const parsed = JSON.parse(current)
        return Array.isArray(parsed) ? parsed : []
      }

      const legacyPrefix = `dsh.trade-practice.draw.v1.${symbol}.`
      const drawingsById = new Map()
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(legacyPrefix)) continue
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || '[]')
          if (!Array.isArray(parsed)) continue
          for (const drawing of parsed) {
            drawingsById.set(JSON.stringify(drawing), drawing)
          }
        } catch {}
      }
      return [...drawingsById.values()]
    }

    function intervalLabel(tf) {
      const found = INTERVALS.find((item) => item.id === tf)
      return found ? found.label : tf
    }

    function readModelChoice() {
      try {
        const raw = localStorage.getItem(MODEL_CHOICE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && parsed.provider && parsed.model) {
            return parsed
          }
        }
      } catch {}
      return null
    }

    function writeModelChoice(choice) {
      if (choice && choice.provider && choice.model) {
        localStorage.setItem(MODEL_CHOICE_KEY, JSON.stringify(choice))
      }
    }

    /** Fill at the bar open when it gaps through a limit / SL / TP. Default on. */
    function readGapFill() {
      try {
        const raw = localStorage.getItem(GAP_FILL_KEY)
        return raw == null ? true : raw === '1'
      } catch {
        return true
      }
    }

    function writeGapFill(enabled) {
      try {
        localStorage.setItem(GAP_FILL_KEY, enabled ? '1' : '0')
      } catch {}
    }

    function PanelIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 20,
          height: 20,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
        },
        h('path', { d: 'M4 19V5' }),
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M8 17V9l3 4 3-6 4 8' }),
      )
    }

    function ChartPane({
      bars,
      drawings,
      selectedDrawingId,
      locateToken,
      drawMode,
      indicatorOptions,
      indicatorData,
      onChartReady,
      onChartClick,
      onChartError,
      onNeedMoreHistory,
      fitToken,
      position,
      orderDraft,
      pendingOrders,
      digits,
      onAdjustStop,
      height,
      chartApiRef,
    }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const chartRef = useRef(null)
      const seriesRef = useRef(null)
      const indicatorSeriesRef = useRef(null)
      const indicatorOptionsRef = useRef(indicatorOptions)
      const indicatorDataRef = useRef(indicatorData)
      const fitTokenRef = useRef(fitToken)
      const locateTokenRef = useRef(locateToken)
      const chartLenRef = useRef(0)
      const chartFirstRef = useRef(null)
      const historyBusyRef = useRef(false)
      const overlayRafRef = useRef(0)
      const crosshairRef = useRef(null)
      const dragPreviewRef = useRef({ sl: null, tp: null })
      const positionRef = useRef(position)
      const drawModeRef = useRef(drawMode)
      const digitsRef = useRef(digits)
      const adjustStopRef = useRef(onAdjustStop)
      positionRef.current = position
      drawModeRef.current = drawMode
      digitsRef.current = digits
      adjustStopRef.current = onAdjustStop
      indicatorOptionsRef.current = indicatorOptions
      indicatorDataRef.current = indicatorData

      const redrawOverlay = useCallback(() => {
        const canvas = canvasRef.current
        const chart = chartRef.current
        const series = seriesRef.current
        if (!canvas || !chart || !series) return
        const rect = canvas.getBoundingClientRect()
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const ts = chart.timeScale()
        const timeToCoordinate = (time) => {
          const direct = ts.timeToCoordinate(time)
          if (direct != null) return direct
          const bars = barsRef.current || []
          let low = 0
          let high = bars.length - 1
          let match = -1
          while (low <= high) {
            const middle = Math.floor((low + high) / 2)
            if (bars[middle].time <= time) {
              match = middle
              low = middle + 1
            } else {
              high = middle - 1
            }
          }
          return match < 0 ? null : ts.timeToCoordinate(bars[match].time)
        }
        ctx.lineWidth = 1.5
        for (const d of drawings || []) {
          ctx.strokeStyle = d.color || '#f0b429'
          ctx.fillStyle = (d.color || '#f0b429') + '33'
          if (d.type === 'hline') {
            const y = series.priceToCoordinate(d.price)
            if (y == null) continue
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(canvas.width, y)
            ctx.stroke()
          } else if (d.type === 'trend' && d.t1 != null && d.t2 != null) {
            const x1 = timeToCoordinate(d.t1)
            const y1 = series.priceToCoordinate(d.p1)
            const x2 = timeToCoordinate(d.t2)
            const y2 = series.priceToCoordinate(d.p2)
            if ([x1, y1, x2, y2].some((v) => v == null)) continue
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
          } else if (d.type === 'ray' && d.t1 != null && d.t2 != null) {
            const x1 = timeToCoordinate(d.t1)
            const y1 = series.priceToCoordinate(d.p1)
            const x2 = timeToCoordinate(d.t2)
            const y2 = series.priceToCoordinate(d.p2)
            if ([x1, y1, x2, y2].some((value) => value == null)) continue
            const slope = x2 === x1 ? 0 : (y2 - y1) / (x2 - x1)
            const edgeX = x2 < x1 ? 0 : canvas.width
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(edgeX, y1 + slope * (edgeX - x1))
            ctx.stroke()
          } else if (d.type === 'vline' && d.t != null) {
            const x = timeToCoordinate(d.t)
            if (x == null) continue
            ctx.setLineDash([4, 4])
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, canvas.height)
            ctx.stroke()
            ctx.setLineDash([])
          } else if (d.type === 'rect' && d.t1 != null && d.t2 != null) {
            const x1 = timeToCoordinate(d.t1)
            const x2 = timeToCoordinate(d.t2)
            const y1 = series.priceToCoordinate(d.p1)
            const y2 = series.priceToCoordinate(d.p2)
            if ([x1, x2, y1, y2].some((v) => v == null)) continue
            const left = Math.min(x1, x2)
            const top = Math.min(y1, y2)
            ctx.fillRect(left, top, Math.abs(x2 - x1), Math.abs(y2 - y1))
            ctx.strokeRect(left, top, Math.abs(x2 - x1), Math.abs(y2 - y1))
          } else if (d.type === 'channel' && d.t1 != null && d.t2 != null && d.t3 != null) {
            const x1 = timeToCoordinate(d.t1)
            const x2 = timeToCoordinate(d.t2)
            const x3 = timeToCoordinate(d.t3)
            const y1 = series.priceToCoordinate(d.p1)
            const y2 = series.priceToCoordinate(d.p2)
            const y3 = series.priceToCoordinate(d.p3)
            if ([x1, x2, x3, y1, y2, y3].some((value) => value == null)) continue
            const baseAtThird = d.t2 === d.t1
              ? d.p1
              : d.p1 + (d.p2 - d.p1) * ((d.t3 - d.t1) / (d.t2 - d.t1))
            const priceOffset = d.p3 - baseAtThird
            const y1Parallel = series.priceToCoordinate(d.p1 + priceOffset)
            const y2Parallel = series.priceToCoordinate(d.p2 + priceOffset)
            if ([y1Parallel, y2Parallel].some((value) => value == null)) continue
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.lineTo(x2, y2Parallel)
            ctx.lineTo(x1, y1Parallel)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          } else if (d.type === 'text' && d.t != null && d.p != null && d.text) {
            const x = timeToCoordinate(d.t)
            const y = series.priceToCoordinate(d.p)
            if ([x, y].some((value) => value == null)) continue
            ctx.font = '12px sans-serif'
            const textWidth = ctx.measureText(d.text).width
            ctx.fillStyle = 'rgba(0,0,0,.65)'
            ctx.fillRect(x + 5, y - 17, textWidth + 10, 20)
            ctx.fillStyle = d.color || '#ffffff'
            ctx.fillText(d.text, x + 10, y - 3)
          } else if (d.type === 'fib' && d.t1 != null && d.t2 != null) {
            const x1 = timeToCoordinate(d.t1)
            const x2 = timeToCoordinate(d.t2)
            if ([x1, x2].some((value) => value == null)) continue
            const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
            for (const level of levels) {
              const price = d.p1 + (d.p2 - d.p1) * level
              const y = series.priceToCoordinate(price)
              if (y == null) continue
              ctx.strokeStyle = d.color || '#f0b429'
              ctx.beginPath()
              ctx.moveTo(Math.min(x1, x2), y)
              ctx.lineTo(Math.max(x1, x2), y)
              ctx.stroke()
              ctx.fillStyle = d.color || '#f0b429'
              ctx.font = '10px sans-serif'
              ctx.fillText(`${(level * 100).toFixed(level === 1 || level === 0 ? 0 : 1)}%`, Math.max(x1, x2) + 4, y - 3)
            }
          } else if (d.type === 'fib-extension' && d.t1 != null && d.t2 != null && d.t3 != null) {
            const x3 = timeToCoordinate(d.t3)
            if (x3 == null) continue
            const levels = [0, 0.618, 1, 1.618, 2, 2.618]
            for (const level of levels) {
              const price = d.p3 + (d.p2 - d.p1) * level
              const y = series.priceToCoordinate(price)
              if (y == null) continue
              ctx.strokeStyle = d.color || '#64b5f6'
              ctx.beginPath()
              ctx.moveTo(x3, y)
              ctx.lineTo(canvas.width, y)
              ctx.stroke()
              ctx.fillStyle = d.color || '#64b5f6'
              ctx.font = '10px sans-serif'
              ctx.fillText(`${level.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`, x3 + 4, y - 3)
            }
          }
        }
        // Custom horizontal crosshair: free normally, nudged onto the hovered
        // candle's body edges / wick tips when the cursor is within a few pixels.
        const cross = crosshairRef.current
        if (cross && cross.y >= 0 && cross.y <= canvas.height) {
          ctx.save()
          ctx.strokeStyle = '#758696'
          ctx.lineWidth = 1
          ctx.setLineDash([4, 4])
          const scaleWidth = chart.priceScale('right').width ? chart.priceScale('right').width() : 0
          const lineEnd = Math.max(0, canvas.width - (scaleWidth || 0))
          ctx.beginPath()
          ctx.moveTo(0, cross.y)
          ctx.lineTo(lineEnd, cross.y)
          ctx.stroke()
          ctx.setLineDash([])
          if (cross.price != null) {
            const text = Number(cross.price).toFixed(digits == null ? 5 : digits)
            ctx.font = '11px ui-sans-serif, system-ui, -apple-system, sans-serif'
            const tagW = ctx.measureText(text).width + 10
            const tagX = Math.max(2, canvas.width - tagW - 2)
            const tagY = Math.max(1, Math.min(canvas.height - 17, cross.y - 8))
            ctx.fillStyle = cross.snapped ? '#5f7186' : '#4c525e'
            ctx.fillRect(tagX, tagY, tagW, 16)
            ctx.fillStyle = '#ffffff'
            ctx.fillText(text, tagX + 5, tagY + 12)
          }
          ctx.restore()
        }
        const preview = dragPreviewRef.current
        const lines = []
        if (position) {
          const slPrice = preview.sl != null ? preview.sl : position.sl
          const tpPrice = preview.tp != null ? preview.tp : position.tp
          lines.push({ price: position.entry, color: '#9e9e9e', dash: [], label: '开仓' })
          if (slPrice != null) lines.push({ price: slPrice, color: '#ef5350', dash: [6, 4], label: 'SL' })
          if (tpPrice != null) lines.push({ price: tpPrice, color: '#26a69a', dash: [6, 4], label: 'TP' })
        }
        if (orderDraft && orderDraft.entry != null) {
          lines.push({ price: orderDraft.entry, color: '#90caf9', dash: [2, 4] })
        }
        for (const order of pendingOrders || []) {
          if (order.limitPrice != null) {
            lines.push({
              price: order.limitPrice,
              color: order.side === 'short' ? '#ef5350' : '#42a5f5',
              dash: [4, 3],
              label: `限价${order.side === 'short' ? '空' : '多'} ${order.lots} @`,
            })
          }
        }
        const priceDigits = digits == null ? 5 : digits
        const labels = []
        for (const line of lines) {
          const y = series.priceToCoordinate(line.price)
          if (y == null) continue
          ctx.strokeStyle = line.color
          ctx.setLineDash(line.dash)
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(canvas.width, y)
          ctx.stroke()
          ctx.setLineDash([])
          if (line.label && y >= 0 && y <= canvas.height) {
            labels.push({ y, text: `${line.label} ${Number(line.price).toFixed(priceDigits)}`, color: line.color })
          }
        }
        // MT5-style labels at the left edge; only shifted when two would overlap.
        ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif'
        const boxH = 17
        let lastBottom = -Infinity
        for (const label of labels.sort((a, b) => a.y - b.y)) {
          const boxW = ctx.measureText(label.text).width + 12
          let top = label.y - boxH / 2
          top = Math.max(2, Math.min(canvas.height - boxH - 2, top))
          if (top < lastBottom + 2) top = lastBottom + 2
          if (top + boxH > canvas.height - 2) top = canvas.height - boxH - 2
          lastBottom = top + boxH
          ctx.globalAlpha = 0.92
          ctx.fillStyle = label.color
          ctx.fillRect(6, top, boxW, boxH)
          ctx.globalAlpha = 1
          ctx.fillStyle = '#0b0b0c'
          ctx.fillText(label.text, 12, top + 12.5)
        }
      }, [drawings, position, orderDraft, pendingOrders, digits])

      const redrawOverlayRef = useRef(redrawOverlay)
      redrawOverlayRef.current = redrawOverlay

      // 建图只依赖 height；回调和数据走 ref，避免父组件每次渲染都重建图表导致 series 变空
      const barsRef = useRef(bars)
      const callbacksRef = useRef({})
      barsRef.current = bars
      callbacksRef.current = { onChartReady, onChartClick, onChartError, onNeedMoreHistory, redrawOverlay }

      /**
       * Snapshot exactly what is on screen right now: the visible bar window,
       * its time/price bounds, and a JPEG of the chart canvases + drawing
       * overlay. The assistant receives this with every question so it can see
       * the same pattern the user sees, while tools still receive real coords.
       */
      const captureViewport = useCallback(() => {
        const chart = chartRef.current
        const wrap = wrapRef.current
        const series = seriesRef.current
        const bars = barsRef.current || []
        if (!chart || !wrap || !series || !bars.length) return null
        let visible
        try {
          visible = chart.timeScale().getVisibleLogicalRange()
        } catch {
          return null
        }
        if (!visible || !Number.isFinite(visible.from) || !Number.isFinite(visible.to)) return null
        const firstIndex = Math.max(0, Math.floor(visible.from))
        const lastIndex = Math.min(bars.length - 1, Math.ceil(visible.to))
        if (lastIndex < firstIndex) return null
        const viewBars = bars.slice(firstIndex, lastIndex + 1)
        if (!viewBars.length) return null
        let min = Infinity
        let max = -Infinity
        for (const bar of viewBars) {
          if (bar.low < min) min = bar.low
          if (bar.high > max) max = bar.high
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null

        crosshairRef.current = null
        redrawOverlayRef.current()
        const rect = wrap.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        const dpr = window.devicePixelRatio || 1
        const targetWidth = Math.min(1024, Math.max(640, Math.round(rect.width * dpr)))
        const scale = targetWidth / rect.width
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(rect.width * scale))
        out.height = Math.max(1, Math.round(rect.height * scale))
        const ctx = out.getContext('2d')
        if (!ctx) return null
        const background = getComputedStyle(wrap).getPropertyValue('--dsw-alias-bg-base').trim() || '#0b0b0c'
        ctx.fillStyle = background
        ctx.fillRect(0, 0, out.width, out.height)
        const overlay = canvasRef.current
        const drawCanvas = (canvas) => {
          if (!canvas.width || !canvas.height) return
          const box = canvas.getBoundingClientRect()
          if (!box.width || !box.height) return
          ctx.drawImage(
            canvas,
            (box.left - rect.left) * scale,
            (box.top - rect.top) * scale,
            box.width * scale,
            box.height * scale,
          )
        }
        for (const canvas of Array.from(wrap.querySelectorAll('canvas'))) {
          if (canvas !== overlay) drawCanvas(canvas)
        }
        // The overlay is a sibling that may precede the chart node in DOM order.
        if (overlay) drawCanvas(overlay)
        const dataUrl = out.toDataURL('image/jpeg', 0.82)
        const comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        return {
          mediaType: 'image/jpeg',
          data: dataUrl.slice(comma + 1),
          width: out.width,
          height: out.height,
          range: { first: viewBars[0].time, last: viewBars[viewBars.length - 1].time },
          priceRange: { min, max },
          bars: viewBars.map((bar) => ({
            time: bar.time,
            openTime: bar.openTime,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
          })),
        }
      }, [])

      useEffect(() => {
        if (!chartApiRef) return undefined
        chartApiRef.current = { captureViewport }
        return () => {
          if (chartApiRef.current && chartApiRef.current.captureViewport === captureViewport) chartApiRef.current = null
        }
      }, [chartApiRef, captureViewport])

      useEffect(() => {
        let disposed = false
        loadLightweightCharts()
          .then((LWC) => {
            if (disposed || !wrapRef.current) return
            if (chartRef.current) {
              chartRef.current.remove()
              chartRef.current = null
            }
            const wrap = wrapRef.current
            // canvas 不解析 CSS 变量，需先取出实际颜色
            const css = getComputedStyle(wrap)
            const cssColor = (name, fallback) => css.getPropertyValue(name).trim() || fallback
            const initialIndicators = indicatorOptionsRef.current
            const hasSubchart = initialIndicators.rsi || initialIndicators.volume
            const chart = LWC.createChart(wrap, {
              width: Math.max(wrap.clientWidth, 320),
              height: height || 400,
              layout: {
                backgroundColor: 'transparent',
                background: { color: 'transparent' },
                textColor: cssColor('--dsw-alias-label-secondary', '#666'),
              },
              grid: {
                vertLines: { color: cssColor('--dsw-alias-border-l1', '#e6e6e6') },
                horzLines: { color: cssColor('--dsw-alias-border-l1', '#e6e6e6') },
              },
              rightPriceScale: {
                scaleMargins: { top: 0.04, bottom: hasSubchart ? (initialIndicators.rsi && initialIndicators.volume ? 0.38 : 0.26) : 0.04 },
              },
              crosshair: {
                mode: LWC.CrosshairMode.Normal,
                // Horizontal line / price label are drawn on the overlay so they can snap.
                horzLine: { visible: false, labelVisible: false },
                vertLine: { visible: true, labelVisible: true },
              },
              timeScale: {
                timeVisible: true,
                secondsVisible: false,
                barSpacing: DEFAULT_BAR_SPACING,
                rightOffset: DEFAULT_RIGHT_OFFSET,
              },
            })
            const series = addCandlestickSeries(chart, LWC, {
              upColor: '#26a69a',
              downColor: '#ef5350',
              borderVisible: false,
              wickUpColor: '#26a69a',
              wickDownColor: '#ef5350',
              priceFormat: priceFormatFor(digitsRef.current),
            })
            const ma20 = chart.addLineSeries({
              color: '#f5a623',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const ma50 = chart.addLineSeries({
              color: '#42a5f5',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const rsi = chart.addLineSeries({
              color: '#ab47bc',
              lineWidth: 1.5,
              priceScaleId: 'rsi',
              priceLineVisible: false,
              lastValueVisible: false,
              autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
            })
            const rsi30 = chart.addLineSeries({
              color: 'rgba(171,71,188,.35)',
              lineWidth: 1,
              lineStyle: LWC.LineStyle.Dashed,
              priceScaleId: 'rsi',
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const rsi50 = chart.addLineSeries({
              color: 'rgba(171,71,188,.2)',
              lineWidth: 1,
              lineStyle: LWC.LineStyle.Dotted,
              priceScaleId: 'rsi',
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const rsi70 = chart.addLineSeries({
              color: 'rgba(171,71,188,.35)',
              lineWidth: 1,
              lineStyle: LWC.LineStyle.Dashed,
              priceScaleId: 'rsi',
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const volume = chart.addHistogramSeries({
              priceScaleId: 'volume',
              priceFormat: { type: 'volume' },
              priceLineVisible: false,
              lastValueVisible: false,
            })
            const initialIndicatorData = indicatorDataRef.current
            ma20.setData(initialIndicatorData.ma20)
            ma50.setData(initialIndicatorData.ma50)
            rsi.setData(initialIndicatorData.rsi)
            rsi30.setData(initialIndicatorData.rsi30)
            rsi50.setData(initialIndicatorData.rsi50)
            rsi70.setData(initialIndicatorData.rsi70)
            volume.setData(initialIndicatorData.volume)
            chart.priceScale('rsi').applyOptions({
              visible: false,
              scaleMargins: {
                top: initialIndicators.volume ? 0.68 : 0.72,
                bottom: initialIndicators.volume ? 0.12 : 0.08,
              },
            })
            chart.priceScale('volume').applyOptions({
              visible: false,
              scaleMargins: { top: 0.88, bottom: 0.02 },
            })
            chartRef.current = chart
            seriesRef.current = series
            indicatorSeriesRef.current = { ma20, ma50, rsi, rsi30, rsi50, rsi70, volume }
            chartLenRef.current = 0
            chartFirstRef.current = null
            const initialData = barsForChart(barsRef.current || [])
            series.setData(initialData)
            chartLenRef.current = initialData.length
            chartFirstRef.current = initialData.length ? initialData[0].time : null
            if (initialData.length) chart.timeScale().scrollToRealTime()
            const callbacks = callbacksRef.current
            if (callbacks.onChartReady) callbacks.onChartReady({ chart, series })
            chart.subscribeClick((param) => {
              if (!param.point || !seriesRef.current) return
              const price = seriesRef.current.coordinateToPrice(param.point.y)
              const time = param.time
              const onClick = callbacksRef.current.onChartClick
              if (onClick) onClick({ time, price })
            })
            // Keep the overlay aligned after vertical price-scale changes.
            const scheduleOverlay = () => {
              if (overlayRafRef.current) return
              overlayRafRef.current = requestAnimationFrame(() => {
                overlayRafRef.current = 0
                callbacksRef.current.redrawOverlay()
              })
            }
            const findBarByTime = (time) => {
              if (typeof time !== 'number') return null
              const bars = barsRef.current || []
              let low = 0
              let high = bars.length - 1
              while (low <= high) {
                const middle = (low + high) >> 1
                const current = bars[middle].time
                if (current === time) return bars[middle]
                if (current < time) low = middle + 1
                else high = middle - 1
              }
              return null
            }
            // Normal mode crosshair; only nudge it when within a few pixels of the
            // hovered candle's body edges or wick tips (high / max(O,C) / min(O,C) / low).
            const updateCrosshair = (param) => {
              const currentSeries = seriesRef.current
              if (!currentSeries || !param || !param.point) {
                crosshairRef.current = null
                return
              }
              const price = currentSeries.coordinateToPrice(param.point.y)
              if (price == null) {
                crosshairRef.current = null
                return
              }
              const bar = findBarByTime(param.time)
              let best = null
              if (bar) {
                const levels = [
                  bar.high,
                  Math.max(bar.open, bar.close),
                  Math.min(bar.open, bar.close),
                  bar.low,
                ]
                for (const level of levels) {
                  const levelY = currentSeries.priceToCoordinate(level)
                  if (levelY == null) continue
                  const distance = Math.abs(levelY - param.point.y)
                  if (distance <= CROSSHAIR_SNAP_PX && (!best || distance < best.distance)) {
                    best = { y: levelY, price: level, distance }
                  }
                }
              }
              crosshairRef.current = best
                ? { y: best.y, price: best.price, snapped: true }
                : { y: param.point.y, price, snapped: false }
            }
            chart.subscribeCrosshairMove((param) => {
              updateCrosshair(param)
              scheduleOverlay()
            })
            chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
              crosshairRef.current = null
              callbacksRef.current.redrawOverlay()
              const needMore = callbacksRef.current.onNeedMoreHistory
              if (!needMore || !range || historyBusyRef.current) return
              if (range.from < HISTORY_EDGE) {
                historyBusyRef.current = true
                Promise.resolve()
                  .then(() => needMore())
                  .finally(() => {
                    setTimeout(() => {
                      historyBusyRef.current = false
                    }, 350)
                  })
              }
            })
            const syncCanvas = () => {
              const c = canvasRef.current
              const w = wrapRef.current
              if (!c || !w) return
              c.width = w.clientWidth
              c.height = w.clientHeight
              callbacksRef.current.redrawOverlay()
            }
            syncCanvas()
            const ro = new ResizeObserver(() => {
              if (!wrapRef.current || !chartRef.current) return
              chartRef.current.applyOptions({
                width: wrapRef.current.clientWidth,
                height: wrapRef.current.clientHeight,
              })
              syncCanvas()
            })
            ro.observe(wrapRef.current)
            chartRef.current.__ro = ro
            requestAnimationFrame(() => {
              if (!wrapRef.current || !chartRef.current) return
              chartRef.current.applyOptions({
                width: Math.max(wrapRef.current.clientWidth, 320),
                height: wrapRef.current.clientHeight,
              })
              syncCanvas()
            })
          })
          .catch((err) => {
            const onError = callbacksRef.current.onChartError
            if (onError) onError(err?.message || String(err))
          })
        return () => {
          disposed = true
          crosshairRef.current = null
          if (overlayRafRef.current) {
            cancelAnimationFrame(overlayRafRef.current)
            overlayRafRef.current = 0
          }
          if (chartRef.current) {
            if (chartRef.current.__ro) chartRef.current.__ro.disconnect()
            chartRef.current.remove()
            chartRef.current = null
            seriesRef.current = null
            indicatorSeriesRef.current = null
          }
        }
      }, [height])

      useEffect(() => {
        if (!seriesRef.current) return
        const candleData = barsForChart(bars)
        const prevLen = chartLenRef.current
        const prevFirst = chartFirstRef.current
        const nextFirst = candleData.length ? candleData[0].time : null
        const prepended =
          prevLen > 0 &&
          nextFirst != null &&
          prevFirst != null &&
          nextFirst < prevFirst &&
          candleData.length > prevLen
            ? candleData.length - prevLen
            : 0

        seriesRef.current.setData(candleData)

        const fitChanged = fitTokenRef.current !== fitToken
        fitTokenRef.current = fitToken

        if (chartRef.current && candleData.length && (fitChanged || prevLen === 0)) {
          // Explicit loads (initial, refresh, practice start, timeframe switch,
          // exit practice) fit/scroll once.
          chartRef.current.timeScale().scrollToRealTime()
        } else if (prepended > 0 && chartRef.current) {
          const range = chartRef.current.timeScale().getVisibleLogicalRange()
          if (range) {
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: range.from + prepended,
              to: range.to + prepended,
            })
          }
        }

        chartLenRef.current = candleData.length
        chartFirstRef.current = nextFirst
        callbacksRef.current.redrawOverlay()
      }, [bars, fitToken])

      useEffect(() => {
        redrawOverlay()
      }, [drawings, position, orderDraft, pendingOrders, redrawOverlay])

      useEffect(() => {
        if (!position && wrapRef.current) wrapRef.current.classList.remove('tp-drag-line')
      }, [position])

      // MT5-style: grab the SL / TP line on the chart and drag it to a new price.
      useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return undefined
        let drag = null

        const priceToY = (price) => {
          const series = seriesRef.current
          if (!series || price == null) return null
          return series.priceToCoordinate(price)
        }

        const hitLine = (clientY) => {
          const pos = positionRef.current
          if (!pos || drawModeRef.current !== 'pointer') return null
          const y = clientY - wrap.getBoundingClientRect().top
          let best = null
          for (const kind of ['sl', 'tp']) {
            const lineY = priceToY(pos[kind])
            if (lineY == null) continue
            const distance = Math.abs(lineY - y)
            if (distance <= 6 && (!best || distance < best.distance)) {
              best = { kind, distance }
            }
          }
          return best
        }

        const previewDrag = (clientY) => {
          const series = seriesRef.current
          if (!drag || !series) return
          const price = series.coordinateToPrice(clientY - drag.rect.top)
          if (price == null || !Number.isFinite(price)) return
          const decimals = digitsRef.current == null ? 5 : digitsRef.current
          dragPreviewRef.current[drag.kind] = Number(price.toFixed(decimals))
          redrawOverlayRef.current()
        }

        const stopDrag = () => {
          if (!drag) return
          const kind = drag.kind
          const price = dragPreviewRef.current[kind]
          drag = null
          dragPreviewRef.current[kind] = null
          wrap.classList.remove('tp-drag-line')
          window.removeEventListener('mousemove', onWindowMove, true)
          window.removeEventListener('mouseup', onWindowUp, true)
          const chart = chartRef.current
          if (chart) {
            try {
              chart.applyOptions({ handleScroll: true, handleScale: true })
            } catch {}
          }
          const adjust = adjustStopRef.current
          if (price != null && adjust) adjust(kind, price)
          redrawOverlayRef.current()
        }

        const onWindowMove = (event) => {
          if (!drag) return
          event.preventDefault()
          event.stopPropagation()
          previewDrag(event.clientY)
        }

        const onWindowUp = (event) => {
          if (!drag) return
          event.preventDefault()
          event.stopPropagation()
          stopDrag()
        }

        const onMouseDown = (event) => {
          if (event.button !== 0) return
          const hit = hitLine(event.clientY)
          if (!hit) return
          event.preventDefault()
          event.stopPropagation()
          drag = { kind: hit.kind, rect: wrap.getBoundingClientRect() }
          wrap.classList.add('tp-drag-line')
          // Hide the snap crosshair while the user is dragging a level.
          crosshairRef.current = null
          redrawOverlayRef.current()
          const chart = chartRef.current
          if (chart) {
            try {
              chart.applyOptions({ handleScroll: false, handleScale: false })
            } catch {}
          }
          previewDrag(event.clientY)
          window.addEventListener('mousemove', onWindowMove, true)
          window.addEventListener('mouseup', onWindowUp, true)
        }

        const onMouseMove = (event) => {
          if (drag) return
          wrap.classList.toggle('tp-drag-line', Boolean(hitLine(event.clientY)))
        }

        const onMouseLeave = () => {
          if (!drag) wrap.classList.remove('tp-drag-line')
        }

        wrap.addEventListener('mousedown', onMouseDown, true)
        wrap.addEventListener('mousemove', onMouseMove, true)
        wrap.addEventListener('mouseleave', onMouseLeave, true)
        return () => {
          wrap.removeEventListener('mousedown', onMouseDown, true)
          wrap.removeEventListener('mousemove', onMouseMove, true)
          wrap.removeEventListener('mouseleave', onMouseLeave, true)
          window.removeEventListener('mousemove', onWindowMove, true)
          window.removeEventListener('mouseup', onWindowUp, true)
          wrap.classList.remove('tp-drag-line')
          const chart = chartRef.current
          if (chart) {
            try {
              chart.applyOptions({ handleScroll: true, handleScale: true })
            } catch {}
          }
        }
      }, [])

      // Only an explicit locate (click a row in the drawing manager) may move the
      // viewport. Adding, editing, selecting or undoing a drawing must leave the
      // candles exactly where the user left them — earlier this effect also fired
      // on creation and re-zoomed the chart around the new drawing.
      useEffect(() => {
        if (locateToken === locateTokenRef.current) return
        locateTokenRef.current = locateToken
        if (selectedDrawingId == null || !chartRef.current) return
        const drawing = (drawings || []).find((item) => item.id === selectedDrawingId)
        if (!drawing) return
        const anchorTime = drawing.t ?? drawing.t1 ?? drawing.t2 ?? drawing.t3
        if (anchorTime == null) return
        const bars = barsRef.current || []
        let index = -1
        for (let current = 0; current < bars.length; current++) {
          if (bars[current].time > anchorTime) break
          index = current
        }
        if (index < 0) return
        chartRef.current.timeScale().setVisibleLogicalRange({
          from: Math.max(0, index - 24),
          to: Math.min(bars.length + DEFAULT_RIGHT_OFFSET, index + 24),
        })
      }, [locateToken])

      useEffect(() => {
        if (!seriesRef.current) return
        seriesRef.current.applyOptions({ priceFormat: priceFormatFor(digits) })
      }, [digits])

      useEffect(() => {
        const chart = chartRef.current
        const series = indicatorSeriesRef.current
        if (!chart || !series) return
        const hasSubchart = indicatorOptions.rsi || indicatorOptions.volume
        const hasBoth = indicatorOptions.rsi && indicatorOptions.volume
        chart.applyOptions({
          rightPriceScale: {
            scaleMargins: { top: 0.04, bottom: hasBoth ? 0.38 : hasSubchart ? 0.26 : 0.04 },
          },
        })
        chart.priceScale('rsi').applyOptions({
          visible: false,
          scaleMargins: {
            top: hasBoth ? 0.68 : 0.72,
            bottom: hasBoth ? 0.12 : 0.08,
          },
        })
        chart.priceScale('volume').applyOptions({
          visible: false,
          scaleMargins: { top: hasBoth ? 0.88 : 0.78, bottom: 0.02 },
        })
        series.ma20.setData(indicatorData.ma20)
        series.ma50.setData(indicatorData.ma50)
        series.rsi.setData(indicatorData.rsi)
        series.rsi30.setData(indicatorData.rsi30)
        series.rsi50.setData(indicatorData.rsi50)
        series.rsi70.setData(indicatorData.rsi70)
        series.volume.setData(indicatorData.volume)
      }, [indicatorOptions, indicatorData])

      return h(
        'div',
        {
          className: 'tp-chart-wrap' + (drawMode && drawMode !== 'pointer' ? ' tp-draw-mode' : ''),
          ref: wrapRef,
          style: { height: height || 400 },
        },
        h('canvas', { className: 'tp-overlay', ref: canvasRef }),
      )
    }

    function ModelPicker({ modelChoice, setModelChoice }) {
      const [catalogue, setCatalogue] = useState(null)
      const [modelMenu, setModelMenu] = useState(false)
      const [modelLoading, setModelLoading] = useState(true)

      const activeModel = useMemo(() => {
        if (!catalogue || !modelChoice) {
          return null
        }
        const provider = (catalogue.providers || []).find((item) => item.id === modelChoice.provider)
        const model = provider && provider.models.find((item) => item.id === modelChoice.model)
        return provider && model ? { provider, model } : null
      }, [catalogue, modelChoice])

      const effortOptions =
        activeModel && activeModel.model.reasoning ? activeModel.model.reasoning.efforts || [] : []
      const activeEffort = effortOptions.find((effort) => effort.id === (modelChoice && modelChoice.reasoningEffort)) || null

      const modelEntries = useMemo(() => {
        const groups = (catalogue && catalogue.providers) || []
        const defaultProvider = catalogue && catalogue.default ? catalogue.default.provider : null
        const rank = (providerId) =>
          modelChoice && modelChoice.provider === providerId ? 0 : defaultProvider === providerId ? 1 : 2
        const chosen = new Map()
        for (const provider of groups) {
          for (const model of provider.models || []) {
            const key = `${model.id}\u0000${model.name || model.id}`
            const existing = chosen.get(key)
            if (!existing || rank(provider.id) < rank(existing.provider.id)) {
              chosen.set(key, { provider, model })
            }
          }
        }
        return Array.from(chosen.values())
      }, [catalogue, modelChoice])

      useEffect(() => {
        let live = true
        fetch('/trade-practice/models', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (!live || !payload || !payload.ok) {
              return
            }
            setCatalogue(payload)
            setModelChoice((current) => {
              const providers = Array.isArray(payload.providers) ? payload.providers : []
              const known =
                current &&
                providers.some(
                  (provider) =>
                    provider.id === current.provider &&
                    provider.models.some((model) => model.id === current.model),
                )
              if (known) {
                return current
              }
              const saved = readModelChoice()
              if (
                saved &&
                providers.some(
                  (provider) =>
                    provider.id === saved.provider &&
                    provider.models.some((model) => model.id === saved.model),
                )
              ) {
                return saved
              }
              const fallback = payload.default || {}
              const provider = providers.find((item) => item.id === fallback.provider)
              const model = provider && provider.models.find((item) => item.id === fallback.model)
              if (provider && model) {
                return { provider: provider.id, model: model.id, reasoningEffort: fallback.reasoningEffort || '' }
              }
              const first = providers.find((item) => item.models.length)
              return first
                ? { provider: first.id, model: first.models[0].id, reasoningEffort: '' }
                : current
            })
          })
          .catch(() => {})
          .finally(() => {
            if (live) {
              setModelLoading(false)
            }
          })
        return () => {
          live = false
        }
      }, [setModelChoice])

      useEffect(() => {
        if (modelChoice) {
          writeModelChoice(modelChoice)
        }
      }, [modelChoice])

      useEffect(() => {
        if (!modelMenu) {
          return undefined
        }
        const close = (event) => {
          if (event.target.closest && event.target.closest('.tp-model')) {
            return
          }
          setModelMenu(false)
        }
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [modelMenu])

      const chooseModel = (providerId, modelId) => {
        const provider = (catalogue.providers || []).find((item) => item.id === providerId)
        const model = provider && provider.models.find((item) => item.id === modelId)
        if (!model) {
          return
        }
        const defaultEffort = model.reasoning && model.reasoning.defaultEffort ? model.reasoning.defaultEffort : ''
        setModelChoice({ provider: providerId, model: modelId, reasoningEffort: defaultEffort })
        setModelMenu(false)
      }

      const chooseEffort = (effortId) => {
        setModelChoice((current) => (current ? { ...current, reasoningEffort: effortId || '' } : current))
      }

      const renderMenu = () => {
        if (modelLoading) {
          return h('div', { className: 'tp-menu-muted' }, '正在加载模型…')
        }
        if (!modelEntries.length) {
          return h('div', { className: 'tp-menu-muted' }, '没有可用模型')
        }
        const items = []
        for (const { provider, model } of modelEntries) {
          const chosen = Boolean(
            modelChoice && modelChoice.provider === provider.id && modelChoice.model === model.id,
          )
          const vision = Array.isArray(model.modalities) ? model.modalities.includes('image') : null
          items.push(
            h(
              'button',
              {
                key: `m:${model.id}`,
                type: 'button',
                className: 'tp-menu-item' + (chosen ? ' tp-menu-item-active' : ''),
                onClick: () => chooseModel(provider.id, model.id),
              },
              model.name || model.id,
              vision
                ? h('span', { className: 'tp-menu-tag', title: '支持图片输入（可自动附上当前视图截图）' }, '图')
                : null,
            ),
          )
        }
        if (effortOptions.length) {
          items.push(h('div', { key: 'effort-h', className: 'tp-menu-heading' }, '推理等级'))
          for (const effort of effortOptions) {
            const chosen = Boolean(modelChoice && modelChoice.reasoningEffort === effort.id)
            items.push(
              h(
                'button',
                {
                  key: `e:${effort.id}`,
                  type: 'button',
                  className: 'tp-menu-item' + (chosen ? ' tp-menu-item-active' : ''),
                  onClick: () => chooseEffort(effort.id),
                },
                effort.name || effort.id,
              ),
            )
          }
        }
        return items
      }

      return h(
        'div',
        { className: 'tp-model' },
        h(
          'button',
          {
            type: 'button',
            className: 'tp-modelbtn',
            onClick: () => setModelMenu((open) => !open),
            'aria-expanded': modelMenu,
          },
          h('span', { className: 'tp-model-name' }, activeModel ? activeModel.model.name : modelLoading ? '模型…' : '选择模型'),
          activeEffort ? h('span', { className: 'tp-model-effort' }, activeEffort.name) : null,
        ),
        modelMenu ? h('div', { className: 'tp-menu tp-model-menu', role: 'menu' }, renderMenu()) : null,
      )
    }

    function ChatPanel({ symbol, interval, replayTime, practiceMode, visibleBars, allBars, account, position, pendingOrders, drawings, onDrawingCommand, captureViewport }) {
      const [messages, setMessages] = useState([])
      const [input, setInput] = useState('')
      const [streaming, setStreaming] = useState(false)
      const [modelChoice, setModelChoice] = useState(() => readModelChoice())
      const [agent, setAgent] = useState(null)
      const [agentStatus, setAgentStatus] = useState('idle')
      const [agentHistoryLoading, setAgentHistoryLoading] = useState(false)
      const [agentMenu, setAgentMenu] = useState(false)
      const abortRef = useRef(null)
      const eventSourceRef = useRef(null)
      const sessionRef = useRef(null)
      const answerRef = useRef('')
      const bootRef = useRef(false)
      const connectedRef = useRef(false)

      const upsertAssistant = (text) => {
        setMessages((current) => {
          const copy = [...current]
          const last = copy[copy.length - 1]
          if (last && last.role === 'assistant') copy[copy.length - 1] = { ...last, text }
          else copy.push({ role: 'assistant', text })
          return copy
        })
      }

      const appendNote = (text) => {
        setMessages((current) => [...current, { role: 'assistant', text }])
      }

      const applyAgentSnapshot = (payload) => {
        if (!payload || payload.available === false) {
          setAgent({ available: false, activeId: null, agents: [] })
          return
        }
        setAgent({
          available: true,
          activeId: payload.activeId || null,
          agents: Array.isArray(payload.agents) ? payload.agents : [],
        })
        setAgentStatus(payload.status || 'idle')
        if (payload.status === 'running') setStreaming(true)
      }

      const ackDrawing = (commandId, ok, message) => {
        fetch('/trade-practice/agent/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId, ok, message }),
        }).catch(() => {})
      }

      const loadAgentHistory = async (sessionId) => {
        setAgentHistoryLoading(true)
        try {
          const response = await fetch(`/trade-practice/agent/history?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json()
          if (payload && payload.ok) {
            setMessages(Array.isArray(payload.messages) ? payload.messages : [])
          }
        } catch {
        } finally {
          setAgentHistoryLoading(false)
        }
      }

      function handleAgentEvent(event) {
        if (!event || typeof event !== 'object') return
        if (event.type === 'hello' || event.type === 'status') {
          if (event.type === 'hello') connectedRef.current = true
          const status = event.status || 'idle'
          setAgentStatus(status)
          if (status === 'running') setStreaming(true)
          else if (status === 'idle') setStreaming(false)
          return
        }
        if (event.type === 'title' && event.sessionId && typeof event.title === 'string') {
          // The host names the session from its first message; reflect it in the
          // history picker without disturbing the running status.
          setAgent((prev) => {
            if (!prev || !Array.isArray(prev.agents)) return prev
            let changed = false
            const agents = prev.agents.map((item) => {
              if (item.id !== event.sessionId || item.title === event.title) return item
              changed = true
              return { ...item, title: event.title }
            })
            return changed ? { ...prev, agents } : prev
          })
          return
        }
        if (event.type === 'assistant' && event.frame) {
          const frame = event.frame
          if (frame.type === 'start') {
            setStreaming(true)
            return
          }
          if (frame.type === 'chunk') {
            const chunk = frame.chunk
            if (chunk && chunk.type === 'text-delta' && chunk.text) {
              answerRef.current += chunk.text
              upsertAssistant(answerRef.current)
            }
            return
          }
          if (frame.type === 'end') {
            // The attempt ended; the agent may still continue with tool calls.
            // Only the authoritative idle status clears the busy state.
            return
          }
          return
        }
        if (event.type === 'assistant-message' && event.text) {
          if (!answerRef.current) {
            answerRef.current = event.text
            upsertAssistant(answerRef.current)
          }
          return
        }
        if (event.type === 'drawing' && event.command) {
          try {
            if (typeof onDrawingCommand === 'function') onDrawingCommand(event.command)
            ackDrawing(event.commandId, true)
          } catch (error) {
            ackDrawing(event.commandId, false, error.message || String(error))
          }
          return
        }
        if (event.type === 'error') {
          appendNote(event.message || 'agent 出错')
        }
      }

      const connectAgent = (sessionId, withHistory = true) => {
        if (!sessionId) return
        connectedRef.current = false
        if (eventSourceRef.current) {
          eventSourceRef.current.close()
          eventSourceRef.current = null
        }
        sessionRef.current = sessionId
        const source = new EventSource(`/trade-practice/agent/events?sessionId=${encodeURIComponent(sessionId)}`)
        eventSourceRef.current = source
        source.onmessage = (message) => {
          try {
            handleAgentEvent(JSON.parse(message.data))
          } catch {}
        }
        source.onerror = () => {
          connectedRef.current = false
        }
        if (withHistory) loadAgentHistory(sessionId)
      }

      const bootstrapAgent = async () => {
        if (bootRef.current || !modelChoice?.provider || !modelChoice?.model) return
        bootRef.current = true
        try {
          const response = await fetch('/trade-practice/agent/bootstrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: modelChoice.provider,
              model: modelChoice.model,
              reasoningEffort: modelChoice.reasoningEffort || undefined,
              symbol,
            }),
          })
          const payload = await response.json()
          if (!response.ok || !payload || !payload.ok || payload.available === false) {
            setAgent({ available: false, activeId: null, agents: [] })
            return
          }
          applyAgentSnapshot(payload)
          if (payload.activeId) connectAgent(payload.activeId, true)
        } catch {
          setAgent({ available: false, activeId: null, agents: [] })
        }
      }

      useEffect(() => {
        bootstrapAgent()
      }, [modelChoice?.provider, modelChoice?.model])

      useEffect(() => () => {
        if (eventSourceRef.current) {
          eventSourceRef.current.close()
          eventSourceRef.current = null
        }
      }, [])

      useEffect(() => {
        if (!agentMenu) return undefined
        const close = (event) => {
          if (event.target.closest && event.target.closest('.tp-agent')) return
          setAgentMenu(false)
        }
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [agentMenu])

      const compactBar = (bar) => ({
        time: bar.time,
        openTime: bar.openTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })

      const buildDrawingsPayload = (range, priceRange) => {
        const first = Number(range?.first)
        const last = Number(range?.last)
        const min = Number(priceRange?.min)
        const max = Number(priceRange?.max)
        return drawings.slice(-200).map((drawing) => {
          const times = [drawing.t, drawing.t1, drawing.t2, drawing.t3].filter((value) => Number.isFinite(value))
          let inView
          if (drawing.type === 'hline' && Number.isFinite(drawing.price)) {
            inView = Number.isFinite(min) && Number.isFinite(max)
              ? drawing.price >= min && drawing.price <= max
              : undefined
          } else if (times.length && Number.isFinite(first) && Number.isFinite(last)) {
            inView = times.some((time) => time >= first && time <= last)
          }
          return {
            id: drawing.id,
            type: drawing.type,
            text: drawing.text || '',
            color: drawing.color || '',
            source: drawing.source || (String(drawing.id || '').startsWith('agent-') ? 'agent' : 'user'),
            ...(inView === undefined ? {} : { inView }),
            ...(drawing.price != null ? { price: drawing.price } : {}),
            ...(drawing.t != null ? { t: drawing.t } : {}),
            ...(drawing.p != null ? { p: drawing.p } : {}),
            ...(drawing.t1 != null ? { t1: drawing.t1 } : {}),
            ...(drawing.p1 != null ? { p1: drawing.p1 } : {}),
            ...(drawing.t2 != null ? { t2: drawing.t2 } : {}),
            ...(drawing.p2 != null ? { p2: drawing.p2 } : {}),
            ...(drawing.t3 != null ? { t3: drawing.t3 } : {}),
            ...(drawing.p3 != null ? { p3: drawing.p3 } : {}),
          }
        })
      }

      const buildViewportPayload = async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()))
        let viewport = null
        try {
          viewport = typeof captureViewport === 'function' ? captureViewport() : null
        } catch {
          viewport = null
        }
        const range = viewport?.range || (visibleBars.length
          ? { first: visibleBars[0].time, last: visibleBars[visibleBars.length - 1].time }
          : null)
        const priceRange = viewport?.priceRange || null
        const cutoff = visibleBars.length ? visibleBars[visibleBars.length - 1].time : range?.last
        const dataStart = allBars?.[0]?.time ?? visibleBars[0]?.time
        const source = Array.isArray(allBars) && allBars.length ? allBars : visibleBars
        let historyBars = []
        if (Number.isFinite(range?.first)) {
          const index = source.findIndex((bar) => bar.time >= range.first)
          const end = index < 0 ? source.length : index
          historyBars = source.slice(Math.max(0, end - 120), end).map(compactBar)
        }
        return {
          viewport,
          range,
          priceRange,
          cutoff,
          dataStart,
          historyBars,
          drawings: buildDrawingsPayload(range, priceRange),
          viewportBars: viewport?.bars || visibleBars.slice(-120).map(compactBar),
        }
      }

      const sendAgent = async (question, context) => {
        answerRef.current = ''
        const response = await fetch('/trade-practice/agent/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            symbol,
            interval: interval || SOURCE_INTERVAL,
            replayTime,
            mode: practiceMode ? 'practice' : 'view',
            visibleBars: visibleBars.length,
            cutoff: context.cutoff,
            dataStart: context.dataStart,
            viewport: {
              range: context.range,
              priceRange: context.priceRange,
              bars: context.viewportBars,
              historyBars: context.historyBars,
              ...(context.viewport
                ? { image: { mediaType: context.viewport.mediaType, data: context.viewport.data } }
                : {}),
            },
            account: practiceMode ? {
              balance: account.balance,
              realizedPnl: account.realizedPnl,
              initial: account.initial,
              name: account.name,
            } : null,
            position,
            pendingOrders,
            drawings: context.drawings,
            question,
          }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'agent 请求失败')
      }

      const sendLegacy = async (question, context) => {
        let answer = ''
        const response = await fetch('/trade-practice/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            symbol,
            interval: interval || SOURCE_INTERVAL,
            replayTime,
            mode: practiceMode ? 'practice' : 'view',
            visibleBars: visibleBars.length,
            recentBars: visibleBars.slice(-20),
            cutoff: context.cutoff,
            dataStart: context.dataStart,
            provider: modelChoice.provider,
            model: modelChoice.model,
            reasoningEffort: modelChoice.reasoningEffort || undefined,
            account: practiceMode ? {
              balance: account.balance,
              realizedPnl: account.realizedPnl,
              initial: account.initial,
              name: account.name,
            } : null,
            position,
            pendingOrders,
            drawings: context.drawings,
            viewport: context.viewport
              ? {
                  range: context.range,
                  priceRange: context.priceRange,
                  bars: context.viewportBars,
                  historyBars: context.historyBars,
                  image: { mediaType: context.viewport.mediaType, data: context.viewport.data },
                }
              : null,
            barsRange: context.range,
            question,
          }),
        })
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}))
          throw new Error(errBody.error || '请求失败')
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() || ''
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue
            const evt = JSON.parse(line.slice(6))
            if (evt.type === 'delta' && evt.text) {
              answer += evt.text
              upsertAssistant(answer)
            } else if (evt.type === 'drawing' && evt.command) {
              if (typeof onDrawingCommand === 'function') onDrawingCommand(evt.command)
            } else if (evt.type === 'tool' && evt.message) {
              const note = `〔画线〕${evt.ok === false ? `未执行：${evt.message}` : evt.message}`
              answer = answer ? `${answer}\n\n${note}\n\n` : `${note}\n\n`
              upsertAssistant(answer)
            } else if (evt.type === 'notice' && evt.text) {
              answer = answer ? `${answer}\n\n（${evt.text}）\n\n` : `（${evt.text}）\n\n`
              upsertAssistant(answer)
            } else if (evt.type === 'error') throw new Error(evt.message)
          }
        }
        if (!answer) upsertAssistant('（无回复）')
      }

      const switchAgent = async (sessionId) => {
        setAgentMenu(false)
        if (!sessionId || sessionId === agent?.activeId) return
        try {
          const response = await fetch('/trade-practice/agent/switch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json()
          if (!response.ok || !payload.ok) throw new Error(payload.error || '切换失败')
          setMessages([])
          applyAgentSnapshot(payload)
          connectAgent(payload.activeId, true)
        } catch (error) {
          appendNote(error.message || String(error))
        }
      }

      const createAgent = async () => {
        setAgentMenu(false)
        if (!modelChoice?.provider || !modelChoice?.model) {
          appendNote('请先选择模型')
          return
        }
        try {
          const response = await fetch('/trade-practice/agent/new', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: modelChoice.provider,
              model: modelChoice.model,
              reasoningEffort: modelChoice.reasoningEffort || undefined,
              symbol,
            }),
          })
          const payload = await response.json()
          if (!response.ok || !payload.ok) throw new Error(payload.error || '新建失败')
          setMessages([])
          applyAgentSnapshot(payload)
          connectAgent(payload.activeId, true)
        } catch (error) {
          appendNote(error.message || String(error))
        }
      }

      // Same as the PDF plugin: the row's × deletes immediately, no confirm.
      const removeAgent = async (sessionId) => {
        const id = sessionId || agent?.activeId
        if (!id) return
        setAgentMenu(false)
        try {
          const response = await fetch('/trade-practice/agent/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: id }),
          })
          const payload = await response.json()
          if (!response.ok || !payload.ok) throw new Error(payload.error || '删除失败')
          applyAgentSnapshot(payload)
          if (id !== agent?.activeId) return
          if (payload.activeId) {
            connectAgent(payload.activeId, true)
          } else {
            if (eventSourceRef.current) eventSourceRef.current.close()
            eventSourceRef.current = null
            sessionRef.current = null
            setMessages([])
            await createAgent()
          }
        } catch (error) {
          appendNote(error.message || String(error))
        }
      }

      const send = async () => {
        const question = input.trim()
        if (!question || streaming) return
        if (!modelChoice || !modelChoice.provider || !modelChoice.model) {
          appendNote('请先在上方选择对话模型')
          return
        }
        if (agent === null) {
          appendNote('正在连接 agent…')
          return
        }
        if (agent.available && !connectedRef.current) {
          appendNote('agent 事件流正在连接，请稍候再发送')
          return
        }
        setInput('')
        setMessages((m) => [...m, { role: 'user', text: question }])
        setStreaming(true)
        const controller = new AbortController()
        abortRef.current = controller
        let useAgent = false
        try {
          const context = await buildViewportPayload()
          if (agent.available && sessionRef.current) {
            useAgent = true
            await sendAgent(question, context)
          } else {
            await sendLegacy(question, context)
          }
        } catch (err) {
          if (err.name !== 'AbortError') appendNote(err.message || String(err))
          setStreaming(false)
        } finally {
          if (!useAgent) setStreaming(false)
          abortRef.current = null
        }
      }

      const activeAgent = agent && Array.isArray(agent.agents)
        ? agent.agents.find((item) => item.id === agent.activeId)
        : null
      const activeAgentLabel = activeAgent ? (activeAgent.title || '新会话') : '新会话'

      return h(
        'div',
        { className: 'tp-chat' },
        h(
          'div',
          { className: 'tp-chat-toolbar' },
          h(ModelPicker, { modelChoice, setModelChoice }),
          h('span', { className: 'tp-chat-hint', title: '发送时自动截取当前屏幕可见的 K 线范围；模型不支持图片时自动降级为纯 K 线数据' }, '自动附当前视图'),
        ),
        agent && agent.available
          ? h(
              'div',
              { className: 'tp-agent-bar' },
              h('span', { className: agentStatus === 'running' ? 'tp-agent-state tp-agent-state-busy' : 'tp-agent-state' }, agentStatus === 'running' ? '运行中' : '就绪'),
              h(
                'div',
                { className: 'tp-agent' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp-agentbtn',
                    onClick: () => setAgentMenu((open) => !open),
                    title: '切换历史 agent',
                    'aria-haspopup': 'menu',
                    'aria-expanded': agentMenu,
                  },
                  h('span', { className: 'tp-agent-name' }, activeAgentLabel),
                  h('span', { className: 'tp-agent-caret', 'aria-hidden': true }),
                ),
                agentMenu
                  ? h(
                      'div',
                      { className: 'tp-menu tp-agent-menu', role: 'menu' },
                      agent.agents.length
                        ? agent.agents.map((item) => h(
                            'div',
                            {
                              key: item.id,
                              className: `tp-agent-row${item.id === agent.activeId ? ' is-active' : ''}`,
                            },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'tp-agent-pick',
                                onClick: () => switchAgent(item.id),
                              },
                              h('span', { className: 'tp-agent-row-name' }, item.title || (item.archived ? '未命名' : '新会话')),
                              item.archived ? h('span', { className: 'tp-agent-tag' }, '归档') : null,
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'tp-agent-del',
                                title: '删除这个会话',
                                'aria-label': '删除这个会话',
                                onClick: (event) => {
                                  event.stopPropagation()
                                  removeAgent(item.id)
                                },
                              },
                              '×',
                            ),
                          ))
                        : h('div', { className: 'tp-menu-muted' }, '暂无历史'),
                    )
                  : null,
              ),
              h('button', { type: 'button', className: 'tp-btn tp-btn-mini', onClick: createAgent }, '新建'),
              agentHistoryLoading ? h('span', { className: 'tp-agent-loading' }, '加载历史…') : null,
            )
          : agent && agent.available === false
            ? h('div', { className: 'tp-agent-off' }, 'agent 层不可用，当前使用直连模式')
            : null,
        h(
          'div',
          { className: 'tp-chat-log' },
          messages.map((msg, i) =>
            h('div', { key: i, className: msg.role === 'user' ? 'tp-chat-user' : 'tp-chat-ai' }, msg.text),
          ),
        ),
        h(
          'div',
          { className: 'tp-chat-input-row' },
          h('textarea', {
            className: 'tp-chat-input',
            rows: 2,
            value: input,
            placeholder: '问市场结构、这笔单、风险管理…（也可说：画一条 3340 支撑线）',
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            },
          }),
          h(
            'div',
            { className: 'tp-chat-actions' },
            h(VoiceMic, {
              disabled: streaming || agentHistoryLoading,
              onText: (text) => setInput((value) => (value ? value + ' ' + text : text)),
            }),
            h(
              'button',
              { type: 'button', className: 'tp-btn tp-btn-primary', disabled: streaming || agentHistoryLoading, onClick: send },
              streaming ? '…' : '发送',
            ),
          ),
        ),
      )
    }

    function PracticePanel() {
      const [symbol, setSymbol] = useState('XAUUSD')
      const [tf, setTf] = useState('1m')
      const [allBars, setAllBars] = useState([])
      const [mtimeMs, setMtimeMs] = useState(0)
      const [cutoffInput, setCutoffInput] = useState('')
      const [practiceSetup, setPracticeSetup] = useState(false)
      const [practiceMode, setPracticeMode] = useState(false)
      const [visibleCount, setVisibleCount] = useState(0)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [playing, setPlaying] = useState(false)
      const [asideTab, setAsideTab] = useState('trade')
      const [drawMode, setDrawMode] = useState('pointer')
      const [drawings, setDrawings] = useState([])
      const [selectedDrawingId, setSelectedDrawingId] = useState(null)
      const [locateToken, setLocateToken] = useState(0)
      const [drawingManagerOpen, setDrawingManagerOpen] = useState(false)
      const [drawingsLoadedFor, setDrawingsLoadedFor] = useState('')
      const [drawPending, setDrawPending] = useState(null)
      const [indicatorOptions, setIndicatorOptions] = useState({ ma: false, rsi: false, volume: false })
      const [gapFill, setGapFill] = useState(readGapFill)
      const [registry, setRegistry] = useState(() => readRegistry())
      const [lots, setLots] = useState(0.1)
      const [orderType, setOrderType] = useState('market')
      const [limitInput, setLimitInput] = useState('')
      const [slInput, setSlInput] = useState('')
      const [tpInput, setTpInput] = useState('')
      const [lastEvent, setLastEvent] = useState('')
      const [truncated, setTruncated] = useState(false)
      const [hasMoreHistory, setHasMoreHistory] = useState(false)
      const [hasMoreFuture, setHasMoreFuture] = useState(false)
      const [historyLoading, setHistoryLoading] = useState(false)
      const [fitToken, setFitToken] = useState(0)
      const [chartError, setChartError] = useState('')
      const simCursorRef = useRef(-1)
      const historyLockRef = useRef(false)
      const allBarsRef = useRef([])
      allBarsRef.current = allBars
      const practiceModeRef = useRef(false)
      practiceModeRef.current = practiceMode
      const loadCsvRef = useRef(null)
      const replayTimeRef = useRef(null)
      const lastSymbolRef = useRef(symbol)
      const practiceLoadTokenRef = useRef(0)
      const chartApiRef = useRef(null)

      const account = useMemo(() => {
        const found = registry.accounts.find((item) => item.id === registry.activeId)
        return found ? normaliseAccount(found) : normaliseAccount(registry.accounts[0])
      }, [registry])

      const commitRegistry = useCallback((updater) => {
        setRegistry((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater
          writeRegistry(next)
          return next
        })
      }, [])

      const patchAccount = useCallback(
        (fn) => {
          commitRegistry((prev) => updateActiveAccount(prev, fn))
        },
        [commitRegistry],
      )

      const symbolPosition = useMemo(() => positionForSymbol(account, symbol), [account, symbol])
      const symbolPending = useMemo(() => pendingForSymbol(account, symbol), [account, symbol])

      const spec = SPECS[symbol] || SPECS.XAUUSD
      const cutoffIso = useMemo(() => parseServerInput(cutoffInput), [cutoffInput])

      // Price precision comes from the loaded OHLC values, not a fixed symbol digit.
      const digits = useMemo(() => inferPriceDigits(allBars), [allBars])

      const visibleBars = useMemo(() => {
        if (!allBars.length) return []
        if (!practiceMode) return allBars
        const count = visibleCount > 0 ? Math.min(visibleCount, allBars.length) : 0
        return allBars.slice(0, count)
      }, [allBars, practiceMode, visibleCount])

      const replayTime = useMemo(() => {
        const latestBar = visibleBars[visibleBars.length - 1]
        if (!latestBar) return null
        return latestBar.openTime || new Date(latestBar.time * 1000).toISOString()
      }, [visibleBars])

      replayTimeRef.current = replayTime

      const indicatorData = useMemo(
        () => buildIndicatorData(visibleBars, indicatorOptions),
        [visibleBars, indicatorOptions],
      )

      const loadCsv = useCallback(async () => {
        // Invalidate any in-flight practice restore before loading the latest bars.
        practiceLoadTokenRef.current += 1
        setLoading(true)
        setError('')
        setHasMoreHistory(false)
        try {
          const data = await getJson(
            `/trade-practice/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&from=${encodeURIComponent(DATA_FROM)}&limit=${CHART_PAGE}`,
          )
          setAllBars(data.bars || [])
          setMtimeMs(data.mtimeMs || 0)
          setTruncated(Boolean(data.truncated))
          setHasMoreHistory(Boolean(data.truncated || data.hasMore))
          setHasMoreFuture(false)
          setFitToken((n) => n + 1)
          const n = (data.bars || []).length
          setVisibleCount(n)
          setPracticeMode(false)
          setPracticeSetup(false)
          simCursorRef.current = -1
          setChartError('')
        } catch (err) {
          setError(err.message || String(err))
          setAllBars([])
          setHasMoreHistory(false)
          setHasMoreFuture(false)
        } finally {
          setLoading(false)
        }
      }, [symbol, tf])

      loadCsvRef.current = loadCsv

      // Background data checks finish with a chart reload; never let that eject
      // an active practice session. The user can refresh explicitly after exiting.
      const handleDataRefresh = useCallback(() => {
        if (practiceModeRef.current) {
          setLastEvent('后台数据检查完成；练习不打断，退出练习后可点「刷新图表」')
          return
        }
        const refresh = loadCsvRef.current
        if (refresh) refresh()
      }, [])

      const chooseRandomPracticeTime = useCallback(() => {
        setError('')
        getJson(`/trade-practice/meta?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}`)
          .then((meta) => {
            const firstTime = Date.parse(meta.first)
            const lastTime = Date.parse(meta.last)
            if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
              throw new Error('当前品种没有可用历史数据')
            }
            const rangeEnd = Math.max(firstTime, lastTime - 5 * 24 * 60 * 60 * 1000)
            const randomTime = firstTime + Math.floor(Math.random() * (rangeEnd - firstTime + 1))
            setCutoffInput(formatServerInput(new Date(randomTime).toISOString()))
          })
          .catch((err) => setError(err.message || String(err)))
      }, [symbol, tf])

      const loadPracticeWindow = useCallback(async (targetIso, options = {}) => {
        const token = ++practiceLoadTokenRef.current
        setLoading(true)
        setError('')
        setPlaying(false)
        try {
          const targetTime = alignPracticeTime(targetIso, tf)
          const alignedIso = new Date(targetTime * 1000).toISOString()
          const base = `/trade-practice/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${CHART_PAGE}`
          const [before, after] = await Promise.all([
            getJson(`${base}&from=${encodeURIComponent(DATA_FROM)}&to=${encodeURIComponent(alignedIso)}`),
            getJson(`${base}&from=${encodeURIComponent(alignedIso)}&direction=forward`),
          ])
          const byTime = new Map()
          for (const bar of [...(before.bars || []), ...(after.bars || [])]) {
            byTime.set(bar.time, bar)
          }
          const combined = [...byTime.values()].sort((a, b) => a.time - b.time)
          let targetIndex = -1
          for (let index = 0; index < combined.length; index++) {
            if (combined[index].time > targetTime) break
            targetIndex = index
          }
          if (targetIndex < 0) {
            throw new Error('所选时间附近没有可用 K 线，请选择有数据的时间')
          }
          if (token !== practiceLoadTokenRef.current) return false
          setAllBars(combined)
          setMtimeMs(Math.max(before.mtimeMs || 0, after.mtimeMs || 0))
          setHasMoreHistory(Boolean(before.truncated || before.hasMore))
          setHasMoreFuture(Boolean(after.truncated || after.hasMore))
          setTruncated(Boolean(before.truncated || after.truncated))
          if (options.updateCutoff) setCutoffInput(formatServerInput(combined[targetIndex].openTime))
          setVisibleCount(targetIndex + 1)
          setPracticeMode(true)
          setPracticeSetup(false)
          setFitToken((n) => n + 1)
          simCursorRef.current = targetIndex
          setChartError('')
          return true
        } catch (err) {
          if (token === practiceLoadTokenRef.current) setError(err.message || String(err))
          return false
        } finally {
          if (token === practiceLoadTokenRef.current) setLoading(false)
        }
      }, [symbol, tf])

      const startPractice = useCallback(async () => {
        if (!cutoffIso) {
          setError('请选择练习时间')
          return
        }
        await loadPracticeWindow(cutoffIso, { updateCutoff: true })
      }, [cutoffIso, loadPracticeWindow])

      const advancePractice = useCallback(async () => {
        if (visibleCount < allBars.length) {
          setVisibleCount((count) => Math.min(count + 1, allBars.length))
          return
        }
        if (!hasMoreFuture || loading || !allBars.length) return
        setLoading(true)
        try {
          const last = allBars[allBars.length - 1]
          const from = new Date((last.time + 1) * 1000).toISOString()
          const data = await getJson(
            `/trade-practice/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&from=${encodeURIComponent(from)}&limit=${CHART_PAGE}&direction=forward`,
          )
          const nextBars = (data.bars || []).filter((bar) => bar.time > last.time)
          if (!nextBars.length) {
            setHasMoreFuture(false)
            return
          }
          setAllBars((bars) => bars.concat(nextBars))
          setVisibleCount((count) => count + 1)
          setHasMoreFuture(Boolean(data.truncated || data.hasMore))
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setLoading(false)
        }
      }, [visibleCount, allBars, hasMoreFuture, loading, symbol, tf])

      const loadOlderHistory = useCallback(async () => {
        if (historyLockRef.current || historyLoading || !hasMoreHistory) {
          return
        }
        const current = allBarsRef.current
        if (!current.length) {
          return
        }
        if (current.length >= MAX_CHART_BARS) {
          setHasMoreHistory(false)
          return
        }
        historyLockRef.current = true
        setHistoryLoading(true)
        try {
          const first = current[0]
          const toIso = new Date(first.time * 1000 - 1).toISOString()
          const room = Math.max(1, MAX_CHART_BARS - current.length)
          const page = Math.min(HISTORY_PAGE, room)
          const data = await getJson(
            `/trade-practice/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&from=${encodeURIComponent(DATA_FROM)}&to=${encodeURIComponent(toIso)}&limit=${page}`,
          )
          const older = (data.bars || []).filter((b) => b.time < first.time)
          if (!older.length) {
            setHasMoreHistory(false)
            return
          }
          const seen = new Set(current.map((b) => b.time))
          const head = []
          for (const bar of older) {
            if (seen.has(bar.time)) continue
            seen.add(bar.time)
            head.push(bar)
            if (head.length >= room) break
          }
          if (!head.length) {
            setHasMoreHistory(Boolean(data.truncated || data.hasMore))
            return
          }
          setAllBars((prev) => head.concat(prev))
          setVisibleCount((prev) => prev + head.length)
          const more = Boolean(data.truncated || data.hasMore) && current.length + head.length < MAX_CHART_BARS
          setHasMoreHistory(more)
          setTruncated(more)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setHistoryLoading(false)
          historyLockRef.current = false
        }
      }, [hasMoreHistory, historyLoading, symbol, tf])

      useEffect(() => {
        const symbolChanged = lastSymbolRef.current !== symbol
        if (!symbolChanged && practiceModeRef.current && replayTimeRef.current) {
          // Timeframe switch inside practice: keep the session and re-anchor on
          // the same replay time instead of reloading the latest bars.
          loadPracticeWindow(replayTimeRef.current, { updateCutoff: false })
          return
        }
        lastSymbolRef.current = symbol
        loadCsv()
        simCursorRef.current = -1
      }, [symbol, tf, loadCsv, loadPracticeWindow])

      useEffect(() => {
        try {
          setDrawings(readDrawingsForSymbol(symbol))
        } catch {
          setDrawings([])
        }
        setSelectedDrawingId(null)
        setDrawingsLoadedFor(symbol)
      }, [symbol])

      useEffect(() => {
        if (drawingsLoadedFor !== symbol) return
        localStorage.setItem(loadDrawingsKey(symbol), JSON.stringify(drawings))
      }, [drawings, drawingsLoadedFor, symbol])

      const runSimForBarIndex = useCallback(
        (index) => {
          if (index < 0 || index >= visibleBars.length) {
            return
          }
          const bar = visibleBars[index]
          patchAccount((acct) => {
            const { account: next, exit, fill } = simulateBarOnAccount(acct, bar, index, symbol, spec, { gapFill })
            if (exit) {
              setLastEvent(
                `${exit.reason === 'tp' ? '止盈' : '止损'}${exit.gap ? '（跳空）' : ''} @ ${formatPrice(exit.exitPrice, digits)} · PnL ${exit.pnl.toFixed(2)}`,
              )
            } else if (fill) {
              setLastEvent(
                `限价${fill.order.side === 'long' ? '多' : '空'}${fill.gap ? '（跳空）' : ''}成交 @ ${formatPrice(fill.entry, digits)} · ${fill.order.lots} 手`,
              )
            }
            return next
          })
        },
        [visibleBars, symbol, spec, gapFill, digits, patchAccount],
      )

      useEffect(() => {
        const target = visibleBars.length - 1
        if (!practiceMode) {
          simCursorRef.current = target
          return
        }
        if (target <= simCursorRef.current) return
        for (let i = simCursorRef.current + 1; i <= target; i++) runSimForBarIndex(i)
        simCursorRef.current = target
      }, [visibleBars.length, runSimForBarIndex, practiceMode])

      useEffect(() => {
        if (!playing || !practiceMode) return undefined
        const id = setInterval(() => {
          setVisibleCount((prev) => {
            const max = allBars.length
            if (prev <= 0) return Math.min(1, max)
            if (prev >= max) {
              setPlaying(false)
              return max
            }
            return prev + 1
          })
        }, 500)
        return () => clearInterval(id)
      }, [playing, practiceMode, allBars.length])

      const onChartClick = ({ time, price }) => {
        if (drawMode === 'pointer' || price == null) return
        if (drawMode !== 'hline' && time == null) {
          setLastEvent('请在 K 线区域点击（右侧空白区没有时间坐标）')
          return
        }
        if (drawMode === 'hline') {
          const id = Date.now()
          setDrawings((d) => [...d, { id, type: 'hline', price, color: '#f0b429' }])
          setSelectedDrawingId(id)
          setDrawMode('pointer')
          return
        }
        if (drawMode === 'vline') {
          const id = Date.now()
          setDrawings((d) => [...d, { id, type: 'vline', t: time, color: '#90caf9' }])
          setSelectedDrawingId(id)
          setDrawMode('pointer')
          return
        }
        if (drawMode === 'text') {
          const text = window.prompt('输入图表标注')
          if (text && text.trim()) {
            const id = Date.now()
            setDrawings((d) => [...d, { id, type: 'text', t: time, p: price, text: text.trim(), color: '#ffffff' }])
            setSelectedDrawingId(id)
          }
          setDrawMode('pointer')
          return
        }
        const point = { t: time, p: price }
        if (!drawPending) {
          setDrawPending(point)
          return
        }
        if ((drawMode === 'channel' || drawMode === 'fib-extension') && drawPending.t1 == null) {
          setDrawPending({ t1: drawPending.t, p1: drawPending.p, t2: point.t, p2: point.p })
          return
        }
        const id = Date.now()
        if (drawMode === 'trend') {
          setDrawings((d) => [
            ...d,
            { id, type: 'trend', t1: drawPending.t, p1: drawPending.p, t2: point.t, p2: point.p, color: '#64b5f6' },
          ])
        } else if (drawMode === 'rect') {
          setDrawings((d) => [
            ...d,
            { id, type: 'rect', t1: drawPending.t, p1: drawPending.p, t2: point.t, p2: point.p, color: '#ba68c8' },
          ])
        } else if (drawMode === 'fib') {
          setDrawings((d) => [
            ...d,
            { id, type: 'fib', t1: drawPending.t, p1: drawPending.p, t2: point.t, p2: point.p, color: '#f0b429' },
          ])
        } else if (drawMode === 'ray') {
          setDrawings((d) => [
            ...d,
            { id, type: 'ray', t1: drawPending.t, p1: drawPending.p, t2: point.t, p2: point.p, color: '#64b5f6' },
          ])
        } else if (drawMode === 'channel') {
          setDrawings((d) => [
            ...d,
            {
              id,
              type: 'channel',
              t1: drawPending.t1,
              p1: drawPending.p1,
              t2: drawPending.t2,
              p2: drawPending.p2,
              t3: point.t,
              p3: point.p,
              color: '#64b5f6',
            },
          ])
        } else if (drawMode === 'fib-extension') {
          setDrawings((d) => [
            ...d,
            {
              id,
              type: 'fib-extension',
              t1: drawPending.t1,
              p1: drawPending.p1,
              t2: drawPending.t2,
              p2: drawPending.p2,
              t3: point.t,
              p3: point.p,
              color: '#64b5f6',
            },
          ])
        }
        setSelectedDrawingId(id)
        setDrawPending(null)
        setDrawMode('pointer')
      }

      const undoDrawing = () => {
        if (!drawings.length) return
        const removed = drawings[drawings.length - 1]
        setDrawings(drawings.slice(0, -1))
        if (selectedDrawingId === removed.id) setSelectedDrawingId(null)
      }

      const deleteDrawing = (drawingId) => {
        setDrawings((items) => items.filter((item) => item.id !== drawingId))
        if (selectedDrawingId === drawingId) setSelectedDrawingId(null)
      }

      const renameDrawing = (drawing) => {
        const label = window.prompt('编辑文字标注', drawing.text || '')
        if (label == null) return
        const text = label.trim()
        if (!text) return
        setDrawings((items) => items.map((item) => item.id === drawing.id ? { ...item, text } : item))
      }

      // The assistant draws through tool calls; commands are applied here so the
      // same localStorage/overlay path as manual drawing is used.
      const applyDrawingCommand = (command) => {
        if (!command || typeof command !== 'object') return
        if (command.action === 'clear') {
          setDrawings([])
          setSelectedDrawingId(null)
          setDrawPending(null)
          setLastEvent('已清空画线（对话）')
          return
        }
        if (command.action === 'delete') {
          if (command.id == null) return
          const id = String(command.id)
          setDrawings((items) => items.filter((item) => String(item.id) !== id))
          setSelectedDrawingId((current) => (current != null && String(current) === id ? null : current))
          setLastEvent(`已删除画线（对话）· ${id}`)
          return
        }
        if (command.action === 'add' && command.drawing && typeof command.drawing === 'object') {
          const source = command.drawing
          if (!source.type) return
          const drawing = { ...source, id: source.id == null ? Date.now() : source.id }
          setDrawings((items) => (
            items.some((item) => String(item.id) === String(drawing.id)) ? items : [...items, drawing]
          ))
          setSelectedDrawingId(drawing.id)
          setLastEvent(`已添加画线（对话）· ${drawing.type}`)
        }
      }

      const submitOrder = (side) => {
        if (!practiceMode) {
          setLastEvent('请先进入练习模式再进行模拟交易')
          return
        }
        if (!visibleBars.length) {
          return
        }
        if (account.position) {
          setLastEvent('已有持仓（含其他品种）')
          return
        }
        const bar = visibleBars[visibleBars.length - 1]
        const lotSize = Number(lots) || 0.1
        const sl = slInput.trim() ? Number(slInput) : null
        const tp = tpInput.trim() ? Number(tpInput) : null
        if (orderType === 'limit') {
          const limitPrice = Number(limitInput)
          if (!Number.isFinite(limitPrice)) {
            setLastEvent('请填写有效限价')
            return
          }
          patchAccount((a) => ({
            ...a,
            pendingOrders: [
              ...(a.pendingOrders || []),
              {
                id: `ord_${Date.now()}`,
                symbol,
                type: 'limit',
                side,
                lots: lotSize,
                limitPrice,
                sl,
                tp,
                createdBarIndex: visibleBars.length - 1,
                createdTime: bar.openTime,
              },
            ],
          }))
          setLastEvent(`限价${side === 'long' ? '多' : '空'} ${lotSize} 手 @ ${formatPrice(limitPrice, digits)} 已挂单`)
          return
        }
        const spread = spec.spread / 2
        const entry = side === 'long' ? bar.close + spread : bar.close - spread
        patchAccount((a) => ({
          ...a,
          position: {
            symbol,
            side,
            lots: lotSize,
            entry,
            sl,
            tp,
            openTime: bar.openTime,
            openBarIndex: visibleBars.length - 1,
            orderType: 'market',
          },
        }))
        setLastEvent(`市价${side === 'long' ? '多' : '空'} ${lotSize} 手 @ ${formatPrice(entry, digits)}`)
      }

      const cancelPending = (orderId) => {
        if (!practiceMode) return
        patchAccount((a) => ({
          ...a,
          pendingOrders: (a.pendingOrders || []).filter((o) => o.id !== orderId),
        }))
        setLastEvent('已撤单')
      }

      const closeManual = () => {
        if (!practiceMode) {
          setLastEvent('请先进入练习模式再进行模拟交易')
          return
        }
        if (!symbolPosition || !visibleBars.length) {
          return
        }
        const bar = visibleBars[visibleBars.length - 1]
        const pos = symbolPosition
        const halfSpread = spec.spread / 2
        const exit = pos.side === 'long' ? bar.close - halfSpread : bar.close + halfSpread
        const pnl = calcPnl(pos.side, pos.entry, exit, pos.lots, spec)
        patchAccount((a) => ({
          ...a,
          balance: a.balance + pnl,
          realizedPnl: a.realizedPnl + pnl,
          history: [
            {
              symbol,
              side: pos.side,
              lots: pos.lots,
              entry: pos.entry,
              exit,
              pnl,
              reason: 'manual',
              gap: false,
              entryGap: Boolean(pos.entryGap),
              orderType: pos.orderType || 'market',
              openTime: pos.openTime,
              closeTime: bar.openTime,
            },
            ...a.history,
          ],
          position: null,
        }))
        setLastEvent(`手动平仓 · PnL ${pnl.toFixed(2)}`)
      }

      const adjustPositionLevel = useCallback(
        (kind, price) => {
          const pos = symbolPosition
          if (!pos) return
          const lastBar = visibleBars[visibleBars.length - 1]
          const market = lastBar ? lastBar.close : pos.entry
          const decimals = digits
          const next = Number(Number(price).toFixed(decimals))
          if (!Number.isFinite(next)) return
          if (pos[kind] != null && Math.abs(pos[kind] - next) < 1e-9) return
          if (kind === 'sl') {
            if (pos.side === 'long' ? next >= market : next <= market) {
              setLastEvent(pos.side === 'long' ? '止损价必须低于当前价' : '止损价必须高于当前价')
              return
            }
          } else if (kind === 'tp') {
            if (pos.side === 'long' ? next <= market : next >= market) {
              setLastEvent(pos.side === 'long' ? '止盈价必须高于当前价' : '止盈价必须低于当前价')
              return
            }
          } else {
            return
          }
          patchAccount((a) => {
            if (!a.position || a.position.symbol !== symbol) return a
            return { ...a, position: { ...a.position, [kind]: next } }
          })
          setLastEvent(`${kind === 'sl' ? '止损' : '止盈'}已调整为 ${next.toFixed(decimals)}`)
        },
        [symbolPosition, visibleBars, digits, symbol, patchAccount],
      )

      const createAccount = () => {
        const name = window.prompt('账户名称', `账户 ${registry.accounts.length + 1}`)
        if (name == null || !String(name).trim()) {
          return
        }
        const initialRaw = window.prompt('初始资金（仅创建时可设）', '10000')
        if (initialRaw == null) {
          return
        }
        const initial = Number(initialRaw)
        if (!Number.isFinite(initial) || initial <= 0) {
          setLastEvent('初始资金无效')
          return
        }
        const id = newAccountId()
        const nextAccount = emptyAccount(initial, String(name).trim(), id)
        commitRegistry((prev) => ({
          activeId: id,
          accounts: [...prev.accounts, nextAccount],
        }))
        setLastEvent(`已创建账户「${nextAccount.name}」`)
      }

      const deleteAccount = () => {
        if (registry.accounts.length <= 1) {
          setLastEvent('至少保留一个账户')
          return
        }
        const target = account
        const ok = window.confirm(`删除账户「${target.name}」？将同时删除其全部成交历史，且不可恢复。`)
        if (!ok) {
          return
        }
        commitRegistry((prev) => {
          const accounts = prev.accounts.filter((item) => item.id !== target.id)
          const activeId = prev.activeId === target.id ? accounts[0].id : prev.activeId
          return { activeId, accounts }
        })
        setLastEvent(`已删除账户「${target.name}」`)
      }

      const orderDraft = useMemo(() => {
        if (!practiceMode || !visibleBars.length || symbolPosition) {
          return null
        }
        if (orderType === 'limit' && limitInput.trim()) {
          const price = Number(limitInput)
          if (Number.isFinite(price)) {
            return { entry: price }
          }
          return null
        }
        if (orderType === 'market') {
          return { entry: visibleBars[visibleBars.length - 1].close }
        }
        return null
      }, [practiceMode, visibleBars, symbolPosition, orderType, limitInput])

      const drawHint =
        drawMode === 'pointer'
          ? ''
          : drawMode === 'hline'
            ? '点击图表放置水平线'
            : drawMode === 'vline'
              ? '点击图表放置垂直线'
              : drawMode === 'text'
                ? '点击图表放置文字'
                : drawMode === 'channel' || drawMode === 'fib-extension'
                  ? drawPending
                    ? drawPending.t1 != null
                      ? '已选基准线，请点击第 3 个点'
                      : '再点击第 2 个点'
                    : '依次点击 3 个点：起点、终点、偏移点'
                  : drawPending
                    ? '已选起点，请点击终点'
                    : '点击起点，再点击终点'

      const activeAsideTab = !practiceMode && asideTab === 'trade' ? 'chat' : asideTab

      const reasonLabel = (reason) => {
        if (reason === 'manual') {
          return '手动'
        }
        if (reason === 'sl') {
          return '止损'
        }
        if (reason === 'tp') {
          return '止盈'
        }
        return reason
      }

      return h(
        'div',
        { className: 'tp-root' },
        h(
          'div',
          { className: 'tp-toolbar' },
          h(
            'label',
            { className: 'tp-field' },
            '品种',
            h(
              'select',
              { className: 'tp-select', value: symbol, onChange: (e) => setSymbol(e.target.value) },
              SYMBOLS.map((s) => h('option', { key: s.id, value: s.id }, s.id)),
            ),
          ),
          h(
            'div',
            { className: 'tp-field' },
            '周期',
            h(
              'div',
              { className: 'tp-tf-group', role: 'group', 'aria-label': 'K线周期' },
              INTERVALS.map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: 'tp-tf-btn' + (tf === item.id ? ' tp-tf-btn-active' : ''),
                    disabled: loading,
                    onClick: () => {
                      if (item.id === tf) return
                      setPlaying(false)
                      // In practice the restore keeps the cursor; outside practice reset it.
                      if (!practiceMode) simCursorRef.current = -1
                      setTf(item.id)
                    },
                  },
                  item.label,
                ),
              ),
            ),
          ),
          h('button', { type: 'button', className: 'tp-btn', disabled: loading, onClick: loadCsv }, loading ? '…' : '刷新图表'),
          practiceMode
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'tp-practice-badge' }, `练习中 · ${formatServerInput(replayTime).replace('T', ' ')}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp-btn tp-btn-primary',
                    disabled: loading || (visibleCount >= allBars.length && !hasMoreFuture),
                    onClick: advancePractice,
                  },
                  '下一根 K',
                ),
                h('button', { type: 'button', className: 'tp-btn', onClick: () => setPlaying((value) => !value) }, playing ? '暂停' : '播放'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp-btn',
                    onClick: () => {
                      practiceLoadTokenRef.current += 1
                      setPlaying(false)
                      setPracticeMode(false)
                      setPracticeSetup(false)
                      setVisibleCount(allBars.length)
                      simCursorRef.current = allBars.length - 1
                      setFitToken((n) => n + 1)
                    },
                  },
                  '退出练习',
                ),
              )
            : practiceSetup
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'label',
                    { className: 'tp-field' },
                    '练习起点（服务器时间）',
                    h('input', {
                      className: 'tp-input',
                      type: 'datetime-local',
                      value: cutoffInput,
                      onChange: (event) => setCutoffInput(event.target.value),
                    }),
                  ),
                  h('button', { type: 'button', className: 'tp-btn', onClick: chooseRandomPracticeTime, disabled: !allBars.length }, '随机时间'),
                  h('button', { type: 'button', className: 'tp-btn tp-btn-primary', onClick: startPractice, disabled: loading || !allBars.length }, loading ? '加载中…' : '进入练习'),
                  h('button', { type: 'button', className: 'tp-btn', onClick: () => setPracticeSetup(false) }, '取消'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'tp-btn tp-btn-primary',
                    disabled: loading || !allBars.length,
                    onClick: () => {
                      if (!cutoffInput && allBars.length) {
                        setCutoffInput(formatServerInput(allBars[Math.max(0, allBars.length - 2)].openTime))
                      }
                      setPracticeSetup(true)
                    },
                  },
                  '开始练习',
                ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn' + (indicatorOptions.ma ? ' tp-btn-toggle-active' : ''),
              'aria-pressed': indicatorOptions.ma,
              onClick: () => setIndicatorOptions((options) => ({ ...options, ma: !options.ma })),
            },
            'MA20/50',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn' + (indicatorOptions.rsi ? ' tp-btn-toggle-active' : ''),
              'aria-pressed': indicatorOptions.rsi,
              onClick: () => setIndicatorOptions((options) => ({ ...options, rsi: !options.rsi })),
            },
            'RSI14',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn' + (indicatorOptions.volume ? ' tp-btn-toggle-active' : ''),
              'aria-pressed': indicatorOptions.volume,
              onClick: () => setIndicatorOptions((options) => ({ ...options, volume: !options.volume })),
            },
            '成交量',
          ),
          h('span', { className: 'tp-draw-label' }, '画线'),
          h(
            'select',
            {
              className: 'tp-select tp-draw-select',
              value: drawMode,
              title: '选择画线工具后在图表上点击：水平线/垂直线/文字一次点击，趋势线/矩形/射线/斐波那契两次点击，通道/扩展三次点击',
              onChange: (e) => {
                setDrawMode(e.target.value)
                setDrawPending(null)
              },
            },
            h('option', { value: 'pointer' }, '浏览'),
            h('option', { value: 'hline' }, '水平线'),
            h('option', { value: 'trend' }, '趋势线'),
            h('option', { value: 'ray' }, '射线'),
            h('option', { value: 'vline' }, '垂直线'),
            h('option', { value: 'rect' }, '矩形'),
            h('option', { value: 'channel' }, '平行通道'),
            h('option', { value: 'fib' }, '斐波那契回调'),
            h('option', { value: 'fib-extension' }, '斐波那契扩展'),
            h('option', { value: 'text' }, '文字标注'),
          ),
          drawHint ? h('span', { className: 'tp-draw-hint' }, drawHint) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn',
              disabled: !drawings.length,
              onClick: undoDrawing,
            },
            '撤销画线',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn' + (drawingManagerOpen ? ' tp-btn-toggle-active' : ''),
              'aria-pressed': drawingManagerOpen,
              onClick: () => setDrawingManagerOpen((open) => !open),
            },
            `画线管理 ${drawings.length}`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tp-btn',
              disabled: !drawings.length,
              onClick: () => {
                setDrawings([])
                setSelectedDrawingId(null)
              },
            },
            '清空画线',
          ),
        ),
        drawingManagerOpen
          ? h(
              'div',
              { className: 'tp-draw-manager' },
              drawings.length
                ? drawings.slice().reverse().map((drawing, index) => {
                    const names = {
                      hline: '水平线', trend: '趋势线', ray: '射线', vline: '垂直线', rect: '矩形',
                      channel: '平行通道', fib: '斐波那契回调', 'fib-extension': '斐波那契扩展', text: '文字标注',
                    }
                    const anchorTime = drawing.t ?? drawing.t1 ?? drawing.t2 ?? drawing.t3
                    const anchorLabel = anchorTime == null ? '' : ` · ${new Date(anchorTime * 1000).toLocaleString()}`
                    const label = `${drawings.length - index}. ${names[drawing.type] || drawing.type}${anchorLabel}${drawing.text ? ` · ${drawing.text}` : ''}`
                    return h(
                      'div',
                      { key: drawing.id, className: 'tp-draw-manager-row' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tp-draw-manager-select' + (selectedDrawingId === drawing.id ? ' tp-draw-manager-selected' : ''),
                          onClick: () => {
                            setSelectedDrawingId(drawing.id)
                            // Explicit locate from the manager; drawing itself never moves the view.
                            setLocateToken((value) => value + 1)
                          },
                        },
                        label,
                      ),
                      drawing.type === 'text'
                        ? h('button', { type: 'button', className: 'tp-btn tp-btn-mini', onClick: () => renameDrawing(drawing) }, '改文字')
                        : null,
                      h('button', { type: 'button', className: 'tp-btn tp-btn-mini', onClick: () => deleteDrawing(drawing.id) }, '删除'),
                    )
                  })
                : h('div', { className: 'tp-stat' }, '暂无画线。选择工具后在图表上点击即可添加。'),
            )
          : null,
        h(DataUpdateControl, { symbol, interval: SOURCE_INTERVAL, onRefreshChart: handleDataRefresh }),
        error || chartError
          ? h('div', { className: 'tp-error' }, error || chartError)
          : h('div', { className: 'tp-meta' }, [
              `已加载 ${allBars.length} 根 · ${intervalLabel(tf)}`,
              tf !== SOURCE_INTERVAL ? '（由 1m 聚合）' : ' · 分月',
              hasMoreHistory ? ' · 可往左翻加载更早' : '',
              historyLoading ? ' · 正在加载更早…' : '',
              truncated && !hasMoreHistory ? ' ·（已截断）' : '',
              allBars.length ? ` · 当前显示 ${visibleBars.length}/${allBars.length}` : '',
              lastEvent ? ` · ${lastEvent}` : '',
            ]),
        h(
          'div',
          { className: 'tp-body' },
          h(
            'div',
            { className: 'tp-main' },
            h(ChartPane, {
              bars: visibleBars,
              drawings,
              selectedDrawingId,
              locateToken,
              drawMode,
              indicatorOptions,
              indicatorData,
              onChartClick,
              position: practiceMode ? symbolPosition : null,
              orderDraft,
              pendingOrders: practiceMode ? symbolPending : [],
              digits,
              onAdjustStop: adjustPositionLevel,
              height: 440,
              onChartError: setChartError,
              onNeedMoreHistory: hasMoreHistory ? loadOlderHistory : null,
              fitToken,
              chartApiRef,
            }),
          ),
          h(
            'div',
            { className: 'tp-aside' },
            h(
              'div',
              { className: 'tp-tabs' },
              [
                { id: 'trade', label: '交易' },
                { id: 'history', label: '历史' },
                { id: 'chat', label: '对话' },
              ].filter((tab) => practiceMode || tab.id !== 'trade').map((tab) =>
                h(
                  'button',
                  {
                    key: tab.id,
                    type: 'button',
                    className: 'tp-tab' + (activeAsideTab === tab.id ? ' tp-tab-active' : ''),
                    onClick: () => setAsideTab(tab.id),
                  },
                  tab.label,
                ),
              ),
            ),
            activeAsideTab === 'trade'
              ? h(
                  'div',
                  { className: 'tp-trade' },
                  h('div', { className: 'tp-section-title' }, '模拟账户'),
                  h(
                    'label',
                    { className: 'tp-field' },
                    '当前账户',
                    h(
                      'select',
                      {
                        className: 'tp-select',
                        value: registry.activeId,
                        onChange: (e) => commitRegistry((prev) => ({ ...prev, activeId: e.target.value })),
                      },
                      registry.accounts.map((item) =>
                        h('option', { key: item.id, value: item.id }, `${item.name} · ${item.balance.toFixed(2)}`),
                      ),
                    ),
                  ),
                  h('div', { className: 'tp-stat' }, `初始 ${account.initial.toFixed(2)} · 余额 ${account.balance.toFixed(2)} · 已实现 ${account.realizedPnl.toFixed(2)}`),
                  h(
                    'div',
                    { className: 'tp-trade-actions' },
                    h('button', { type: 'button', className: 'tp-btn', onClick: createAccount }, '新建'),
                    h('button', { type: 'button', className: 'tp-btn', onClick: deleteAccount }, '删除'),
                  ),
                  account.position && account.position.symbol !== symbol
                    ? h(
                        'div',
                        { className: 'tp-stat tp-warn' },
                        `其它品种持仓：${account.position.symbol} ${account.position.side} ${account.position.lots} 手`,
                      )
                    : null,
                  symbolPosition
                    ? h(
                        'div',
                        { className: 'tp-stat' },
                        `持仓 ${symbolPosition.side} ${symbolPosition.lots} @ ${formatPrice(symbolPosition.entry, digits)} (${symbolPosition.orderType || 'market'}) · SL ${symbolPosition.sl != null ? formatPrice(symbolPosition.sl, digits) : '—'} · TP ${symbolPosition.tp != null ? formatPrice(symbolPosition.tp, digits) : '—'}`,
                      )
                    : null,
                  symbolPosition
                    ? h('div', { className: 'tp-hint' }, '提示：拖动图表上的 SL / TP 线可直接修改')
                    : null,
                  h('div', { className: 'tp-section-title' }, '下单'),
                  h(
                    'label',
                    { className: 'tp-field' },
                    '类型',
                    h(
                      'select',
                      {
                        className: 'tp-select',
                        value: orderType,
                        onChange: (e) => setOrderType(e.target.value),
                      },
                      h('option', { value: 'market' }, '市价'),
                      h('option', { value: 'limit' }, '限价'),
                    ),
                  ),
                  orderType === 'limit'
                    ? h(
                        'label',
                        { className: 'tp-field' },
                        '限价',
                        h('input', {
                          className: 'tp-input',
                          value: limitInput,
                          onChange: (e) => setLimitInput(e.target.value),
                          placeholder: '触发价',
                        }),
                      )
                    : null,
                  h(
                    'label',
                    { className: 'tp-field' },
                    '手数',
                    h('input', {
                      className: 'tp-input',
                      type: 'number',
                      step: '0.01',
                      value: lots,
                      onChange: (e) => setLots(e.target.value),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'tp-field' },
                    '止损价',
                    h('input', { className: 'tp-input', value: slInput, onChange: (e) => setSlInput(e.target.value) }),
                  ),
                  h(
                    'label',
                    { className: 'tp-field' },
                    '止盈价',
                    h('input', { className: 'tp-input', value: tpInput, onChange: (e) => setTpInput(e.target.value) }),
                  ),
                  h(
                    'label',
                    {
                      className: 'tp-check',
                      title: '开盘价已越过挂单价 / 止损止盈价时，按开盘价成交；关闭则按挂单价成交',
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: gapFill,
                      onChange: (e) => {
                        setGapFill(e.target.checked)
                        writeGapFill(e.target.checked)
                      },
                    }),
                    '跳空按开盘价成交',
                  ),
                  h(
                    'div',
                    { className: 'tp-trade-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tp-btn tp-btn-primary',
                        onClick: () => submitOrder('long'),
                        disabled: Boolean(account.position),
                      },
                      orderType === 'limit' ? '限价多' : '市价多',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tp-btn',
                        onClick: () => submitOrder('short'),
                        disabled: Boolean(account.position),
                      },
                      orderType === 'limit' ? '限价空' : '市价空',
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'tp-btn', onClick: closeManual, disabled: !symbolPosition },
                      '平仓',
                    ),
                  ),
                  symbolPending.length
                    ? h(
                        'div',
                        { className: 'tp-pending' },
                        h('div', { className: 'tp-hist-title' }, '挂单'),
                        symbolPending.map((order) =>
                          h(
                            'div',
                            { key: order.id, className: 'tp-pending-row' },
                            h('span', null, `${order.side} ${order.lots} @ ${formatPrice(order.limitPrice, digits)}`),
                            h(
                              'button',
                              { type: 'button', className: 'tp-btn tp-btn-mini', onClick: () => cancelPending(order.id) },
                              '撤',
                            ),
                          ),
                        ),
                      )
                    : null,
                )
              : activeAsideTab === 'history'
                ? h(
                    'div',
                    { className: 'tp-history' },
                    h('div', { className: 'tp-stat' }, `${account.name} · 共 ${account.history.length} 笔`),
                    account.history.length
                      ? account.history.map((t, i) =>
                          h(
                            'div',
                            { key: i, className: 'tp-hist-row' },
                            `${t.symbol || symbol} ${t.side} ${t.lots} · ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} · ${reasonLabel(t.reason)} · ${t.orderType || 'market'}${t.entryGap ? ' · 跳空入场' : ''}${t.gap ? ' · 跳空出场' : ''}`,
                          ),
                        )
                      : h('div', { className: 'tp-stat' }, '暂无成交记录'),
                  )
                : h(ChatPanel, {
                    symbol,
                    interval: tf,
                    replayTime,
                    practiceMode,
                    visibleBars,
                    allBars,
                    account,
                    position: practiceMode ? symbolPosition : null,
                    pendingOrders: practiceMode ? symbolPending : [],
                    drawings,
                    onDrawingCommand: applyDrawingCommand,
                    captureViewport: () => (chartApiRef.current ? chartApiRef.current.captureViewport() : null),
                  }),
          ),
        ),
      )
    }

    const STYLES = `
.tp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.tp-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.tp-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.tp-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.tp-select,.tp-input{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.tp-draw-select{min-width:88px}
.tp-draw-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tp-draw-hint{font-size:11px;line-height:1.3;color:var(--dsw-alias-brand-primary);white-space:nowrap}
.tp-tf-group{display:flex;flex-wrap:wrap;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.tp-tf-btn{height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.tp-tf-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.tp-tf-btn:disabled{opacity:.45;cursor:not-allowed}
.tp-tf-btn-active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);font-weight:600}
.tp-btn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.tp-btn:disabled{opacity:.45;cursor:not-allowed}
.tp-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.tp-btn-toggle-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.tp-draw-manager{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-draw-manager-row{display:flex;align-items:center;gap:6px;min-width:0}
.tp-draw-manager-select{flex:1;min-width:0;overflow:hidden;padding:5px 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.tp-draw-manager-select:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.tp-draw-manager-selected{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.tp-practice-badge{align-self:center;padding:5px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px}
.tp-meta{padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.tp-error{margin:8px 12px;padding:8px;border-radius:8px;background:rgba(239,83,80,.12);font-size:12px}
.tp-body{display:flex;flex:1;min-height:0}
.tp-main{flex:1;min-width:0;display:flex;flex-direction:column;padding:8px 8px 8px 12px}
.tp-aside{width:320px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.tp-tabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-tab{flex:1;height:34px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.tp-tab-active{color:var(--dsw-alias-brand-primary);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}
.tp-chart-wrap{position:relative;flex:1;min-height:280px;width:100%}
.tp-chart-wrap.tp-drag-line,.tp-chart-wrap.tp-drag-line *{cursor:ns-resize !important;user-select:none}
.tp-chart-wrap.tp-draw-mode,.tp-chart-wrap.tp-draw-mode *{cursor:crosshair !important}
.tp-overlay{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3}
.tp-trade{padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto}
.tp-stat{font-size:12px;color:var(--dsw-alias-label-secondary)}
.tp-hint{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-secondary);opacity:.8}
.tp-trade-actions{display:flex;gap:8px;flex-wrap:wrap}
.tp-hist-title{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.tp-hist{font-size:11px;display:flex;flex-direction:column;gap:4px}
.tp-hist-row{padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-chat{display:flex;flex-direction:column;flex:1;min-height:0;padding:8px}
.tp-chat-log{flex:1;overflow:auto;font-size:12px;display:flex;flex-direction:column;gap:8px}
.tp-chat-user{align-self:flex-end;background:var(--dsw-alias-bg-layer-2);padding:6px 8px;border-radius:8px;max-width:95%}
.tp-chat-ai{align-self:flex-start;padding:4px 0;line-height:1.5;white-space:pre-wrap}
.tp-chat-input-row{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.tp-chat-input{width:100%;resize:vertical;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px}
.tp-chat-toolbar{display:flex;align-items:center;margin-bottom:8px}
.tp-chat-hint{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tp-agent-bar{display:flex;align-items:center;gap:6px;margin-bottom:8px;min-width:0}
.tp-agent-state{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px}
.tp-agent-state-busy{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.tp-agent{position:relative;flex:1;min-width:0}
.tp-agentbtn{display:flex;align-items:center;gap:6px;width:100%;height:26px;min-width:0;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.tp-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.tp-agent-caret{flex:none;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dsw-alias-label-secondary)}
.tp-agent-menu{top:calc(100% + 6px);left:0;right:0;min-width:220px}
.tp-agent-row{display:flex;align-items:center;gap:2px;border-radius:6px}
.tp-agent-row:hover,.tp-agent-row.is-active{background:var(--dsw-alias-bg-layer-2)}
.tp-agent-row.is-active .tp-agent-row-name{color:var(--dsw-alias-brand-primary)}
.tp-agent-pick{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.tp-agent-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-agent-tag{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px}
.tp-agent-del{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:3px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer;opacity:0}
.tp-agent-row:hover .tp-agent-del,.tp-agent-del:focus-visible{opacity:1}
.tp-agent-del:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.tp-agent-loading{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tp-agent-off{margin-bottom:8px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.tp-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:4px}
.tp-warn{color:var(--dsw-alias-brand-primary)}
.tp-pending{display:flex;flex-direction:column;gap:6px}
.tp-pending-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}
.tp-btn-mini{height:24px;padding:0 8px;font-size:11px}
.tp-history{padding:10px;overflow:auto;flex:1;font-size:11px;display:flex;flex-direction:column;gap:4px}
.tp-model{position:relative;display:flex;min-width:0}
.tp-modelbtn{display:flex;align-items:center;gap:4px;max-width:100%;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.tp-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
.tp-model-effort{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:16px}
.tp-menu{position:absolute;z-index:20;min-width:220px;max-height:min(360px,50vh);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 8px 24px rgba(0,0,0,.15)}
.tp-model-menu{bottom:calc(100% + 6px);left:0}
.tp-menu-item{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.tp-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.tp-menu-item-active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.tp-menu-tag{display:inline-block;margin-left:6px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:15px;vertical-align:1px}
.tp-menu-heading{padding:6px 10px 4px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.tp-menu-muted{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
`

    // ---------------------------------------------------------------------
    // Voice input bridge. Reuses the DSH speech remote mounted by the
    // experimental voice-input client plugin: same provider, same local model,
    // same host transcription service as the main composer microphone.
    // The button only appears while that remote exists.
    // ---------------------------------------------------------------------

    const voiceBridge = { api: null, listeners: new Set() }

    function notifyVoiceBridge() {
      for (const listener of voiceBridge.listeners) {
        try {
          listener()
        } catch {}
      }
    }

    function unwrapVoiceResult(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok) {
          const message = result.error && result.error.message ? result.error.message : '语音服务返回错误'
          throw new Error(message)
        }
        return result.value
      }
      return result
    }

    function useVoiceBridge() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        voiceBridge.listeners.add(listener)
        listener()
        return () => {
          voiceBridge.listeners.delete(listener)
        }
      }, [])
      return voiceBridge
    }

    /** Wait for the speech remote and publish it to the panels. */
    function attachVoiceBridge(ctx) {
      try {
        ctx.inject(['remote.speech'], (scope) => {
          try {
            const api = scope.get('remote.speech') || (scope.remote && scope.remote.speech)
            if (!api) return
            voiceBridge.api = api
            notifyVoiceBridge()
            scope.effect(() => () => {
              if (voiceBridge.api === api) voiceBridge.api = null
              notifyVoiceBridge()
            })
          } catch {}
        })
      } catch {}
    }

    /** Canonical 16 kHz mono PCM16 WAV, the format the Host accepts. */
    function encodeVoiceWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    function voiceBase64(bytes) {
      let text = ''
      for (let index = 0; index < bytes.length; index += 8192) {
        text += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192))
      }
      return btoa(text)
    }

    /** One microphone acquisition, decoded and resampled to the Host format. */
    class VoiceRecorder {
      constructor() {
        this.stream = null
        this.recorder = null
        this.context = null
        this.chunks = []
      }

      async start() {
        if (typeof MediaRecorder === 'undefined') throw new Error('当前环境不支持录音')
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('当前环境不支持麦克风')
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
        } catch (failure) {
          if (failure && failure.name === 'NotAllowedError') throw new Error('麦克风权限被拒绝')
          if (failure && (failure.name === 'NotFoundError' || failure.name === 'OverconstrainedError')) {
            throw new Error('没有可用的麦克风')
          }
          throw failure
        }
        this.stream = stream
        this.context = new AudioContext()
        this.chunks = []
        this.recorder = new MediaRecorder(stream)
        this.recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) this.chunks.push(event.data)
        }
        this.recorder.start()
      }

      async stop(maxDurationSeconds) {
        const recorder = this.recorder
        const context = this.context
        if (!recorder || !context || recorder.state !== 'recording') {
          this.dispose()
          throw new Error('没有录到声音')
        }
        await new Promise((resolve) => {
          recorder.onstop = resolve
          recorder.stop()
        })
        if (this.stream) this.stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(this.chunks, { type: recorder.mimeType })
        if (!blob.size) {
          this.dispose()
          throw new Error('没有录到声音')
        }
        const decoded = await context.decodeAudioData(await blob.arrayBuffer())
        const seconds = Math.max(0.1, Math.min(decoded.duration, Number(maxDurationSeconds) || 120))
        const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(seconds * 16000)), 16000)
        const source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start()
        const rendered = await offline.startRendering()
        const bytes = encodeVoiceWave(rendered.getChannelData(0))
        this.dispose()
        return bytes
      }

      dispose() {
        try {
          if (this.recorder && this.recorder.state === 'recording') this.recorder.stop()
        } catch {}
        try {
          if (this.stream) this.stream.getTracks().forEach((track) => track.stop())
        } catch {}
        try {
          if (this.context && this.context.state !== 'closed') this.context.close()
        } catch {}
        this.recorder = null
        this.stream = null
        this.context = null
        this.chunks = []
      }
    }

    function voiceFailureText(failure) {
      if (failure && failure.name === 'NotAllowedError') return '麦克风权限被拒绝'
      if (failure && failure.message) return failure.message
      return String(failure)
    }

    /** Compact microphone button: click to record, click again to transcribe. */
    function VoiceMic({ onText, disabled }) {
      const bridge = useVoiceBridge()
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState('')
      const recorderRef = useRef(null)
      const timerRef = useRef(null)
      const limitRef = useRef(120)
      const busyRef = useRef(false)

      useEffect(
        () => () => {
          if (timerRef.current) clearTimeout(timerRef.current)
          if (recorderRef.current) {
            try {
              recorderRef.current.dispose()
            } catch {}
          }
        },
        [],
      )

      const finish = async () => {
        const recorder = recorderRef.current
        const api = voiceBridge.api
        if (!recorder || !api || busyRef.current) return
        busyRef.current = true
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        recorderRef.current = null
        setPhase('transcribing')
        try {
          const bytes = await recorder.stop(limitRef.current)
          const catalog = unwrapVoiceResult(await api.catalog())
          if (catalog && bytes.byteLength > catalog.maxAudioBytes) throw new Error('录音超出大小上限，请说短一些')
          const result = unwrapVoiceResult(
            await api.transcribe({
              audioBase64: voiceBase64(bytes),
              providerId: catalog.selection.providerId,
              language: catalog.selection.language,
            }),
          )
          const text = result && typeof result.text === 'string' ? result.text.trim() : ''
          if (text) {
            setError('')
            onText(text)
          } else {
            setError('没有识别到内容')
          }
        } catch (failure) {
          setError(voiceFailureText(failure))
        } finally {
          busyRef.current = false
          setPhase('idle')
        }
      }

      const start = async () => {
        const api = voiceBridge.api
        if (busyRef.current) return
        if (!api) {
          setError('语音输入不可用：语音输入插件未加载')
          return
        }
        busyRef.current = true
        setError('')
        try {
          const catalog = unwrapVoiceResult(await api.catalog())
          const provider = (catalog.providers || []).find((item) => item.id === catalog.selection.providerId)
          const state = provider && provider.preparation ? provider.preparation.phase : ''
          if (state !== 'ready' && state !== 'standby' && state !== 'waking') {
            throw new Error('语音模型还没准备好，请先到「设置 → 语音输入」里完成准备')
          }
          const recorder = new VoiceRecorder()
          await recorder.start()
          recorderRef.current = recorder
          limitRef.current = Math.max(5, Math.min(120, Number(catalog.maxDurationSeconds) || 120))
          setPhase('recording')
          timerRef.current = setTimeout(() => {
            finish()
          }, limitRef.current * 1000)
        } catch (failure) {
          setPhase('idle')
          setError(voiceFailureText(failure))
        } finally {
          busyRef.current = false
        }
      }

      const recording = phase === 'recording'
      const busy = phase === 'transcribing'
      return h(
        'span',
        { className: 'voice-mic-wrap' },
        error
          ? h('span', { className: 'voice-mic-error', title: error }, error.length > 26 ? error.slice(0, 26) + '…' : error)
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'voice-mic' + (recording ? ' is-recording' : '') + (busy ? ' is-busy' : ''),
            disabled: Boolean(disabled) || busy,
            onClick: recording ? finish : start,
            title: error || (recording ? '停止并转写' : busy ? '正在转写…' : '语音输入'),
            'aria-label': recording ? '停止录音' : '语音输入',
          },
          recording
            ? h('span', { className: 'voice-mic-stop' })
            : h(
                'svg',
                {
                  width: 15,
                  height: 15,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.7,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': true,
                },
                h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
                h('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }),
              ),
        ),
      )
    }

    const VOICE_STYLES = `
.tp-chat-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.voice-mic-wrap{display:inline-flex;align-items:center;gap:6px;flex:none}
.voice-mic{width:30px;height:30px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}
.voice-mic:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.voice-mic:disabled{opacity:.5;cursor:default}
.voice-mic.is-recording{border-color:#e5484d;color:#e5484d;background:color-mix(in srgb,#e5484d 12%,transparent)}
.voice-mic.is-busy{opacity:.7}
.voice-mic-stop{width:10px;height:10px;border-radius:3px;background:currentColor;display:block}
.voice-mic-error{max-width:240px;padding:0 8px;height:20px;border-radius:10px;background:#e5484d;color:#fff;font-size:11px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;cursor:help}
`

    function installStyles() {
      const el = document.createElement('style')
      el.setAttribute('data-trade-practice', '')
      el.textContent = STYLES + DATA_UPDATE_STYLES + VOICE_STYLES
      document.head.appendChild(el)
      return () => el.remove()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(installStyles)
        attachVoiceBridge(ctx)
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'trade-practice',
              order: 25,
              label: () => '交易练习',
            },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'trade-practice' }, PracticePanel),
        )
      },
    }
  },
})
