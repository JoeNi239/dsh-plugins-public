/**
 * Trade Practice — host half.
 *
 * K-line data comes ONLY from workspace CSV files. This module never downloads
 * market data in-process. Sole updater: HistData.com via POST /trade-practice/update-data
 * (scripts/fetch_m1.py). Higher TFs are aggregated from 1m at read time.
 *
 *   GET /trade-practice/health
 *   GET /trade-practice/symbols
 *   GET /trade-practice/meta?symbol=&interval=
 *   GET /trade-practice/bars?symbol=&interval=
 *   GET  /trade-practice/models
 *   GET  /trade-practice/update-check  (local gap check, no download)
 *   POST /trade-practice/update-data  (spawn HistData fetch, manual only)
 *   POST /trade-practice/ask   (SSE; optional viewport screenshot + drawing tools)
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve, sep } from 'node:path'
import { aggregateMeta, loadBars as loadBarsFromStore } from './lib/monthlyCsv.js'
import { CHART_INTERVALS, loadChartBars } from './lib/aggregateBars.js'
import { getModelCatalogueResponse, modelSelection } from './lib/modelCatalogue.js'
import { getUpdateCheck, startHistdataUpdate } from './lib/histdataRunner.js'
import { DRAWING_TOOLS, describeDrawing, executeDrawingTool } from './lib/drawingTools.js'
import { AgentManager } from './lib/agentManager.js'

const MAX_BODY = 8 * 1024 * 1024
const MAX_TOOL_ROUNDS = 3
/** Upper bound for OHLC rows sent to the model; a viewport is usually far smaller. */
const MAX_PROMPT_BARS = 320
const SYSTEM_PROMPT = [
  '你是嵌在交易练习面板里的市场分析助手。用户在查看历史 K 线或做逐 K 回放（均非实时）。',
  '根据提供的品种、周期、模式、当前可见到的 K 线时间、最近 K 线摘要及可用的模拟账户情况回答问题。',
  '说明观点时标注依据（例如「最近几根 K 线…」「当前结构…」），不要假装知道最后一根可见 K 线之后的走势。',
  '不提供投资建议式承诺；可讨论风险、场景与纪律。',
  '你可以调用 add_drawing / delete_drawing / clear_drawings 在图表上画线或清理画线。',
  '每次提问会自动附带当前屏幕视图的 K 线截图（仅截图那一刻的可见范围，可能不等于全部已加载数据）；截图只用于辨认形态，画线坐标一律以【视图内 K 线】的时间与价格为准。',
  '截图由面板自动截取，不是用户上传的图片；不要要求用户再发图或声称“你发的图”。',
  '当用户要求画线、标注或让你演示“如果是你会怎么画”时，必须调用 add_drawing 在图表上真正画出，而不是描述像素位置或声称已在截图上画。',
  '工具的 time 必须取自【视图内 K 线】的 openTime 且落在【视图时间范围】内；price 使用视图内的价格，不要编造截图外的数据。',
  '只画必要的 1–3 个对象；不要删除或清空已有画线，除非用户明确要求。工具报范围错误时按提示修正后再试，不要重复同一错误。',
  '如果本次没有附带截图（例如模型不支持图片），就只依据 K 线数据回答，并在需要时说明这一点。',
  '工具执行后，用一句中文说明画了什么（或为什么没画），不要在正文重复参数 JSON。',
].join('\n')

export const inject = ['webServer']

const ROUTE_PREFIX = '/trade-practice'

/** Built-in catalogue; CSV files must exist under data root. */
const SYMBOLS = [
  { id: 'XAUUSD', name: 'Gold / USD' },
  { id: 'GBPUSD', name: 'GBP / USD' },
]

const INTERVALS = CHART_INTERVALS
/** On-disk source is always 1m; higher TFs are aggregated at read time. */
const SOURCE_INTERVAL = '1m'
const DEFAULT_LIMIT = 120000

function normalise(path) {
  return path.replace(/[\\/]+$/, '')
}

