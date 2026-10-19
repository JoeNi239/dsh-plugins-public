/**
 * Trade-practice agent manager.
 *
 * Owns the plugin-private history index, the single active agent for the panel,
 * scoped drawing/data tools, the browser tool bridge, and agent event fan-out.
 * Sessions are ordinary DSH Agent sessions, but they are indexed here and kept
 * out of the main session grouping by archiving them while idle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DRAWING_TOOLS, executeDrawingTool } from './drawingTools.js'
import { createBarsTool } from './chartDataTools.js'
import { defineTextTool } from './toolDefs.js'

const INDEX_VERSION = 1
const COMMAND_TIMEOUT_MS = 8000
const RULES_SECTION_ORDER = 8000

const AGENT_RULES = [
  '你是交易练习面板里的图表分析 agent，运行在逐 K 回放或历史看盘图表旁边。',
  '你可以分析当前视图之前的历史，也可以调用 get_bars 换周期观察；引用任何周期结论时必须写明周期和数据截止时间。',
  '练习模式只能看到回放截止时间（cutoff）之前的数据。绝不能读取、搜索或推测 cutoff 之后的行情；不要请求未来时间。',
  '用户问“当前行情/当前结构”时，以本条消息的【当前视图】为准；历史上下文只用于结构分析，不能用旧范围冒充当前。',
  '画线必须调用 add_drawing / delete_drawing / clear_drawings 在图表上真正画出；坐标不能超过 cutoff，画线锚点尽量落在当前视图内。',
  '分析用户画线时，结合附图（截图中包含画线覆盖层）和结构化锚点；区分“用户画线”和“AI 画线”，不要混淆。',
  '练习模式禁用联网（web_search/web_fetch 会被拦截）；普通模式可用联网查询，但网页信息必须标注来源，并与图上历史数据区分。',
  '只画必要对象（1–3 个），不要主动删除或清空用户画线；工具失败时按错误提示修正后再试。',
].join('\n')

/**
 * Titles older versions wrote eagerly at creation:
 * `交易练习 · XAUUSD · 2026/10/20 01:21:53`. They are not names the session
 * earned from a prompt, so they are treated as "unnamed".
 */
const LEGACY_AUTO_TITLE = /^交易练习\s*·.*·\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$/

/**
 * A DSH session title is the first words of the first human message. The panel
 * sends the whole chart context as that message, so the plugin names the fresh
 * session from the user's actual question instead, using the same shape as the
 * host fallback (five words, 40 UTF-8 bytes).
 */
const TITLE_MAX_WORDS = 5
const TITLE_MAX_BYTES = 40

function truncateTitleUtf8(text, maxBytes) {
  let used = 0
  let out = ''
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maxBytes) break
    used += size
    out += character
  }
  return out.trimEnd()
}

export function deriveTitle(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return truncateTitleUtf8(line.split(' ').filter(Boolean).slice(0, TITLE_MAX_WORDS).join(' '), TITLE_MAX_BYTES)
}

function normaliseEntry(value) {
  if (!value || typeof value !== 'object') return null
  const id = typeof value.id === 'string' ? value.id : ''
  if (!id) return null
  const storedTitle = typeof value.title === 'string' ? value.title.trim() : ''
  return {
    id,
    // A session is unnamed until the host title service derives a title from
    // its first human message; a timestamp is never used as a fallback name.
    title: storedTitle && !LEGACY_AUTO_TITLE.test(storedTitle) ? storedTitle : '',
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
    symbol: typeof value.symbol === 'string' ? value.symbol : '',
    archived: value.archived === true,
  }
}

