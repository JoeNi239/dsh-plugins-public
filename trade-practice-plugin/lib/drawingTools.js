/**
 * Drawing tools exposed to the in-panel trading assistant.
 *
 * The host only validates and describes drawing commands; the browser owns the
 * actual drawing state (localStorage + overlay), so a successful tool call is
 * streamed to the client as a `drawing` SSE event and applied there.
 *
 * Times are MT5 server time. ISO strings are interpreted as written (a missing
 * zone means UTC, matching the CSV/`openTime` convention), numeric values are
 * Unix seconds (or milliseconds when they are large enough to only fit that).
 */

export const DRAWING_TYPES = [
  'hline',
  'trend',
  'ray',
  'vline',
  'rect',
  'channel',
  'fib',
  'fib-extension',
  'text',
]

const TYPE_LABELS = {
  hline: '水平线',
  trend: '趋势线',
  ray: '射线',
  vline: '垂直线',
  rect: '矩形',
  channel: '平行通道',
  fib: '斐波那契回调',
  'fib-extension': '斐波那契扩展',
  text: '文字标注',
}

const DEFAULT_COLORS = {
  hline: '#f0b429',
  trend: '#64b5f6',
  ray: '#64b5f6',
  vline: '#90caf9',
  rect: '#ba68c8',
  channel: '#64b5f6',
  fib: '#f0b429',
  'fib-extension': '#64b5f6',
  text: '#ffffff',
}

let sequence = 0

function nextDrawingId() {
  sequence = (sequence + 1) % 0x1000
  return `agent-${Date.now().toString(36)}-${sequence.toString(36)}`
}

function labelOf(type) {
  return TYPE_LABELS[type] || type
}

/** Parse a drawing time argument into Unix seconds. */
export function parseDrawingTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = value > 1e12 ? Math.round(value / 1000) : Math.round(value)
    return seconds > 0 ? seconds : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    if (/^\d+(\.\d+)?$/.test(text)) return parseDrawingTime(Number(text))
    const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text)
      ? text
      : text.includes('T')
        ? `${text}Z`
        : `${text}T00:00:00Z`
    const ms = Date.parse(normalized)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return null
}

function toPrice(value) {
  const number = typeof value === 'string' && value.trim()
    ? Number(value.replace(/[,\s]/g, ''))
    : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

function toText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toColor(value, type) {
  if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.trim())) return value.trim()
  return DEFAULT_COLORS[type]
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toISOString()
}

/** Human-readable one-line description used in prompts and tool results. */
export function describeDrawing(drawing) {
  if (!drawing || typeof drawing !== 'object') return ''
  const type = drawing.type || '?'
  const parts = [`id=${drawing.id ?? '?'}`, type]
  const price = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : '?')
  const time = (value) => (Number.isFinite(Number(value)) ? formatTime(Number(value)) : '?')
  if (drawing.type === 'hline') parts.push(`价格 ${price(drawing.price)}`)
  else if (drawing.type === 'vline') parts.push(`时间 ${time(drawing.t)}`)
  else if (drawing.type === 'text') parts.push(`时间 ${time(drawing.t)}`, `价格 ${price(drawing.p)}`, `文字「${drawing.text || ''}」`)
  else {
    if (drawing.t1 != null) parts.push(`(${time(drawing.t1)}, ${price(drawing.p1)})`)
    if (drawing.t2 != null) parts.push(`→ (${time(drawing.t2)}, ${price(drawing.p2)})`)
    if (drawing.t3 != null) parts.push(`→ (${time(drawing.t3)}, ${price(drawing.p3)})`)
  }
  return parts.join(' · ')
}