function allowedRoots(ctx) {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return
    const root = normalise(resolve(value))
    if (!roots.includes(root)) roots.push(root)
  }
  for (const entry of (process.env.TRADE_PRACTICE_ROOTS || '').split(delimiter)) push(entry)
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      for (const workspace of registry.list()) {
        push(workspace && (workspace.path || workspace.root || workspace.directory))
      }
    }
  } catch {}
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory) push(workingDirectory.defaultDirectory)
  } catch {}
  push(process.cwd())
  return roots
}

function inside(root, path) {
  return path === root || path.startsWith(root + sep) || path.startsWith(root + '/')
}

function dataRoot(ctx) {
  const override = (process.env.TRADE_PRACTICE_DATA || '').trim()
  if (override) return normalise(resolve(override))
  const roots = allowedRoots(ctx)
  if (!roots.length) throw new Error('找不到工作区根目录')
  return join(roots[0], '.trade-practice', 'data')
}

function tradePracticeRoot(ctx) {
  const roots = allowedRoots(ctx)
  return join(roots[0] || process.cwd(), '.trade-practice')
}

function validateSymbol(symbol) {
  const sym = String(symbol || '').toUpperCase()
  if (!SYMBOLS.some((s) => s.id === sym)) throw new Error('不支持的品种：' + sym)
  return sym
}

function validateChartInterval(interval) {
  const tf = interval || '1m'
  if (!INTERVALS.includes(tf)) throw new Error('不支持的周期：' + tf)
  return tf
}

function validateSymbolInterval(symbol, interval) {
  validateChartInterval(interval)
  return validateSymbol(symbol)
}

/** Data-update / fetch-status always operate on the 1m source store. */
function validateSourceInterval(interval) {
  const tf = interval || SOURCE_INTERVAL
  if (tf !== SOURCE_INTERVAL && !INTERVALS.includes(tf)) {
    throw new Error('不支持的周期：' + tf)
  }
  return SOURCE_INTERVAL
}

