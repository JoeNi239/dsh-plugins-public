import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessHistdataUpdateNeed } from './updateCheck.js'

const pluginRoot = dirname(fileURLToPath(import.meta.url))
const fetchScript = join(pluginRoot, '..', 'scripts', 'fetch_m1.py')

/** @type {Map<string, { child: import('node:child_process').ChildProcess | null }>} */
const activeJobs = new Map()

function jobKey(symbol, interval) {
  return `${String(symbol).toUpperCase()}-${interval}`
}

export function resolveWorkspaceRoot(ctx) {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return
    const root = value.replace(/[\\/]+$/, '')
    if (!roots.includes(root)) roots.push(root)
  }
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
  if (!roots.length) throw new Error('找不到工作区根目录')
  return roots[0]
}

export function readFetchState(workspaceRoot, symbol, interval) {
  const statePath = join(workspaceRoot, '.trade-practice', 'state', `${symbol}-${interval}-fetch.json`)
  if (!existsSync(statePath)) return { statePath, state: null }
  try {
    return { statePath, state: JSON.parse(readFileSync(statePath, 'utf8')) }
  } catch {
    return { statePath, state: null }
  }
}

function isStateRunning(state) {
  return Boolean(state && state.running)
}

export function getUpdateCheck(ctx, { symbol, interval = '1m', fromYear = 2020, dataRoot }) {
  const sym = String(symbol || '').toUpperCase()
  let root = dataRoot
  if (!root) {
    const workspace = resolveWorkspaceRoot(ctx)
    root = join(workspace, '.trade-practice', 'data')
  }
  return assessHistdataUpdateNeed(root, sym, interval, { fromYear })
}

export function startHistdataUpdate(ctx, { symbol, interval = '1m', fromYear, toYear, full = false, force = false }) {
  const sym = String(symbol || '').toUpperCase()
  const key = jobKey(sym, interval)
  const workspace = resolveWorkspaceRoot(ctx)
  const dataRoot = join(workspace, '.trade-practice', 'data')
  const { state } = readFetchState(workspace, sym, interval)

  if (activeJobs.has(key) || isStateRunning(state)) {
    return { ok: true, started: false, alreadyRunning: true, message: '更新任务已在运行' }
  }

  const check = assessHistdataUpdateNeed(dataRoot, sym, interval, {
    fromYear: full ? 2020 : Number(fromYear) || 2020,
  })

  if (!full && !force && !check.needsUpdate) {
    return {
      ok: true,
      started: false,
      skipped: true,
      message: check.summary,
      check,
    }
  }

  const nowYear = new Date().getUTCFullYear()
  let startYear = full ? 2020 : Number(fromYear) || nowYear
  let endYear = full ? nowYear : Number(toYear) || startYear
  let onlyMonths = []

  if (!full && check.plan?.onlyMonths?.length) {
    onlyMonths = check.plan.onlyMonths
    startYear = check.plan.fromYear ?? startYear
    endYear = check.plan.toYear ?? endYear
  }

  const args = [
    fetchScript,
    '--workspace',
    workspace,
    '--histdata',
    '--pair',
    sym,
    '--from-year',
    String(startYear),
    '--to-year',
    String(endYear),
  ]
  if (onlyMonths.length) {
    args.push('--only-months', onlyMonths.join(','))
  }

  let child
  try {
    child = spawn('python', args, {
      cwd: join(pluginRoot, '..'),
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    return { ok: false, started: false, error: error.message || String(error) }
  }

  activeJobs.set(key, { child })
  child.on('exit', () => {
    activeJobs.delete(key)
  })
  child.on('error', () => {
    activeJobs.delete(key)
  })

  return {
    ok: true,
    started: true,
    pid: child.pid,
    symbol: sym,
    interval,
    fromYear: startYear,
    toYear: endYear,
    full,
    message: full
      ? `已开始全量 HistData（${startYear}–${endYear}）`
      : onlyMonths.length
        ? `已开始补 ${onlyMonths.length} 个月：${onlyMonths.slice(0, 4).join('、')}${onlyMonths.length > 4 ? '…' : ''}`
        : `已开始更新 ${startYear}${endYear !== startYear ? `–${endYear}` : ''} 年数据`,
    check,
  }
}