function checkTimeAllowed(seconds, context) {
  const cutoff = Number(context?.cutoff ?? context?.viewRange?.last ?? context?.barsRange?.last)
  if (Number.isFinite(cutoff) && seconds > cutoff) {
    return `时间 ${formatTime(seconds)} 超过当前回放截止时间 ${formatTime(cutoff)}；练习模式不能使用未来数据。`
  }
  const start = Number(context?.dataStart ?? context?.barsRange?.first)
  if (Number.isFinite(start) && seconds < start) {
    return `时间 ${formatTime(seconds)} 早于已加载数据起点 ${formatTime(start)}。`
  }
  return null
}

function requireTime(args, key, context) {
  const seconds = parseDrawingTime(args[key])
  if (seconds == null) return { error: `${key} 不是合法时间，请传 ISO 8601（可直接用 K 线的 openTime）或 Unix 秒。` }
  const rangeError = checkTimeAllowed(seconds, context)
  if (rangeError) return { error: rangeError }
  return { seconds }
}

function requirePrice(args, key) {
  const price = toPrice(args[key])
  if (price == null) return { error: `${key} 不是合法价格。` }
  return { price }
}

function buildAddDrawing(args, context) {
  const type = typeof args.type === 'string' ? args.type.trim() : ''
  if (!DRAWING_TYPES.includes(type)) {
    return { ok: false, message: `不支持的画线类型「${type || '空'}」；可用：${DRAWING_TYPES.join(', ')}。` }
  }
  const limits = context || null
  const drawing = { id: nextDrawingId(), type, color: toColor(args.color, type), source: 'agent' }

  if (type === 'hline') {
    const price = requirePrice(args, 'price')
    if (price.error) return { ok: false, message: price.error }
    drawing.price = price.price
  } else if (type === 'vline') {
    const time = requireTime(args, 'time', limits)
    if (time.error) return { ok: false, message: time.error }
    drawing.t = time.seconds
  } else if (type === 'text') {
    const time = requireTime(args, 'time', limits)
    if (time.error) return { ok: false, message: time.error }
    const price = requirePrice(args, 'price')
    if (price.error) return { ok: false, message: price.error }
    const text = toText(args.text)
    if (!text) return { ok: false, message: 'text 类型需要非空的 text 参数。' }
    Object.assign(drawing, { t: time.seconds, p: price.price, text })
  } else {
    const firstTime = requireTime(args, 'time', limits)
    if (firstTime.error) return { ok: false, message: firstTime.error }
    const firstPrice = requirePrice(args, 'price')
    if (firstPrice.error) return { ok: false, message: firstPrice.error }
    const secondTime = requireTime(args, 'time2', limits)
    if (secondTime.error) return { ok: false, message: secondTime.error }
    const secondPrice = requirePrice(args, 'price2')
    if (secondPrice.error) return { ok: false, message: secondPrice.error }
    Object.assign(drawing, {
      t1: firstTime.seconds,
      p1: firstPrice.price,
      t2: secondTime.seconds,
      p2: secondPrice.price,
    })
    if (type === 'channel' || type === 'fib-extension') {
      const thirdTime = requireTime(args, 'time3', limits)
      if (thirdTime.error) return { ok: false, message: thirdTime.error }
      const thirdPrice = requirePrice(args, 'price3')
      if (thirdPrice.error) return { ok: false, message: thirdPrice.error }
      Object.assign(drawing, { t3: thirdTime.seconds, p3: thirdPrice.price })
    }
  }

  const prices = [drawing.price, drawing.p, drawing.p1, drawing.p2, drawing.p3].filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  )
  const minPrice = Number(context?.priceRange?.min)
  const maxPrice = Number(context?.priceRange?.max)
  let priceNote = ''
  if (Number.isFinite(minPrice) && Number.isFinite(maxPrice) && maxPrice > minPrice) {
    const pad = (maxPrice - minPrice) * 0.02
    const outside = prices.find((price) => price < minPrice - pad || price > maxPrice + pad)
    if (outside != null) {
      priceNote = ` 注意：价格 ${outside} 在视图价格范围 ${minPrice}～${maxPrice} 之外，画线可能不可见。`
    }
  }

  const times = [drawing.t, drawing.t1, drawing.t2, drawing.t3].filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  )
  const view = context?.viewRange || null
  const viewFirst = Number(view?.first)
  const viewLast = Number(view?.last)
  let viewNote = ''
  if (times.length && Number.isFinite(viewFirst) && Number.isFinite(viewLast)) {
    const inView = times.some((time) => time >= viewFirst && time <= viewLast)
    if (!inView) {
      viewNote = ' 注意：所有锚点都在当前视图之前，线可能离当前行情较远；分析可以用更早历史，但画线请尽量靠近当前视图。'
    }
  }

  return {
    ok: true,
    command: { action: 'add', drawing },
    message: `已添加${labelOf(type)}（${describeDrawing(drawing)}）。${priceNote}${viewNote}`,
  }
}