function fetchStatePath(ctx, symbol, interval) {
  const roots = allowedRoots(ctx)
  const root = roots[0] || process.cwd()
  return join(root, '.trade-practice', 'state', `${symbol}-${interval}-fetch.json`)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function barOpenTime(bar) {
  return bar.openTime || (Number.isFinite(bar.time) ? new Date(bar.time * 1000).toISOString() : '?')
}

/** Keep the first/last bar and an even sample; the screenshot already shows the shape. */
export function sampleBars(bars, limit) {
  if (!Array.isArray(bars) || bars.length <= limit) return { bars: bars || [], sampled: false }
  const step = (bars.length - 1) / (limit - 1)
  const out = []
  for (let index = 0; index < limit; index++) {
    out.push(bars[Math.min(bars.length - 1, Math.round(index * step))])
  }
  return { bars: out, sampled: true }
}

function describeAgentDrawing(drawing) {
  const source = drawing.source === 'agent' || String(drawing.id || '').startsWith('agent-') ? 'AI' : '用户'
  const color = drawing.color ? ` · ${drawing.color}` : ''
  const view = drawing.inView === true ? ' · 当前视图内' : drawing.inView === false ? ' · 视图外' : ''
  return `- ${source} · ${describeDrawing(drawing)}${color}${view}`
}

export function buildAskPrompt(input, options = {}) {
  const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : null
  const range = viewport?.range || input.barsRange || null
  const first = Number(range?.first)
  const last = Number(range?.last)
  const cutoff = Number(input.cutoff ?? viewport?.cutoff ?? last)
  const dataStart = Number(input.dataStart ?? viewport?.dataStart)
  const lines = [
    `【品种】${input.symbol || '?'} · ${input.interval || '1h'}`,
    `【模式】${input.mode === 'practice' ? '逐 K 练习' : '普通历史看盘'}`,
  ]
  if (Number.isFinite(cutoff)) {
    lines.push(`【回放截止 cutoff】${new Date(cutoff * 1000).toISOString()}（练习模式绝不能使用此时间之后的数据）`)
  }
  lines.push(`【当前可见到】${input.replayTime || '暂无 K 线'}（最近一根可见 K 线开盘时间，MT5 服务器时间）· 共 ${input.visibleBars || 0} 根 K`)
  if (Number.isFinite(first) && Number.isFinite(last)) {
    lines.push(
      `【视图时间范围】${new Date(first * 1000).toISOString()} ～ ${new Date(last * 1000).toISOString()}（画线锚点尽量在此范围内，且不得超过 cutoff）`,
    )
  }
  if (Number.isFinite(dataStart)) {
    lines.push(`【已加载数据起点】${new Date(dataStart * 1000).toISOString()}`)
  }
  const minPrice = Number(viewport?.priceRange?.min)
  const maxPrice = Number(viewport?.priceRange?.max)
  if (Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
    lines.push(`【视图价格范围】${minPrice} ～ ${maxPrice}`)
  }
  lines.push(
    options.imageAttached
      ? '【当前视图截图】已附带一张，只包含截图那一刻屏幕上可见的 K 线、用户/AI 画线和坐标轴。'
      : '【当前视图截图】未附带，请仅依据下面的 K 线与画线数据。',
  )
  if (input.account) {
    lines.push(`【模拟账户】余额 ${input.account.balance} · 已实现盈亏 ${input.account.realizedPnl}`)
  }
  if (input.position) {
    const p = input.position
    lines.push(`【持仓】${p.side} ${p.lots} 手 @ ${p.entry} · SL ${p.sl ?? '—'} · TP ${p.tp ?? '—'}`)
  }
  if (Array.isArray(input.pendingOrders) && input.pendingOrders.length) {
    lines.push(`【挂单】${input.pendingOrders.length} 笔：`)
    for (const o of input.pendingOrders.slice(0, 8)) {
      lines.push(`  - ${o.type} ${o.side} ${o.lots} 手 · 限价 ${o.limitPrice ?? '—'}`)
    }
  }
  const historyBars = Array.isArray(viewport?.historyBars) ? viewport.historyBars : []
  if (historyBars.length) {
    const { bars, sampled } = sampleBars(historyBars, MAX_PROMPT_BARS)
    lines.push(
      `【视图前历史】${sampled ? `已抽样 ${bars.length}/${historyBars.length} 根 · ` : ''}截止到视图起点之前，旧→新：`,
    )
    for (const b of bars) {
      lines.push(`  ${barOpenTime(b)} O${b.open} H${b.high} L${b.low} C${b.close}`)
    }
  }
  const viewBars = Array.isArray(viewport?.bars) && viewport.bars.length ? viewport.bars : input.recentBars
  if (Array.isArray(viewBars) && viewBars.length) {
    const { bars, sampled } = sampleBars(viewBars, MAX_PROMPT_BARS)
    lines.push(
      `【视图内 K 线】${sampled ? `已抽样 ${bars.length}/${viewBars.length} 根 · ` : ''}OHLC 旧→新（openTime 可直接作为工具 time）：`,
    )
    for (const b of bars) {
      lines.push(`  ${barOpenTime(b)} O${b.open} H${b.high} L${b.low} C${b.close}`)
    }
  }
  const drawings = Array.isArray(input.drawings) ? input.drawings : []
  if (drawings.length) {
    const shown = drawings.slice(-200)
    lines.push(`【图上画线】${drawings.length} 个${shown.length < drawings.length ? `（仅列最近 ${shown.length} 个）` : ''}（可用 id 删除/修改）：`)
    for (const d of shown) lines.push(`  ${describeAgentDrawing(d)}`)
  } else {
    lines.push('【图上画线】无')
  }
  lines.push('', '【问题】', String(input.question || '').trim())
  return lines.join('\n')
}

/** Whether the selected route can consume an image. */
async function modelImageSupport(llm, provider, model) {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    if (Array.isArray(info?.inputModalities)) return info.inputModalities.includes('image') ? 'yes' : 'no'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Commit the auto-captured viewport image as an attachment for the model
 * request. The browser sends `{ mediaType, data }` with canonical base64.
 * Only models that explicitly advertise image input receive the attachment:
 * sending one to a text-only route would fail the whole request.
 */
async function prepareViewportImage(ctx, llm, provider, model, image) {
  if (!image || typeof image.data !== 'string' || !image.data) return { ref: null, reason: 'no-image' }
  const support = await modelImageSupport(llm, provider, model)
  if (support === 'no') return { ref: null, reason: 'text-only' }
  if (support !== 'yes') return { ref: null, reason: 'unknown-modalities' }
  const attachments = ctx.get('attachments')
  if (!attachments) return { ref: null, reason: 'no-attachments' }
  const mediaType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
    ? image.mediaType
    : 'image/jpeg'
  const data = image.data.replace(/^data:[^;]+;base64,/, '')
  try {
    const refs = await attachments.saveImages([
      { data, mediaType, name: mediaType === 'image/png' ? 'chart-view.png' : 'chart-view.jpg' },
    ])
    return { ref: refs[0], reason: '' }
  } catch (error) {
    return { ref: null, reason: 'save-failed', error }
  }
}

/**
 * One assistant turn with drawing tools. Tool calls are validated here, sent to
 * the browser as `drawing` SSE events, and answered back to the model as tool
 * results so it can keep talking; the last round omits tools so the model must
 * produce a final answer instead of looping forever.
 */
export async function runAssistant({ llm, res, provider, model, reasoningEffort, input, signal, imageRef }) {
  const userContent = []
  if (imageRef) userContent.push({ type: 'image', attachment: imageRef })
  userContent.push({ type: 'text', text: buildAskPrompt(input, { imageAttached: Boolean(imageRef) }) })
  const messages = [{ role: 'user', content: userContent }]
  let addedDrawings = 0
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const useTools = round < MAX_TOOL_ROUNDS
    const toolCalls = new Map()
    let text = ''
    let finish
    const stream = llm.stream({
      provider,
      model,
      reasoningEffort,
      system: SYSTEM_PROMPT,
      messages: [...messages],
      ...(useTools ? { tools: DRAWING_TOOLS } : {}),
      signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (chunk.text) {
          text += chunk.text
          sendSse(res, { type: 'delta', text: chunk.text })
        }
      } else if (chunk.type === 'reasoning-delta') {
        if (chunk.text) sendSse(res, { type: 'reasoning', text: chunk.text })
      } else if (chunk.type === 'tool-call-delta') {
        const index = Number.isInteger(chunk.index) ? chunk.index : toolCalls.size
        let call = toolCalls.get(index)
        if (!call) {
          call = { id: '', name: '', arguments: '' }
          toolCalls.set(index, call)
        }
        if (typeof chunk.id === 'string' && chunk.id) call.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name) call.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') call.arguments += chunk.argumentsDelta
      } else if (chunk.type === 'finish') {
        finish = chunk
      }
    }
    if (signal.aborted) return
    if (finish?.reason?.kind === 'error') {
      sendSse(res, { type: 'error', message: finish.reason.failure?.message || '模型错误' })
      return
    }
    const calls = [...toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, call]) => call)
      .filter((call) => call.name)
    if (!calls.length || !useTools) return

    const content = []
    if (text) content.push({ type: 'text', text })
    for (const [index, call] of calls.entries()) {
      content.push({
        type: 'tool-call',
        id: call.id || `call_${round}_${index}`,
        name: call.name,
        arguments: call.arguments || '{}',
      })
    }
    messages.push({ role: 'assistant', source: { kind: 'model', provider, model }, content })

    for (const [index, call] of calls.entries()) {
      const callId = call.id || `call_${round}_${index}`
      let args = null
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {}
      let outcome = args && typeof args === 'object' && !Array.isArray(args)
        ? executeDrawingTool(call.name, args, {
            barsRange: input.viewport?.range || input.barsRange,
            priceRange: input.viewport?.priceRange,
            question: input.question,
          })
        : { ok: false, message: '工具参数不是合法 JSON 对象，请重新调用。' }
      if (outcome.command?.action === 'add') {
        if (addedDrawings >= 3) {
          outcome = { ok: false, message: '本轮最多新增 3 个画线对象，已忽略这一条。请先说明画法，或让用户明确需要更多。' }
        } else {
          addedDrawings += 1
        }
      }
      if (outcome.command) {
        sendSse(res, { type: 'drawing', command: outcome.command, message: outcome.message })
      }
      sendSse(res, { type: 'tool', name: call.name, ok: outcome.ok, message: outcome.message })
      messages.push({
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: outcome.message }],
        isError: !outcome.ok,
      })
    }
  }
}

