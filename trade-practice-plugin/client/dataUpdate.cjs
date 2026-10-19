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
