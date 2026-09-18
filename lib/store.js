// 实时状态：把 Harness 的 session/event 火线折叠成看板需要的每个会话（队长 / 成员）的画像。
// 纯内存、进程内单例；核心插件与看板插件各自把 ctx 事件喂进来，按 (sessionId, seq) 去重，重复挂载无害。
import { estimateCost, modelFamily } from './team.js'

export const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'dispatch_member', 'ralph'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const READ_TOOLS = new Set(['read', 'read_image'])
const MESSAGE_TOOLS = new Set(['send_message'])
const MAX_TIMELINE = 400
const MAX_SESSIONS = 400

export function shortStr(s, n = 90) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function shortPath(p) {
  p = String(p || '').replace(/\\/g, '/')
  const parts = p.split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : p
}

export function normPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('')
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw || '{}')) || {} } catch { return {} }
}

/** 工具调用的中文摘要（看板时间线 / 动态里显示）。 */
export function toolLabel(name, args) {
  const a = args || {}
  const p = a.path || a.file_path || a.file || a.filename || ''
  if (WRITE_TOOLS.has(name) || READ_TOOLS.has(name)) return `${name} · ${shortPath(p)}`
  if (name === 'bash' || name === 'pwsh') return `${name} · ${shortStr(a.command || a.cmd || '', 60)}`
  if (name === 'grep') return `grep · ${shortStr(a.pattern || a.query || '', 40)}`
  if (name === 'glob') return `glob · ${shortStr(a.pattern || '', 40)}`
  if (name === 'web_fetch') return `web_fetch · ${shortStr(a.url || '', 60)}`
  if (name === 'web_search') return `web_search · ${shortStr(a.query || '', 50)}`
  if (DISPATCH_TOOLS.has(name)) return `${name} · ${shortStr(a.description || a.name || a.member || '', 60)}`
  if (MESSAGE_TOOLS.has(name)) return `send_message · → ${shortStr(a.target || a.target_id || a.to || '', 30)}`
  if (name === 'skill') return `skill · ${shortStr(a.name || a.skill || '', 40)}`
  const first = Object.values(a).find(v => typeof v === 'string' && v.trim())
  return first ? `${name} · ${shortStr(first, 50)}` : name
}

export function newSession(id, header = {}) {
  return {
    id,
    cwd: header.cwd || '',
    parent: header.parentSession || '',
    origin: header.origin || '',
    depth: header.delegationDepth || 0,
    createdAt: header.createdAt ? header.createdAt / 1000 : Date.now() / 1000,
    firstAt: 0,
    lastAt: 0,
    provider: '',
    model: '',
    usage: { in: 0, out: 0, cache_read: 0, cache_write: 0 },
    turnOpen: false,
    turns: 0,
    steps: 0,
    openCalls: new Map(),
    timeline: [],
    toolCount: 0,
    thinkingCount: 0,
    lastText: '',
    lastUserPrompt: '',
    writes: [],
    reads: [],
    messages: [],
    dispatches: [],
    run: null,
    label: '',
    description: '',
    prompt: '',
    member: '',
    dispatchFrom: '',
    dispatchCallId: '',
    lastSeq: -1,
    ended: false,
    error: '',
    live: true,
  }
}

export class TeamStore {
  constructor() {
    this.sessions = new Map()
    this.revision = 0
    this.startedAt = Date.now() / 1000
  }

  touch() { this.revision++ }

  ensure(id, header) {
    let s = this.sessions.get(id)
    if (!s) {
      s = newSession(id, header)
      this.sessions.set(id, s)
      this.prune()
      this.touch()
    } else if (header) {
      if (!s.cwd && header.cwd) s.cwd = header.cwd
      if (!s.parent && header.parentSession) s.parent = header.parentSession
      if (!s.origin && header.origin) s.origin = header.origin
      if (!s.depth && header.delegationDepth) s.depth = header.delegationDepth
    }
    return s
  }