function route(ctx, manager, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const sub = path.startsWith(`${ROUTE_PREFIX}/`) ? path.slice(ROUTE_PREFIX.length + 1) : ''
  const method = req.method || 'GET'

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/health`) {
    let root = ''
    try {
      root = dataRoot(ctx)
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error.message })
      return
    }
    sendJson(res, 200, { ok: true, dataRoot: root, symbols: SYMBOLS.map((s) => s.id), intervals: INTERVALS })
    return
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/symbols`) {
    let root
    try {
      root = dataRoot(ctx)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message })
      return
    }
    const interval = validateChartInterval(url.searchParams.get('interval') || '1m')
    const list = SYMBOLS.map((sym) => {
      const meta = aggregateMeta(root, sym.id, SOURCE_INTERVAL)
      return { id: sym.id, name: sym.name, interval, sourceInterval: SOURCE_INTERVAL, ...meta }
    })
    sendJson(res, 200, { ok: true, dataRoot: root, symbols: list, intervals: INTERVALS })
    return
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/meta`) {
    try {
      const interval = validateChartInterval(url.searchParams.get('interval') || '1m')
      const symbol = validateSymbol(url.searchParams.get('symbol'))
      const meta = aggregateMeta(dataRoot(ctx), symbol, SOURCE_INTERVAL)
      sendJson(res, 200, { ok: true, symbol, interval, sourceInterval: SOURCE_INTERVAL, ...meta })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) })
    }
    return
  }

  if (sub === 'update-check' && method === 'GET') {
    try {
      const interval = validateSourceInterval(url.searchParams.get('interval') || '1m')
      const symbol = validateSymbol(url.searchParams.get('symbol') || 'XAUUSD')
      const fromYear = Number(url.searchParams.get('fromYear') || '2020')
      const check = getUpdateCheck(ctx, { symbol, interval, fromYear, dataRoot: dataRoot(ctx) })
      sendJson(res, 200, { ok: true, symbol, interval, check })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) })
    }
    return
  }

  if (sub === 'update-data' && method === 'POST') {
    const runUpdate = async () => {
      try {
        const input = await readJson(req)
        const interval = validateSourceInterval(url.searchParams.get('interval') || input.interval || '1m')
        const symbol = validateSymbol(input.symbol || url.searchParams.get('symbol'))
        const full = Boolean(input.full)
        const force = Boolean(input.force)
        const fromYear = input.fromYear != null ? Number(input.fromYear) : undefined
        const toYear = input.toYear != null ? Number(input.toYear) : undefined
        const result = startHistdataUpdate(ctx, { symbol, interval, fromYear, toYear, full, force })
        if (!result.ok) {
          sendJson(res, 500, { ok: false, error: result.error || '启动失败' })
          return
        }
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || String(error) })
      }
    }
    runUpdate()
    return
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/fetch-status`) {
    try {
      const symbol = validateSymbol(url.searchParams.get('symbol') || 'XAUUSD')
      const interval = validateSourceInterval(url.searchParams.get('interval') || '1m')
      const statePath = fetchStatePath(ctx, symbol, interval)
      let state = null
      if (existsSync(statePath)) {
        try {
          state = JSON.parse(readFileSync(statePath, 'utf8'))
        } catch {}
      }
      const meta = aggregateMeta(dataRoot(ctx), symbol, interval)
      sendJson(res, 200, { ok: true, symbol, interval, meta, fetch: state })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) })
    }
    return
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/bars`) {
    try {
      const interval = validateChartInterval(url.searchParams.get('interval') || '1m')
      const symbol = validateSymbol(url.searchParams.get('symbol'))
      const fromMs = Date.parse(url.searchParams.get('from') || '')
      const toMs = Date.parse(url.searchParams.get('to') || '')
      const limitRaw = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(0, limitRaw), DEFAULT_LIMIT) : DEFAULT_LIMIT
      const direction = url.searchParams.get('direction') === 'forward' ? 'forward' : 'backward'
      const loaded = loadChartBars(
        loadBarsFromStore,
        dataRoot(ctx),
        symbol,
        interval,
        Number.isFinite(fromMs) ? fromMs : NaN,
        Number.isFinite(toMs) ? toMs : NaN,
        limit,
        direction,
      )
      sendJson(res, 200, {
        ok: true,
        symbol,
        interval,
        sourceInterval: SOURCE_INTERVAL,
        mtimeMs: loaded.mtimeMs,
        path: loaded.path,
        storage: loaded.storage,
        truncated: loaded.truncated,
        hasMore: Boolean(loaded.truncated),
        bars: loaded.bars,
      })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) })
    }
    return
  }

  if (sub === 'models' && method === 'GET') {
    const runModels = async () => {
      try {
        const refresh = url.searchParams.get('refresh') === '1'
        const body = await getModelCatalogueResponse(ctx, refresh)
        sendJson(res, 200, body)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) })
      }
    }
    runModels()
    return
  }

  if (sub === 'agent/bootstrap' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const fallback = modelSelection(ctx)
        const provider = String(input.provider || '').trim() || fallback.provider
        const model = String(input.model || '').trim() || fallback.model
        const reasoningEffort = String(input.reasoningEffort || fallback.reasoningEffort || '').trim() || undefined
        if (!provider || !model) {
          sendJson(res, 400, { ok: false, error: '请先选择对话模型' })
          return
        }
        const snapshot = await manager.bootstrap({ provider, model, reasoningEffort, symbol: input.symbol })
        sendJson(res, 200, { ok: true, ...snapshot })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'agent/list' && method === 'GET') {
    sendJson(res, 200, { ok: true, ...manager.snapshot() })
    return
  }

  if (sub === 'agent/new' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const fallback = modelSelection(ctx)
        const provider = String(input.provider || '').trim() || fallback.provider
        const model = String(input.model || '').trim() || fallback.model
        const reasoningEffort = String(input.reasoningEffort || fallback.reasoningEffort || '').trim() || undefined
        if (!provider || !model) {
          sendJson(res, 400, { ok: false, error: '请先选择对话模型' })
          return
        }
        const snapshot = await manager.newAgent({ provider, model, reasoningEffort, symbol: input.symbol })
        sendJson(res, 200, { ok: true, ...snapshot })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'agent/switch' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const sessionId = String(input.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        const snapshot = await manager.switchTo(sessionId)
        sendJson(res, 200, { ok: true, ...snapshot })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'agent/delete' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const sessionId = String(input.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        const snapshot = await manager.deleteAgent(sessionId)
        sendJson(res, 200, { ok: true, ...snapshot })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'agent/history' && method === 'GET') {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim()
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
      return
    }
    sendJson(res, 200, { ok: true, messages: manager.history(sessionId) })
    return
  }

  if (sub === 'agent/events' && method === 'GET') {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim()
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    manager.addConnection(sessionId, res)
    const status = sessionId === manager.activeId
      ? (manager.snapshot().status || 'idle')
      : 'idle'
    res.write(`data: ${JSON.stringify({ type: 'hello', sessionId, status })}\n\n`)
    return
  }

  if (sub === 'agent/prompt' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const question = String(input.question || '').trim()
        if (!question) {
          sendJson(res, 400, { ok: false, error: '问题不能为空' })
          return
        }
        const entry = manager.entryFor(manager.activeId)
        if (!entry) {
          sendJson(res, 409, { ok: false, error: '没有活跃的 agent，请先新建' })
          return
        }
        const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : null
        let preparedImage = { ref: null, reason: 'no-image' }
        try {
          preparedImage = await prepareViewportImage(
            ctx,
            ctx.get('llm'),
            entry.provider,
            entry.model,
            viewport?.image,
          )
        } catch (error) {
          preparedImage = { ref: null, reason: 'save-failed', error }
        }
        const state = {
          mode: input.mode === 'practice' ? 'practice' : 'view',
          cutoff: Number(input.cutoff ?? viewport?.range?.last),
          viewRange: viewport?.range || null,
          priceRange: viewport?.priceRange || null,
          symbol: String(input.symbol || entry.symbol || ''),
          interval: String(input.interval || ''),
          dataStart: Number(input.dataStart),
          drawings: Array.isArray(input.drawings) ? input.drawings : [],
          question,
        }
        const text = buildAskPrompt(input, { imageAttached: Boolean(preparedImage.ref) })
        await manager.sendPrompt({ text, imageRef: preparedImage.ref, state })
        sendJson(res, 200, { ok: true, imageAttached: Boolean(preparedImage.ref), agentStatus: manager.snapshot().status })
      } catch (error) {
        const status = error.code === 'AGENT_BUSY' ? 409 : 500
        sendJson(res, status, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'agent/ack' && method === 'POST') {
    const run = async () => {
      try {
        const input = await readJson(req)
        const commandId = String(input.commandId || '').trim()
        if (!commandId) {
          sendJson(res, 400, { ok: false, error: '缺少 commandId' })
          return
        }
        const accepted = manager.ack(commandId, input.ok !== false, input.message)
        sendJson(res, 200, { ok: true, accepted })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || String(error) })
      }
    }
    run()
    return
  }

  if (sub === 'ask' && method === 'POST') {
    const run = async () => {
      const input = await readJson(req)
      const question = String(input.question || '').trim()
      if (!question) {
        sendJson(res, 400, { ok: false, error: '问题不能为空' })
        return
      }
      const llm = ctx.get('llm')
      const fallback = modelSelection(ctx)
      const provider = String(input.provider || '').trim() || fallback.provider
      const model = String(input.model || '').trim() || fallback.model
      const reasoningEffort = String(input.reasoningEffort || fallback.reasoningEffort || '').trim() || undefined
      if (!llm) {
        sendJson(res, 503, { ok: false, error: 'LLM 不可用' })
        return
      }
      if (!provider || !model) {
        sendJson(res, 400, { ok: false, error: '请选择对话模型（或设置 Harness 默认模型）' })
        return
      }
      const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : null
      let preparedImage = { ref: null, reason: 'no-image' }
      try {
        preparedImage = await prepareViewportImage(ctx, llm, provider, model, viewport?.image)
      } catch (error) {
        preparedImage = { ref: null, reason: 'save-failed', error }
      }
      if (req.destroyed || res.destroyed) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      const controller = new AbortController()
      const abort = () => controller.abort()
      req.on('close', abort)
      res.on('close', abort)
      sendSse(res, { type: 'meta', provider, model })
      if (!preparedImage.ref) {
        const notice = {
          'text-only': '当前模型不支持图片，本次只发送 K 线与画线数据。',
          'unknown-modalities': '无法确认当前模型是否支持图片，本次只发送 K 线与画线数据；可选择带「图」标记的模型。',
          'no-attachments': '附件服务不可用，本次只发送 K 线与画线数据。',
          'save-failed': '图表截图保存失败，本次只发送 K 线与画线数据。',
        }[preparedImage.reason]
        if (notice) sendSse(res, { type: 'notice', text: notice })
      }
      try {
        await runAssistant({
          llm,
          res,
          provider,
          model,
          reasoningEffort,
          input,
          signal: controller.signal,
          imageRef: preparedImage.ref,
        })
        if (!controller.signal.aborted) sendSse(res, { type: 'done' })
      } catch (error) {
        if (!controller.signal.aborted) {
          sendSse(res, { type: 'error', message: error.message || String(error) })
        }
      } finally {
        req.off('close', abort)
        res.off('close', abort)
        res.end()
      }
    }
    run().catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message || String(error) })
      else {
        try {
          sendSse(res, { type: 'error', message: error.message || String(error) })
          res.end()
        } catch {}
      }
    })
    return
  }

  sendJson(res, 404, { ok: false, error: '未知的交易练习接口' })
}

export function apply(ctx) {
  const manager = new AgentManager({
    ctx,
    // Resolved per use: the workspace registry is not ready at apply time.
    root: () => tradePracticeRoot(ctx),
    dataRoot: () => dataRoot(ctx),
  })
  manager.attach()
  ctx.effect(() => () => manager.dispose())
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => route(ctx, manager, req, res),
    }),
  )
}