export class AgentManager {
  /**
   * @param {object} options
   * @param {object} options.ctx - plugin Cordis context
   * @param {string | (() => string)} options.root - `<workspace>/.trade-practice`;
   *   a function is resolved lazily so a root captured before the workspace
   *   registry has initialized cannot strand the index in another directory
   * @param {() => string} options.dataRoot - CSV data root
   */
  constructor({ ctx, root, dataRoot }) {
    this.ctx = ctx
    this.rootSource = root
    this.dataRoot = dataRoot
    this.entries = []
    this.activeId = null
    this.activeHandle = null
    this.states = new Map()
    this.connections = new Map()
    this.pending = new Map()
    this.loaded = false
    this.bootCleaned = false
    this.bootstrapPromise = null
    this.streamDisposers = []
    this.closed = false
    this.barsTool = createBarsTool({
      dataRoot: () => this.dataRoot(),
      stateFor: (sessionId) => this.states.get(sessionId),
    })
    this.drawingTools = DRAWING_TOOLS.map((schema) => defineTextTool({
      name: schema.name,
      description: `${schema.description} 时间不得超过当前回放截止时间；画线锚点尽量落在当前视图内。`,
      parameters: schema.parameters,
      timeoutMs: 15000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.session?.id
        const state = sessionId ? this.states.get(sessionId) : null
        if (!state) throw new Error('缺少当前图表上下文，请先发送一条问题。')
        const outcome = executeDrawingTool(schema.name, args, state)
        if (!outcome.ok) throw new Error(outcome.message)
        await this.sendDrawing(sessionId, outcome.command)
        return outcome.message
      },
    }))
  }

  get agentLoop() {
    return this.ctx.get('agentLoop')
  }

  /** Resolve the plugin state directory on every use, not once at apply time. */
  get root() {
    return typeof this.rootSource === 'function' ? this.rootSource() : this.rootSource
  }

  get indexPath() {
    return join(this.root, 'agents.json')
  }

  get registry() {
    return this.ctx.get('workspaceRegistry')
  }

  get available() {
    return Boolean(this.agentLoop)
  }

  /** Register agent event fan-out once at plugin start. */
  attach() {
    const onFrame = ({ agent, frame }) => {
      if (!agent || agent.id !== this.activeId) return
      this.broadcast(agent.session.id, { type: 'assistant', frame })
    }
    const onStatus = ({ agent, status }) => {
      if (!agent || agent.id !== this.activeId) return
      this.broadcast(agent.session.id, { type: 'status', status })
    }
    const onSessionEvent = (session, event) => {
      if (!session) return
      if (event.type === 'session/title') {
        this.applyTitle(session.id, event.data?.title)
        return
      }
      if (session.id !== this.activeId) return
      if (event.type === 'tool/call') {
        this.broadcast(session.id, {
          type: 'tool',
          phase: 'call',
          callId: event.data?.callId,
          name: event.data?.name,
        })
      } else if (event.type === 'tool/result') {
        this.broadcast(session.id, {
          type: 'tool',
          phase: 'result',
          callId: event.data?.message?.toolCallId,
          isError: event.data?.message?.isError === true,
        })
      } else if (event.type === 'assistant/message') {
        const message = event.data?.message
        const text = (message?.content || [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text) this.broadcast(session.id, { type: 'assistant-message', text })
      }
    }
    this.streamDisposers.push(
      this.ctx.on('agent/assistant-stream', onFrame),
      this.ctx.on('agent/status', onStatus),
      this.ctx.on('session/event', onSessionEvent),
    )
  }

  loadIndex() {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.indexPath)) return
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      this.entries = Array.isArray(parsed.agents)
        ? parsed.agents.map(normaliseEntry).filter(Boolean)
        : []
    } catch {
      this.entries = []
    }
  }

  saveIndex() {
    if (this.closed) return
    try {
      mkdirSync(this.root, { recursive: true })
      writeFileSync(this.indexPath, JSON.stringify({
        version: INDEX_VERSION,
        activeId: this.activeId,
        agents: this.entries,
      }, null, 2))
    } catch (error) {
      this.ctx.logger?.warn?.(`trade-practice: agent index save failed: ${error.message || error}`)
    }
  }

  entryFor(id) {
    return this.entries.find((entry) => entry.id === id) || null
  }

  /** Latest title accepted by the host title service for a live session, or ''. */
  titleOf(session) {
    if (!session) return ''
    try {
      const titles = this.ctx.get('sessionTitle')
      const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined
      return typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * Mirror a host-derived session title into the plugin index. Titles arrive
   * only after the first human message (same as ordinary DSH sessions), so an
   * agent created from the panel stays unnamed until then.
   */
  applyTitle(sessionId, rawTitle) {
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
    if (!sessionId || !title) return
    const entry = this.entryFor(sessionId)
    if (!entry || entry.title === title) return
    entry.title = title
    this.saveIndex()
    this.broadcast(sessionId, { type: 'title', sessionId, title })
  }

  /** Adopt the stored title of a session that was just resumed. */
  syncTitle(session) {
    if (!session) return
    this.applyTitle(session.id, this.titleOf(session))
  }

  /**
   * Name a still-unnamed session after the question that just opened it. The
   * host's own fallback would read the injected chart context, so the plugin
   * writes the title itself; later user renames still arrive as title events.
   */
  nameSession(session, question) {
    if (!session || this.titleOf(session)) return
    const title = deriveTitle(question)
    if (!title) return
    try {
      const titles = this.ctx.get('sessionTitle')
      if (!titles || typeof titles.rename !== 'function') return
      titles.rename(session, title)
      this.applyTitle(session.id, this.titleOf(session) || title)
    } catch (error) {
      this.ctx.logger?.warn?.(`trade-practice: naming ${session.id} failed: ${error.message || error}`)
    }
  }

  touch(id) {
    const entry = this.entryFor(id)
    if (!entry) return
    entry.updatedAt = Date.now()
    this.saveIndex()
  }

  async archiveSession(id, entry) {
    try {
      if (this.registry && typeof this.registry.archiveSession === 'function') {
        await this.registry.archiveSession(id, { stopActivity: true })
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`trade-practice: archive ${id} failed: ${error.message || error}`)
    }
    if (entry) entry.archived = true
  }

  async unarchiveSession(id, entry) {
    try {
      if (this.registry && typeof this.registry.unarchiveSession === 'function') {
        await this.registry.unarchiveSession(id)
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`trade-practice: unarchive ${id} failed: ${error.message || error}`)
    }
    if (entry) entry.archived = false
  }

  async disposeActive() {
    const handle = this.activeHandle
    this.activeHandle = null
    if (!handle) return
    try {
      handle.agent?.cancel?.({ kind: 'disposed' })
    } catch {}
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger?.warn?.(`trade-practice: agent dispose failed: ${error.message || error}`)
    }
  }

  setupAgent(agentCtx) {
    for (const tool of this.drawingTools) agentCtx.tools.register(tool)
    agentCtx.tools.register(this.barsTool)
    try {
      agentCtx.tools.restrict({ allow: ['web_search', 'web_fetch'] })
    } catch {
      try {
        agentCtx.tools.restrict({ allow: [] })
      } catch {}
    }
    agentCtx.tools.guard((exec) => {
      const sessionId = exec.agent?.session?.id
      const state = sessionId ? this.states.get(sessionId) : null
      if (state?.mode === 'practice' && (exec.name === 'web_search' || exec.name === 'web_fetch')) {
        return '练习模式禁用联网，避免看到回放截止时间之后的信息。'
      }
      return undefined
    })
    agentCtx.systemPrompt.section({
      name: 'trade-practice:rules',
      order: RULES_SECTION_ORDER,
      text: AGENT_RULES,
    })
  }

  async createAgent({ provider, model, reasoningEffort, symbol }) {
    const loop = this.agentLoop
    if (!loop) throw new Error('agentLoop 不可用')
    if (this.closed) throw new Error('插件已卸载')
    const sessionId = `tp-${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const agentOptions = {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
    const handle = await loop.createAgent(this.ctx, {
      sessionId,
      agentOptions,
      setup: (agentCtx) => this.setupAgent(agentCtx),
    })
    this.activeHandle = handle
    this.activeId = sessionId
    const entry = {
      id: sessionId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: provider || '',
      model: model || '',
      reasoningEffort: reasoningEffort || '',
      symbol: symbol || '',
      archived: false,
    }
    this.entries.unshift(entry)
    this.saveIndex()
    return this.snapshot()
  }

  async bootstrap({ provider, model, reasoningEffort, symbol }) {
    if (!this.available) return { available: false }
    this.loadIndex()
    // `ctx.agents` is a declared-inject service; reading the property without
    // declaring it throws. `ctx.get()` is the reflective accessor the rest of
    // this plugin already uses.
    const agents = this.ctx.get('agents')
    if (this.activeHandle && agents && typeof agents.get === 'function' && agents.get(this.activeId)) {
      return this.snapshot()
    }
    if (this.bootstrapPromise) return this.bootstrapPromise
    this.bootstrapPromise = (async () => {
      if (!this.bootCleaned) {
        this.bootCleaned = true
        for (const entry of [...this.entries]) await this.archiveSession(entry.id, entry)
        this.saveIndex()
      }
      return this.createAgent({ provider, model, reasoningEffort, symbol })
    })().finally(() => {
      this.bootstrapPromise = null
    })
    return this.bootstrapPromise
  }

  async switchTo(id) {
    this.loadIndex()
    const entry = this.entryFor(id)
    if (!entry) throw new Error('找不到该历史 agent')
    if (id === this.activeId && this.activeHandle) return this.snapshot()
    const previous = this.activeId
    await this.disposeActive()
    if (previous) await this.archiveSession(previous, this.entryFor(previous))
    await this.unarchiveSession(id, entry)
    const loop = this.agentLoop
    if (!loop) throw new Error('agentLoop 不可用')
    const handle = await loop.resume(this.ctx, {
      resumeSessionId: id,
      agentOptions: {
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      },
      setup: (agentCtx) => this.setupAgent(agentCtx),
    })
    this.activeHandle = handle
    this.activeId = id
    this.touch(id)
    this.syncTitle(handle.agent?.session)
    return this.snapshot()
  }

  async newAgent({ provider, model, reasoningEffort, symbol }) {
    const previous = this.activeId
    await this.disposeActive()
    if (previous) await this.archiveSession(previous, this.entryFor(previous))
    this.activeId = null
    return this.createAgent({ provider, model, reasoningEffort, symbol })
  }

  async deleteAgent(id) {
    this.loadIndex()
    const entry = this.entryFor(id)
    if (!entry) throw new Error('找不到该历史 agent')
    if (id === this.activeId) {
      await this.disposeActive()
      this.activeId = null
    }
    await this.archiveSession(id, entry)
    this.entries = this.entries.filter((item) => item.id !== id)
    this.saveIndex()
    return this.snapshot()
  }

  snapshot() {
    // Titles can land after an event was missed (or after switching); the live
    // session is the source of truth, so pick it up before listing agents.
    this.syncTitle(this.activeHandle?.agent?.session)
    return {
      available: this.available,
      activeId: this.activeId,
      status: this.activeHandle?.agent?.status || 'idle',
      agents: this.entries.map((entry) => ({ ...entry })),
    }
  }

  async sendPrompt({ text, imageRef, state }) {
    const handle = this.activeHandle
    if (!handle) throw new Error('没有活跃的 agent，请先新建')
    const agent = handle.agent
    if (agent.status === 'running') {
      const error = new Error('agent 正在运行，请等它完成')
      error.code = 'AGENT_BUSY'
      throw error
    }
    const sessionId = agent.session.id
    this.states.set(sessionId, { ...state })
    const content = []
    if (imageRef) content.push({ type: 'image', attachment: imageRef })
    content.push({ type: 'text', text: String(text || '') })
    agent.followup({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user', displayText: String(state?.question || '') },
      content,
    })
    this.nameSession(agent.session, state?.question)
    this.touch(sessionId)
  }

  /** Read a compact transcript from the live session for the panel. */
  history(sessionId) {
    const sessions = this.ctx.get('sessions')
    const session = (sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null)
      || (this.activeId === sessionId ? this.activeHandle?.agent?.session : null)
    if (!session || typeof session.snapshotEvents !== 'function') return []
    let events = []
    try {
      events = session.snapshotEvents()
    } catch {
      return []
    }
    const order = []
    const byId = new Map()
    const push = (id, role, text) => {
      if (!text) return
      if (!byId.has(id)) order.push(id)
      byId.set(id, { role, text })
    }
    for (const event of events) {
      if (!event || !event.data) continue
      if (event.type === 'user/message') {
        const message = event.data
        if (message.source?.kind !== 'user') continue
        const text = typeof message.source?.displayText === 'string' && message.source.displayText
          ? message.source.displayText
          : (message.content || [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
            .trim()
        push(message.id, 'user', text)
      } else if (event.type === 'assistant/message') {
        const message = event.data.message
        if (!message) continue
        const text = (message.content || [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        push(message.id, 'assistant', text)
      }
    }
    return order.map((id) => byId.get(id))
  }

  addConnection(sessionId, res) {
    let set = this.connections.get(sessionId)
    if (!set) {
      set = new Set()
      this.connections.set(sessionId, set)
    }
    set.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {}
    }, 15000)
    ping.unref?.()
    const cleanup = () => {
      clearInterval(ping)
      const current = this.connections.get(sessionId)
      if (!current) return
      current.delete(res)
      if (current.size === 0) this.connections.delete(sessionId)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
    return cleanup
  }

  broadcast(sessionId, event) {
    const set = this.connections.get(sessionId)
    if (!set || set.size === 0) return
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const res of [...set]) {
      try {
        if (!res.writableEnded) res.write(line)
      } catch {}
    }
  }

  async sendDrawing(sessionId, command) {
    const set = this.connections.get(sessionId)
    if (!set || set.size === 0) throw new Error('图表未连接，无法画线；请保持交易练习面板打开。')
    const commandId = `cmd_${randomUUID()}`
    const line = `data: ${JSON.stringify({ type: 'drawing', commandId, command })}\n\n`
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(new Error('画线命令超时，浏览器没有确认。'))
      }, COMMAND_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(commandId, { resolve, reject, timer, sessionId })
    })
    for (const res of [...set]) {
      try {
        if (!res.writableEnded) res.write(line)
      } catch {}
    }
    return promise
  }

  ack(commandId, ok, message) {
    const pending = this.pending.get(commandId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(commandId)
    if (ok) pending.resolve(true)
    else pending.reject(new Error(message || '画线命令被浏览器拒绝'))
    return true
  }

  dispose() {
    this.closed = true
    for (const dispose of this.streamDisposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('插件正在卸载'))
    }
    this.pending.clear()
    for (const set of this.connections.values()) {
      for (const res of set) {
        try {
          res.end()
        } catch {}
      }
    }
    this.connections.clear()
    this.disposeActive().catch(() => {})
  }
}