  prune() {
    if (this.sessions.size <= MAX_SESSIONS) return
    const gone = [...this.sessions.values()].filter(s => !s.live).sort((a, b) => a.lastAt - b.lastAt)
    for (const s of gone.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(s.id)
  }

  /** 会话对象进入 store（session/created）：记录头信息，若已有历史事件（插件晚于会话加载）则回放一遍。 */
  onCreated(session) {
    try {
      const s = this.ensure(session.id, session.header || {})
      s.live = true
      let events = []
      try { events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [] } catch { events = [] }
      for (const e of events) this.onEvent(session, e)
      this.linkOrphan(s)
      this.touch()
    } catch { /* 观察者绝不影响主循环 */ }
  }

  onDisposed(session) {
    const s = this.sessions.get(session && session.id)
    if (!s) return
    s.live = false
    s.turnOpen = false
    for (const c of s.openCalls.values()) if (c.item) c.item.done = true
    s.openCalls.clear()
    this.touch()
  }

  /** subagent/start：子会话由哪个 provider 起的。 */
  onRunStart(info) {
    if (!info || !info.id) return
    const s = this.ensure(info.id)
    s.run = { provider: info.provider || '', runId: info.runId || '', startedAt: Date.now() / 1000 }
    s.origin = s.origin || 'subagent'
    this.linkOrphan(s)
    this.touch()
  }

  onRunEnd(info) {
    if (!info || !info.id) return
    const s = this.ensure(info.id)
    s.run = { ...(s.run || {}), stopReason: info.stopReason || '', endedAt: Date.now() / 1000 }
    s.ended = true
    s.turnOpen = false
    if (info.stopReason && info.stopReason !== 'completed') s.error = String(info.stopReason)
    if (!s.lastText && info.lastAssistantMessage) s.lastText = shortStr(contentText(info.lastAssistantMessage), 600)
    this.touch()
  }

  /** 明确的派工关联（本插件的 dispatch_member 工具知道子会话 id）。 */
  link(childId, parentId, callId, extra = {}) {
    const s = this.ensure(childId)
    s.parent = parentId
    s.origin = 'subagent'
    s.dispatchFrom = parentId
    s.dispatchCallId = callId || ''
    Object.assign(s, extra)
    const p = this.sessions.get(parentId)
    if (p) {
      const d = p.dispatches.find(x => x.callId === callId) || p.dispatches.find(x => !x.childId && !x.done)
      if (d) { d.childId = childId; if (!s.description) s.description = d.description; if (!s.prompt) s.prompt = d.prompt; if (!s.member) s.member = d.member }
    }
    this.touch()
  }

  /** 没有明确关联的子会话：挂到最近一个有“未回填的派工调用”的父会话上（按头信息 parentSession 优先）。 */
  linkOrphan(s) {
    if (!s || s.dispatchFrom) return
    let parent = s.parent ? this.sessions.get(s.parent) : null
    if (!parent) {
      const cands = [...this.sessions.values()].filter(p => p.id !== s.id && p.dispatches.some(d => !d.childId && !d.done))
      cands.sort((a, b) => b.lastAt - a.lastAt)
      parent = cands[0] || null
      if (parent) s.parent = parent.id
    }
    if (!parent) return
    const d = parent.dispatches.find(x => !x.childId && !x.done)
    if (d) {
      d.childId = s.id
      s.dispatchFrom = parent.id
      s.dispatchCallId = d.callId
      if (!s.description) s.description = d.description
      if (!s.prompt) s.prompt = d.prompt
      if (!s.member) s.member = d.member
    } else {
      s.dispatchFrom = parent.id
    }
  }

  onEvent(session, event) {
    try {
      const id = session && session.id
      if (!id || !event || typeof event !== 'object') return
      const s = this.ensure(id, session.header || {})
      const seq = Number(event.seq)
      if (Number.isFinite(seq)) {
        if (seq <= s.lastSeq) return
        s.lastSeq = seq
      }
      const ts = Number(event.time) > 0 ? event.time / 1000 : Date.now() / 1000
      if (!s.firstAt) s.firstAt = ts
      s.lastAt = Math.max(s.lastAt, ts)
      const d = event.data || {}
      switch (event.type) {
        case 'turn/start':
          s.turnOpen = true; s.turns++; break
        case 'turn/end':
          s.turnOpen = false
          for (const c of s.openCalls.values()) if (c.item) { c.item.done = true }
          s.openCalls.clear()
          if (d.reason && typeof d.reason === 'object' && d.reason.kind && /error|fail/i.test(String(d.reason.kind))) s.error = String(d.reason.kind)
          break
        case 'step/start': s.steps++; break
        case 'user/message': {
          const msg = d.message || d
          const kind = msg && msg.source && msg.source.kind
          const text = contentText(msg && msg.content)
          if (kind === 'user' || (!kind && text)) {
            if (text) s.lastUserPrompt = shortStr(text, 300)
          } else if (kind === 'team-message' || (msg && msg.source && msg.source.kind === 'team-message')) {
            s.timeline.push({ kind: 'text', label: `收到 ${msg.source.senderName || '队友'} 的消息`, ts })
          }
          break
        }
        case 'assistant/message': {
          const msg = d.message || {}
          const src = msg.source || {}
          if (src.provider) s.provider = src.provider
          if (src.model) s.model = src.model
          if (d.usage && typeof d.usage === 'object') {
            const u = d.usage
            s.usage.in += Number(u.inputTokens) || 0
            s.usage.out += Number(u.outputTokens) || 0
            s.usage.cache_read += Number(u.cacheReadTokens) || 0
            s.usage.cache_write += Number(u.cacheWriteTokens) || 0
          }
          const text = contentText(msg.content)
          if (Array.isArray(msg.content) && msg.content.some(b => b && (b.type === 'reasoning' || b.type === 'thinking'))) s.thinkingCount++
          if (text.trim()) {
            s.lastText = shortStr(text, 600)
            s.timeline.push({ kind: 'text', label: shortStr(text, 120), ts })
          }
          break
        }
        case 'tool/call': {
          const name = String(d.name || '')
          const args = parseArgs(d.arguments)
          const item = { kind: 'tool', name, label: toolLabel(name, args), ts, done: false, error: false, ms: null }
          s.timeline.push(item)
          s.toolCount++
          s.openCalls.set(d.callId, { name, args, ts, item })
          const p = args.path || args.file_path || args.file || ''
          if (WRITE_TOOLS.has(name) && p) s.writes.push({ path: normPath(p), label: shortPath(p), ts })
          if (READ_TOOLS.has(name) && p) s.reads.push({ path: normPath(p), label: shortPath(p), ts })
          if (MESSAGE_TOOLS.has(name)) s.messages.push({ ts, to: String(args.target || args.target_id || args.to || ''), text: shortStr(args.message || args.content || '', 240), delivered: true, callId: d.callId })
          if (DISPATCH_TOOLS.has(name)) {
            s.dispatches.push({
              callId: d.callId, ts, name,
              description: shortStr(args.description || args.name || '', 120),
              prompt: shortStr(args.prompt || '', 2000),
              member: String(args.member || args.name || ''),
              provider: String(args.provider || ''), model: String(args.model || ''), effort: String(args.reasoning_effort || args.effort || ''),
              background: !!args.run_in_background, done: false, childId: '',
            })
          }
          break
        }
        case 'tool/result': {
          const c = s.openCalls.get(d.callId)
          const isErr = !!(d.error) || (d.message && Array.isArray(d.message.content) && d.message.content.some(b => b && b.isError))
          if (c) {
            c.item.done = true
            c.item.error = isErr
            c.item.ms = Math.max(0, Math.round((ts - c.ts) * 1000))
            s.openCalls.delete(d.callId)
            if (MESSAGE_TOOLS.has(c.name)) { const m = s.messages.find(x => x.callId === d.callId); if (m && isErr) m.delivered = false }
            if (DISPATCH_TOOLS.has(c.name)) {
              const disp = s.dispatches.find(x => x.callId === d.callId)
              if (disp) {
                disp.done = true
                disp.error = isErr
                const text = contentText(d.message && d.message.content)
                const child = disp.childId && this.sessions.get(disp.childId)
                if (child && !child.lastText && text) child.lastText = shortStr(text, 600)
                if (child && !disp.background) { child.ended = true; child.turnOpen = false; if (isErr && !child.error) child.error = 'error' }
              }
            }
          }
          break
        }
        case 'subagent/descriptor': {
          if (d && typeof d === 'object') {
            const desc = d.descriptor || d
            if (desc.label || desc.description) s.label = String(desc.label || desc.description)
            if (desc.provider && !s.run) s.run = { provider: String(desc.provider) }
            if (desc.agentOptions && typeof desc.agentOptions === 'object') {
              if (desc.agentOptions.provider && !s.provider) s.provider = String(desc.agentOptions.provider)
              if (desc.agentOptions.model && !s.model) s.model = String(desc.agentOptions.model)
            }
            s.origin = s.origin || 'subagent'
          }
          break
        }
        default:
          break
      }
      if (s.timeline.length > MAX_TIMELINE) s.timeline.splice(0, s.timeline.length - MAX_TIMELINE)
      if (s.writes.length > 400) s.writes.splice(0, s.writes.length - 400)
      if (s.reads.length > 400) s.reads.splice(0, s.reads.length - 400)
      this.touch()
    } catch { /* 永不抛给 agent loop */ }
  }

  /** 顶层会话（没有 subagent 出身）按最近活动排序。 */
  leads() {
    return [...this.sessions.values()].filter(s => !s.origin && !s.dispatchFrom && !s.parent).sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 一个队长下的全部后代（深度优先，按创建时间）。 */
  descendants(leadId) {
    const out = []
    const seen = new Set()
    const walk = (pid) => {
      const kids = [...this.sessions.values()].filter(s => (s.dispatchFrom === pid || s.parent === pid) && !seen.has(s.id)).sort((a, b) => a.createdAt - b.createdAt)
      for (const k of kids) { seen.add(k.id); out.push(k); walk(k.id) }
    }
    walk(leadId)
    return out
  }

  status(s, now) {
    if (s.error && s.error !== 'completed') return 'error'
    if (s.ended || (s.run && s.run.endedAt)) return 'completed'
    if (!s.live) return s.lastText ? 'completed' : 'stalled'
    if (s.turnOpen) return now - s.lastAt > 600 ? 'stalled' : 'running'
    return s.lastText || s.toolCount ? 'completed' : 'idle'
  }

  usageWithCost(s) {
    const u = { ...s.usage }
    const ctx = u.in + u.cache_read + u.cache_write
    const cost = estimateCost(s.provider, s.model, u)
    return { usage: u, totalTokens: ctx + u.out, cacheHit: ctx ? Math.round(u.cache_read / ctx * 1e4) / 1e4 : 0, cost: cost == null ? null : Math.round(cost * 1e4) / 1e4, family: modelFamily(s.model) }
  }
}

export const store = new TeamStore()

/** 把一个 Cordis ctx 的事件接到 store（核心插件与看板插件都可调用；重复无害）。 */
export function attach(ctx, sessionsService) {
  const disposers = []
  const on = (name, fn) => { try { disposers.push(ctx.on(name, fn)) } catch { /* 该事件不存在也无所谓 */ } }
  on('session/created', (session) => store.onCreated(session))
  on('session/disposed', (session) => store.onDisposed(session))
  on('session/event', (session, event) => store.onEvent(session, event))
  on('subagent/start', (info) => store.onRunStart(info))
  on('subagent/end', (info) => store.onRunEnd(info))
  // 已经在跑的会话（插件热加载 / 晚于会话启动）
  try {
    const list = sessionsService && typeof sessionsService.list === 'function' ? sessionsService.list() : []
    for (const sess of list) store.onCreated(sess)
  } catch { /* ignore */ }
  return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
}
