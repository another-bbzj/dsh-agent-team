// 测试用的假 Cordis ctx：够插件 apply() 跑起来，并能往里喂 session/event。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-team-'))
  process.env.DSH_AGENT_TEAM_HOME = path.join(dir, 'agent-team')
  return dir
}

export class FakeCtx {
  constructor(services = {}) {
    this.listeners = new Map()
    this.effects = []
    this.services = services
    for (const [k, v] of Object.entries(services)) this[k] = v
  }
  get(name) { return this.services[name] }
  /** 模拟 cordis 的 ctx.inject：服务都在就立刻跑回调；否则挂起（本测试里等于永不触发）。 */
  inject(deps, cb) { this.pendingInjects = this.pendingInjects || []; if (deps.every(d => this.services[d])) cb(this); else this.pendingInjects.push(deps); return Promise.resolve() }
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(fn)
    return () => this.listeners.get(name).delete(fn)
  }
  emit(name, ...args) {
    for (const fn of this.listeners.get(name) || []) fn(...args)
  }
  effect(fn) { const d = fn(); if (typeof d === 'function') this.effects.push(d); return () => d && d() }
  dispose() { for (const d of this.effects) d() }
}

export function fakeSession(id, header = {}) {
  const events = []
  return {
    id,
    header: { id, version: 3, createdAt: Date.now(), cwd: header.cwd || 'C:/demo', ...header },
    events,
    snapshotEvents() { return events.slice() },
    requestHeader() { return { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
  }
}

/** 往 ctx 上按 Harness 的事件语义喂一条 session 事件。 */
export function feed(ctx, session, type, data, t = Date.now()) {
  const ev = { type, seq: session.events.length, time: t, data }
  session.events.push(ev)
  ctx.emit('session/event', session, ev)
  return ev
}

export const usage = (i, o, cr = 0, cw = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw })

export function assistant(ctx, s, text, u, provider = 'deepseek-official', model = 'deepseek-v4-flash', t) {
  return feed(ctx, s, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model } }, usage: u, stream: [] }, t)
}

export function toolCall(ctx, s, callId, name, args, t) {
  return feed(ctx, s, 'tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, t)
}

export function toolResult(ctx, s, callId, text, isError = false, t) {
  return feed(ctx, s, 'tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', callId, isError, content: [{ type: 'text', text }] }], source: { kind: 'tool', callId } }, ...(isError ? { error: { name: 'ToolError', code: 'E' } } : {}) }, t)
}
