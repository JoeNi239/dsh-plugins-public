window.__ModuleLoader__.load({
  id: '@local/pdf-reader',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo } = React
    const h = React.createElement

    // ---------------------------------------------------------------------
    // Localised copy
    // ---------------------------------------------------------------------

    const ZH = {
      panelTitle: 'PDF 阅读',
      open: '打开 PDF',
      emptyTitle: '把 PDF 拖到这里',
      emptyHint: '左边读一页，右边是整篇共用的对话；选中原文就能直接追问。',
      recent: '最近打开',
      drop: '松开即可打开',
      page: '页',
      prev: '上一页',
      next: '下一页',
      fit: '适应宽度',
      zoomIn: '放大',
      zoomOut: '缩小',
      ask: '提问',
      askPlaceholder: '输入问题，Enter 发送，Shift+Enter 换行',
      quote: '引用',
      clearThread: '清空本页对话',
      thinking: '正在阅读这一页…',
      stop: '停止',
      emptyThread: '还没有对话',
      emptyThreadHint: '试一个：',
      selectHint: '选中页面上的文字，可以就这段直接提问',
      summarize: '总结本页',
      outline: '要点清单',
      translate: '翻译本页',
      explain: '解释这段',
      askAbout: '问这段',
      explainShort: '解释',
      translateShort: '翻译',
      pathHint: '也可以直接输入 PDF 的完整路径',
      up: '上一级',
      cancel: '取消',
      loading: '正在渲染…',
      noText: '本页没有可提取的文字，可能是扫描页',
      failed: '出错了',
      copied: '已复制',
      copy: '复制',
      retry: '重试',
      regen: '重新回答',
      model: '模型',
      pageLabel: '第 {n} 页',
      of: '/ {n}',
    }
    const EN = {
      panelTitle: 'PDF Reader',
      open: 'Open PDF',
      emptyTitle: 'Drop a PDF here',
      emptyHint: 'One page on the left, one conversation on the right. Select text to ask about it.',
      recent: 'Recently opened',
      drop: 'Drop to open',
      page: 'page',
      prev: 'Previous page',
      next: 'Next page',
      fit: 'Fit width',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      ask: 'Ask',
      askPlaceholder: 'Ask about this page. Enter to send, Shift+Enter for a new line',
      quote: 'Quote',
      clearThread: 'Clear this page’s thread',
      thinking: 'Reading this page…',
      stop: 'Stop',
      emptyThread: 'No conversation on this page yet',
      emptyThreadHint: 'Try:',
      selectHint: 'Select text on the page to ask about it',
      summarize: 'Summarize',
      outline: 'Key points',
      translate: 'Translate',
      explain: 'Explain',
      askAbout: 'Ask about this',
      explainShort: 'Explain',
      translateShort: 'Translate',
      pathHint: 'Or paste the full path of a PDF',
      up: 'Up',
      cancel: 'Cancel',
      loading: 'Rendering…',
      noText: 'No extractable text on this page (possibly scanned)',
      failed: 'Something went wrong',
      copied: 'Copied',
      copy: 'Copy',
      retry: 'Retry',
      regen: 'Regenerate',
      model: 'Model',
      pageLabel: 'Page {n}',
      of: '/ {n}',
    }

    // ---------------------------------------------------------------------
    // API
    // ---------------------------------------------------------------------

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    const api = {
      browse(path) {
        const suffix = path ? `?path=${encodeURIComponent(path)}` : ''
        return getJson(`/pdf-reader/browse${suffix}`)
      },
      info(path) {
        return getJson(`/pdf-reader/info?path=${encodeURIComponent(path)}`)
      },
      page(path, page, scale) {
        return getJson(`/pdf-reader/page?path=${encodeURIComponent(path)}&page=${page}&scale=${scale}`)
      },
      async importFile(file) {
        const response = await fetch(`/pdf-reader/import?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || payload.ok === false) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        return payload
      },
      pickFile() {
        return getJson('/pdf-reader/pick-file')
      },
      async archiveSessions(sessionIds) {
        const response = await fetch('/pdf-reader/agent/archive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || payload.ok === false) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        return payload
      },
      async ask(input, onEvent, signal) {
        const response = await fetch('/pdf-reader/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal,
        })
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => '')
          throw new Error(text || `HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const raw = line.slice(5).trim()
              if (!raw) continue
              try {
                onEvent(JSON.parse(raw))
              } catch {}
            }
          }
        }
      },
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    const STORAGE_KEY = 'dsh.pdf-reader.v1'
    const PAGE_CACHE_LIMIT = 24

    function readStore() {
      try {
        return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {}
      } catch {
        return {}
      }
    }

    function writeStore(patch) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStore(), ...patch }))
      } catch {}
    }

    function uid() {
      return Math.random().toString(36).slice(2) + Date.now().toString(36)
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function rectsOverlap(a, b) {
      return Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5
    }

    // Saving an answer keeps the reader's text as-is and adds just enough
    // provenance to find it again later.
    const EXPORT_FORMATS = [
      { id: 'md', label: '.md' },
      { id: 'txt', label: '.txt' },
      { id: 'html', label: '.html' },
    ]

    function exportNameFrom(text) {
      const line =
        String(text || '')
          .split('\n')
          .map((value) => value.replace(/^[#>*\-\s]+/, '').trim())
          .find(Boolean) || '回答'
      return line.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || '回答'
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (character) => {
        if (character === '&') return '&amp;'
        if (character === '<') return '&lt;'
        if (character === '>') return '&gt;'
        if (character === '"') return '&quot;'
        return '&#39;'
      })
    }

    function buildExportContent({ format, title, documentTitle, page, text, excerpt }) {
      const savedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const source = `《${documentTitle}》第 ${page} 页${excerpt ? ' · 节选' : ''}`
      if (format === 'txt') {
        return `${title}\n${source}\n保存时间：${savedAt}\n\n${'-'.repeat(24)}\n\n${text}\n`
      }
      if (format === 'html') {
        return [
          '<!doctype html>',
          '<html lang="zh-CN"><head><meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          `<title>${escapeHtml(title)}</title>`,
          '<style>',
          'body{margin:0 auto;padding:48px 24px 80px;max-width:760px;background:#fff;color:#1f2328;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
          'h1{font-size:24px;line-height:1.4;margin:0 0 10px}',
          '.meta{color:#6b7280;font-size:13px;margin-bottom:28px}',
          'pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}',
          '</style></head><body>',
          `<h1>${escapeHtml(title)}</h1>`,
          `<div class="meta">${escapeHtml(source)}<br>保存时间：${escapeHtml(savedAt)}</div>`,
          `<pre>${escapeHtml(text)}</pre>`,
          '</body></html>',
          '',
        ].join('\n')
      }
      return `# ${title}\n\n> ${source}  \n> 保存时间：${savedAt}\n\n${text}\n`
    }

    // Read a pasted/selected image, downscale it for the model, keep PNG pixels.
    function readImageFile(file, maxEdge = 1600) {
      return new Promise((resolvePromise, rejectPromise) => {
        const url = URL.createObjectURL(file)
        const image = new Image()
        image.onload = () => {
          const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
          const width = Math.max(1, Math.round(image.width * scale))
          const height = Math.max(1, Math.round(image.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0, width, height)
          URL.revokeObjectURL(url)
          resolvePromise({ dataUrl: canvas.toDataURL('image/png'), width, height })
        }
        image.onerror = (error) => {
          URL.revokeObjectURL(url)
          rejectPromise(error)
        }
        image.src = url
      })
    }

    function trimThread(messages) {
      const list = Array.isArray(messages) ? messages.slice(-40) : []
      return list.map((message) => ({ ...message, streaming: false }))
    }

    function conversationTitle(messages) {
      const first = (Array.isArray(messages) ? messages : []).find((message) => message && message.role === 'user' && message.text)
      if (!first) return ''
      const text = String(first.text).replace(/\s+/g, ' ').trim()
      return text.length > 26 ? `${text.slice(0, 26)}…` : text
    }

    function formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const now = new Date()
      const pad = (number) => String(number).padStart(2, '0')
      if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function conversationMeta(item) {
      const messages = Array.isArray(item.messages) ? item.messages : []
      const rounds = messages.filter((message) => message.role === 'user').length
      const pages = new Set(messages.map((message) => message.page).filter(Boolean)).size
      const time = formatTime(item.ts)
      return `${rounds} 轮${pages ? ` · ${pages} 页` : ''}${time ? ` · ${time}` : ''}`
    }

    // Threads are stored as `{ [path]: { active, items: [{ id, title, ts, messages }] } }`.
    // Conversations belong to the whole document; every message keeps the page it
    // was asked on. Older releases stored per-page conversations (and before that,
    // bare message arrays per page), so fold those into the document on load.
    function sanitizeConversations(items, active) {
      const clean = (Array.isArray(items) ? items : [])
        .filter((item) => item && Array.isArray(item.messages))
        .map((item) => ({
          id: item.id || uid(),
          // Agent-backed conversations carry the DSH session that owns history.
          sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
          title: item.title || conversationTitle(item.messages),
          ts: item.ts || Date.now(),
          messages: trimThread(item.messages),
        }))
        .filter((item) => item.messages.length || item.title)
      const chosen = clean.some((item) => item.id === active) ? active : clean[0] ? clean[0].id : null
      return { active: chosen, items: clean.slice(0, 12) }
    }

    function migrateThreads(raw) {
      const output = {}
      for (const [filePath, value] of Object.entries(raw || {})) {
        if (!value || typeof value !== 'object') continue
        if (Array.isArray(value.items)) {
          output[filePath] = sanitizeConversations(value.items, value.active)
          continue
        }
        const merged = []
        for (const [pageNumber, record] of Object.entries(value)) {
          const page = Number(pageNumber) || 1
          if (Array.isArray(record)) {
            const messages = trimThread(record).map((message) => ({ ...message, page: message.page || page }))
            if (messages.length) {
              merged.push({ id: uid(), title: conversationTitle(messages), ts: messages[0].ts || Date.now(), messages })
            }
            continue
          }
          if (!record || !Array.isArray(record.items)) continue
          for (const item of record.items) {
            const messages = trimThread(item.messages || []).map((message) => ({ ...message, page: message.page || page }))
            if (!messages.length) continue
            merged.push({ id: uid(), title: item.title || conversationTitle(messages), ts: item.ts || Date.now(), messages })
          }
        }
        merged.sort((a, b) => (b.ts || 0) - (a.ts || 0))
        output[filePath] = sanitizeConversations(merged, null)
      }
      return output
    }

    // ---------------------------------------------------------------------
    // Small presentational pieces
    // ---------------------------------------------------------------------

    function Icon({ name, size = 16 }) {
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }
      const paths = {
        book: [
          h('path', { key: 'a', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z' }),
          h('path', { key: 'b', d: 'M8 7h7M8 10.5h5' }),
        ],
        chat: [h('path', { key: 'a', d: 'M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7z' })],
        left: [h('path', { key: 'a', d: 'M14 6l-6 6 6 6' })],
        right: [h('path', { key: 'a', d: 'M10 6l6 6-6 6' })],
        plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
        minus: [h('path', { key: 'a', d: 'M5 12h14' })],
        send: [h('path', { key: 'a', d: 'M4 12l16-8-6 16-2.5-6.5z' })],
        folder: [h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })],
        file: [
          h('path', { key: 'a', d: 'M6 3h7l5 5v13H6z' }),
          h('path', { key: 'b', d: 'M13 3v5h5' }),
        ],
        close: [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })],
        copy: [
          h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
          h('path', { key: 'b', d: 'M5 15V5a2 2 0 0 1 2-2h8' }),
        ],
        spark: [h('path', { key: 'a', d: 'M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3z' })],
        image: [
          h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 14, rx: 2 }),
          h('circle', { key: 'b', cx: 8.5, cy: 10, r: 1.5 }),
          h('path', { key: 'c', d: 'M21 15.5L16.5 11 6 20' }),
        ],
        refresh: [h('path', { key: 'a', d: 'M4 10a8 8 0 1 1 2.5 8.5M4 4v6h6' })],
        trash: [
          h('path', { key: 'a', d: 'M4 7h16' }),
          h('path', { key: 'b', d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }),
          h('path', { key: 'c', d: 'M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12' }),
          h('path', { key: 'd', d: 'M10 11v6M14 11v6' }),
        ],
      }
      return h('svg', common, paths[name] || paths.file)
    }

    const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|「[^」\n]{2,200}」|第\s*\d+(?:\s*[–~\-—至]\s*\d+)?\s*页)/

    function inlineNodes(text, actions) {
      const nodes = []
      const pattern = new RegExp(INLINE_PATTERN.source, 'g')
      let last = 0
      let match
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: `b${nodes.length}` }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key: `c${nodes.length}`, className: 'pdfr-code' }, token.slice(1, -1)))
        } else if (token.startsWith('「')) {
          const inner = token.slice(1, -1)
          nodes.push(
            actions && actions.onLocateQuote
              ? h(
                  'button',
                  {
                    key: `q${nodes.length}`,
                    type: 'button',
                    className: 'pdfr-ref pdfr-ref-quote',
                    title: '跳到这段原文',
                    onClick: () => actions.onLocateQuote(inner),
                  },
                  token,
                )
              : token,
          )
        } else {
          const pageNumber = Number((token.match(/\d+/) || [])[0])
          nodes.push(
            actions && actions.onGoPage && pageNumber
              ? h(
                  'button',
                  {
                    key: `p${nodes.length}`,
                    type: 'button',
                    className: 'pdfr-ref',
                    title: `跳到第 ${pageNumber} 页`,
                    onClick: () => actions.onGoPage(pageNumber),
                  },
                  token,
                )
              : token,
          )
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function RichText({ text, onGoPage, onLocateQuote }) {
      const actions = { onGoPage, onLocateQuote }
      const blocks = []
      let list = null
      for (const line of String(text || '').split('\n')) {
        const bullet = /^\s*[-*•]\s+(.+)$/.exec(line)
        const numbered = /^\s*(\d+)[.、)]\s+(.+)$/.exec(line)
        if (bullet || numbered) {
          if (!list) {
            list = []
            blocks.push(list)
          }
          list.push(bullet ? bullet[1] : numbered[2])
          continue
        }
        if (!line.trim()) {
          list = null
          continue
        }
        list = null
        blocks.push(line.replace(/^#{1,4}\s*/, ''))
      }
      return h(
        'div',
        { className: 'pdfr-richtext' },
        blocks.map((block, index) =>
          Array.isArray(block)
            ? h('ul', { key: index, className: 'pdfr-list' }, block.map((item, itemIndex) => h('li', { key: itemIndex }, inlineNodes(item, actions))))
            : h('p', { key: index }, inlineNodes(block, actions)),
        ),
      )
    }

    function Quote({ text, label, onRemove }) {
      return h(
        'div',
        { className: 'pdfr-quote' },
        h('span', { className: 'pdfr-quote-bar' }),
        label ? h('span', { className: 'pdfr-quote-label' }, label) : null,
        h('span', { className: 'pdfr-quote-text', title: text }, text),
        onRemove
          ? h('button', { type: 'button', className: 'pdfr-iconbtn pdfr-quote-close', onClick: onRemove, title: '移除引用' }, h(Icon, { name: 'close', size: 12 }))
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // File picker
    // ---------------------------------------------------------------------

    // Recent documents with an inline "forget this document" confirmation.
    // Deleting here removes the document's conversations, never the PDF file.
    function RecentList({ items, onOpen, onForget }) {
      const [confirming, setConfirming] = useState('')
      return h(
        'div',
        { className: 'pdfr-recent-list' },
        items.map((item) =>
          confirming === item.path
            ? h(
                'div',
                { key: item.path, className: 'pdfr-recent-confirm' },
                h('span', { className: 'pdfr-recent-confirm-text', title: item.path }, `删除《${item.title || item.path}》的全部对话？`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pdfr-minibtn pdfr-danger',
                    onClick: () => {
                      setConfirming('')
                      if (onForget) onForget(item)
                    },
                  },
                  '删除',
                ),
                h('button', { type: 'button', className: 'pdfr-minibtn', onClick: () => setConfirming('') }, '取消'),
              )
            : h(
                'div',
                { key: item.path, className: 'pdfr-recent-item' },
                h(
                  'button',
                  { type: 'button', className: 'pdfr-recent-row', onClick: () => onOpen(item.path), title: item.path },
                  h(Icon, { name: 'file', size: 14 }),
                  h('span', null, item.title || item.path),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pdfr-recent-del',
                    title: '删除这个 PDF 的全部对话（PDF 文件保留）',
                    onClick: (event) => {
                      event.stopPropagation()
                      setConfirming(item.path)
                    },
                  },
                  h(Icon, { name: 'trash', size: 13 }),
                ),
              ),
        ),
      )
    }

    function FilePicker({ onClose, onOpen, recent, onImport, onForget }) {
      const [listing, setListing] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState('')
      const inputRef = useRef(null)

      const load = useCallback(async (path) => {
        setBusy(true)
        setError('')
        try {
          const payload = await api.browse(path)
          setListing(payload)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }, [])


      useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
      }, [])

      const submitManual = () => {
        const value = manual.trim().replace(/^"|"$/g, '')
        if (!value) return
        onOpen(value)
      }

      return h(
        'div',
        { className: 'pdfr-modal-backdrop', onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'pdfr-modal', role: 'dialog', 'aria-label': 'PDF' },
          h(
            'div',
            { className: 'pdfr-modal-head' },
            h('span', { className: 'pdfr-modal-title' }, 'PDF'),
            h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: onClose, title: '关闭' }, h(Icon, { name: 'close' })),
          ),
          h(
            'div',
            { className: 'pdfr-modal-path' },
            h('span', { className: 'pdfr-path-text', title: listing ? listing.path || '此电脑' : '' }, listing ? listing.path || '此电脑' : '选择 PDF'),
            listing && listing.parent
              ? h('button', { type: 'button', className: 'pdfr-minibtn', onClick: () => load(listing.parent) }, '上一级')
              : null,
          ),
          h(
            'div',
            { className: 'pdfr-modal-list' },
            busy ? h('div', { className: 'pdfr-muted pdfr-pad' }, '…') : null,
            error ? h('div', { className: 'pdfr-error pdfr-pad' }, error) : null,
            !listing && !busy ? h('div', { className: 'pdfr-muted pdfr-pad' }, '点「浏览…」用系统对话框选择，或直接把 PDF 拖进面板。') : null,
            listing
              ? listing.dirs.map((dir) =>
                  h(
                    'button',
                    { type: 'button', key: `d:${dir.path}`, className: 'pdfr-row', onClick: () => load(dir.path) },
                    h('span', { className: 'pdfr-row-icon' }, h(Icon, { name: 'folder' })),
                    h('span', { className: 'pdfr-row-name' }, dir.name),
                  ),
                )
              : null,
            listing
              ? listing.pdfs.map((file) =>
                  h(
                    'button',
                    { type: 'button', key: `f:${file.path}`, className: 'pdfr-row pdfr-row-file', onClick: () => onOpen(file.path) },
                    h('span', { className: 'pdfr-row-icon' }, h(Icon, { name: 'file' })),
                    h('span', { className: 'pdfr-row-name' }, file.name),
                    h('span', { className: 'pdfr-row-meta' }, `${Math.max(1, Math.round(file.size / 1024))} KB`),
                  ),
                )
              : null,
            !busy && listing && !listing.dirs.length && !listing.pdfs.length ? h('div', { className: 'pdfr-muted pdfr-pad' }, '这个目录里没有 PDF') : null,
            listing && !listing.path && recent.length
              ? h(
                  'div',
                  { className: 'pdfr-recent' },
                  h('div', { className: 'pdfr-section-label' }, '最近打开'),
                  h(RecentList, { items: recent, onOpen, onForget }),
                )
              : null,
          ),
          h(
            'div',
            { className: 'pdfr-modal-foot' },
            h('input', {
              ref: inputRef,
              className: 'pdfr-input',
              placeholder: '也可以直接输入 PDF 的完整路径',
              value: manual,
              onChange: (event) => setManual(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submitManual()
                if (event.key === 'Escape') onClose()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'pdfr-minibtn',
                onClick: async () => {
                  try {
                    const result = await api.pickFile()
                    if (result && result.path) onOpen(result.path)
                  } catch {}
                },
              },
              '浏览…',
            ),
            h(
              'label',
              { className: 'pdfr-minibtn pdfr-upload' },
              '上传…',
              h('input', {
                type: 'file',
                accept: 'application/pdf,.pdf',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0]
                  if (file) onImport(file)
                },
              }),
            ),
            h('button', { type: 'button', className: 'pdfr-btn pdfr-btn-primary', onClick: submitManual }, '打开'),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Reader page
    // ---------------------------------------------------------------------

    function ReaderPage() {
      const saved = useMemo(() => readStore(), [])
      const [doc, setDoc] = useState(saved.doc && saved.doc.path ? saved.doc : null)
      const [page, setPage] = useState(saved.page || 1)
      const [pagesData, setPagesData] = useState({})
      const [loadingPages, setLoadingPages] = useState({})
      const [pageErrors, setPageErrors] = useState({})
      const [loadError, setLoadError] = useState('')
      const [viewMode, setViewMode] = useState(saved.viewMode === 'continuous' ? 'continuous' : 'single')
      const [imageSupport, setImageSupport] = useState(null)
      const [catalogue, setCatalogue] = useState(null)
      const [modelChoice, setModelChoice] = useState(saved.modelChoice && saved.modelChoice.provider && saved.modelChoice.model ? saved.modelChoice : null)
      const [modelMenu, setModelMenu] = useState(false)
      const [modelLoading, setModelLoading] = useState(true)
      const initialThreads = useMemo(() => migrateThreads(saved.threads), [saved])
      const [threads, setThreads] = useState(initialThreads)
      const [recent, setRecent] = useState(Array.isArray(saved.recent) ? saved.recent : [])
      const [quote, setQuote] = useState(null)
      const [draft, setDraft] = useState('')
      const [draftImages, setDraftImages] = useState([])
      const [asking, setAsking] = useState(false)
      const [pill, setPill] = useState(null)
      const [marquee, setMarquee] = useState(null)
      const [highlight, setHighlight] = useState(null)
      const [annotations, setAnnotations] = useState([])
      const [annotationMenu, setAnnotationMenu] = useState(false)
      const [annotationEditor, setAnnotationEditor] = useState(null)
      const [picker, setPicker] = useState(false)
      const [dropping, setDropping] = useState(false)
      const [zoomMode, setZoomMode] = useState('fit-width')
      const [zoom, setZoom] = useState(1.2)
      const [chatWidth, setChatWidth] = useState(clamp(Number(saved.chatWidth) || 390, 300, 760))
      const [chatCollapsed, setChatCollapsed] = useState(Boolean(saved.chatCollapsed))
      const [layoutMenu, setLayoutMenu] = useState(false)
      const [convMenu, setConvMenu] = useState(false)
      const [resizing, setResizing] = useState(false)
      const [toast, setToast] = useState('')
      const [exportDialog, setExportDialog] = useState(null)

      const scrollRef = useRef(null)
      const bodyRef = useRef(null)
      const threadRef = useRef(null)
      const inputRef = useRef(null)
      const imageInputRef = useRef(null)
      const cacheRef = useRef(new Map())
      const inflightRef = useRef(new Set())
      const pageNodesRef = useRef(new Map())
      const marqueeRef = useRef(null)
      const highlightTimer = useRef(null)
      const wheelDeltaRef = useRef(0)
      const clickGuardRef = useRef(false)
      const abortRef = useRef(null)
      const dragDepth = useRef(0)

      const path = doc ? doc.path : null
      const documentRecord = path && threads[path] ? threads[path] : null
      const conversations = documentRecord && Array.isArray(documentRecord.items) ? documentRecord.items : []
      const activeConversation = conversations.find((item) => item.id === (documentRecord && documentRecord.active)) || conversations[0] || null
      const messages = (activeConversation && activeConversation.messages) || []
      const turnCount = messages.filter((message) => message.role === 'user').length
      const currentPageData = pagesData[page] || null

      // What the next question will actually carry, mirrored from `send`.
      const contextPlan = useMemo(() => {
        if (!doc) return { label: '' }
        const span = quote && quote.pages && quote.pages.length
          ? quote.pages.length > 1
            ? `（第 ${quote.pages[0]}–${quote.pages[quote.pages.length - 1]} 页）`
            : `（第 ${quote.pages[0]} 页）`
          : ''
        if (quote && quote.region) return { label: `框选图片${span}` }
        if (quote && quote.text) return { label: `引用原文${span}` }
        return { label: '未选内容（模型按需查阅）' }
      }, [doc, quote])

      const contextChars = useMemo(() => {
        let total = quote && quote.text ? quote.text.length : 0
        for (const message of messages) total += Math.min(400, (message.text || '').length)
        return total
      }, [quote, messages])

      const activeModel = useMemo(() => {
        if (!catalogue || !modelChoice) return null
        const provider = (catalogue.providers || []).find((item) => item.id === modelChoice.provider)
        const model = provider && provider.models.find((item) => item.id === modelChoice.model)
        return provider && model ? { provider, model } : null
      }, [catalogue, modelChoice])
      const effortOptions = activeModel && activeModel.model.reasoning ? activeModel.model.reasoning.efforts || [] : []
      const activeEffort = effortOptions.find((effort) => effort.id === (modelChoice && modelChoice.reasoningEffort)) || null
      const imageSupportNow = activeModel && activeModel.model.modalities
        ? activeModel.model.modalities.includes('image')
        : Boolean(imageSupport)

      // The same model can be exposed by several providers (desktop account vs.
      // API key). Show it once and keep the route already in use, else the default.
      const modelEntries = useMemo(() => {
        const groups = (catalogue && catalogue.providers) || []
        const defaultProvider = catalogue && catalogue.default ? catalogue.default.provider : null
        const rank = (providerId) => (modelChoice && modelChoice.provider === providerId ? 0 : defaultProvider === providerId ? 1 : 2)
        const chosen = new Map()
        for (const provider of groups) {
          for (const model of provider.models || []) {
            const key = `${model.id}\u0000${model.name || model.id}`
            const existing = chosen.get(key)
            if (!existing || rank(provider.id) < rank(existing.provider.id)) chosen.set(key, { provider, model })
          }
        }
        return Array.from(chosen.values())
      }, [catalogue, modelChoice])

      // Persist doc / page / threads / recent ---------------------------------
      useEffect(() => {
        writeStore({ doc: doc ? { path: doc.path, title: doc.title, pages: doc.pages, width: doc.width, height: doc.height } : null, page })
      }, [doc, page])

      useEffect(() => {
        const timer = setTimeout(() => writeStore({ threads }), 350)
        return () => clearTimeout(timer)
      }, [threads])

      useEffect(() => {
        writeStore({ recent })
      }, [recent])

      useEffect(() => {
        writeStore({ chatWidth, chatCollapsed })
      }, [chatWidth, chatCollapsed])

      useEffect(() => {
        writeStore({ viewMode })
      }, [viewMode])

      // Does the configured model accept image input?
      useEffect(() => {
        let live = true
        fetch('/pdf-reader/health', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (live) setImageSupport(Boolean(payload && payload.images))
          })
          .catch(() => {})
        return () => {
          live = false
        }
      }, [])

      // Models, modalities, and reasoning efforts, shared with the chat composer.
      useEffect(() => {
        let live = true
        fetch('/pdf-reader/models', { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (!live || !payload || !payload.ok) return
            setCatalogue(payload)
            setModelChoice((current) => {
              const providers = Array.isArray(payload.providers) ? payload.providers : []
              const known = current && providers.some((provider) => provider.id === current.provider && provider.models.some((model) => model.id === current.model))
              if (known) return current
              const fallback = payload.default || {}
              const provider = providers.find((item) => item.id === fallback.provider)
              const model = provider && provider.models.find((item) => item.id === fallback.model)
              if (provider && model) return { provider: provider.id, model: model.id, reasoningEffort: fallback.reasoningEffort || '' }
              const first = providers.find((item) => item.models.length)
              return first ? { provider: first.id, model: first.models[0].id, reasoningEffort: '' } : current
            })
          })
          .catch(() => {})
          .finally(() => {
            if (live) setModelLoading(false)
          })
        return () => {
          live = false
        }
      }, [])

      useEffect(() => {
        if (modelChoice) writeStore({ modelChoice })
      }, [modelChoice])

      const updateDocument = useCallback((filePath, updater) => {
        setThreads((previous) => {
          const record = previous[filePath] || { active: null, items: [] }
          const next = updater(record)
          if (!next) return previous
          return { ...previous, [filePath]: next }
        })
      }, [])

      // Append one exchange to an exact conversation, creating it when missing.
      const appendExchange = useCallback(
        (filePath, conversationId, entries) => {
          updateDocument(filePath, (record) => {
            let items = record.items
            if (!items.some((item) => item.id === conversationId)) {
              items = [{ id: conversationId, title: '', ts: Date.now(), messages: [] }, ...items]
            }
            return {
              active: conversationId,
              items: items.slice(0, 12).map((item) =>
                item.id === conversationId
                  ? { ...item, title: item.title || conversationTitle(entries), messages: [...item.messages, ...entries] }
                  : item,
              ),
            }
          })
        },
        [updateDocument],
      )

      // Patch by message id across every conversation of the document, so a reply
      // keeps streaming even if the reader switches conversations meanwhile.
      const patchMessage = useCallback(
        (filePath, messageId, updater) => {
          updateDocument(filePath, (record) => {
            let changed = false
            const items = record.items.map((item) => {
              let touched = false
              const messages = item.messages.map((message) => {
                if (message.id !== messageId) return message
                touched = true
                changed = true
                return updater(message)
              })
              return touched ? { ...item, messages } : item
            })
            return changed ? { ...record, items } : null
          })
        },
        [updateDocument],
      )

      const startConversation = useCallback(() => {
        if (!doc) return
        const id = uid()
        updateDocument(doc.path, (record) => ({
          active: id,
          items: [{ id, title: '', ts: Date.now(), messages: [] }, ...record.items].slice(0, 12),
        }))
        setConvMenu(false)
        setQuote(null)
        setPill(null)
        setTimeout(() => {
          if (inputRef.current) inputRef.current.focus()
        }, 0)
      }, [doc, updateDocument])

      const selectConversation = useCallback(
        (id) => {
          if (!doc) return
          updateDocument(doc.path, (record) => ({ ...record, active: id }))
          setConvMenu(false)
          setQuote(null)
          setPill(null)
        },
        [doc, updateDocument],
      )

      const removeConversation = useCallback(
        (id) => {
          if (!doc) return
          const target = conversations.find((item) => item.id === id)
          if (target && target.sessionId) api.archiveSessions([target.sessionId]).catch(() => {})
          updateDocument(doc.path, (record) => {
            const items = record.items.filter((item) => item.id !== id)
            return {
              active: record.active === id ? (items[0] ? items[0].id : null) : record.active,
              items,
            }
          })
        },
        [doc, updateDocument, conversations],
      )

      // Open a document -------------------------------------------------------
      const openDoc = useCallback(
        async (target, options) => {
          setLoadError('')
          try {
            const info = await api.info(target)
            setDoc({ path: info.path || target, title: info.title || target, pages: info.pages, width: info.width, height: info.height })
            setPage(options && options.page ? clamp(options.page, 1, info.pages || 1) : 1)
            setZoomMode('fit-width')
            setPagesData({})
            setPageErrors({})
            setQuote(null)
            setPill(null)
            setPicker(false)
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            setRecent((previous) => {
              const next = (previous || []).filter((item) => item.path !== (info.path || target))
              next.unshift({ path: info.path || target, title: info.title || target, pages: info.pages, ts: Date.now() })
              return next.slice(0, 8)
            })
          } catch (problem) {
            setLoadError(problem.message)
            setPicker(true)
          }
        },
        [],
      )

      const chooseFile = useCallback(async () => {
        try {
          const result = await api.pickFile()
          if (result && result.path) {
            openDoc(result.path)
            return
          }
          if (result && result.unavailable) setPicker(true)
        } catch (problem) {
          setToast(problem && problem.message ? problem.message : '无法打开系统文件选择框')
          setPicker(true)
        }
      }, [openDoc])

      // Remove a document from "最近打开" together with every conversation
      // stored for it. The PDF file and its annotations stay untouched.
      const forgetDocument = useCallback(
        (item) => {
          const key = item && item.path ? item.path : String(item || '')
          if (!key) return
          const label = (item && item.title) || key
          const record = threads && threads[key]
          const sessionIds = record && Array.isArray(record.items)
            ? record.items.map((entry) => entry.sessionId).filter((id) => typeof id === 'string')
            : []
          if (sessionIds.length) api.archiveSessions(sessionIds).catch(() => {})
          setRecent((list) => (Array.isArray(list) ? list.filter((entry) => entry.path !== key) : list))
          setThreads((map) => {
            if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return map
            const next = { ...map }
            delete next[key]
            return next
          })
          if (doc && doc.path === key) {
            if (abortRef.current) abortRef.current.abort()
            setQuote(null)
            setPill(null)
            setDraft('')
            setDraftImages([])
            setConvMenu(false)
          }
          setToast(`已删除《${label}》的全部对话（PDF 文件保留）`)
        },
        [doc, threads],
      )

      useEffect(() => {
        const stored = saved.doc
        if (!stored || !stored.path) return
        openDoc(stored.path, { page: saved.page })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(''), 2600)
        return () => clearTimeout(timer)
      }, [toast])

      useEffect(() => () => {
        if (abortRef.current) abortRef.current.abort()
        if (highlightTimer.current) clearTimeout(highlightTimer.current)
      }, [])

      const importFile = useCallback(
        async (file) => {
          if (!file) return
          if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
            setToast('只支持 PDF 文件')
            return
          }
          setToast('正在导入…')
          try {
            const payload = await api.importFile(file)
            await openDoc(payload.path)
            setToast('')
          } catch (problem) {
            setToast(problem.message)
          }
        },
        [openDoc],
      )

      // Page data -------------------------------------------------------------
      const ensurePage = useCallback(
        (number) => {
          if (!doc || !doc.path) return
          const total = doc.pages || 1
          const target = clamp(Number(number) || 1, 1, total)
          const key = `${doc.path}#${target}`
          const cached = cacheRef.current.get(key)
          if (cached) {
            setPagesData((previous) => (previous[target] ? previous : { ...previous, [target]: cached }))
            return
          }
          if (inflightRef.current.has(key)) return
          inflightRef.current.add(key)
          setLoadingPages((previous) => ({ ...previous, [target]: true }))
          api
            .page(doc.path, target, 2)
            .then((data) => {
              cacheRef.current.set(key, data)
              while (cacheRef.current.size > PAGE_CACHE_LIMIT) {
                cacheRef.current.delete(cacheRef.current.keys().next().value)
              }
              setPagesData((previous) => ({ ...previous, [target]: data }))
              setPageErrors((previous) => {
                if (!previous[target]) return previous
                const next = { ...previous }
                delete next[target]
                return next
              })
              setDoc((previous) => (previous && data.count && previous.pages !== data.count ? { ...previous, pages: data.count } : previous))
            })
            .catch((problem) => {
              setPageErrors((previous) => ({ ...previous, [target]: problem.message }))
            })
            .finally(() => {
              inflightRef.current.delete(key)
              setLoadingPages((previous) => {
                if (!previous[target]) return previous
                const next = { ...previous }
                delete next[target]
                return next
              })
            })
        },
        [doc],
      )

      // Single-page mode: keep the current page and its neighbour loaded.
      useEffect(() => {
        if (!doc || viewMode !== 'single') return
        ensurePage(page)
        if (page + 1 <= (doc.pages || 1)) ensurePage(page + 1)
      }, [doc, page, viewMode, ensurePage])

      // Continuous mode: load pages near the viewport and follow scrolling.
      useEffect(() => {
        if (!doc || viewMode !== 'continuous') return undefined
        const container = scrollRef.current
        if (!container) return undefined
        const ratios = new Map()
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const number = Number(entry.target.getAttribute('data-page'))
              ratios.set(number, entry.isIntersecting ? entry.intersectionRatio : 0)
              if (entry.isIntersecting) {
                ensurePage(number)
                if (number + 1 <= (doc.pages || 1)) ensurePage(number + 1)
              }
            }
            let best = 0
            let bestRatio = 0
            for (const [number, ratio] of ratios) {
              if (ratio > bestRatio) {
                bestRatio = ratio
                best = number
              }
            }
            if (best && bestRatio > 0.15) setPage((current) => (current === best ? current : best))
          },
          { root: container, rootMargin: '700px 0px 700px 0px', threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] },
        )
        container.querySelectorAll('[data-page]').forEach((node) => observer.observe(node))
        ensurePage(page)
        return () => observer.disconnect()
        // `page` is intentionally read once when the mode mounts; scrolling feeds it back.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc, viewMode, ensurePage])

      // Jump to the reading position when continuous mode mounts.
      useEffect(() => {
        if (!doc || viewMode !== 'continuous') return
        const node = pageNodesRef.current.get(page)
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start' })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [viewMode, doc])

      // Zoom / layout ---------------------------------------------------------
      const fitSource = useMemo(
        () => (viewMode === 'continuous' && doc ? { width: doc.width || 595, height: doc.height || 842 } : currentPageData),
        [viewMode, doc, currentPageData],
      )
      const fitZoom = useCallback(() => {
        if (zoomMode === 'custom' || !fitSource) return null
        const container = scrollRef.current
        if (!container) return null
        const availableWidth = Math.max(200, container.clientWidth - 56)
        const availableHeight = Math.max(200, container.clientHeight - 104)
        const byWidth = availableWidth / fitSource.width
        const byHeight = availableHeight / fitSource.height
        return clamp(zoomMode === 'fit-page' ? Math.min(byWidth, byHeight) : byWidth, 0.3, 3.5)
      }, [zoomMode, fitSource])

      useEffect(() => {
        const next = fitZoom()
        if (next != null) setZoom(next)
      }, [fitZoom, page])

      useEffect(() => {
        if (zoomMode === 'custom') return undefined
        const container = scrollRef.current
        if (!container || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => {
          const next = fitZoom()
          if (next != null) setZoom(next)
        })
        observer.observe(container)
        return () => observer.disconnect()
      }, [zoomMode, fitZoom])

      // Ctrl/⌘ + wheel zooms the page without triggering browser zoom --------
      useEffect(() => {
        const element = scrollRef.current
        if (!element) return undefined
        const onWheel = (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          setZoomMode('custom')
          setZoom((value) => clamp(value * (event.deltaY < 0 ? 1.08 : 1 / 1.08), 0.3, 3.5))
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [viewMode, path])

      // Keep the conversation column inside the available width ---------------
      useEffect(() => {
        const onResize = () => {
          const container = bodyRef.current
          if (!container) return
          const maxWidth = Math.max(300, Math.min(760, container.clientWidth - 320))
          setChatWidth((width) => Math.min(width, maxWidth))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Scroll the thread to the newest message -------------------------------
      useEffect(() => {
        const node = threadRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messages.length, asking, page])

      useEffect(() => {
        const node = threadRef.current
        if (!node || !asking) return
        node.scrollTop = node.scrollHeight
      }, [messages, asking])

      // Page navigation -------------------------------------------------------
      const goToPage = useCallback(
        (next) => {
          if (!doc) return
          const target = clamp(Number(next) || 1, 1, doc.pages || 1)
          setPage(target)
          setQuote(null)
          setPill(null)
          setConvMenu(false)
          marqueeRef.current = null
          setMarquee(null)
          if (viewMode === 'continuous') {
            const node = pageNodesRef.current.get(target)
            if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start', behavior: 'auto' })
          } else if (scrollRef.current) {
            scrollRef.current.scrollTop = 0
          }
        },
        [doc, viewMode],
      )

      // Single-page mode: when the page is already scrolled to the very top or
      // bottom, a further wheel gesture turns the page instead of doing nothing.
      // There is no fixed cooldown: a mouse notch turns immediately, while a
      // precision trackpad accumulates until it has travelled far enough.
      useEffect(() => {
        if (viewMode !== 'single') return undefined
        const element = scrollRef.current
        if (!element) return undefined
        wheelDeltaRef.current = 0
        const onWheel = (event) => {
          if (event.ctrlKey || event.metaKey || marqueeRef.current || !event.deltaY) return
          const raw = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * element.clientHeight : event.deltaY
          if (!raw) return
          const atTop = element.scrollTop <= 1
          const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
          const forward = raw > 0
          if ((forward && !atBottom) || (!forward && !atTop)) {
            wheelDeltaRef.current = 0
            return
          }
          const sameDirection = Math.sign(raw) === Math.sign(wheelDeltaRef.current)
          wheelDeltaRef.current = (sameDirection ? wheelDeltaRef.current : 0) + raw
          if (Math.abs(wheelDeltaRef.current) < 80) return
          wheelDeltaRef.current = 0
          if (forward ? !doc || page >= doc.pages : page <= 1) return
          goToPage(forward ? page + 1 : page - 1)
        }
        element.addEventListener('wheel', onWheel, { passive: true })
        return () => element.removeEventListener('wheel', onWheel)
      }, [viewMode, page, doc, goToPage])

      // Jump + temporary highlight for the locations the model cites.
      const flashHighlight = useCallback((pageNumber, rects) => {
        setHighlight({ page: pageNumber, rects: Array.isArray(rects) ? rects : [] })
        if (highlightTimer.current) clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => setHighlight(null), 3000)
      }, [])

      const locateQuote = useCallback(
        async (text) => {
          if (!doc || !text) return
          const needle = String(text).trim().slice(0, 200)
          if (!needle) return
          setToast('正在定位原文…')
          try {
            const response = await fetch(`/pdf-reader/find?path=${encodeURIComponent(doc.path)}&text=${encodeURIComponent(needle)}`)
            const payload = await response.json()
            if (!payload || payload.ok === false) throw new Error((payload && payload.error) || '定位失败')
            const hit = (payload.hits || [])[0]
            if (!hit) {
              setToast('没有找到这段原文')
              return
            }
            goToPage(hit.page)
            flashHighlight(hit.page, hit.rects)
            setToast('')
          } catch (problem) {
            setToast(problem && problem.message ? problem.message : '定位失败')
          }
        },
        [doc, goToPage, flashHighlight],
      )

      // Annotations: sidecar JSON, editable here and by the model's tools.
      const refreshAnnotations = useCallback(async () => {
        if (!doc) {
          setAnnotations([])
          return
        }
        try {
          const response = await fetch(`/pdf-reader/annotations?path=${encodeURIComponent(doc.path)}`)
          const payload = await response.json()
          if (payload && payload.ok && Array.isArray(payload.items)) setAnnotations(payload.items)
        } catch {}
      }, [doc])

      useEffect(() => {
        refreshAnnotations()
      }, [refreshAnnotations])

      const persistAnnotations = useCallback(
        async (items) => {
          if (!doc) return
          setAnnotations(items)
          try {
            await fetch('/pdf-reader/annotations', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: doc.path, items }),
            })
          } catch {}
        },
        [doc],
      )

      const selectionRects = useCallback(() => {
        const container = scrollRef.current
        const selection = window.getSelection && window.getSelection()
        if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return null
        const text = selection.toString().replace(/\s+/g, ' ').trim()
        if (!text) return null
        const range = selection.getRangeAt(0)
        const nodes = Array.from(container.querySelectorAll('[data-page]'))
        const groups = new Map()
        const clientRects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height)
        for (const rect of clientRects) {
          for (const node of nodes) {
            const box = node.getBoundingClientRect()
            if (rect.left >= box.right || rect.right <= box.left || rect.top >= box.bottom || rect.bottom <= box.top) continue
            const pageNumber = Number(node.getAttribute('data-page'))
            const x0 = Math.max(0, rect.left - box.left) / zoom
            const x1 = Math.min(box.width, rect.right - box.left) / zoom
            const y0 = Math.max(0, rect.top - box.top) / zoom
            const y1 = Math.min(box.height, rect.bottom - box.top) / zoom
            if (x1 - x0 >= 1 && y1 - y0 >= 1) {
              if (!groups.has(pageNumber)) groups.set(pageNumber, [])
              groups.get(pageNumber).push([x0, y0, x1, y1])
            }
            break
          }
        }
        if (!groups.size) return null
        const first = clientRects[0] || range.getBoundingClientRect()
        return {
          text: text.slice(0, 2000),
          groups: Array.from(groups, ([page, rects]) => ({ page, rects: rects.slice(0, 40) })).slice(0, 4),
          x: first.left,
          y: first.bottom + 8,
        }
      }, [zoom])

      const openAnnotationFromSelection = useCallback(() => {
        const result = selectionRects()
        if (!result) {
          setToast('先选中要标注的文字')
          return
        }
        setAnnotationEditor({ mode: 'create', groups: result.groups, quote: result.text, note: '', color: 'yellow', x: result.x, y: result.y })
        setPill(null)
      }, [selectionRects])

      const openAnnotationEditor = useCallback((annotation, event) => {
        if (event) event.stopPropagation()
        setAnnotationEditor({
          mode: 'edit',
          id: annotation.id,
          page: annotation.page,
          note: annotation.note || '',
          color: annotation.color || 'yellow',
          quote: annotation.quote || '',
          x: event ? event.clientX : 160,
          y: event ? event.clientY + 10 : 160,
        })
      }, [])

      const closeAnnotationEditor = useCallback(() => setAnnotationEditor(null), [])

      const saveAnnotation = useCallback(() => {
        if (!annotationEditor) return
        const now = Date.now()
        if (annotationEditor.mode === 'create') {
          const created = annotationEditor.groups.map((group) => ({
            id: uid(),
            page: group.page,
            rects: group.rects,
            color: annotationEditor.color,
            quote: annotationEditor.quote,
            note: annotationEditor.note,
            author: 'user',
            createdAt: now,
            updatedAt: now,
          }))
          persistAnnotations([...annotations, ...created])
        } else {
          persistAnnotations(
            annotations.map((item) =>
              item.id === annotationEditor.id ? { ...item, note: annotationEditor.note, color: annotationEditor.color, updatedAt: now } : item,
            ),
          )
        }
        setAnnotationEditor(null)
      }, [annotationEditor, annotations, persistAnnotations])

      const deleteAnnotation = useCallback(() => {
        if (!annotationEditor || annotationEditor.mode !== 'edit') return
        persistAnnotations(annotations.filter((item) => item.id !== annotationEditor.id))
        setAnnotationEditor(null)
      }, [annotationEditor, annotations, persistAnnotations])

      const toggleViewMode = useCallback(() => {
        setViewMode((mode) => (mode === 'continuous' ? 'single' : 'continuous'))
        setPill(null)
      }, [])

      useEffect(() => {
        const onKey = (event) => {
          const target = event.target
          const typing =
            target &&
            (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
          if (typing) return
          if (!doc) return
          if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === 'j') {
            event.preventDefault()
            goToPage(page + 1)
          } else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'k') {
            event.preventDefault()
            goToPage(page - 1)
          } else if (event.key === 'Escape') {
            setPill(null)
            setQuote(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [doc, page, goToPage])

      // Right-drag marquee: right button draws the box, wheel scrolls, left click confirms.
      const contentPoint = useCallback((clientX, clientY) => {
        const container = scrollRef.current
        if (!container) return null
        const box = container.getBoundingClientRect()
        return { x: clientX - box.left + container.scrollLeft, y: clientY - box.top + container.scrollTop }
      }, [])

      const refreshMarquee = useCallback(() => {
        const state = marqueeRef.current
        if (!state) return
        const point = contentPoint(state.clientX, state.clientY)
        if (!point) return
        setMarquee({
          left: Math.min(state.origin.x, point.x),
          top: Math.min(state.origin.y, point.y),
          width: Math.abs(point.x - state.origin.x),
          height: Math.abs(point.y - state.origin.y),
        })
      }, [contentPoint])

      // The marquee carries picture content only: crop geometry per page, no text.
      const extractMarquee = useCallback(() => {
        const container = scrollRef.current
        const state = marqueeRef.current
        if (!container || !state || !zoom) return { pages: [], regions: [] }
        const box = container.getBoundingClientRect()
        const point = contentPoint(state.clientX, state.clientY)
        if (!point) return { pages: [], regions: [] }
        const rect = {
          x0: Math.min(state.origin.x, point.x),
          y0: Math.min(state.origin.y, point.y),
          x1: Math.max(state.origin.x, point.x),
          y1: Math.max(state.origin.y, point.y),
        }
        const blocks = []
        for (const node of container.querySelectorAll('[data-page]')) {
          const pageBox = node.getBoundingClientRect()
          const left = pageBox.left - box.left + container.scrollLeft
          const top = pageBox.top - box.top + container.scrollTop
          if (left + pageBox.width <= rect.x0 || left >= rect.x1 || top + pageBox.height <= rect.y0 || top >= rect.y1) continue
          const number = Number(node.getAttribute('data-page'))
          const lx0 = Math.max(0, rect.x0 - left) / zoom
          const lx1 = Math.min(pageBox.width, rect.x1 - left) / zoom
          const ly0 = Math.max(0, rect.y0 - top) / zoom
          const ly1 = Math.min(pageBox.height, rect.y1 - top) / zoom
          if (lx1 - lx0 < 2 || ly1 - ly0 < 2) continue
          blocks.push({ page: number, rect: [lx0, ly0, lx1, ly1] })
        }
        blocks.sort((a, b) => a.page - b.page)
        return { pages: blocks.map((block) => block.page), regions: blocks.slice(0, 3) }
      }, [contentPoint, zoom])

      const cancelMarquee = useCallback(() => {
        marqueeRef.current = null
        setMarquee(null)
      }, [])

      const confirmMarquee = useCallback(() => {
        if (!marqueeRef.current) return
        const result = extractMarquee()
        marqueeRef.current = null
        setMarquee(null)
        clickGuardRef.current = true
        setTimeout(() => {
          clickGuardRef.current = false
        }, 220)
        if (!imageSupportNow) {
          setToast('框选只发送图片；当前模型不支持图片，请切换视觉模型，或左键拖选文字提问')
          return
        }
        if (!result.regions.length) {
          setToast('框选区域太小，重新拖一个范围')
          return
        }
        const overlapping = annotations.filter((item) =>
          result.regions.some((region) => region.page === item.page && item.rects.some((rect) => rectsOverlap(rect, region.rect))),
        )
        setPill(null)
        setQuote({
          text: '',
          pages: result.pages,
          region: true,
          regions: result.regions,
          images: true,
          annotationCount: overlapping.length || undefined,
        })
        const rangeLabel = result.pages.length > 1 ? `${result.pages[0]}–${result.pages[result.pages.length - 1]}` : String(result.pages[0] || page)
        setToast(
          `已框选图片 第 ${rangeLabel} 页${overlapping.length ? ` · 含 ${overlapping.length} 条标注` : ''} · 输入问题后发送`,
        )
        if (chatCollapsed) setChatCollapsed(false)
        setTimeout(() => {
          if (inputRef.current) inputRef.current.focus()
        }, 0)
      }, [extractMarquee, chatCollapsed, page, imageSupportNow, annotations])

      const handleReaderMouseDown = useCallback(
        (event) => {
          if (!doc) return
          if (event.button === 2) {
            const target = event.target
            if (target && target.closest && target.closest('.pdfr-pill, button, a, input, textarea')) return
            event.preventDefault()
            const point = contentPoint(event.clientX, event.clientY)
            if (!point) return
            try {
              window.getSelection().removeAllRanges()
            } catch {}
            setPill(null)
            marqueeRef.current = { origin: point, clientX: event.clientX, clientY: event.clientY }
            setMarquee({ left: point.x, top: point.y, width: 0, height: 0 })
            return
          }
          if (event.button === 0 && marqueeRef.current) {
            event.preventDefault()
            event.stopPropagation()
            confirmMarquee()
          }
        },
        [doc, contentPoint, confirmMarquee],
      )

      const confirmRef = useRef(null)
      useEffect(() => {
        confirmRef.current = confirmMarquee
      }, [confirmMarquee])

      const marqueeActive = Boolean(marquee)
      useEffect(() => {
        if (!marqueeActive) return undefined
        const onMove = (event) => {
          if (!marqueeRef.current) return
          marqueeRef.current.clientX = event.clientX
          marqueeRef.current.clientY = event.clientY
          refreshMarquee()
        }
        const onScroll = () => refreshMarquee()
        const onDown = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          if (confirmRef.current) confirmRef.current()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelMarquee()
          }
        }
        window.addEventListener('mousemove', onMove, true)
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.removeEventListener('mousemove', onMove, true)
          window.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [marqueeActive, refreshMarquee, cancelMarquee])

      // Selection → floating pill ---------------------------------------------
      const captureSelection = useCallback(() => {
        const container = scrollRef.current
        const selection = window.getSelection && window.getSelection()
        if (!container || !selection || selection.isCollapsed || !selection.rangeCount) {
          setPill(null)
          return
        }
        const text = selection.toString().replace(/\s+/g, ' ').trim()
        if (!text) {
          setPill(null)
          return
        }
        const range = selection.getRangeAt(0)
        const pages = new Set()
        const collect = (node) => {
          const element = node && (node.nodeType === 1 ? node : node.parentElement)
          const holder = element && element.closest && element.closest('[data-page]')
          if (holder) pages.add(Number(holder.getAttribute('data-page')))
        }
        collect(range.startContainer)
        collect(range.endContainer)
        if (!pages.size) {
          setPill(null)
          return
        }
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height)
        const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
        if (!last.width && !last.height) {
          setPill(null)
          return
        }
        const list = Array.from(pages)
          .filter(Boolean)
          .sort((a, b) => a - b)
        const spanned = []
        for (let number = list[0]; number <= list[list.length - 1] && spanned.length < 6; number += 1) spanned.push(number)
        const box = container.getBoundingClientRect()
        const contentTop = last.bottom - box.top + container.scrollTop + 8
        const visibleBottom = container.scrollTop + container.clientHeight - 48
        setPill({
          text: text.slice(0, 4000),
          pages: spanned,
          left: clamp(
            last.left - box.left + container.scrollLeft + last.width / 2 - 96,
            container.scrollLeft + 8,
            container.scrollLeft + Math.max(8, container.clientWidth - 200),
          ),
          top: contentTop > visibleBottom ? last.top - box.top + container.scrollTop - 46 : contentTop,
        })
      }, [])

      const handleReaderMouseUp = useCallback(
        (event) => {
          if (event.button === 2 && marqueeRef.current) {
            const origin = marqueeRef.current.origin
            const point = contentPoint(event.clientX, event.clientY)
            // A plain right click (no drag) should not leave an unusable box behind.
            if (point && Math.abs(point.x - origin.x) < 6 && Math.abs(point.y - origin.y) < 6) {
              cancelMarquee()
              setPill(null)
              return
            }
          }
          captureSelection()
        },
        [contentPoint, cancelMarquee, captureSelection],
      )

      useEffect(() => {
        const onDown = (event) => {
          if (event.target.closest && event.target.closest('.pdfr-pill')) return
          setPill(null)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [])

      // Ask -------------------------------------------------------------------
      const send = useCallback(
        async (rawQuestion, options) => {
          const question = String(rawQuestion || '').trim()
          if (!question || !doc || asking) return
          if (chatCollapsed) setChatCollapsed(false)
          const activeQuote = options && 'quote' in options ? options.quote : quote
          const filePath = doc.path
          const pageNumber = page
          const quotePages = activeQuote && Array.isArray(activeQuote.pages) ? activeQuote.pages : []
          const quoteRegions = activeQuote && Array.isArray(activeQuote.regions) ? activeQuote.regions : []
          const imageOnly = Boolean(activeQuote && activeQuote.region)
          const withImages = Boolean(imageOnly && imageSupportNow && quoteRegions.length)
          if (imageOnly && !withImages) {
            setToast('当前模型不支持图片，无法发送框选内容；请切换视觉模型，或改用左键拖选文字')
            return
          }
          if (draftImages.length && !imageSupportNow) {
            setToast('当前模型不支持图片，先移除附带的图片或切换视觉模型')
            return
          }
          const uploads = draftImages.map((image) => {
            const comma = image.dataUrl.indexOf(',')
            return {
              data: comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl,
              mediaType: 'image/png',
              name: image.name,
            }
          })
          // Text and images only: no page text is preloaded. Selected text keeps
          // its page numbers, and the model can read more pages through tools.
          const selectionPages = imageOnly ? [] : quotePages.slice(0, 6)
          const conversationId = activeConversation ? activeConversation.id : uid()
          const sessionId = activeConversation ? activeConversation.sessionId : undefined
          const userMessage = {
            id: uid(),
            role: 'user',
            text: question,
            quote: activeQuote ? activeQuote.text || undefined : undefined,
            quotePages: quotePages.length ? quotePages : undefined,
            quoteRegion: activeQuote && activeQuote.region ? true : undefined,
            quoteImages: withImages || undefined,
            quoteAnnotations: activeQuote && activeQuote.annotationCount ? activeQuote.annotationCount : undefined,
            imageCount: uploads.length || undefined,
            page: pageNumber,
            ts: Date.now(),
          }
          const replyId = uid()
          appendExchange(filePath, conversationId, [
            userMessage,
            { id: replyId, role: 'assistant', text: '', streaming: true, page: pageNumber, ts: Date.now() },
          ])
          setDraft('')
          setDraftImages([])
          setQuote(null)
          setPill(null)
          setAsking(true)
          const controller = new AbortController()
          abortRef.current = controller
          let buffered = ''
          let reasoningText = ''
          try {
            await api.ask(
              {
                path: filePath,
                page: pageNumber,
                count: doc.pages,
                title: doc.title,
                provider: modelChoice ? modelChoice.provider : undefined,
                model: modelChoice ? modelChoice.model : undefined,
                reasoningEffort: modelChoice && modelChoice.reasoningEffort ? modelChoice.reasoningEffort : undefined,
                question,
                selection: imageOnly ? '' : activeQuote ? activeQuote.text : '',
                selectionPages: selectionPages.length ? selectionPages : undefined,
                pages: [],
                images: withImages ? quoteRegions.slice(0, 3).map((item) => ({ page: item.page, rect: item.rect })) : undefined,
                uploads: uploads.length ? uploads : undefined,
                imageOnly: imageOnly || undefined,
                sessionId,
              },
              (event) => {
                if (event.type === 'meta' && event.sessionId) {
                  const nextSessionId = event.sessionId
                  updateDocument(filePath, (record) => ({
                    ...record,
                    items: record.items.map((item) => (item.id === conversationId ? { ...item, sessionId: nextSessionId } : item)),
                  }))
                } else if (event.type === 'delta') {
                  buffered += event.text
                  const value = buffered
                  patchMessage(filePath, replyId, (message) => ({ ...message, text: value }))
                } else if (event.type === 'reasoning') {
                  reasoningText = (reasoningText + event.text).slice(-6000)
                  const value = reasoningText
                  patchMessage(filePath, replyId, (message) => ({ ...message, reasoning: value }))
                } else if (event.type === 'tool') {
                  patchMessage(filePath, replyId, (message) => ({ ...message, activity: event.label }))
                } else if (event.type === 'annotations') {
                  refreshAnnotations()
                } else if (event.type === 'file') {
                  patchMessage(filePath, replyId, (message) => {
                    const files = Array.isArray(message.files) ? message.files : []
                    if (files.some((file) => file.path === event.path)) return message
                    return { ...message, files: [...files, { path: event.path, name: event.name }] }
                  })
                } else if (event.type === 'error') {
                  const value = buffered ? `${buffered}\n\n⚠︎ ${event.message}` : event.message
                  buffered = value
                  patchMessage(filePath, replyId, (message) => ({ ...message, text: value, error: true, streaming: false }))
                }
              },
              controller.signal,
            )
          } catch (problem) {
            if (!controller.signal.aborted) {
              const value = problem && problem.message ? problem.message : String(problem)
              patchMessage(filePath, replyId, (message) => ({ ...message, text: value, error: true, streaming: false }))
            }
          } finally {
            patchMessage(filePath, replyId, (message) => ({ ...message, streaming: false, activity: undefined }))
            abortRef.current = null
            setAsking(false)
          }
        },
        [doc, page, asking, quote, messages, activeConversation, pagesData, appendExchange, patchMessage, chatCollapsed, imageSupportNow, modelChoice, draftImages, refreshAnnotations],
      )

      const stop = useCallback(() => {
        if (abortRef.current) abortRef.current.abort()
        if (doc) {
          updateDocument(doc.path, (record) => ({
            ...record,
            items: record.items.map((item) => ({
              ...item,
              messages: item.messages.map((message) =>
                message.streaming && !message.text ? { ...message, text: '（已停止）', streaming: false } : message,
              ),
            })),
          }))
        }
        setAsking(false)
      }, [doc, updateDocument])

      const attachQuote = useCallback(() => {
        if (!pill) return
        setQuote({ text: pill.text, pages: pill.pages })
        setPill(null)
        if (chatCollapsed) {
          setChatCollapsed(false)
          setTimeout(() => {
            if (inputRef.current) inputRef.current.focus()
          }, 0)
        } else if (inputRef.current) {
          inputRef.current.focus()
        }
      }, [pill, chatCollapsed])

      const quoteAndSend = useCallback(
        (prompt) => {
          if (!pill) return
          send(prompt, { quote: { text: pill.text, pages: pill.pages } })
        },
        [pill, send],
      )

      const copyText = useCallback((text) => {
        try {
          navigator.clipboard.writeText(text)
          setToast('已复制')
          setTimeout(() => setToast(''), 1200)
        } catch {}
      }, [])

      // Save an answer (or just the selected part of it) as a workspace file.
      const openExportDialog = useCallback(
        (message, event) => {
          if (!message || !message.text) return
          let text = message.text
          let excerpt = false
          try {
            const bubble = event && event.currentTarget ? event.currentTarget.closest('.pdfr-msg') : null
            const selection = window.getSelection && window.getSelection()
            if (bubble && selection && !selection.isCollapsed && selection.rangeCount) {
              const range = selection.getRangeAt(0)
              if (bubble.contains(range.commonAncestorContainer)) {
                const picked = selection.toString().trim()
                if (picked) {
                  text = picked
                  excerpt = true
                }
              }
            }
          } catch {}
          const title = exportNameFrom(text)
          setExportDialog({
            text,
            excerpt,
            title,
            name: title,
            page: Number(message.page) || page,
            directory: '',
            format: 'md',
            busy: false,
            done: '',
            error: '',
          })
          // Show the absolute workspace root so the saved file is easy to find.
          api
            .browse('')
            .then((data) => {
              const root = data && Array.isArray(data.roots) ? data.roots[0] : ''
              if (!root) return
              setExportDialog((value) => (value && !value.directory ? { ...value, directory: root } : value))
            })
            .catch(() => {})
        },
        [page],
      )

      const closeExportDialog = useCallback(() => setExportDialog(null), [])

      const saveExport = useCallback(async () => {
        const current = exportDialog
        if (!current || current.busy || !doc) return
        setExportDialog((value) => (value ? { ...value, busy: true, error: '' } : value))
        try {
          const content = buildExportContent({
            format: current.format,
            title: current.title,
            documentTitle: doc.title || doc.path,
            page: current.page,
            text: current.text,
            excerpt: current.excerpt,
          })
          const response = await fetch('/pdf-reader/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: current.name,
              format: current.format,
              directory: current.directory,
              content,
            }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok === false) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          setExportDialog((value) => (value ? { ...value, busy: false, done: payload.path, error: '' } : value))
        } catch (problem) {
          const message = problem && problem.message ? problem.message : String(problem)
          setExportDialog((value) => (value ? { ...value, busy: false, error: message } : value))
        }
      }, [exportDialog, doc])

      useEffect(() => {
        if (!exportDialog) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setExportDialog(null)
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [exportDialog])

      // Attach images to the next question: paste, drop, or pick files.
      const addImageFiles = useCallback(
        async (files) => {
          const list = Array.from(files || []).filter((file) => file && typeof file.type === 'string' && file.type.startsWith('image/'))
          if (!list.length) return
          const room = Math.max(0, 3 - draftImages.length)
          if (!room) {
            setToast('最多附 3 张图片')
            return
          }
          const accepted = list.slice(0, room)
          for (const file of accepted) {
            try {
              const result = await readImageFile(file)
              setDraftImages((previous) => (previous.length >= 3 ? previous : [...previous, { id: uid(), name: file.name || '图片.png', dataUrl: result.dataUrl }]))
            } catch {
              setToast('图片读取失败')
            }
          }
          if (list.length > room) setToast('最多附 3 张图片')
        },
        [draftImages.length],
      )

      const removeDraftImage = useCallback((id) => {
        setDraftImages((previous) => previous.filter((image) => image.id !== id))
      }, [])

      // View ------------------------------------------------------------------
      const zoomBy = useCallback((factor) => {
        setZoomMode('custom')
        setZoom((previous) => clamp(previous * factor, 0.3, 3.5))
      }, [])

      const chooseLayout = useCallback((mode) => {
        setLayoutMenu(false)
        if (mode === 'actual') {
          setZoomMode('custom')
          setZoom(1)
          return
        }
        if (mode === 'custom') return
        setZoomMode(mode)
      }, [])

      const chooseZoom = useCallback((value) => {
        setLayoutMenu(false)
        setZoomMode('custom')
        setZoom(clamp(value, 0.3, 3.5))
      }, [])

      const chooseModel = useCallback(
        (providerId, modelId) => {
          const provider = catalogue && (catalogue.providers || []).find((item) => item.id === providerId)
          const model = provider && provider.models.find((item) => item.id === modelId)
          if (!model) return
          const defaultEffort = model.reasoning && model.reasoning.defaultEffort ? model.reasoning.defaultEffort : ''
          setModelChoice({ provider: providerId, model: modelId, reasoningEffort: defaultEffort })
        },
        [catalogue],
      )

      const chooseEffort = useCallback((effortId) => {
        setModelChoice((current) => (current ? { ...current, reasoningEffort: effortId } : current))
      }, [])

      useEffect(() => {
        if (!modelMenu) return undefined
        const onDown = (event) => {
          if (event.target.closest && event.target.closest('.pdfr-model')) return
          setModelMenu(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setModelMenu(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [modelMenu])

      useEffect(() => {
        if (!layoutMenu) return undefined
        const onDown = (event) => {
          if (event.target.closest && event.target.closest('.pdfr-zoom')) return
          setLayoutMenu(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setLayoutMenu(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [layoutMenu])

      useEffect(() => {
        if (!convMenu) return undefined
        const onDown = (event) => {
          if (event.target.closest && event.target.closest('.pdfr-conv')) return
          setConvMenu(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setConvMenu(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [convMenu])

      useEffect(() => {
        if (!annotationMenu) return undefined
        const onDown = (event) => {
          if (event.target.closest && event.target.closest('.pdfr-anno-menu-wrap')) return
          setAnnotationMenu(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setAnnotationMenu(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [annotationMenu])

      // Splitter --------------------------------------------------------------
      const beginSplit = useCallback(
        (event) => {
          if (event.button !== undefined && event.button !== 0) return
          const container = bodyRef.current
          if (!container) return
          event.preventDefault()
          setResizing(true)
          const startX = event.clientX
          const startWidth = chatWidth
          const move = (moveEvent) => {
            const maxWidth = Math.max(300, Math.min(760, container.clientWidth - 320))
            setChatWidth(clamp(startWidth + (startX - moveEvent.clientX), 300, maxWidth))
          }
          const finish = () => {
            setResizing(false)
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', finish)
            document.removeEventListener('pointercancel', finish)
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', finish)
          document.addEventListener('pointercancel', finish)
        },
        [chatWidth],
      )

      const nudgeSplit = useCallback((delta) => {
        setChatWidth((width) => clamp(width + delta, 300, 760))
      }, [])

      const hasDoc = Boolean(doc)

      const pageNodeCallbacks = useRef(new Map())
      const pageNodeRef = useCallback((number) => {
        let callback = pageNodeCallbacks.current.get(number)
        if (!callback) {
          callback = (element) => {
            if (element) pageNodesRef.current.set(number, element)
            else pageNodesRef.current.delete(number)
          }
          pageNodeCallbacks.current.set(number, callback)
        }
        return callback
      }, [])

      const renderTextLayer = (data) =>
        h(
          'div',
          { className: 'pdfr-textlayer' },
          (data.spans || []).map((span, index) =>
            h(
              'span',
              {
                key: index,
                className: 'pdfr-word',
                style: {
                  left: `${span[0] * zoom}px`,
                  top: `${span[1] * zoom}px`,
                  width: `${Math.max(1, (span[2] - span[0]) * zoom)}px`,
                  height: `${Math.max(1, (span[3] - span[1]) * zoom)}px`,
                  fontSize: `${Math.max(4, span[4] * zoom)}px`,
                },
              },
              span[5],
            ),
          ),
        )

      const renderPageBlock = (number) => {
        const data = pagesData[number]
        const width = (data ? data.width : doc.width || 595) * zoom
        const height = (data ? data.height : doc.height || 842) * zoom
        const error = pageErrors[number]
        return h(
          'div',
          {
            key: number,
            className: 'pdfr-page-block',
            ref: pageNodeRef(number),
          },
          h(
            'div',
            {
              className: `pdfr-stage${number === page ? ' is-current' : ''}`,
              'data-page': number,
              style: { width: `${width}px`, height: `${height}px` },
            },
            data
              ? h('img', {
                  className: 'pdfr-pageimg',
                  src: `data:image/png;base64,${data.image}`,
                  alt: `第 ${number} 页`,
                  draggable: false,
                  style: { width: `${width}px`, height: `${height}px` },
                })
              : h(
                  'div',
                  { className: 'pdfr-page-placeholder' },
                  error
                    ? h('span', { className: 'pdfr-error' }, error)
                    : loadingPages[number]
                      ? h('span', { className: 'pdfr-spinner' })
                      : h('span', { className: 'pdfr-placeholder-label' }, `第 ${number} 页`),
                ),
            annotations.filter((item) => item.page === number).map((item) =>
              item.rects.map((rect, index) =>
                h('div', {
                  key: `anno-${item.id}-${index}`,
                  className: `pdfr-anno-fill is-${item.color || 'yellow'}`,
                  style: {
                    left: `${rect[0] * zoom}px`,
                    top: `${rect[1] * zoom}px`,
                    width: `${Math.max(2, (rect[2] - rect[0]) * zoom)}px`,
                    height: `${Math.max(2, (rect[3] - rect[1]) * zoom)}px`,
                  },
                }),
              ),
            ),
            data ? renderTextLayer(data) : null,
            highlight && highlight.page === number
              ? (highlight.rects || []).map((rect, index) =>
                  h('div', {
                    key: `hit-${index}`,
                    className: 'pdfr-hit',
                    style: {
                      left: `${rect[0] * zoom}px`,
                      top: `${rect[1] * zoom}px`,
                      width: `${Math.max(2, (rect[2] - rect[0]) * zoom)}px`,
                      height: `${Math.max(2, (rect[3] - rect[1]) * zoom)}px`,
                    },
                  }),
                )
              : null,
            annotations.filter((item) => item.page === number).map((item) =>
              h('button', {
                key: `anno-mark-${item.id}`,
                type: 'button',
                className: `pdfr-anno-mark is-${item.color || 'yellow'}`,
                style: { left: `${item.rects[0][2] * zoom}px`, top: `${item.rects[0][1] * zoom - 6}px` },
                title: item.note || item.quote || '标注',
                onClick: (event) => openAnnotationEditor(item, event),
              }),
            ),
          ),
          h('div', { className: 'pdfr-page-label' }, `第 ${number} 页`),
        )
      }

      const renderSinglePage = () => {
        const data = currentPageData
        const width = (data ? data.width : doc.width || 595) * zoom
        const height = (data ? data.height : doc.height || 842) * zoom
        const error = pageErrors[page]
        return h(
          'div',
          { className: 'pdfr-stage-wrap', style: { width: `${width}px`, height: `${height}px` } },
          h(
            'div',
            {
              className: 'pdfr-stage',
              'data-page': page,
              style: { width: `${width}px`, height: `${height}px` },
            },
            data
              ? h('img', {
                  className: 'pdfr-pageimg',
                  src: `data:image/png;base64,${data.image}`,
                  alt: `第 ${page} 页`,
                  draggable: false,
                  style: { width: `${width}px`, height: `${height}px` },
                })
              : h(
                  'div',
                  { className: 'pdfr-page-placeholder' },
                  error
                    ? h('span', { className: 'pdfr-error' }, error)
                    : loadingPages[page]
                      ? h('span', { className: 'pdfr-spinner' })
                      : h('span', { className: 'pdfr-placeholder-label' }, '正在准备…'),
                ),
            annotations.filter((item) => item.page === page).map((item) =>
              item.rects.map((rect, index) =>
                h('div', {
                  key: `anno-${item.id}-${index}`,
                  className: `pdfr-anno-fill is-${item.color || 'yellow'}`,
                  style: {
                    left: `${rect[0] * zoom}px`,
                    top: `${rect[1] * zoom}px`,
                    width: `${Math.max(2, (rect[2] - rect[0]) * zoom)}px`,
                    height: `${Math.max(2, (rect[3] - rect[1]) * zoom)}px`,
                  },
                }),
              ),
            ),
            data ? renderTextLayer(data) : null,
            highlight && highlight.page === page
              ? (highlight.rects || []).map((rect, index) =>
                  h('div', {
                    key: `hit-${index}`,
                    className: 'pdfr-hit',
                    style: {
                      left: `${rect[0] * zoom}px`,
                      top: `${rect[1] * zoom}px`,
                      width: `${Math.max(2, (rect[2] - rect[0]) * zoom)}px`,
                      height: `${Math.max(2, (rect[3] - rect[1]) * zoom)}px`,
                    },
                  }),
                )
              : null,
            annotations.filter((item) => item.page === page).map((item) =>
              h('button', {
                key: `anno-mark-${item.id}`,
                type: 'button',
                className: `pdfr-anno-mark is-${item.color || 'yellow'}`,
                style: { left: `${item.rects[0][2] * zoom}px`, top: `${item.rects[0][1] * zoom - 6}px` },
                title: item.note || item.quote || '标注',
                onClick: (event) => openAnnotationEditor(item, event),
              }),
            ),
          ),
        )
      }

      const renderPill = () =>
        pill
          ? h(
              'div',
              { className: 'pdfr-pill', style: { left: `${pill.left}px`, top: `${pill.top}px` } },
              h(
                'button',
                { type: 'button', className: 'pdfr-pill-primary', onMouseDown: (event) => event.preventDefault(), onClick: attachQuote },
                h(Icon, { name: 'chat', size: 13 }),
                pill.pages && pill.pages.length > 1 ? `问这 ${pill.pages.length} 页` : '问这段',
              ),
              h(
                'button',
                { type: 'button', className: 'pdfr-pill-btn', onMouseDown: (event) => event.preventDefault(), onClick: () => quoteAndSend('解释我选中的这段内容在说什么。') },
                '解释',
              ),
              h(
                'button',
                { type: 'button', className: 'pdfr-pill-btn', onMouseDown: (event) => event.preventDefault(), onClick: () => quoteAndSend('把选中的这段翻译成中文（若原文已是中文则翻译成英文）。') },
                '翻译',
              ),
              h(
                'button',
                { type: 'button', className: 'pdfr-pill-btn', onMouseDown: (event) => event.preventDefault(), onClick: openAnnotationFromSelection },
                '标注',
              ),
            )
          : null

      const renderModelMenu = () => {
        if (modelLoading) return h('div', { className: 'pdfr-muted pdfr-pad' }, '正在加载模型…')
        if (!modelEntries.length) return h('div', { className: 'pdfr-muted pdfr-pad' }, '没有可用模型')
        const rows = []
        for (const { provider, model } of modelEntries) {
          const chosen = Boolean(modelChoice && modelChoice.provider === provider.id && modelChoice.model === model.id)
          const vision = Boolean(model.modalities && model.modalities.includes('image'))
          rows.push(
            h(
              'button',
              {
                key: `m:${model.id}`,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': chosen,
                className: 'pdfr-menu-item',
                title: model.description || '',
                onClick: () => chooseModel(provider.id, model.id),
              },
              h(
                'span',
                { className: 'pdfr-model-row' },
                h('span', { className: 'pdfr-model-label' }, model.name || model.id),
                h('span', { className: `pdfr-model-tag${vision ? ' has-vision' : ''}` }, vision ? '视觉' : '文字'),
              ),
              chosen ? h('span', { className: 'pdfr-menu-check' }, '✓') : null,
            ),
          )
        }
        rows.push(h('div', { key: 'sep', className: 'pdfr-menu-sep' }))
        rows.push(h('div', { key: 'effort-label', className: 'pdfr-menu-label' }, '思考强度'))
        if (effortOptions.length) {
          const defaultChosen = !modelChoice || !modelChoice.reasoningEffort
          rows.push(
            h(
              'button',
              {
                key: 'effort:default',
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': defaultChosen,
                className: 'pdfr-menu-item',
                onClick: () => chooseEffort(''),
              },
              h('span', null, '模型默认'),
              defaultChosen ? h('span', { className: 'pdfr-menu-check' }, '✓') : null,
            ),
          )
          for (const effort of effortOptions) {
            const chosen = Boolean(modelChoice && modelChoice.reasoningEffort === effort.id)
            rows.push(
              h(
                'button',
                {
                  key: `effort:${effort.id}`,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': chosen,
                  className: 'pdfr-menu-item',
                  title: effort.description || '',
                  onClick: () => chooseEffort(effort.id),
                },
                h('span', null, effort.name || effort.id),
                chosen ? h('span', { className: 'pdfr-menu-check' }, '✓') : null,
              ),
            )
          }
        } else {
          rows.push(h('div', { key: 'effort-none', className: 'pdfr-muted pdfr-pad' }, '该模型不支持思考强度'))
        }
        const providerCount = catalogue && catalogue.providers ? catalogue.providers.filter((provider) => provider.models && provider.models.length).length : 0
        if (providerCount > 1) {
          rows.push(h('div', { key: 'merge-note', className: 'pdfr-menu-note' }, '同一模型在多个接入方可用时已合并显示'))
        }
        return rows
      }

      return h(
        'div',
        {
          className: `pdfr-root${marquee ? ' pdfr-marqueeing' : ''}`,
          onClickCapture: (event) => {
            if (!clickGuardRef.current) return
            event.preventDefault()
            event.stopPropagation()
          },
          onDragEnter: (event) => {
            event.preventDefault()
            dragDepth.current += 1
            setDropping(true)
          },
          onDragOver: (event) => event.preventDefault(),
          onDragLeave: () => {
            dragDepth.current = Math.max(0, dragDepth.current - 1)
            if (!dragDepth.current) setDropping(false)
          },
          onDrop: (event) => {
            event.preventDefault()
            dragDepth.current = 0
            setDropping(false)
            const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
            if (file) importFile(file)
          },
        },
        h(
          'header',
          { className: 'pdfr-top' },
          h(
            'div',
            { className: 'pdfr-top-left' },
            h(
              'button',
              { type: 'button', className: 'pdfr-btn', onClick: chooseFile, title: '打开 PDF' },
              h(Icon, { name: 'book', size: 15 }),
              h('span', null, '打开 PDF'),
            ),
            doc
              ? h(
                  'div',
                  { className: 'pdfr-doc' },
                  h('span', { className: 'pdfr-doc-title', title: doc.path }, doc.title || 'PDF'),
                  h('span', { className: 'pdfr-doc-meta' }, `第 ${page} 页 / 共 ${doc.pages} 页`),
                )
              : h('span', { className: 'pdfr-muted' }, '把 PDF 拖进来开始阅读'),
          ),
          h(
            'div',
            { className: 'pdfr-top-right' },
            h(
              'button',
              {
                type: 'button',
                className: `pdfr-modebtn${viewMode === 'continuous' ? ' is-on' : ''}`,
                onClick: toggleViewMode,
                disabled: !hasDoc,
                title: viewMode === 'continuous' ? '切换到单页模式' : '切换到连续多页模式',
              },
              viewMode === 'continuous' ? '连续' : '单页',
            ),
            h(
              'div',
              { className: 'pdfr-group' },
              h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => goToPage(page - 1), disabled: !hasDoc || page <= 1, title: '上一页 (←)' }, h(Icon, { name: 'left' })),
              h('input', {
                className: 'pdfr-pageinput',
                value: page,
                disabled: !hasDoc,
                onChange: (event) => {
                  const value = Number(event.target.value.replace(/\D/g, ''))
                  if (value) goToPage(value)
                },
                title: '页码',
                'aria-label': '页码',
              }),
              h('span', { className: 'pdfr-muted' }, `/ ${doc ? doc.pages : '–'}`),
              h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => goToPage(page + 1), disabled: !hasDoc || (doc && page >= doc.pages), title: '下一页 (→)' }, h(Icon, { name: 'right' })),
            ),
            h(
              'div',
              { className: 'pdfr-zoom' },
              h(
                'div',
                { className: 'pdfr-group' },
                h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => zoomBy(1 / 1.15), disabled: !hasDoc, title: '缩小' }, h(Icon, { name: 'minus' })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pdfr-zoomlabel',
                    onClick: () => setLayoutMenu((value) => !value),
                    disabled: !hasDoc,
                    title: '缩放与版面',
                    'aria-haspopup': 'menu',
                    'aria-expanded': layoutMenu,
                  },
                  `${Math.round(zoom * 100)}%`,
                  h('span', { className: 'pdfr-caret-sm' }),
                ),
                h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => zoomBy(1.15), disabled: !hasDoc, title: '放大' }, h(Icon, { name: 'plus' })),
              ),
              layoutMenu
                ? h(
                    'div',
                    { className: 'pdfr-menu', role: 'menu' },
                    [
                      ['fit-width', '适应宽度'],
                      ['fit-page', '适应页面'],
                      ['actual', '实际大小 100%'],
                    ].map(([mode, label]) =>
                      h(
                        'button',
                        {
                          key: mode,
                          type: 'button',
                          role: 'menuitemradio',
                          'aria-checked': zoomMode === mode || (mode === 'actual' && zoomMode === 'custom' && Math.abs(zoom - 1) < 0.005),
                          className: 'pdfr-menu-item',
                          onClick: () => chooseLayout(mode),
                        },
                        h('span', null, label),
                        zoomMode === mode || (mode === 'actual' && zoomMode === 'custom' && Math.abs(zoom - 1) < 0.005)
                          ? h('span', { className: 'pdfr-menu-check' }, '✓')
                          : null,
                      ),
                    ),
                    h('div', { className: 'pdfr-menu-sep' }),
                    [0.5, 0.75, 1.25, 1.5, 2].map((value) =>
                      h(
                        'button',
                        {
                          key: value,
                          type: 'button',
                          role: 'menuitemradio',
                          'aria-checked': zoomMode === 'custom' && Math.abs(zoom - value) < 0.005,
                          className: 'pdfr-menu-item',
                          onClick: () => chooseZoom(value),
                        },
                        h('span', null, `${Math.round(value * 100)}%`),
                        zoomMode === 'custom' && Math.abs(zoom - value) < 0.005 ? h('span', { className: 'pdfr-menu-check' }, '✓') : null,
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pdfr-iconbtn',
                onClick: () => setChatCollapsed((value) => !value),
                title: chatCollapsed ? '展开对话' : '收起对话',
                'aria-pressed': !chatCollapsed,
              },
              h(Icon, { name: 'chat' }),
            ),
          ),
        ),
        doc
          ? h('div', { className: 'pdfr-progress' }, h('span', { style: { width: `${Math.min(100, (page / Math.max(1, doc.pages)) * 100)}%` } }))
          : null,
        h(
          'div',
          { className: resizing ? 'pdfr-body pdfr-resizing' : 'pdfr-body', ref: bodyRef },
          h(
            'section',
            { className: 'pdfr-reader' },
            !doc
              ? h(
                  'div',
                  { className: 'pdfr-empty' },
                  h('div', { className: 'pdfr-empty-icon' }, h(Icon, { name: 'book', size: 34 })),
                  h('h2', null, '把 PDF 拖到这里'),
                  h('p', null, '左边读一页，右边是整篇共用的对话；选中原文就能直接追问。'),
                  h(
                    'button',
                    { type: 'button', className: 'pdfr-btn pdfr-btn-primary', onClick: chooseFile },
                    h(Icon, { name: 'plus', size: 15 }),
                    h('span', null, '打开 PDF'),
                  ),
                  recent.length
                    ? h(
                        'div',
                        { className: 'pdfr-empty-recent' },
                        h('div', { className: 'pdfr-section-label' }, '最近打开'),
                        h(RecentList, { items: recent, onOpen: openDoc, onForget: forgetDocument }),
                      )
                    : null,
                )
              : h(
                  'div',
                  {
                    className: `pdfr-stage-scroll${viewMode === 'continuous' ? ' is-continuous' : ''}`,
                    ref: scrollRef,
                    onMouseUp: handleReaderMouseUp,
                    onMouseDown: handleReaderMouseDown,
                    onContextMenu: (event) => event.preventDefault(),
                  },
                  loadError
                    ? h('div', { className: 'pdfr-error pdfr-pad' }, loadError)
                    : null,
                  viewMode === 'continuous'
                    ? h(
                        'div',
                        { className: 'pdfr-pages' },
                        Array.from({ length: doc.pages || 1 }, (_, index) => renderPageBlock(index + 1)),
                      )
                    : renderSinglePage(),
                  marquee
                    ? h('div', {
                        className: 'pdfr-marquee',
                        style: {
                          left: `${marquee.left}px`,
                          top: `${marquee.top}px`,
                          width: `${Math.max(1, marquee.width)}px`,
                          height: `${Math.max(1, marquee.height)}px`,
                        },
                      })
                    : null,
                  renderPill(),
                  viewMode === 'single' && currentPageData
                    ? h(
                        'div',
                        { className: 'pdfr-stage-hint' },
                        h(Icon, { name: 'spark', size: 13 }),
                        h('span', null, '选中页面上的文字，可以就这段直接提问'),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'pdfr-pager' },
                    h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => goToPage(page - 1), disabled: page <= 1, title: '上一页' }, h(Icon, { name: 'left' })),
                    h('span', { className: 'pdfr-pager-label' }, `第 ${page} 页`),
                    h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: () => goToPage(page + 1), disabled: doc && page >= doc.pages, title: '下一页' }, h(Icon, { name: 'right' })),
                  ),
                ),
                marquee ? h('div', { className: 'pdfr-marquee-tip' }, '框选图片 · 滚轮翻页 · 左键确认 · Esc 取消') : null,
          ),
          chatCollapsed
            ? null
            : h('div', {
                className: 'pdfr-split',
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': '调整对话宽度',
                'aria-valuenow': Math.round(chatWidth),
                tabIndex: 0,
                title: '拖动调整对话宽度，双击复位',
                onPointerDown: beginSplit,
                onDoubleClick: () => setChatWidth(390),
                onKeyDown: (event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    nudgeSplit(16)
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    nudgeSplit(-16)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    setChatWidth(390)
                  }
                },
              }),
          chatCollapsed
            ? null
            : h(
                'aside',
                { className: 'pdfr-chat', style: { width: `${chatWidth}px` } },
            h(
              'div',
              { className: 'pdfr-chat-head' },
              h('span', { className: 'pdfr-chat-mark', 'aria-hidden': true }, h(Icon, { name: 'spark', size: 13 })),
              doc
                ? h(
                    'div',
                    { className: 'pdfr-conv' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pdfr-conv-btn',
                        onClick: () => setConvMenu((value) => !value),
                        title: '切换或新建整篇的对话',
                        'aria-haspopup': 'menu',
                        'aria-expanded': convMenu,
                      },
                      h('span', { className: 'pdfr-conv-page' }, '整篇 ·'),
                      h('span', { className: 'pdfr-conv-title' }, activeConversation && activeConversation.title ? activeConversation.title : '对话'),
                      h('span', { className: 'pdfr-caret-sm' }),
                    ),
                    convMenu
                      ? h(
                          'div',
                          { className: 'pdfr-menu pdfr-conv-menu', role: 'menu' },
                          conversations.length
                            ? conversations.map((item) =>
                                h(
                                  'div',
                                  {
                                    key: item.id,
                                    className: `pdfr-conv-row${item.id === (activeConversation && activeConversation.id) ? ' is-active' : ''}`,
                                  },
                                  h(
                                    'button',
                                    { type: 'button', className: 'pdfr-conv-pick', onClick: () => selectConversation(item.id) },
                                    h('span', { className: 'pdfr-conv-name' }, item.title || '新对话'),
                                    h(
                                      'span',
                                      { className: 'pdfr-conv-meta' },
                                      conversationMeta(item),
                                    ),
                                  ),
                                  h(
                                    'button',
                                    { type: 'button', className: 'pdfr-iconbtn pdfr-conv-del', title: '删除这个对话', onClick: () => removeConversation(item.id) },
                                    h(Icon, { name: 'close', size: 11 }),
                                  ),
                                ),
                              )
                            : h('div', { className: 'pdfr-muted pdfr-pad' }, '还没有对话'),
                          h('div', { className: 'pdfr-menu-sep' }),
                          h('button', { type: 'button', className: 'pdfr-menu-item', onClick: startConversation }, h('span', null, '＋ 新对话')),
                        )
                      : null,
                  )
                : h('div', { className: 'pdfr-chat-title' }, '对话'),
              doc
                ? h(
                    'div',
                    { className: 'pdfr-chat-actions' },
                    h(
                      'div',
                      { className: 'pdfr-anno-menu-wrap' },
                      h(
                        'button',
                        { type: 'button', className: 'pdfr-minibtn', onClick: () => setAnnotationMenu((value) => !value), title: '查看这篇 PDF 的标注' },
                        `标注 ${annotations.length}`,
                      ),
                      annotationMenu
                        ? h(
                            'div',
                            { className: 'pdfr-menu pdfr-anno-menu', role: 'menu' },
                            annotations.length
                              ? annotations.map((item) =>
                                  h(
                                    'button',
                                    {
                                      key: item.id,
                                      type: 'button',
                                      className: 'pdfr-menu-item pdfr-anno-item',
                                      onClick: () => {
                                        setAnnotationMenu(false)
                                        goToPage(item.page)
                                        flashHighlight(item.page, item.rects)
                                      },
                                    },
                                    h(
                                      'span',
                                      { className: 'pdfr-anno-item-main' },
                                      h('span', { className: 'pdfr-anno-item-page' }, `第 ${item.page} 页${item.author === 'ai' ? ' · AI' : ''}`),
                                      h('span', { className: 'pdfr-anno-item-text' }, item.note || item.quote || '（无备注）'),
                                    ),
                                    h('span', { className: `pdfr-anno-dot is-${item.color || 'yellow'}` }),
                                  ),
                                )
                              : h('div', { className: 'pdfr-muted pdfr-pad' }, '还没有标注。选中文字后点「标注」即可。'),
                          )
                        : null,
                    ),
                    h('button', { type: 'button', className: 'pdfr-iconbtn pdfr-chat-new', onClick: startConversation, title: '新建一个空白对话' }, h(Icon, { name: 'plus', size: 14 })),
                  )
                : null,
            ),
            doc
              ? h(
                  'div',
                  {
                    className: 'pdfr-context',
                    title: '上下文规则：只发你选中的文字（带页码）或框选的图片；没有选中内容时，模型会自己按需查阅当前页、前后页或全文检索。对话只带最近 8 轮（每轮上限 400 字）。',
                  },
                  h(
                    'span',
                    null,
                    `上下文：${contextPlan.label} · 整篇 ${turnCount} 轮 · 约 ${contextChars >= 1000 ? `${(contextChars / 1000).toFixed(1)}k` : contextChars} 字`,
                  ),
                )
              : null,
            h(
              'div',
              { className: 'pdfr-thread', ref: threadRef },
              !hasDoc
                ? h(
                    'div',
                    { className: 'pdfr-thread-empty' },
                    h('div', { className: 'pdfr-empty-icon pdfr-empty-icon-sm' }, h(Icon, { name: 'chat', size: 22 })),
                    h('p', null, '打开一个 PDF，对话会出现在这里。'),
                  )
                : null,
              messages.map((message) =>
                message.role === 'user'
                  ? h(
                      'div',
                      { key: message.id, className: 'pdfr-msg pdfr-msg-user' },
                      message.page && Number(message.page) !== Number(page)
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'pdfr-msg-page',
                              onClick: () => goToPage(message.page),
                              title: `跳到第 ${message.page} 页`,
                            },
                            `第 ${message.page} 页`,
                          )
                        : null,
                      message.imageCount ? h('span', { className: 'pdfr-msg-note' }, `附 ${message.imageCount} 张图片`) : null,
                      message.quote || message.quoteRegion || message.quoteImages
                        ? h(Quote, {
                            text: message.quote || '图片区域',
                            label: message.quoteImages
                              ? `框选图片 第 ${message.quotePages && message.quotePages.length > 1 ? `${message.quotePages[0]}–${message.quotePages[message.quotePages.length - 1]}` : (message.quotePages && message.quotePages[0]) || message.page} 页${message.quoteAnnotations ? ` · 含 ${message.quoteAnnotations} 条标注` : ''}`
                              : message.quoteRegion
                                ? `框选 第 ${message.quotePages && message.quotePages.length > 1 ? `${message.quotePages[0]}–${message.quotePages[message.quotePages.length - 1]}` : (message.quotePages && message.quotePages[0]) || message.page} 页${message.quoteAnnotations ? ` · 含 ${message.quoteAnnotations} 条标注` : ''}`
                                : message.quotePages && message.quotePages.length > 1
                                  ? `第 ${message.quotePages[0]}–${message.quotePages[message.quotePages.length - 1]} 页`
                                  : null,
                          })
                        : null,
                      h('div', { className: 'pdfr-bubble pdfr-bubble-user' }, message.text),
                    )
                  : h(
                      'div',
                      { key: message.id, className: 'pdfr-msg pdfr-msg-assistant' },
                      h(
                        'div',
                        { className: `pdfr-bubble pdfr-bubble-assistant${message.error ? ' pdfr-bubble-error' : ''}` },
                        message.text
                          ? h(RichText, { text: message.text, onGoPage: goToPage, onLocateQuote: locateQuote })
                          : message.streaming
                            ? h(
                                'span',
                                { className: 'pdfr-typing-wrap' },
                                message.reasoning ? h('span', { className: 'pdfr-thinking-label' }, '思考中…') : null,
                                h('span', { className: 'pdfr-typing' }, h('span'), h('span'), h('span')),
                              )
                            : null,
                        message.streaming && message.text ? h('span', { className: 'pdfr-caret' }) : null,
                      ),
                      message.reasoning
                        ? h(
                            'details',
                            { className: 'pdfr-reasoning' },
                            h('summary', null, `思考过程${message.streaming && !message.text ? '（进行中）' : ''}`),
                            h('div', { className: 'pdfr-reasoning-body' }, message.reasoning.slice(-3000)),
                          )
                        : null,
                      message.streaming && message.activity
                        ? h('div', { className: 'pdfr-activity' }, h('span', { className: 'pdfr-spinner' }), h('span', null, message.activity))
                        : null,
                      message.files && message.files.length
                        ? h(
                            'div',
                            { className: 'pdfr-files' },
                            message.files.map((file) =>
                              h(
                                'div',
                                { key: file.path, className: 'pdfr-file', title: file.path },
                                h(Icon, { name: 'file', size: 14 }),
                                h('span', { className: 'pdfr-file-name' }, file.name || file.path),
                                h('button', { type: 'button', className: 'pdfr-minibtn', onClick: () => copyText(file.path) }, '复制路径'),
                              ),
                            ),
                          )
                        : null,
                      message.text && !message.streaming && !message.error
                        ? h(
                            'div',
                            { className: 'pdfr-msg-actions' },
                            h('button', { type: 'button', className: 'pdfr-minibtn', onClick: () => copyText(message.text) }, '复制'),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pdfr-minibtn',
                                title: '保存为文件（选中回答的一部分时只保存选中内容）',
                                onMouseDown: (event) => event.preventDefault(),
                                onClick: (event) => openExportDialog(message, event),
                              },
                              '保存',
                            ),
                          )
                        : null,
                    ),
              ),
            ),
            h(
              'div',
              {
                className: 'pdfr-composer',
                onDragEnter: (event) => {
                  if (event.dataTransfer) event.stopPropagation()
                },
                onDragOver: (event) => {
                  if (!event.dataTransfer) return
                  if (!Array.from(event.dataTransfer.types || []).includes('Files')) return
                  event.preventDefault()
                  event.stopPropagation()
                },
                onDrop: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  addImageFiles(event.dataTransfer && event.dataTransfer.files)
                },
              },
              quote
                ? h(Quote, {
                    text: quote.text || '图片区域（提问时随消息发送）',
                    label: quote.region
                      ? `${quote.images ? '框选图片' : '框选'} 第 ${quote.pages && quote.pages.length > 1 ? `${quote.pages[0]}–${quote.pages[quote.pages.length - 1]}` : (quote.pages && quote.pages[0]) || page} 页${quote.annotationCount ? ` · 含 ${quote.annotationCount} 条标注` : ''}`
                      : quote.pages && quote.pages.length > 1
                        ? `第 ${quote.pages[0]}–${quote.pages[quote.pages.length - 1]} 页`
                        : null,
                    onRemove: () => setQuote(null),
                  })
                : null,
              draftImages.length
                ? h(
                    'div',
                    { className: 'pdfr-attachments' },
                    draftImages.map((image) =>
                      h(
                        'div',
                        { key: image.id, className: 'pdfr-attach', title: image.name },
                        h('img', { src: image.dataUrl, alt: image.name }),
                        h(
                          'button',
                          { type: 'button', className: 'pdfr-attach-remove', onClick: () => removeDraftImage(image.id), title: '移除图片' },
                          h(Icon, { name: 'close', size: 9 }),
                        ),
                      ),
                    ),
                  )
                : null,
              h('textarea', {
                ref: inputRef,
                className: 'pdfr-textarea',
                rows: 1,
                placeholder: doc ? '输入问题，Enter 发送，Shift+Enter 换行' : '打开 PDF 后就可以提问',
                value: draft,
                disabled: !doc,
                onChange: (event) => setDraft(event.target.value),
                onPaste: (event) => {
                  const items = event.clipboardData && event.clipboardData.items
                  if (!items) return
                  const files = []
                  for (let index = 0; index < items.length; index += 1) {
                    const item = items[index]
                    if (item && item.kind === 'file' && item.type && item.type.startsWith('image/')) {
                      const file = item.getAsFile()
                      if (file) files.push(file)
                    }
                  }
                  if (files.length) {
                    event.preventDefault()
                    addImageFiles(files)
                  }
                },
                onInput: (event) => {
                  const node = event.target
                  node.style.height = 'auto'
                  node.style.height = `${Math.min(140, node.scrollHeight)}px`
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    send(draft)
                  }
                },
              }),
              h(
                'div',
                { className: 'pdfr-composer-row' },
                h(
                  'div',
                  { className: 'pdfr-composer-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pdfr-attachbtn',
                      onClick: () => {
                        if (imageInputRef.current) imageInputRef.current.click()
                      },
                      title: '附加图片（也可直接粘贴截图）',
                      disabled: asking || !doc,
                    },
                    h(Icon, { name: 'image', size: 15 }),
                  ),
                  h('input', {
                    ref: imageInputRef,
                    type: 'file',
                    accept: 'image/*',
                    multiple: true,
                    style: { display: 'none' },
                    onChange: (event) => {
                      addImageFiles(event.target.files)
                      event.target.value = ''
                    },
                  }),
                  h(VoiceMic, {
                    disabled: asking || !doc,
                    onText: (text) => {
                      setDraft((value) => (value ? value + ' ' + text : text))
                      const node = inputRef.current
                      if (node) {
                        requestAnimationFrame(() => {
                          node.style.height = 'auto'
                          node.style.height = `${Math.min(140, node.scrollHeight)}px`
                          node.focus()
                        })
                      }
                    },
                  }),
                  h(
                    'div',
                    { className: 'pdfr-model' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pdfr-modelbtn',
                        onClick: () => setModelMenu((value) => !value),
                        title: '选择模型与思考强度',
                        'aria-haspopup': 'menu',
                        'aria-expanded': modelMenu,
                      },
                      h('span', { className: 'pdfr-model-name' }, activeModel ? activeModel.model.name : modelLoading ? '模型…' : '默认模型'),
                      activeEffort ? h('span', { className: 'pdfr-model-effort' }, activeEffort.name) : null,
                      h('span', { className: 'pdfr-caret-sm' }),
                    ),
                    modelMenu ? h('div', { className: 'pdfr-menu pdfr-model-menu', role: 'menu' }, renderModelMenu()) : null,
                  ),
                  asking
                    ? h('button', { type: 'button', className: 'pdfr-send pdfr-send-stop', onClick: stop, title: '停止' }, h('span', { className: 'pdfr-stop-icon' }))
                    : h('button', { type: 'button', className: 'pdfr-send', onClick: () => send(draft), disabled: !doc || !draft.trim(), title: '发送 (Enter)' }, h(Icon, { name: 'send', size: 15 })),
                ),
              ),
            ),
          ),
        ),
        dropping
          ? h('div', { className: 'pdfr-drop' }, h(Icon, { name: 'book', size: 30 }), h('span', null, '松开即可打开'))
          : null,
        annotationEditor
          ? h(
              'div',
              {
                className: 'pdfr-anno-editor',
                style: {
                  left: `${clamp(annotationEditor.x || 16, 12, Math.max(12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 320))}px`,
                  top: `${clamp(annotationEditor.y || 16, 12, Math.max(12, (typeof window !== 'undefined' ? window.innerHeight : 800) - 260))}px`,
                },
              },
              h(
                'div',
                { className: 'pdfr-anno-head' },
                h('span', null, annotationEditor.mode === 'create' ? '新建标注' : `编辑标注 · 第 ${annotationEditor.page} 页`),
                h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: closeAnnotationEditor, title: '关闭' }, h(Icon, { name: 'close', size: 12 })),
              ),
              annotationEditor.quote ? h('div', { className: 'pdfr-anno-quote' }, `「${annotationEditor.quote.slice(0, 140)}」`) : null,
              h('textarea', {
                className: 'pdfr-anno-note',
                rows: 2,
                placeholder: '备注（可留空，只做高亮）',
                value: annotationEditor.note,
                autoFocus: true,
                onChange: (event) => setAnnotationEditor((current) => (current ? { ...current, note: event.target.value } : current)),
              }),
              h(
                'div',
                { className: 'pdfr-anno-colors' },
                ['yellow', 'green', 'blue', 'pink', 'purple'].map((color) =>
                  h('button', {
                    key: color,
                    type: 'button',
                    className: `pdfr-anno-dot is-${color}${annotationEditor.color === color ? ' is-on' : ''}`,
                    title: color,
                    onClick: () => setAnnotationEditor((current) => (current ? { ...current, color } : current)),
                  }),
                ),
              ),
              h(
                'div',
                { className: 'pdfr-anno-actions' },
                annotationEditor.mode === 'edit'
                  ? h('button', { type: 'button', className: 'pdfr-minibtn pdfr-anno-delete', onClick: deleteAnnotation }, '删除')
                  : null,
                h('button', { type: 'button', className: 'pdfr-minibtn', onClick: closeAnnotationEditor }, '取消'),
                h('button', { type: 'button', className: 'pdfr-btn pdfr-btn-primary pdfr-anno-save', onClick: saveAnnotation }, '保存'),
              ),
            )
          : null,
        exportDialog
          ? h(
              'div',
              { className: 'pdfr-modal-mask', onMouseDown: closeExportDialog },
              h(
                'div',
                { className: 'pdfr-export-dialog', onMouseDown: (event) => event.stopPropagation() },
                h(
                  'div',
                  { className: 'pdfr-anno-head' },
                  h('span', null, '保存回答到文件'),
                  h('button', { type: 'button', className: 'pdfr-iconbtn', onClick: closeExportDialog, title: '关闭' }, h(Icon, { name: 'close', size: 12 })),
                ),
                exportDialog.done
                  ? h(
                      'div',
                      { className: 'pdfr-export-success' },
                      h('div', { className: 'pdfr-export-done-label' }, '已保存到工作区'),
                      h('div', { className: 'pdfr-export-meta' }, exportDialog.done),
                      h(
                        'div',
                        { className: 'pdfr-export-actions' },
                        h('button', { type: 'button', className: 'pdfr-minibtn', onClick: () => copyText(exportDialog.done) }, '复制路径'),
                        h('button', { type: 'button', className: 'pdfr-btn pdfr-btn-primary', onClick: closeExportDialog }, '完成'),
                      ),
                    )
                  : h(
                      'div',
                      { className: 'pdfr-export-form' },
                      h(
                        'div',
                        { className: 'pdfr-export-meta' },
                        `《${doc ? doc.title || doc.path : ''}》第 ${exportDialog.page} 页 · ${exportDialog.excerpt ? '选中片段' : '整条回答'} · ${exportDialog.text.length} 字`,
                      ),
                      h('textarea', {
                        className: 'pdfr-export-content',
                        rows: 8,
                        spellCheck: false,
                        placeholder: '要保存的内容',
                        value: exportDialog.text,
                        onChange: (event) => setExportDialog((value) => (value ? { ...value, text: event.target.value } : value)),
                      }),
                h(
                  'label',
                  { className: 'pdfr-export-row' },
                  h('span', null, '文件名'),
                  h('input', {
                    className: 'pdfr-export-input',
                    value: exportDialog.name,
                    autoFocus: true,
                    spellCheck: false,
                    onChange: (event) => setExportDialog((value) => (value ? { ...value, name: event.target.value } : value)),
                  }),
                ),
                h(
                  'div',
                  { className: 'pdfr-export-row' },
                  h('span', null, '格式'),
                  h(
                    'div',
                    { className: 'pdfr-export-formats' },
                    EXPORT_FORMATS.map((format) =>
                      h(
                        'button',
                        {
                          key: format.id,
                          type: 'button',
                          className: `pdfr-chip${exportDialog.format === format.id ? ' pdfr-chip-on' : ''}`,
                          onClick: () => setExportDialog((value) => (value ? { ...value, format: format.id } : value)),
                        },
                        format.label,
                      ),
                    ),
                  ),
                ),
                h(
                  'label',
                  { className: 'pdfr-export-row' },
                  h('span', null, '目录'),
                  h('input', {
                    className: 'pdfr-export-input',
                    value: exportDialog.directory,
                    placeholder: '留空 = 工作区根目录',
                    spellCheck: false,
                    onChange: (event) => setExportDialog((value) => (value ? { ...value, directory: event.target.value } : value)),
                  }),
                ),
                h('div', { className: 'pdfr-export-hint' }, '内容可以先在这里改；文件写入工作区，可在 DSH 文件树里打开，同名会自动加序号。'),
                exportDialog.error ? h('div', { className: 'pdfr-export-error' }, exportDialog.error) : null,
                h(
                  'div',
                  { className: 'pdfr-export-actions' },
                  h('button', { type: 'button', className: 'pdfr-minibtn', onClick: closeExportDialog, disabled: exportDialog.busy }, '取消'),
                  h(
                    'button',
                    { type: 'button', className: 'pdfr-btn pdfr-btn-primary', onClick: saveExport, disabled: exportDialog.busy || !exportDialog.text.trim() },
                    exportDialog.busy ? '保存中…' : '保存',
                  ),
                ),
                    ),
              ),
            )
          : null,
        toast ? h('div', { className: 'pdfr-toast' }, toast) : null,
        picker ? h(FilePicker, { onClose: () => setPicker(false), onOpen: (target) => openDoc(target), recent, onImport: importFile, onForget: forgetDocument }) : null,
        !doc && loadError ? h('div', { className: 'pdfr-toast pdfr-toast-error' }, loadError) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Panel icon
    // ---------------------------------------------------------------------

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[pdf-reader]', error, info)
        } catch {}
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'pdfr-root pdfr-crash' },
            h('h2', null, 'PDF 阅读面板出错了'),
            h('p', null, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
            h('button', { type: 'button', className: 'pdfr-btn', onClick: () => this.setState({ error: null }) }, '重试'),
          )
        }
        return this.props.children
      }
    }

    function ReaderPanel() {
      return h(Boundary, null, h(ReaderPage))
    }

    function PanelIcon({ size = 20, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('path', { d: 'M4.5 5.2A2.2 2.2 0 0 1 6.7 3H19v14.4H6.7A2.2 2.2 0 0 0 4.5 19.6z' }),
        h('path', { d: 'M8 7.2h7M8 10.4h4.5' }),
        h('path', { d: 'M14.2 13.2h5.3v5.1h-2.4L15 20.4v-2.1h-.8z' }),
      )
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const STYLES = `
.pdfr-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.pdfr-root *{box-sizing:border-box}
.pdfr-top{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:46px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);flex:none}
.pdfr-top-left{display:flex;align-items:center;gap:10px;min-width:0}
.pdfr-top-right{display:flex;align-items:center;gap:8px}
.pdfr-doc{display:flex;align-items:baseline;gap:8px;min-width:0}
.pdfr-doc-title{font-weight:600;font-size:13px;max-width:36vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfr-doc-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.pdfr-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.pdfr-group{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.pdfr-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.pdfr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.pdfr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.pdfr-btn-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}
.pdfr-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.pdfr-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdfr-iconbtn:disabled{opacity:.35;cursor:default}
.pdfr-minibtn{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.pdfr-minibtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pdfr-pageinput{width:38px;height:24px;text-align:center;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0}
.pdfr-zoomlabel{display:inline-flex;align-items:center;justify-content:center;gap:2px;min-width:52px;height:24px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;border-radius:6px;padding:0 4px}
.pdfr-zoomlabel:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdfr-progress{height:2px;background:transparent;flex:none}
.pdfr-progress span{display:block;height:2px;background:var(--dsw-alias-brand-primary);opacity:.55;transition:width .3s ease}
.pdfr-body{display:flex;flex:1;min-height:0;position:relative}
.pdfr-split{position:relative;flex:none;width:9px;margin:0 -1px;cursor:col-resize;z-index:6;touch-action:none;background:transparent}
.pdfr-split::before{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:var(--dsw-alias-border-l1);transition:background .12s ease,width .12s ease,left .12s ease}
.pdfr-split:hover::before,.pdfr-split:focus-visible::before,.pdfr-resizing .pdfr-split::before{left:3px;width:2px;background:var(--dsw-alias-brand-primary)}
.pdfr-split:focus-visible{outline:none}
.pdfr-resizing{cursor:col-resize}
.pdfr-resizing .pdfr-thread,.pdfr-resizing .pdfr-textlayer,.pdfr-resizing .pdfr-stage{user-select:none}
.pdfr-zoom{position:relative;display:flex}
.pdfr-caret-sm{width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid currentColor;opacity:.55}
.pdfr-menu{position:absolute;top:calc(100% + 7px);right:0;z-index:30;min-width:178px;display:flex;flex-direction:column;gap:1px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 36px rgba(0,0,0,.24)}
.pdfr-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;height:27px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;white-space:nowrap}
.pdfr-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.pdfr-menu-check{color:var(--dsw-alias-brand-primary);font-size:11px}
.pdfr-menu-sep{height:1px;margin:3px 4px;background:var(--dsw-alias-border-l1)}
.pdfr-reader{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-2)}
.pdfr-stage-scroll{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:26px 28px 44px;display:flex;flex-direction:column;align-items:center;gap:8px}
.pdfr-stage-scroll.is-continuous{display:block;padding:22px 24px 64px}
.pdfr-pages{display:flex;flex-direction:column;align-items:center;gap:22px}
.pdfr-page-block{display:flex;flex-direction:column;align-items:center;gap:6px}
.pdfr-page-label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-page-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);border-radius:2px}
.pdfr-placeholder-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.7}
.pdfr-stage.is-current{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,transparent),0 8px 28px rgba(0,0,0,.12)}
.pdfr-stage.is-selected{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary),0 8px 28px rgba(0,0,0,.12)}
.pdfr-marquee{position:absolute;z-index:4;pointer-events:none;border:1.5px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-radius:2px}
.pdfr-marquee-tip{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:9;padding:5px 11px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:11.5px;color:var(--dsw-alias-label-primary);pointer-events:none;white-space:nowrap}
.pdfr-marqueeing .pdfr-stage-scroll{cursor:crosshair}
.pdfr-marqueeing .pdfr-textlayer,.pdfr-marqueeing .pdfr-word{user-select:none!important}
.pdfr-pagesel{display:flex;align-items:center;flex-wrap:wrap;gap:5px}
.pdfr-pagesel-label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.pdfr-modebtn{height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.pdfr-modebtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdfr-modebtn.is-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.pdfr-modebtn:disabled{opacity:.4;cursor:default}
.pdfr-quote-label{flex:none;font-size:10.5px;color:var(--dsw-alias-brand-primary);padding-right:2px}
.pdfr-stage-wrap{flex:none;margin:0 auto}
.pdfr-stage{position:relative;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.14),0 8px 28px rgba(0,0,0,.12);border-radius:2px;overflow:hidden}
.pdfr-pageimg{display:block;user-select:none;-webkit-user-drag:none}
.pdfr-textlayer{position:absolute;inset:0;overflow:hidden;line-height:1;user-select:text;cursor:text}
.pdfr-word{position:absolute;color:transparent;white-space:pre;overflow:visible;transform-origin:0 0;font-family:"Segoe UI",system-ui,sans-serif;line-height:1.18;pointer-events:auto}
.pdfr-word::selection{background:rgba(37,119,191,.32)}
.pdfr-textlayer::selection{background:rgba(37,119,191,.32)}
.pdfr-pill{position:absolute;z-index:5;display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.18)}
.pdfr-pill button{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.pdfr-pill button:hover{background:var(--dsw-alias-bg-layer-2)}
.pdfr-pill-primary{background:var(--dsw-alias-brand-primary)!important;color:var(--dsw-alias-label-primary-foreground)!important}
.pdfr-stage-hint{display:flex;align-items:center;gap:6px;padding:2px 8px 6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;opacity:.85}
.pdfr-pager{display:none;align-items:center;justify-content:center;gap:10px;height:36px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);flex:none}
.pdfr-pager-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pdfr-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;padding:24px}
.pdfr-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);display:inline-block;animation:pdfr-spin .8s linear infinite}
@keyframes pdfr-spin{to{transform:rotate(360deg)}}
.pdfr-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 24px;text-align:center}
.pdfr-empty h2{margin:6px 0 0;font-size:16px;font-weight:600}
.pdfr-empty p{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:360px;line-height:1.6}
.pdfr-empty-icon{width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary)}
.pdfr-empty-icon-sm{width:40px;height:40px;border-radius:11px}
.pdfr-empty-recent{margin-top:18px;display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%;max-width:360px}
.pdfr-section-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin:0 6px 4px}
.pdfr-recent-list{display:flex;flex-direction:column;gap:1px;text-align:left}
.pdfr-recent-item{display:flex;align-items:center;border-radius:8px;transition:background .12s ease}
.pdfr-recent-item:hover{background:var(--dsw-alias-bg-layer-1)}
.pdfr-recent-row{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;overflow:hidden}
.pdfr-recent-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfr-recent-item:hover .pdfr-recent-row{background:transparent}
.pdfr-recent-del{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:3px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:opacity .12s ease,background .12s ease,color .12s ease}
.pdfr-recent-item:hover .pdfr-recent-del,.pdfr-recent-del:focus-visible{opacity:1}
.pdfr-recent-del:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.pdfr-recent-confirm{display:flex;align-items:center;gap:5px;padding:5px 6px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}
.pdfr-recent-confirm-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.pdfr-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.pdfr-chat{display:flex;flex-direction:column;width:390px;flex:none;min-height:0;background:var(--dsw-alias-bg-base)}
.pdfr-chat-head{display:flex;align-items:center;justify-content:flex-start;gap:9px;height:46px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,var(--dsw-alias-bg-layer-1))}
.pdfr-chat-mark{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);color:var(--dsw-alias-brand-primary)}
.pdfr-chat-title{flex:1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.01em}
.pdfr-conv{position:relative;display:flex;align-items:center;min-width:0;flex:1}
.pdfr-conv-btn{display:flex;align-items:center;gap:6px;min-width:0;height:26px;padding:0 7px;margin-left:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.pdfr-conv-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.pdfr-conv-page{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.pdfr-conv-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px;font-weight:500}
.pdfr-conv-menu{left:0;right:auto;top:calc(100% + 6px);min-width:248px;max-width:min(320px,72vw)}
.pdfr-conv-row{display:flex;align-items:center;gap:2px;border-radius:6px}
.pdfr-conv-row:hover,.pdfr-conv-row.is-active{background:var(--dsw-alias-bg-layer-2)}
.pdfr-conv-row.is-active .pdfr-conv-name{color:var(--dsw-alias-brand-primary)}
.pdfr-conv-pick{display:flex;flex-direction:column;align-items:flex-start;gap:1px;flex:1;min-width:0;padding:5px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.pdfr-conv-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.pdfr-conv-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-conv-del{width:20px;height:20px;flex:none;opacity:0}
.pdfr-conv-row:hover .pdfr-conv-del{opacity:1}
.pdfr-chat-actions{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto}
.pdfr-chat-actions .pdfr-minibtn{height:24px;border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
.pdfr-chat-new{width:26px;height:26px;border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
.pdfr-context{display:flex;align-items:center;gap:5px;flex:none;padding:8px 12px 2px;border-bottom:0;color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfr-context>span{display:block;max-width:100%;padding:3px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis}
.pdfr-thread{flex:1;min-height:0;overflow-y:auto;padding:16px 14px 8px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.pdfr-thread::-webkit-scrollbar{width:8px}
.pdfr-thread::-webkit-scrollbar-track{background:transparent}
.pdfr-thread::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.pdfr-thread-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.pdfr-thread-empty p{margin:0;line-height:1.6}
.pdfr-msg{display:flex;flex-direction:column;gap:5px}
.pdfr-msg-page{align-self:flex-end;margin-right:2px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;cursor:pointer;border-radius:4px}
.pdfr-msg-page:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.pdfr-msg-user{align-items:flex-end}
.pdfr-msg-assistant{align-items:stretch}
.pdfr-bubble{padding:9px 11px;border-radius:14px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.pdfr-bubble-user{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-border-l1));max-width:88%;padding:10px 13px;border-bottom-right-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.pdfr-bubble-assistant{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);padding:11px 13px;border-bottom-left-radius:5px;white-space:normal;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.pdfr-bubble-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.pdfr-richtext p{margin:0 0 7px}
.pdfr-richtext p:last-child{margin-bottom:0}
.pdfr-richtext .pdfr-list{margin:0 0 7px;padding-left:18px}
.pdfr-list li{margin:2px 0}
.pdfr-code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}
.pdfr-ref{display:inline;padding:0 3px;margin:0 1px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:inherit;line-height:inherit;vertical-align:baseline;cursor:pointer;text-decoration:none;transition:background .12s ease,border-color .12s ease}
.pdfr-ref:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.pdfr-ref:active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.pdfr-ref-quote{text-decoration:none}
.pdfr-hit{position:absolute;z-index:3;pointer-events:none;background:rgba(255,196,0,.4);border-radius:2px;box-shadow:0 0 0 1px rgba(255,196,0,.6);animation:pdfr-hit 3s ease-out forwards}
@keyframes pdfr-hit{0%{opacity:0}10%{opacity:1}82%{opacity:1}100%{opacity:0}}
.pdfr-msg-actions{display:flex;gap:4px;padding:0 2px;opacity:.4;transition:opacity .15s ease}
.pdfr-msg:hover .pdfr-msg-actions,.pdfr-msg:focus-within .pdfr-msg-actions{opacity:1}
.pdfr-msg-actions .pdfr-minibtn{height:21px;border-color:transparent;background:transparent}
.pdfr-msg-actions .pdfr-minibtn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.pdfr-files{display:flex;flex-direction:column;gap:5px;margin-top:4px}
.pdfr-file{display:flex;align-items:center;gap:7px;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.pdfr-file>svg{flex:none;color:var(--dsw-alias-brand-primary)}
.pdfr-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfr-file .pdfr-minibtn{flex:none}
.pdfr-quote{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);max-width:100%}
.pdfr-quote-bar{width:2px;align-self:stretch;border-radius:2px;background:var(--dsw-alias-brand-primary);flex:none}
.pdfr-quote-text{flex:1;min-width:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pdfr-quote-close{width:18px;height:18px;flex:none}
.pdfr-composer{flex:none;display:flex;flex-direction:column;gap:9px;padding:12px 14px 14px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 26%,transparent);background:var(--dsw-alias-bg-base)}
.pdfr-textarea{width:100%;resize:none;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 62%,transparent);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;padding:10px 12px;outline:none;min-height:42px;max-height:140px;box-shadow:inset 0 1px 2px rgba(0,0,0,.035);transition:border-color .15s ease,box-shadow .15s ease}
.pdfr-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.8}
.pdfr-textarea:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 85%,transparent)}
.pdfr-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.pdfr-textarea:disabled{opacity:.6}
.pdfr-composer-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.pdfr-composer-actions{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto}
.pdfr-attachbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:background .12s ease,color .12s ease}
.pdfr-attachbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdfr-attachbtn:disabled{opacity:.4;cursor:default}
.pdfr-attachments{display:flex;flex-wrap:wrap;gap:6px}
.pdfr-attach{position:relative;width:54px;height:54px;border-radius:7px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.pdfr-attach img{display:block;width:100%;height:100%;object-fit:cover}
.pdfr-attach-remove{position:absolute;top:2px;right:2px;display:flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;cursor:pointer}
.pdfr-msg-note{align-self:flex-end;padding:0 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-model{position:relative;display:flex;min-width:0}
.pdfr-modelbtn{display:flex;align-items:center;gap:4px;max-width:190px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.pdfr-modelbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pdfr-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:112px}
.pdfr-model-effort{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:16px}
.pdfr-model-menu{left:auto;right:0;top:auto;bottom:calc(100% + 8px);min-width:246px;max-height:min(420px,60vh);overflow:auto}
.pdfr-menu-label{padding:3px 8px;font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}
.pdfr-menu-note{padding:4px 8px 2px;font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.75}
.pdfr-model-row{display:flex;align-items:center;gap:6px;min-width:0}
.pdfr-model-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.pdfr-model-tag{flex:none;font-size:9.5px;line-height:14px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pdfr-model-tag.has-vision{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.pdfr-typing-wrap{display:inline-flex;align-items:center;gap:7px}
.pdfr-thinking-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-reasoning{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-reasoning summary{cursor:pointer;list-style:none;padding:2px;color:var(--dsw-alias-label-secondary);opacity:.85;user-select:none}
.pdfr-reasoning summary::-webkit-details-marker{display:none}
.pdfr-reasoning summary::before{content:'▸ ';font-size:10px}
.pdfr-reasoning[open] summary::before{content:'▾ '}
.pdfr-reasoning-body{margin:4px 0 2px;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:0 6px 6px 0;white-space:pre-wrap;line-height:1.6;max-height:260px;overflow:auto;font-size:11.5px}
.pdfr-activity{display:flex;align-items:center;gap:6px;padding:2px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pdfr-activity .pdfr-spinner{width:11px;height:11px;border-width:1.5px}
.pdfr-anno-fill{position:absolute;z-index:1;pointer-events:none;border-radius:2px;opacity:.42}
.pdfr-anno-fill.is-yellow{background:#ffd54a}
.pdfr-anno-fill.is-green{background:#7ed67e}
.pdfr-anno-fill.is-blue{background:#6aa9ff}
.pdfr-anno-fill.is-pink{background:#ff9bc4}
.pdfr-anno-fill.is-purple{background:#c09bff}
.pdfr-anno-mark{position:absolute;z-index:5;width:10px;height:10px;padding:0;border-radius:50%;border:1.5px solid #fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.pdfr-anno-mark.is-yellow{background:#e0a400}
.pdfr-anno-mark.is-green{background:#2f9e44}
.pdfr-anno-mark.is-blue{background:#2f6dd0}
.pdfr-anno-mark.is-pink{background:#d6336c}
.pdfr-anno-mark.is-purple{background:#7048e8}
.pdfr-anno-editor{position:fixed;z-index:80;width:296px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.3)}
.pdfr-modal-mask{position:fixed;inset:0;z-index:85;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.32)}
.pdfr-export-dialog{width:420px;max-width:100%;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 64px rgba(0,0,0,.35)}
.pdfr-export-content{width:100%;min-height:120px;max-height:260px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.55;padding:7px 8px;outline:none}
.pdfr-export-content:focus{border-color:var(--dsw-alias-brand-primary)}
.pdfr-export-meta{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:7px;padding:7px 9px;max-height:64px;overflow:auto;word-break:break-word}
.pdfr-export-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-export-row>span{flex:none;width:34px}
.pdfr-export-input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.pdfr-export-input:focus{border-color:var(--dsw-alias-brand-primary)}
.pdfr-export-formats{display:flex;gap:5px}
.pdfr-export-hint{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.8}
.pdfr-export-error{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.pdfr-export-form{display:flex;flex-direction:column;gap:10px}
.pdfr-export-success{display:flex;flex-direction:column;gap:8px}
.pdfr-export-done-label{font-size:12px;color:var(--dsw-alias-label-primary)}
.pdfr-export-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.pdfr-btn:disabled{opacity:.5;cursor:default}
.pdfr-anno-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-anno-quote{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:6px;padding:6px 8px;max-height:72px;overflow:auto}
.pdfr-anno-note{width:100%;resize:vertical;min-height:54px;max-height:140px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:7px 8px;outline:none}
.pdfr-anno-note:focus{border-color:var(--dsw-alias-brand-primary)}
.pdfr-anno-colors{display:flex;gap:6px}
.pdfr-anno-dot{width:16px;height:16px;padding:0;border-radius:50%;border:2px solid transparent;cursor:pointer}
.pdfr-anno-dot.is-yellow{background:#ffd54a}
.pdfr-anno-dot.is-green{background:#7ed67e}
.pdfr-anno-dot.is-blue{background:#6aa9ff}
.pdfr-anno-dot.is-pink{background:#ff9bc4}
.pdfr-anno-dot.is-purple{background:#c09bff}
.pdfr-anno-dot.is-on{border-color:var(--dsw-alias-label-primary)}
.pdfr-anno-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.pdfr-anno-delete{color:var(--dsw-alias-state-error-primary);margin-right:auto}
.pdfr-anno-menu-wrap{position:relative;display:flex}
.pdfr-anno-menu{right:0;left:auto;top:calc(100% + 6px);min-width:260px;max-width:320px;max-height:320px;overflow:auto}
.pdfr-anno-item{align-items:flex-start;gap:8px}
.pdfr-anno-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.pdfr-anno-item-page{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pdfr-anno-item-text{font-size:11.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}
.pdfr-chip{height:23px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.pdfr-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pdfr-chip:disabled{opacity:.4;cursor:default}
.pdfr-send{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);transition:filter .12s ease,opacity .12s ease}
.pdfr-send:hover:not(:disabled){filter:brightness(1.07)}
.pdfr-send:disabled{opacity:.4;cursor:default}
.pdfr-send-stop{background:var(--dsw-alias-state-error-primary)}
.pdfr-stop-icon{width:9px;height:9px;border-radius:2px;background:#fff;display:block}
.pdfr-typing{display:inline-flex;gap:3px;align-items:center;padding:4px 2px}
.pdfr-typing span{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.5;animation:pdfr-blink 1.1s infinite}
.pdfr-typing span:nth-child(2){animation-delay:.18s}
.pdfr-typing span:nth-child(3){animation-delay:.36s}
@keyframes pdfr-blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:.9;transform:translateY(-2px)}}
.pdfr-caret{display:inline-block;width:6px;height:13px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-brand-primary);animation:pdfr-caret 1s steps(2) infinite}
@keyframes pdfr-caret{50%{opacity:0}}
.pdfr-drop{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);border:2px dashed var(--dsw-alias-brand-primary);border-radius:10px;color:var(--dsw-alias-label-primary);font-size:13px;pointer-events:none}
.pdfr-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:120;max-width:calc(100% - 32px);padding:7px 13px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px rgba(0,0,0,.22);font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;text-align:center}
.pdfr-toast-error{color:var(--dsw-alias-state-error-primary)}
.pdfr-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.pdfr-pad{padding:10px 2px}
.pdfr-modal-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
.pdfr-modal{width:min(560px,92vw);max-height:min(620px,86vh);display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden}
.pdfr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px}
.pdfr-modal-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.pdfr-modal-path{display:flex;align-items:center;gap:8px;padding:0 12px 8px}
.pdfr-path-text{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.pdfr-modal-list{flex:1;min-height:120px;overflow:auto;padding:2px 6px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.pdfr-row{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.pdfr-row:hover{background:var(--dsw-alias-bg-layer-2)}
.pdfr-row-icon{display:flex;color:var(--dsw-alias-label-secondary);flex:none}
.pdfr-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfr-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.pdfr-row-file .pdfr-row-icon{color:var(--dsw-alias-brand-primary)}
.pdfr-recent{margin-top:6px;padding:4px 0 8px}
.pdfr-modal-foot{display:flex;align-items:center;gap:8px;padding:10px 12px}
.pdfr-input{flex:1;min-width:0;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.pdfr-input:focus{border-color:var(--dsw-alias-brand-primary)}
.pdfr-upload{cursor:pointer}
@media (max-width: 860px){.pdfr-doc-title{max-width:26vw}}
.pdfr-crash{align-items:center;justify-content:center;gap:8px;padding:40px;text-align:center}
.pdfr-crash h2{margin:0;font-size:15px;font-weight:600}
.pdfr-crash p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;max-width:520px;line-height:1.6;word-break:break-word}
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
      const element = document.createElement('style')
      element.setAttribute('data-pdf-reader', '')
      element.textContent = STYLES + VOICE_STYLES
      document.head.appendChild(element)
      return () => {
        if (element.parentNode) element.parentNode.removeChild(element)
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(installStyles)
        attachVoiceBridge(ctx)
        try {
          const locale = ctx.get('locale')
          if (locale) {
            const zh = {}
            const en = {}
            for (const key of Object.keys(ZH)) {
              zh[key] = ZH[key]
              en[key] = EN[key]
            }
            locale.register('pdf-reader', 'zh', zh)
            locale.register('pdf-reader', 'en', en)
          }
        } catch {}

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'pdf-reader',
              order: 20,
              label: () => {
                try {
                  const value = ctx.locale.bind('pdf-reader')('panelTitle')
                  if (value && value !== 'panelTitle') return value
                } catch {}
                return 'PDF 阅读'
              },
            },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'pdf-reader' }, ReaderPanel),
        )
      },
    }
  },
})
