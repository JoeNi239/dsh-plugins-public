/**
 * PDF Reader — host half.
 *
 * Serves the reader page's data over same-origin HTTP routes:
 *   GET  /pdf-reader/health
 *   GET  /pdf-reader/browse?path=
 *   GET  /pdf-reader/info?path=
 *   GET  /pdf-reader/page?path=&page=&scale=
 *   POST /pdf-reader/import?name=
 *   POST /pdf-reader/export
 *   POST /pdf-reader/ask        (server-sent events)
 *
 * Page rasterisation and text extraction run in a long-lived PyMuPDF worker
 * (`pdf_worker.py`), so switching pages does not pay interpreter start-up.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const inject = ['webServer']

const PREFIX = '/pdf-reader/'
const ROUTE_PREFIX = '/pdf-reader'
// Local build: open any absolute .pdf path on this computer and browse any
// folder. Set false to restore the workspace-only path jail.
const ALLOW_ANY_PATH = true
const MAX_BODY = 64 * 1024 * 1024
const MAX_PAGE_TEXT = 16000
const MAX_PAGE_BLOCK = 6000
const MAX_SELECTION = 2000
const MAX_HISTORY = 4000
const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple']
// Same swatches the reader uses for its highlight overlays (0..1 RGB), so a
// marquee crop can burn the visible colours into the picture sent to the model.
const ANNOTATION_FILLS = {
  yellow: [1, 0.835, 0.29],
  green: [0.494, 0.839, 0.494],
  blue: [0.416, 0.663, 1],
  pink: [1, 0.608, 0.769],
  purple: [0.753, 0.608, 1],
}
const ANNOTATION_COLOR_NAMES = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
  purple: '紫色',
}
const MAX_REGION_ANNOTATIONS = 12
const MAX_EXPORT_BYTES = 4 * 1024 * 1024
const EXPORT_FORMATS = new Set(['md', 'txt', 'html'])

const SYSTEM_PROMPT = [
  '你是嵌在 PDF 阅读器里的阅读助手。用户正在阅读一份 PDF，提问通常附带他选中的文字（带页码）或框选的图片，也可能什么都没有附。',
  '规则：',
  '1. 只依据用户选中的文字、附带的图片、工具查到的原文和对话上下文回答。信息不足时，自己用工具查阅，不要要求用户手动翻页或粘贴原文。',
  '2. 回答要短而可直接阅读：先给结论，再用要点展开，通常不超过 200 字；用户要求输出文件时例外，文件正文要完整。',
  '3. 解释概念时，如果有助说明可以举一个贴切的例子或类比，不强制；翻译时保留原文术语。',
  '4. 不要复述整页原文；引用原文时用「」括起，保持简短；提到位置时写成「第 N 页」，这些写法会变成可点击的跳转。',
  '5. 对话记录是整篇文档共用的，可能来自其他页并带页码；引用其他页的讨论时先说明是第几页的内容。',
  '6. 需要当前页、相邻页或其他页的原文时，调用 read_pages；不确定内容在哪一页时，先 search_document 再读。',
  '7. 消息附带图片时，先说明你从图中读到的关键信息（图表坐标、图例、流程或结构），再回答问题；图片模糊或信息不足时如实说明。图片里半透明的彩色块是读者已有的高亮标注，颜色和备注以随消息给出的说明为准。',
  '8. 一次查阅多页时，先点明你依据的是哪几页；跨页比较要指出相同点和差异，没读过的页面不要臆测。',
  '9. 用户要求划重点、加批注或整理标注时，使用 list_annotations / create_annotation / update_annotation / delete_annotation；修改前先 list 拿 id，标注 quote 用原文片段。',
  '10. 用户要求把内容输出为文件、导出成文件、保存成 md/txt/html 或写一份报告时，调用 save_file：content 放你整理好的完整正文（不是摘要，也不要只写“已保存”），name 用简短中文文件名；完成后告诉用户文件已保存以及路径。',
  '11. 默认使用中文回答，除非用户要求其他语言。',
].join('\n')

const SAVE_FILE_TOOL = {
  name: 'save_file',
  description:
    '把整理好的内容保存为工作区文件（.md / .txt / .html）。用户说“把……输出为文件 / 导出成文件 / 保存成 md / 写一份报告”时调用。content 必须是完整正文（模型自己整理好的内容），不要只写“已保存”或摘要。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '文件名，不含扩展名，简短明确，例如「第10页内存要点」' },
      format: { type: 'string', enum: ['md', 'txt', 'html'], description: '文件格式，默认 md' },
      content: { type: 'string', description: '完整正文；markdown 格式可直接用标题、列表、表格' },
      directory: { type: 'string', description: '可选：工作区内的子目录；默认工作区根目录' },
    },
    required: ['name', 'content'],
    additionalProperties: false,
  },
}

const TOOL_SCHEMAS = [
  {
    name: 'read_pages',
    description: '读取这份 PDF 指定页的原文。用户没给原文、或需要当前页/前后页/其他页时调用。',
    parameters: {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'integer' }, description: '页码列表，从 1 开始，最多 4 页' },
      },
      required: ['pages'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_document',
    description: '在整份 PDF 中搜索关键词或短语，返回命中的页码与上下文片段。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要搜索的词或短语' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotations',
    description: '列出这份 PDF 现有的标注（id、页码、原文、备注、作者）。修改或删除前先调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_annotation',
    description: '在指定页给一段原文添加高亮标注，可附备注。quote 必须能在该页原文中找到。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始' },
        quote: { type: 'string', description: '要高亮的原文片段，尽量短而唯一' },
        note: { type: 'string', description: '备注，可为空' },
        color: { type: 'string', enum: ANNOTATION_COLORS, description: '颜色' },
      },
      required: ['page', 'quote'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_annotation',
    description: '修改一条标注的备注或颜色，需要 id。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string' },
        color: { type: 'string', enum: ANNOTATION_COLORS },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_annotation',
    description: '删除一条标注，需要 id。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  SAVE_FILE_TOOL,
]
const MAX_TOOL_ROUNDS = 10

function toolLabel(call) {
  try {
    const args = JSON.parse(call.arguments || '{}')
    if (call.name === 'read_pages') {
      const pages = Array.isArray(args.pages) ? args.pages.join('、') : ''
      return pages ? `读取第 ${pages} 页` : '读取页面原文'
    }
    if (call.name === 'search_document') return `搜索「${String(args.query || '').slice(0, 30)}」`
    if (call.name === 'list_annotations') return '查看标注'
    if (call.name === 'create_annotation') return `添加标注（第 ${Number(args.page) || '?'} 页）`
    if (call.name === 'update_annotation') return '修改标注'
    if (call.name === 'delete_annotation') return '删除标注'
    if (call.name === 'save_file') {
      const name = String(args.name || '').slice(0, 30)
      return name ? `保存文件（${name}）` : '保存文件'
    }
  } catch {}
  return '查阅原文'
}

async function executeTool(ctx, input, call, notify) {
  const pdf = resolvePdf(ctx, input.path)
  let args = {}
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {}
  if (call.name === 'list_annotations') {
    const items = loadAnnotations(pdf)
    if (!items.length) return { text: '当前没有标注。' }
    return { text: JSON.stringify(annotationsSummary(items), null, 2) }
  }
  if (call.name === 'create_annotation') {
    const page = Number(args.page)
    const quote = String(args.quote || '').trim().slice(0, 300)
    if (!Number.isInteger(page) || page < 1 || !quote) return { text: '需要提供 page 和 quote。', isError: true }
    const found = await workerCall('find', { path: pdf, text: quote })
    const hit = found && found.ok ? (found.hits || []).find((item) => item.page === page) : null
    if (!hit) {
      return { text: `第 ${page} 页没有找到「${quote.slice(0, 40)}」，换一段原文或确认页码。`, isError: true }
    }
    const items = loadAnnotations(pdf)
    const item = {
      id: `a-${randomUUID()}`,
      page,
      rects: hit.rects.slice(0, 12),
      color: ANNOTATION_COLORS.includes(args.color) ? args.color : 'yellow',
      quote,
      note: String(args.note || '').slice(0, 2000),
      author: 'ai',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    saveAnnotations(pdf, [...items, item])
    if (notify) notify()
    return { text: `已添加标注 id=${item.id}（第 ${page} 页）。` }
  }
  if (call.name === 'update_annotation') {
    const id = String(args.id || '')
    const items = loadAnnotations(pdf)
    const target = items.find((item) => item.id === id)
    if (!target) return { text: `没有找到标注 ${id}。`, isError: true }
    if (typeof args.note === 'string') target.note = args.note.slice(0, 2000)
    if (ANNOTATION_COLORS.includes(args.color)) target.color = args.color
    target.updatedAt = Date.now()
    saveAnnotations(pdf, items)
    if (notify) notify()
    return { text: `已更新标注 ${id}。` }
  }
  if (call.name === 'delete_annotation') {
    const id = String(args.id || '')
    const items = loadAnnotations(pdf)
    const next = items.filter((item) => item.id !== id)
    if (next.length === items.length) return { text: `没有找到标注 ${id}。`, isError: true }
    saveAnnotations(pdf, next)
    if (notify) notify()
    return { text: `已删除标注 ${id}。` }
  }
  if (call.name === 'save_file') {
    try {
      const saved = saveExportFile(ctx, {
        name: args.name,
        format: args.format,
        directory: args.directory,
        content: args.content,
      })
      return {
        text: `已保存到 ${saved.path}（${saved.bytes} 字节）。用一两句话告诉用户保存了什么、文件在哪里，不要重复整篇正文。`,
        file: { path: saved.path, name: saved.name },
      }
    } catch (error) {
      return { text: `保存失败：${error && error.message ? error.message : String(error)}`, isError: true }
    }
  }
  if (call.name === 'read_pages') {
    const pages = Array.isArray(args.pages)
      ? args.pages
          .map(Number)
          .filter((number) => Number.isInteger(number) && number >= 1)
          .slice(0, 4)
      : []
    if (!pages.length) return { text: '需要提供 pages 数组（页码从 1 开始）。', isError: true }
    const reply = await workerCall('text', { path: pdf, pages })
    if (!reply.ok) return { text: reply.error || '读取失败', isError: true }
    return {
      text: reply.pages
        .map((page) => `【第 ${page.page} 页原文】\n${page.text || '（这一页没有可提取的文字）'}`)
        .join('\n\n'),
    }
  }
  if (call.name === 'search_document') {
    const query = String(args.query || '').trim().slice(0, 120)
    if (!query) return { text: '需要提供 query。', isError: true }
    const reply = await workerCall('search', { path: pdf, query })
    if (!reply.ok) return { text: reply.error || '搜索失败', isError: true }
    if (!reply.hits || !reply.hits.length) return { text: `没有找到「${query}」。` }
    return { text: reply.hits.map((hit) => `【第 ${hit.page} 页】${hit.excerpt || ''}`).join('\n\n') }
  }
  return { text: `未知工具：${call.name}`, isError: true }
}

// ---------------------------------------------------------------------------
// Python worker
// ---------------------------------------------------------------------------

let workerState = null

function pythonCandidates() {
  const fromEnv = (process.env.PDF_READER_PYTHON || '').trim()
  return fromEnv ? [fromEnv] : ['python', 'py']
}

function startWorker(candidateIndex) {
  const candidates = pythonCandidates()
  const command = candidates[candidateIndex]
  if (!command) {
    return Promise.reject(new Error('找不到可用的 Python 解释器（设置 PDF_READER_PYTHON 可指定路径）'))
  }
  const script = fileURLToPath(new URL('./pdf_worker.py', import.meta.url))
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const args = command === 'py' ? ['-3', script] : [script]
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    const state = {
      proc,
      pending: new Map(),
      seq: 0,
      stderr: '',
      command,
    }
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      state.stderr = (state.stderr + chunk).slice(-4000)
    })
    proc.on('error', (error) => {
      if (!settled) {
        settled = true
        rejectPromise(error)
        return
      }
      failAll(state, error.message)
    })
    proc.on('exit', (code) => {
      if (workerState === state) workerState = null
      failAll(state, `PDF 解析进程已退出（code ${code}）` + (state.stderr ? `\n${state.stderr.slice(-600)}` : ''))
    })
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        return
      }
      const entry = state.pending.get(reply.id)
      if (!entry) return
      state.pending.delete(reply.id)
      clearTimeout(entry.timer)
      entry.resolve(reply)
    })
    // The first successful spawn wins; a missing `py` launcher is retried once.
    proc.once('spawn', () => {
      settled = true
      workerState = state
      resolvePromise(state)
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        try { proc.kill() } catch {}
        rejectPromise(new Error(`Python 启动超时：${command}`))
      }
    }, 8000)
  }).catch((error) => {
    if (candidateIndex + 1 < pythonCandidates().length) return startWorker(candidateIndex + 1)
    throw error
  })
}

function failAll(state, message) {
  for (const [, entry] of state.pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(message))
  }
  state.pending.clear()
}

async function getWorker() {
  if (workerState && workerState.proc.exitCode === null) return workerState
  workerState = null
  return startWorker(0)
}

async function workerCall(op, payload, timeoutMs = 60000) {
  const state = await getWorker()
  const id = ++state.seq
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      rejectCall(new Error(`PDF 操作超时：${op}`))
    }, timeoutMs)
    state.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    try {
      state.proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
    } catch (error) {
      clearTimeout(timer)
      state.pending.delete(id)
      rejectCall(error)
    }
  })
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const importedPaths = new Set()

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
  for (const entry of (process.env.PDF_READER_ROOTS || '').split(delimiter)) push(entry)
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

function resolvePdf(ctx, raw) {
  if (!raw || typeof raw !== 'string') throw new Error('缺少 PDF 路径')
  const path = resolve(raw)
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('只支持 .pdf 文件')
  if (ALLOW_ANY_PATH) {
    try {
      if (!statSync(path).isFile()) throw new Error('不是文件：' + path)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('文件不存在：' + path)
      throw error
    }
    return path
  }
  const allowed = importedPaths.has(normalise(path)) || allowedRoots(ctx).some((root) => inside(root, normalise(path)))
  if (!allowed) throw new Error('路径不在工作区内')
  if (!existsSync(path)) throw new Error('文件不存在：' + path)
  const info = statSync(path)
  if (!info.isFile()) throw new Error('不是文件：' + path)
  return path
}

// ---------------------------------------------------------------------------
// Annotations (sidecar file next to the PDF, readable by the model as well)
// ---------------------------------------------------------------------------

function annotationPaths(pdf) {
  const hash = createHash('sha256').update(pdf).digest('hex').slice(0, 16)
  return {
    primary: `${pdf}.annotations.json`,
    fallback: join(tmpdir(), 'dsh-pdf-reader-annotations', `${hash}.json`),
  }
}

function sanitizeAnnotations(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items.slice(0, 500)) {
    const page = Number(item && item.page)
    if (!Number.isInteger(page) || page < 1) continue
    const rects = Array.isArray(item.rects)
      ? item.rects
          .slice(0, 40)
          .map((rect) => (Array.isArray(rect) && rect.length === 4 ? rect.map(Number) : null))
          .filter((rect) => rect && rect.every(Number.isFinite))
      : []
    if (!rects.length) continue
    out.push({
      id: typeof item.id === 'string' && item.id ? item.id.slice(0, 64) : `a-${randomUUID()}`,
      page,
      rects,
      color: ANNOTATION_COLORS.includes(item.color) ? item.color : 'yellow',
      quote: String(item.quote || '').slice(0, 2000),
      note: String(item.note || '').slice(0, 2000),
      author: item.author === 'ai' ? 'ai' : 'user',
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    })
  }
  return out
}

function readAnnotationFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return sanitizeAnnotations(data && data.items)
  } catch {
    return null
  }
}

function loadAnnotations(pdf) {
  const { primary, fallback } = annotationPaths(pdf)
  const fromPrimary = readAnnotationFile(primary)
  if (fromPrimary) return fromPrimary
  return readAnnotationFile(fallback) || []
}

function saveAnnotations(pdf, items) {
  const clean = sanitizeAnnotations(items)
  const payload = JSON.stringify({ version: 1, pdf: basename(pdf), updatedAt: Date.now(), items: clean }, null, 2)
  const { primary, fallback } = annotationPaths(pdf)
  try {
    writeFileSync(primary, payload, 'utf8')
    return { items: clean, path: primary }
  } catch {
    mkdirSync(dirname(fallback), { recursive: true })
    writeFileSync(fallback, payload, 'utf8')
    return { items: clean, path: fallback }
  }
}

function annotationsSummary(items) {
  return items.map((item) => ({
    id: item.id,
    page: item.page,
    quote: item.quote.slice(0, 200),
    note: item.note.slice(0, 300),
    color: item.color,
    author: item.author,
  }))
}

function rectsOverlap(a, b) {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5
}

// Annotations whose rectangles intersect one of the marquee regions. The
// marquee is an image-only question, so these are the only annotation facts
// that can travel with it: quote, note and colour per page.
function annotationsInRegions(items, regions) {
  const picked = []
  const seen = new Set()
  for (const region of regions) {
    const page = Number(region && region.page)
    const rect = Array.isArray(region && region.rect) ? region.rect.map(Number) : null
    if (!Number.isInteger(page) || page < 1 || !rect || rect.length !== 4 || rect.some((value) => !Number.isFinite(value))) {
      continue
    }
    for (const item of items) {
      if (item.page !== page || seen.has(item.id)) continue
      const hits = item.rects.filter((candidate) => rectsOverlap(candidate, rect))
      if (!hits.length) continue
      seen.add(item.id)
      picked.push({ ...item, hits })
      if (picked.length >= MAX_REGION_ANNOTATIONS) return picked
    }
  }
  return picked
}

// A saved answer keeps the reader's file-name freedom in check: no path
// separators, no Windows-reserved characters, and a bounded length.
function exportFileName(raw) {
  const cleaned = String(raw || '')
    .replace(/\.(md|txt|html)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim()
  return cleaned || '回答'
}

// Shared by the manual "保存回答" route and the save_file tool: both write a
// UTF-8 text file inside the workspace and never overwrite silently.
function saveExportFile(ctx, input) {
  const content = String((input && input.content) || '')
  if (!content.trim()) throw new Error('没有可保存的内容')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_EXPORT_BYTES) throw new Error('内容太大（上限 4MB）')
  const format = String((input && input.format) || 'md').toLowerCase().replace(/^\./, '')
  if (!EXPORT_FORMATS.has(format)) throw new Error('只支持 md / txt / html')
  const roots = allowedRoots(ctx)
  if (!roots.length) throw new Error('没有可写的目录')
  const requested = String((input && input.directory) || '').trim()
  const directory = !requested ? roots[0] : isAbsolute(requested) ? resolve(requested) : resolve(roots[0], requested)
  if (!roots.some((root) => inside(root, normalise(directory)))) throw new Error('保存目录不在工作区内')
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error('保存目录不存在：' + directory)
  const name = exportFileName(input && input.name)
  let target = join(directory, `${name}.${format}`)
  for (let index = 2; existsSync(target) && index < 100; index += 1) {
    target = join(directory, `${name} (${index}).${format}`)
  }
  if (existsSync(target)) throw new Error('同名文件太多，请换个文件名')
  writeFileSync(target, content, 'utf8')
  return { path: target, bytes, name: `${name}.${format}` }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
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

function browse(ctx, rawPath) {
  const roots = allowedRoots(ctx)
  if (!rawPath) {
    // The picker starts at "This PC": drive roots only, never a workspace folder.
    const drives = ALLOW_ANY_PATH ? listDrives() : []
    const entries = (drives.length ? drives : roots).map((root) => ({
      name: drives.length ? root : basename(root) || root,
      path: root,
      root: true,
    }))
    return {
      path: '',
      roots,
      parent: null,
      dirs: entries,
      pdfs: [],
    }
  }
  const path = resolve(rawPath)
  if (!ALLOW_ANY_PATH && !roots.some((root) => inside(root, normalise(path)))) throw new Error('路径不在工作区内')
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('目录不存在')
  const dirs = []
  const pdfs = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.pdf-reader') continue
    const full = join(path, entry.name)
    let info = null
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) dirs.push({ name: entry.name, path: full })
    else if (extname(entry.name).toLowerCase() === '.pdf') {
      pdfs.push({ name: entry.name, path: full, size: info.size, mtime: info.mtimeMs })
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  pdfs.sort((a, b) => a.name.localeCompare(b.name))
  const up = resolve(path, '..')
  const parent = ALLOW_ANY_PATH
    ? (up === path ? null : up)
    : roots.some((root) => normalise(path) !== root && inside(root, normalise(path)))
      ? up
      : null
  return { path, parent, roots, dirs, pdfs }
}

/** Drive roots ("C:\\") shown as the picker's starting points. */
function listDrives() {
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ':' + sep
    try {
      if (existsSync(root)) drives.push(root)
    } catch {}
  }
  return drives
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function modelSelection(ctx) {
  let provider = (process.env.PDF_READER_PROVIDER || '').trim()
  let model = (process.env.PDF_READER_MODEL || '').trim()
  let reasoningEffort = ''
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection) {
      provider = provider || selection.provider || selection.providerId || ''
      model = model || selection.model || selection.modelId || selection.id || ''
      reasoningEffort = selection.reasoningEffort || selection.effort || ''
    }
  } catch {}
  return { provider, model, reasoningEffort: reasoningEffort || undefined }
}