/**
 * Execute one drawing tool call. Returns either an SSE drawing command or an
 * explanatory error the model can act on in the next round.
 */
export function executeDrawingTool(name, args, context = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (name === 'add_drawing') return buildAddDrawing(input, context)
  if (name === 'delete_drawing') {
    const id = input.id == null ? '' : String(input.id).trim()
    if (!id) return { ok: false, message: 'delete_drawing 需要 id 参数，请从【图上已有画线】中取值。' }
    return {
      ok: true,
      command: { action: 'delete', id },
      message: `已删除画线 id=${id}。`,
    }
  }
  if (name === 'clear_drawings') {
    const question = String(context?.question || '')
    if (!/(清空|清除|全删|全部删|都删|清掉|删光)/.test(question)) {
      return {
        ok: false,
        message: '用户没有明确要求清空画线。只有用户说“清空/全部删除”时才可调用 clear_drawings；否则请只删除自己刚画的对象。',
      }
    }
    return {
      ok: true,
      command: { action: 'clear' },
      message: '已清空图上所有画线。',
    }
  }
  return { ok: false, message: `未知工具「${name}」。` }
}

const TIME_DESCRIPTION = 'MT5 服务器时间。传 ISO 8601 字符串（可直接用 K 线的 openTime）或 Unix 秒；不能超过当前回放截止时间。'

/** Provider-neutral tool schemas for the assistant call. */
export const DRAWING_TOOLS = [
  {
    name: 'add_drawing',
    description:
      '在交易图表上新增一个画线对象。按 type 提供锚点：'
      + 'hline 需要 price；vline 需要 time；text 需要 time、price、text；'
      + 'trend / ray / rect / fib 需要 time、price、time2、price2；'
      + 'channel / fib-extension 还需要 time3、price3。'
      + '仅在用户明确要求画线/标注，或为说明关键价位确有必要时调用；一次最多 3 个对象，画完在正文简短说明。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: DRAWING_TYPES, description: '画线类型。' },
        time: { type: 'string', description: `第一个锚点时间。${TIME_DESCRIPTION}` },
        price: { type: 'number', description: '第一个锚点价格；水平线只收 price。' },
        time2: { type: 'string', description: `第二个锚点时间。${TIME_DESCRIPTION}` },
        price2: { type: 'number', description: '第二个锚点价格。' },
        time3: { type: 'string', description: `第三个锚点时间（通道 / 斐波那契扩展）。${TIME_DESCRIPTION}` },
        price3: { type: 'number', description: '第三个锚点价格（通道 / 斐波那契扩展）。' },
        text: { type: 'string', description: '文字标注内容，仅 type=text 时使用。' },
        color: { type: 'string', description: '可选十六进制颜色，如 #f0b429；省略时按类型取默认色。' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_drawing',
    description: '按 id 删除图上一条画线。id 见【图上已有画线】或上一次 add_drawing 的工具结果。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的画线 id。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_drawings',
    description: '清空图上所有画线。仅在用户明确要求「清空画线 / 全部删除」时调用。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]