const modelInfoCache = new Map()
const catalogueCache = { at: 0, data: null }

async function resolveModelInfoCached(ctx, provider, model) {
  const key = `${provider}\u0000${model}`
  const cached = modelInfoCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.info
  const llm = ctx.get('llm')
  if (!llm) throw new Error('LLM service unavailable')
  const info = await llm.resolveModelInfo(provider, model)
  modelInfoCache.set(key, { at: Date.now(), info })
  return info
}

async function modelCatalogue(ctx) {
  const llm = ctx.get('llm')
  let groups = null
  let fallbackDefault = null
  try {
    const controller = ctx.get('sessionController')
    if (controller && typeof controller.modelCatalog === 'function') {
      const catalog = await controller.modelCatalog()
      if (catalog && Array.isArray(catalog.groups)) {
        groups = catalog.groups
        fallbackDefault = catalog.default || null
      }
    }
  } catch {}

  if (!groups) {
    if (!llm) return { providers: [], default: null }
    groups = []
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {}
      groups.push({ id: provider.id, name: provider.name || provider.id, models })
    }
  }

  const providers = []
  const failures = []
  for (const group of groups) {
    const entries = []
    for (const model of (group.models || []).slice(0, 40)) {
      let info = null
      try {
        info = llm ? await resolveModelInfoCached(ctx, group.id, model.id) : null
      } catch (error) {
        failures.push({ provider: group.id, model: model.id, error: error && error.message ? error.message : String(error) })
      }
      const reasoning = model.reasoning || (info && info.reasoning) || null
      entries.push({
        provider: group.id,
        id: model.id,
        name: model.name || (info && info.name) || model.id,
        description: model.description,
        modalities: info && Array.isArray(info.inputModalities) ? info.inputModalities : null,
        reasoning: reasoning
          ? {
              defaultEffort: reasoning.defaultEffort || null,
              efforts: (reasoning.efforts || []).map((effort) => ({
                id: effort.id,
                name: effort.name || effort.id,
                description: effort.description,
              })),
            }
          : null,
      })
    }
    providers.push({ id: group.id, name: group.name || group.id, models: entries })
  }
  return { providers, default: fallbackDefault, failures }
}

// "把……输出为一份文件" does not always survive as a tool call, so nudge the
// model explicitly whenever the question asks for a file.
function wantsFileOutput(question) {
  const text = String(question || '')
  return (
    /(输出|导出|保存|生成|写成|整理成|整理为)[^。；;\n]{0,20}(文件|文档|md|markdown|txt|html)/i.test(text) ||
    /(文件|文档|md|markdown|txt|html)[^。；;\n]{0,20}(输出|导出|保存|生成)/i.test(text)
  )
}

function buildPrompt(input) {
  const selection = String(input.selection || '').slice(0, MAX_SELECTION).trim()
  const question = String(input.question || '').trim()
  const fileHint = wantsFileOutput(question)
  const currentPage = Number(input.page) || 1
  const history = Array.isArray(input.history) ? input.history.slice(-8) : []
  const historyText = history
    .map((turn) => {
      const text = String((turn && turn.text) || '').slice(0, 400)
      if (turn && turn.role === 'assistant') return `助手：${text}`
      const page = Number(turn && turn.page)
      return page ? `读者（第 ${page} 页）：${text}` : `读者：${text}`
    })
    .join('\n')
    .slice(-MAX_HISTORY)

  const providedPages = Array.isArray(input.pages)
  const requested = providedPages
    ? input.pages
        .map((row) => ({ page: Number(row && row.page), text: String((row && row.text) || '').trim() }))
        .filter((row) => Number.isFinite(row.page) && row.page >= 1)
        .slice(0, 6)
    : []
  // An explicit empty `pages` array means "no page text on purpose" (e.g. a
  // quote-only question); only legacy callers without `pages` fall back.
  const source = requested.length ? requested : providedPages ? [] : [{ page: currentPage, text: String(input.pageText || '').trim() }]

  // A marquee question is deliberately image-only: no text is extracted from it.
  if (input.imageOnly) {
    const regionNotes = Array.isArray(input.regionAnnotations)
      ? input.regionAnnotations
          .map((item) => ({
            page: Number(item && item.page),
            color: ANNOTATION_COLORS.includes(item && item.color) ? item.color : 'yellow',
            quote: String((item && item.quote) || '').slice(0, 300),
            note: String((item && item.note) || '').slice(0, 300),
          }))
          .filter((item) => Number.isInteger(item.page) && item.page >= 1)
          .slice(0, MAX_REGION_ANNOTATIONS)
      : []
    const imageParts = []
    imageParts.push(`【文档】${input.title || 'PDF'}（当前第 ${currentPage} 页 / 共 ${input.count || '?'} 页）`)
    imageParts.push(
      regionNotes.length
        ? `【图像】随消息附上了 ${Number(input.imageCount) || 1} 张图片（框选或附件），这是本次提问的主要依据，没有提供页面文字。框选范围内的读者高亮已按原色画进图片（半透明色块），对应的原文与备注见下。请先描述你从图中看到的关键信息，再回答问题；图片模糊或信息不足时如实说明。`
        : `【图像】随消息附上了 ${Number(input.imageCount) || 1} 张图片（框选或附件），这是本次提问的唯一依据，没有提供页面文字。请先描述你从图中看到的关键信息，再回答问题；图片模糊或信息不足时如实说明。`,
    )
    if (regionNotes.length) {
      const lines = regionNotes.map((item) => {
        const color = ANNOTATION_COLOR_NAMES[item.color] || item.color
        const quote = item.quote ? `原文「${item.quote}」` : '只做了高亮，没有原文'
        const note = item.note ? `；备注：${item.note}` : ''
        return `- 第 ${item.page} 页 · ${color}高亮 · ${quote}${note}`
      })
      imageParts.push(`【框选范围内的读者标注】\n${lines.join('\n')}`)
    }
    if (fileHint) {
      imageParts.push('【提示】用户这次要求把内容输出为文件：调用 save_file，content 放整理好的完整正文（不是摘要），保存后告诉用户文件在哪里。')
    }
    if (historyText) imageParts.push(`【这篇文档此前的对话】（整篇共用，括号里是提问时所在的页码）\n${historyText}`)
    imageParts.push(`【问题】\n${question}`)
    return imageParts.join('\n\n')
  }

  let budget = MAX_PAGE_TEXT
  const blocks = []
  for (const row of source) {
    if (budget <= 0) break
    const text = row.text.slice(0, Math.min(MAX_PAGE_BLOCK, budget))
    budget -= text.length
    blocks.push({ page: row.page, text })
  }

  const parts = []
  parts.push(
    `【文档】${input.title || 'PDF'}（当前第 ${currentPage} 页 / 共 ${input.count || '?'} 页${blocks.length > 1 ? `；本次提问涉及 ${blocks.length} 页` : ''}）`,
  )
  if (Number(input.imageCount) > 0) {
    parts.push(`【图像】随消息附上了 ${Number(input.imageCount)} 张图片，请结合图片内容回答。`)
  }
  for (const block of blocks) {
    parts.push(`【第 ${block.page} 页原文】\n${block.text || '（这一页没有可提取的文字，可能是扫描件或图片页）'}`)
  }
  if (selection) {
    const selectionPages = Array.isArray(input.selectionPages)
      ? input.selectionPages.map(Number).filter((number) => Number.isInteger(number) && number >= 1).slice(0, 6)
      : []
    const pageLabel = selectionPages.length
      ? `（第 ${selectionPages.length > 1 ? `${selectionPages[0]}–${selectionPages[selectionPages.length - 1]}` : selectionPages[0]} 页）`
      : ''
    parts.push(`【用户选中的原文${pageLabel}】\n「${selection}」`)
  } else if (!blocks.length) {
    parts.push(
      `【提示】用户这次没有选中文字。需要原文时用 read_pages 查阅（当前第 ${currentPage} 页或相邻页），或先 search_document 检索；不要要求用户手动翻页或粘贴原文。`,
    )
  }
  if (fileHint) {
    parts.push('【提示】用户这次要求把内容输出为文件：调用 save_file，content 放整理好的完整正文（不是摘要，也不要在回答里重复全文），保存后告诉用户文件在哪里。')
  }
  if (historyText) parts.push(`【这篇文档此前的对话】（整篇共用，括号里是提问时所在的页码）\n${historyText}`)
  parts.push(`【问题】\n${question}`)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Agent-backed conversations
//
// Every PDF gets its own hidden home directory (`docs/<hash>/`) that is used as
// the agent's cwd; the PDF itself is never copied. One conversation = one agent
// session (`pdfr-<hash>-<id>`), so DSH keeps the history and the plugin only
// forwards prompts and stream events.
// ---------------------------------------------------------------------------

/** sessionId -> { handle, pdf, dir, sink } */
const agentSessions = new Map()
/** sessionId -> true while a prompt is streaming */
const agentBusy = new Set()

const SESSION_ID_PATTERN = /^pdfr-[a-z0-9-]{8,80}$/

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

function newSessionId(pdf) {
  return `pdfr-${docHash(pdf)}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function docHash(pdf) {
  return createHash('sha256').update(String(pdf).toLowerCase()).digest('hex').slice(0, 16)
}

function docRoot(ctx) {
  const roots = allowedRoots(ctx)
  return roots[0] || process.cwd()
}

/** Hidden per-PDF home directory; it is the agent's cwd and holds a path pointer. */
function docWorkspaceDir(ctx, pdf) {
  const dir = join(docRoot(ctx), '.pdf-reader', 'docs', docHash(pdf))
  mkdirSync(dir, { recursive: true })
  const metaPath = join(dir, 'document.json')
  let meta = null
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {}
  const current = meta && meta.path === pdf ? meta : null
  let size = current ? current.size : 0
  let mtime = current ? current.mtime : Date.now()
  try {
    if (!current) {
      const info = statSync(pdf)
      size = info.size
      mtime = info.mtimeMs
    }
  } catch {}
  const next = {
    path: pdf,
    title: current && current.title ? current.title : basename(pdf).replace(/\.pdf$/i, ''),
    size,
    mtime,
    updatedAt: Date.now(),
  }
  if (!current || next.title !== current.title) {
    try {
      writeFileSync(metaPath, JSON.stringify(next, null, 2))
    } catch {}
  }
  return dir
}

/** Turn a tool result into the model-facing content block list. */
function toolOutputContent(text) {
  return [{ type: 'text', text: String(text || '') }]
}

function registerPdfTools(agentCtx, ctx, sessionId) {
  for (const schema of TOOL_SCHEMAS) {
    agentCtx.tools.register({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'model-facing tool result text' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args, value) => toolOutputContent(value && typeof value.text === 'string' ? value.text : ''),
      },
      execute: async (args) => {
        const entry = agentSessions.get(sessionId)
        if (!entry) throw new Error('会话已关闭')
        const sink = entry.sink
        const call = { name: schema.name, arguments: JSON.stringify(args || {}) }
        if (sink) sink.tool(toolLabel(call))
        const result = await executeTool(ctx, { path: entry.pdf }, call, () => {
          if (sink) sink.annotations()
        })
        if (result.file && sink) sink.file(result.file)
        if (result.isError) throw new Error(result.text)
        return { text: result.text }
      },
    })
  }
}

function setupAgent(agentCtx, ctx, sessionId, pdf) {
  agentCtx.systemPrompt.section({ name: 'pdf-reader', order: 820, text: SYSTEM_PROMPT })
  registerPdfTools(agentCtx, ctx, sessionId)
  // Keep the agent to read-only workspace tools; the PDF tools above stay
  // visible because they are scoped registrations.
  try {
    const keep = new Set(['read', 'glob', 'grep'])
    const allow = agentCtx.tools
      .schemas()
      .map((schema) => schema.name)
      .filter((name) => keep.has(name))
    if (allow.length) agentCtx.tools.restrict({ allow })
  } catch {}
  agentCtx.on('agent/assistant-stream', (payload) => {
    const entry = agentSessions.get(sessionId)
    if (!entry || !entry.sink || !payload || !payload.frame) return
    entry.sink.frame(payload.frame)
  })
  // Record the concrete LLM failure (code/status) so a transport problem is
  // debuggable instead of only surfacing the adapter's generic message.
  agentCtx.on('agent/request-error', (payload, next) => {
    const entry = agentSessions.get(sessionId)
    if (entry) {
      try {
        appendFileSync(join(entry.dir, 'agent-errors.log'), `${JSON.stringify({ at: Date.now(), failure: payload && payload.failure })}\n`)
      } catch {}
      if (entry.sink && entry.sink.error && payload && payload.failure) entry.sink.error(payload.failure)
    }
    return next()
  })
}

async function ensureAgent(ctx, sessionId, pdf, agentOptions) {
  const agents = ctx.get('agents')
  const controller = ctx.get('sessionController')
  if (!agents || !controller) throw new Error('当前 Harness 没有 agent 服务')
  const live = agentSessions.get(sessionId)
  if (live && agents.get(sessionId)) return live
  const dir = docWorkspaceDir(ctx, pdf)
  const persistence = ctx.get('sessionPersistence')
  let stored = false
  try {
    stored = Boolean(persistence && (await persistence.stat(sessionId)))
  } catch {}
  if (!stored) {
    // A fresh conversation: create its Session with the PDF's own cwd so the
    // agent and its tools live inside that document's home directory.
    await controller.create({ sessionId, cwd: dir })
  }
  // resolveAgent resumes a stored session or activates the fresh one; unlike
  // agents.create this path dispatches model requests correctly.
  const resolved = await controller.resolveAgent(sessionId)
  const agent = resolved && resolved.agent
  if (!agent) {
    const detail = resolved && resolved.error
    throw new Error((detail && (detail.message || detail.code)) || '无法启动 PDF 对话 agent')
  }
  setupAgent(agent.ctx, ctx, sessionId, pdf)
  if (agentOptions && (agentOptions.provider || agentOptions.model)) {
    try {
      await controller.selectModel({
        sessionId,
        provider: agentOptions.provider || undefined,
        model: agentOptions.model || undefined,
        reasoningEffort: agentOptions.reasoningEffort || undefined,
      })
    } catch {}
  }
  const entry = { agent, sessionId, pdf, dir, sink: null }
  agentSessions.set(sessionId, entry)
  return entry
}

async function archiveAgentSession(ctx, sessionId) {
  const entry = agentSessions.get(sessionId)
  if (entry) {
    agentSessions.delete(sessionId)
    try {
      entry.agent.cancel({ kind: 'user' })
    } catch {}
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.archiveSession === 'function') {
    await registry.archiveSession(sessionId)
  }
}

/** Prompt text for one user turn; the agent already owns earlier history. */
function buildAgentPrompt(input) {
  const parts = []
  const currentPage = Number(input.page) || 1
  parts.push(`【文档】${input.title || 'PDF'}（当前第 ${currentPage} 页 / 共 ${input.count || '?'} 页）`)
  const selection = String(input.selection || '').slice(0, MAX_SELECTION).trim()
  const selectionPages = Array.isArray(input.selectionPages)
    ? input.selectionPages.map(Number).filter((page) => Number.isInteger(page) && page > 0).slice(0, 6)
    : []
  if (selection) {
    parts.push(`【用户选中的文字】${selectionPages.length ? `（第 ${selectionPages.join('、')} 页）` : ''}\n${selection}`)
  }
  if (input.imageOnly) {
    parts.push('【图像】这次提问的依据是随消息附带的图片（框选或附件），不提供页面文字。先说明你从图中读到的关键信息，再回答问题；信息不足时如实说明。')
  }
  const notes = Array.isArray(input.regionNotes) ? input.regionNotes.slice(0, MAX_REGION_ANNOTATIONS) : []
  if (notes.length) {
    const lines = notes.map((item) => {
      const color = ANNOTATION_COLOR_NAMES[item.color] || item.color
      const quote = item.quote ? `原文「${item.quote}」` : '只做了高亮，没有原文'
      const note = item.note ? `；备注：${item.note}` : ''
      return `- 第 ${item.page} 页 · ${color}高亮 · ${quote}${note}`
    })
    parts.push(`【框选范围内的读者标注】\n${lines.join('\n')}`)
  }
  if (!selection && !notes.length && !input.imageOnly) {
    parts.push('【提示】用户这次没有选中文字。需要原文时用 read_pages 查阅当前页或相邻页，或先 search_document 检索；不要要求用户手动翻页或粘贴原文。')
  }
  if (wantsFileOutput(String(input.question || ''))) {
    parts.push('【提示】用户这次要求输出文件：调用 save_file，content 放整理好的完整正文（不是摘要），保存后告诉用户文件在哪里。')
  }
  parts.push(`【问题】\n${String(input.question || '').trim()}`)
  return parts.join('\n\n')
}

/** Direct model loop used when the agent runtime cannot dispatch a request. */
async function runLegacyAsk(ctx, opts) {
  const { input, provider, model, reasoningEffort, res, controller, imageBlocks, regionNotes } = opts
  const llm = ctx.get('llm')
  const send = (event) => sendSse(res, event)
  const toolSchemas = input.imageOnly ? [SAVE_FILE_TOOL] : TOOL_SCHEMAS
  let messages = [
    {
      role: 'user',
      content: [
        ...(imageBlocks || []),
        { type: 'text', text: buildPrompt({ ...input, imageCount: (imageBlocks || []).length, regionAnnotations: regionNotes || [] }) },
      ],
    },
  ]
  let failure = null
  let answered = false
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const stream = llm.stream({ provider, model, reasoningEffort, system: SYSTEM_PROMPT, messages, tools: toolSchemas, signal: controller.signal })
    let text = ''
    let reasoning = ''
    const calls = new Map()
    let finish = null
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && chunk.text) {
        text += chunk.text
        send({ type: 'delta', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        reasoning += chunk.text
        send({ type: 'reasoning', text: chunk.text })
      } else if (chunk.type === 'tool-call-delta' && chunk.id) {
        const entry = calls.get(chunk.id) || { id: chunk.id, name: '', arguments: '' }
        if (chunk.name) entry.name = chunk.name
        entry.arguments += chunk.argumentsDelta || ''
        calls.set(chunk.id, entry)
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
        calls.set(chunk.block.id, { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments || '' })
      } else if (chunk.type === 'finish') {
        finish = chunk.reason || {}
      } else if (chunk.type === 'usage') {
        send({ type: 'usage', usage: chunk.usage })
      }
    }
    if (finish && finish.kind === 'error') {
      failure = (finish.failure && finish.failure.message) || '模型调用失败'
      break
    }
    if (finish && finish.kind === 'aborted') {
      if (!text) failure = '生成已取消'
      break
    }
    const toolCalls = [...calls.values()].filter((call) => call.name)
    if (!toolCalls.length) {
      answered = true
      break
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      send({ type: 'delta', text: '\n\n（已达到查阅次数上限，先按现有资料回答）' })
      answered = true
      break
    }
    const content = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    if (text) content.push({ type: 'text', text })
    for (const call of toolCalls) content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' })
    messages = [...messages, { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider, model }, content }]
    for (const call of toolCalls) {
      send({ type: 'tool', label: toolLabel(call) })
      let result
      try {
        result = await executeTool(ctx, input, call, () => send({ type: 'annotations' }))
      } catch (error) {
        result = { text: error && error.message ? error.message : String(error), isError: true }
      }
      if (result.file) send({ type: 'file', path: result.file.path, name: result.file.name })
      messages = [
        ...messages,
        {
          id: randomUUID(),
          role: 'tool',
          source: { kind: 'tool', callId: call.id },
          toolCallId: call.id,
          content: [{ type: 'text', text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        },
      ]
    }
  }
  if (failure) send({ type: 'error', message: failure })
  else if (!answered && !controller.signal.aborted) send({ type: 'error', message: '模型没有返回结果' })
  else if (!controller.signal.aborted) send({ type: 'done' })
}

/** One agent turn; reports whether it produced visible output. */
async function runAgentAsk(ctx, opts) {
  const { sessionId, pdf, input, provider, model, reasoningEffort, res, controller, imageBlocks, regionNotes } = opts
  const entry = await ensureAgent(ctx, sessionId, pdf, { provider, model, reasoningEffort })
  let textLength = 0
  let failure = null
  entry.sink = {
    frame(frame) {
      if (!frame || frame.type !== 'chunk' || !frame.chunk) return
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' && chunk.text) {
        textLength += chunk.text.length
        sendSse(res, { type: 'delta', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        sendSse(res, { type: 'reasoning', text: chunk.text })
      } else if (chunk.type === 'usage') {
        sendSse(res, { type: 'usage', usage: chunk.usage })
      }
    },
    tool(label) {
      sendSse(res, { type: 'tool', label })
    },
    file(file) {
      sendSse(res, { type: 'file', path: file.path, name: file.name })
    },
    annotations() {
      sendSse(res, { type: 'annotations' })
    },
    error(next) {
      failure = next
    },
  }
  const content = [...(imageBlocks || []), { type: 'text', text: buildAgentPrompt({ ...input, regionNotes }) }]
  const controllerSvc = ctx.get('sessionController')
  await controllerSvc.prompt(
    {
      sessionId,
      requestId: `pdfr-${randomUUID()}`,
      mode: 'queue',
      content,
    },
    controller.signal,
  )
  await entry.agent.whenIdle()
  try {
    const sessions = ctx.get('sessions')
    const live = sessions && sessions.get(sessionId)
    if (live) await sessions.flush(live)
  } catch {}

  if (failure) {
    const code = failure.code ? ` [${failure.code}${failure.status ? ` ${failure.status}` : ''}]` : ''
    return { ok: false, textLength, message: `${failure.message || '模型请求失败'}${code}` }
  }
  return { ok: true, textLength }
}
/** Open the native Windows "Open PDF" dialog and return the chosen path. */
function pickPdfFile() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, unavailable: true })
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    "$dialog.Title = '选择 PDF'",
    "$dialog.Filter = 'PDF 文件 (*.pdf)|*.pdf|所有文件 (*.*)|*.*'",
    '$dialog.CheckFileExists = $true',
    '$dialog.Multiselect = $false',
    '$result = $dialog.ShowDialog($owner)',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.FileName))) }',
  ].join('; ')
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      finish({ ok: false, error: '选择超时' })
    }, 300000)
    proc.stdout.on('data', (chunk) => {
      out += chunk
    })
    proc.stderr.on('data', (chunk) => {
      err += chunk
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, error: error.message })
    })
    proc.on('close', () => {
      clearTimeout(timer)
      const encodedPath = out.trim()
      let path = null
      try {
        if (encodedPath) path = Buffer.from(encodedPath, 'base64').toString('utf8')
      } catch {}
      finish({ ok: true, path, error: err ? err.slice(-300) : null })
    })
  })
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function route(ctx, req, res) {
  const url = new URL(req.url || PREFIX, 'http://127.0.0.1')
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname.replace(/^\//, '')
  const method = req.method || 'GET'

  const run = async () => {
    if (path === 'health') {
      const selection = modelSelection(ctx)
      let modalities = null
      let images = false
      try {
        const info = await ctx.get('llm')?.resolveModelInfo?.(selection.provider, selection.model)
        modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : null
        images = Boolean(modalities && modalities.includes('image'))
      } catch {}
      return sendJson(res, 200, {
        ok: true,
        python: workerState ? workerState.command : null,
        model: selection,
        images,
        modalities,
        roots: allowedRoots(ctx),
        llm: Boolean(ctx.get('llm')),
        stderr: workerState ? workerState.stderr.slice(-800) : '',
      })
    }

    if (path === 'models') {
      const refresh = url.searchParams.get('refresh') === '1'
      if (refresh || !catalogueCache.data || Date.now() - catalogueCache.at > 60 * 1000) {
        catalogueCache.data = await modelCatalogue(ctx)
        catalogueCache.at = Date.now()
      }
      return sendJson(res, 200, {
        ok: true,
        default: catalogueCache.data.default || modelSelection(ctx),
        providers: catalogueCache.data.providers,
        failures: catalogueCache.data.failures || [],
      })
    }

    if (path === 'browse') {
      return sendJson(res, 200, { ok: true, ...browse(ctx, url.searchParams.get('path')) })
    }

    if (path === 'info') {
      const pdf = resolvePdf(ctx, url.searchParams.get('path'))
      const reply = await workerCall('info', { path: pdf })
      if (!reply.ok) return sendJson(res, 400, reply)
      return sendJson(res, 200, reply)
    }

    if (path === 'page') {
      const pdf = resolvePdf(ctx, url.searchParams.get('path'))
      const page = Number(url.searchParams.get('page') || 1)
      const scale = Number(url.searchParams.get('scale') || 2)
      const reply = await workerCall('page', { path: pdf, page, scale }, 90000)
      if (!reply.ok) return sendJson(res, 400, reply)
      return sendJson(res, 200, reply)
    }

    if (path === 'annotations' && method === 'GET') {
      const pdf = resolvePdf(ctx, url.searchParams.get('path'))
      return sendJson(res, 200, { ok: true, items: loadAnnotations(pdf) })
    }

    if (path === 'annotations' && method === 'POST') {
      const input = await readJson(req)
      const pdf = resolvePdf(ctx, input.path)
      const saved = saveAnnotations(pdf, input.items)
      return sendJson(res, 200, { ok: true, ...saved })
    }

    if (path === 'export' && method === 'POST') {
      const input = await readJson(req)
      return sendJson(res, 200, { ok: true, ...saveExportFile(ctx, input) })
    }

    if (path === 'find') {
      const pdf = resolvePdf(ctx, url.searchParams.get('path'))
      const text = String(url.searchParams.get('text') || '').trim().slice(0, 300)
      if (!text) return sendJson(res, 400, { ok: false, error: '缺少要定位的文字' })
      const reply = await workerCall('find', { path: pdf, text }, 30000)
      if (!reply.ok) return sendJson(res, 400, reply)
      return sendJson(res, 200, reply)
    }

    if (path === 'import' && method === 'POST') {
      const raw = await readBody(req)
      if (raw.length < 5) throw new Error('文件为空')
      if (raw.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('不是 PDF 文件')
      const requested = String(url.searchParams.get('name') || 'document.pdf')
      const name = basename(requested).replace(/[^\w.\- ()（）\u4e00-\u9fff]+/g, '_').slice(0, 120) || 'document.pdf'
      const root = allowedRoots(ctx)[0]
      let targetDir = root && existsSync(root) ? join(root, '.pdf-reader') : join(tmpdir(), 'dsh-pdf-reader')
      let target = join(targetDir, name)
      try {
        mkdirSync(targetDir, { recursive: true })
        if (existsSync(target)) target = join(targetDir, `${Date.now()}-${name}`)
        writeFileSync(target, raw)
      } catch (error) {
        targetDir = join(tmpdir(), 'dsh-pdf-reader')
        mkdirSync(targetDir, { recursive: true })
        target = join(targetDir, `${Date.now()}-${name}`)
        writeFileSync(target, raw)
      }
      importedPaths.add(normalise(target))
      const reply = await workerCall('info', { path: target })
      return sendJson(res, reply.ok ? 200 : 400, { ...reply, path: target })
    }

    if (path === 'ask' && method === 'POST') {
      const input = await readJson(req)
      const question = String(input.question || '').trim()
      if (!question) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: '问题不能为空' }))
      }
      const llm = ctx.get('llm')
      const fallback = modelSelection(ctx)
      const provider = String(input.provider || '').trim() || fallback.provider
      const model = String(input.model || '').trim() || fallback.model
      const pdf = resolvePdf(ctx, input.path)
      const sessionId = isSessionId(input.sessionId) ? input.sessionId : newSessionId(pdf)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      if (!llm) {
        sendSse(res, { type: 'error', message: '当前 Harness 没有可用的 LLM 服务' })
        return res.end()
      }
      if (!provider || !model) {
        sendSse(res, { type: 'error', message: '没有可用的默认模型，请先在设置中选择模型' })
        return res.end()
      }
      let modelInfo = null
      try {
        modelInfo = await resolveModelInfoCached(ctx, provider, model)
      } catch (error) {
        sendSse(res, { type: 'error', message: `模型不可用：${provider}/${model}` })
        return res.end()
      }
      const requestedEffort = String(input.reasoningEffort || fallback.reasoningEffort || '').trim()
      const efforts = modelInfo && modelInfo.reasoning && Array.isArray(modelInfo.reasoning.efforts) ? modelInfo.reasoning.efforts : []
      const reasoningEffort = requestedEffort && efforts.some((effort) => effort.id === requestedEffort) ? requestedEffort : undefined
      let finished = false
      const controller = new AbortController()
      const abort = () => {
        if (finished) return
        controller.abort()
        const entry = agentSessions.get(sessionId)
        if (entry) {
          try {
            entry.agent.cancel({ kind: 'user' })
          } catch {}
        }
      }
      req.on('close', abort)
      res.on('close', abort)
      sendSse(res, {
        type: 'meta',
        sessionId,
        provider,
        model,
        effort: reasoningEffort || null,
        reasoning: efforts.length > 0,
        images: Boolean(modelInfo && Array.isArray(modelInfo.inputModalities) && modelInfo.inputModalities.includes('image')),
      })
      if (agentBusy.has(sessionId)) {
        sendSse(res, { type: 'error', message: '这个对话正在回答中，请等当前回答结束。' })
        return res.end()
      }
      let imageBlocks = []
      let regionNotes = []
      try {
        const requested = Array.isArray(input.images) ? input.images.slice(0, 3) : []
        const uploads = Array.isArray(input.uploads) ? input.uploads.slice(0, 3) : []
        if (requested.length || uploads.length) {
          const attachments = ctx.get('attachments')
          const supportsImages = Boolean(modelInfo && Array.isArray(modelInfo.inputModalities) && modelInfo.inputModalities.includes('image'))
          if (!supportsImages) {
            sendSse(res, { type: 'error', message: '当前模型不支持图片输入，请切换到支持视觉的模型，或只发送文字。' })
            return res.end()
          }
          if (!attachments) {
            sendSse(res, { type: 'error', message: '当前 Harness 没有附件服务，无法发送图片。' })
            return res.end()
          }
          for (const upload of uploads) {
            if (imageBlocks.length >= 4) break
            const encoded = typeof upload.data === 'string' ? upload.data : ''
            if (!encoded) continue
            const buffer = Buffer.from(encoded, 'base64')
            if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
              throw new Error('图片太大或为空（单张上限 6MB）')
            }
            const mediaType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(upload.mediaType) ? upload.mediaType : 'image/png'
            const reference = await attachments.saveImage({
              data: buffer,
              mediaType,
              name: String(upload.name || 'attachment.png').slice(0, 80),
            })
            imageBlocks.push({ type: 'image', attachment: reference })
          }
          // Annotations live in the sidecar file, not in the PDF itself, so
          // the raw raster never shows them. Pick the ones inside the marquee
          // and let the worker paint their colours back into the crop.
          const matched = requested.length ? annotationsInRegions(loadAnnotations(pdf), requested) : []
          regionNotes = matched.map((item) => ({
            page: item.page,
            color: item.color,
            quote: item.quote,
            note: item.note,
          }))
          for (const item of requested) {
            if (imageBlocks.length >= 4) break
            const page = Number(item && item.page)
            const rect = Array.isArray(item && item.rect) ? item.rect.map(Number) : null
            if (!page || !rect || rect.length !== 4 || rect.some((value) => !Number.isFinite(value))) continue
            const marks = matched
              .filter((entry) => entry.page === page)
              .flatMap((entry) =>
                entry.hits.map((hit) => ({ rect: hit, color: ANNOTATION_FILLS[entry.color] || ANNOTATION_FILLS.yellow })),
              )
              .slice(0, 80)
            const crop = await workerCall('crop', { path: pdf, page, rect, marks })
            if (!crop.ok) continue
            const reference = await attachments.saveImage({
              data: Buffer.from(crop.image, 'base64'),
              mediaType: 'image/png',
              name: `pdf-p${page}-region.png`,
            })
            imageBlocks.push({ type: 'image', attachment: reference })
          }
          if (!imageBlocks.length) {
            sendSse(res, { type: 'error', message: '图片无法读取，请重新添加或框选。' })
            return res.end()
          }
        }
      } catch (error) {
        sendSse(res, { type: 'error', message: error && error.message ? error.message : String(error) })
        return res.end()
      }
      agentBusy.add(sessionId)
      try {
        const result = await runAgentAsk(ctx, { sessionId, pdf, input, provider, model, reasoningEffort, res, controller, imageBlocks, regionNotes })
        if (result.ok) {
          if (!controller.signal.aborted) sendSse(res, { type: 'done' })
        } else if (result.textLength === 0 && !controller.signal.aborted) {
          // The agent runtime could not dispatch this request; keep the panel
          // usable with the direct model loop (see agent-errors.log).
          await runLegacyAsk(ctx, { input, pdf, provider, model, reasoningEffort, res, controller, imageBlocks, regionNotes })
        } else if (!controller.signal.aborted) {
          sendSse(res, { type: 'error', message: result.message || '模型请求失败' })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          sendSse(res, { type: 'error', message: error && error.message ? error.message : String(error) })
        }
      } finally {
        finished = true
        const entry = agentSessions.get(sessionId)
        if (entry) entry.sink = null
        agentBusy.delete(sessionId)
        req.off('close', abort)
        res.off('close', abort)
        res.end()
      }
      return
    }

    if (path === 'pick-file' && method === 'GET') {
      if (url.searchParams.get('dry') === '1') return sendJson(res, 200, { ok: true, dry: true })
      const result = await pickPdfFile()
      return sendJson(res, 200, result)
    }
    if (path === 'agent/archive' && method === 'POST') {
      const input = await readJson(req)
      const ids = (Array.isArray(input.sessionIds) ? input.sessionIds : [input.sessionId]).filter(isSessionId).slice(0, 24)
      if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少会话 id' })
      const archived = []
      for (const id of ids) {
        try {
          await archiveAgentSession(ctx, id)
          archived.push(id)
        } catch {}
      }
      return sendJson(res, 200, { ok: true, archived })
    }

    sendJson(res, 404, { ok: false, error: '未知的 PDF 阅读器接口' })
  }

  run().catch((error) => {
    if (res.headersSent) {
      try {
        sendSse(res, { type: 'error', message: error.message || String(error) })
        res.end()
      } catch {}
      return
    }
    sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
  })
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => route(ctx, req, res) }))
  ctx.effect(() => () => {
    const state = workerState
    workerState = null
    if (state) {
      try { state.proc.kill() } catch {}
    }
  })
}
