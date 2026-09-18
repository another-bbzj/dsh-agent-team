// 把 store 里的会话画像组装成看板前端消费的 snapshot.json（字段与 claude-agent-team 的看板一致，前端原样复用）。
import { store, shortStr } from './store.js'
import { teamCfg, loadMembers, petList, petInfo, modelFamily, priceEntry, DEPT_AVATAR } from './team.js'
import { version } from './paths.js'

const AVATARS = ['server-engineer', 'ui-designer', 'qa-engineer', 'security-reviewer', 'data-analyst', 'docs-coordinator', 'release-engineer']
const NAMES = { 'server-engineer': '阿服', 'ui-designer': '小界', 'qa-engineer': '测测', 'security-reviewer': '老审', 'data-analyst': '探探', 'docs-coordinator': '文文', 'release-engineer': '发发' }

function stableHash(s) {
  let h = 0
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

/** “部门名·任务标题” 约定：临时派的成员按标题前缀归到部门。 */
function deptHint(title, departments) {
  const t = String(title || '')
  const m = /^\s*([^·:：\-—]{1,12})\s*[·:：\-—]/.exec(t)
  if (!m) return ''
  const key = m[1].trim()
  const d = departments.find(x => x.name === key || x.id === key || (key.length >= 2 && x.name.includes(key)))
  return d ? d.id : ''
}

function avatarFor(identity, id, fallback) {
  return AVATARS[stableHash(`${identity}|${id}`) % AVATARS.length] || fallback
}

function sumUsage(items) {
  const u = { in: 0, out: 0, cache_read: 0, cache_write: 0 }
  for (const it of items) for (const k of Object.keys(u)) u[k] += Number((it || {})[k]) || 0
  u.total = u.in + u.out + u.cache_read + u.cache_write
  const ctx = u.in + u.cache_read + u.cache_write
  u.cacheHit = ctx ? Math.round(u.cache_read / ctx * 1e4) / 1e4 : 0
  return u
}

function currentTool(s) {
  for (let i = s.timeline.length - 1; i >= 0; i--) if (s.timeline[i].kind === 'tool') return s.timeline[i]
  return null
}

/** 一个成员会话 → 看板成员对象。 */
function memberView(s, now, members, cfg) {
  const st = store.status(s, now)
  const uc = store.usageWithCost(s)
  const def = s.member && members[s.member] ? members[s.member] : null
  const reg = s.member && cfg.agents[s.member] ? cfg.agents[s.member] : null
  const agentType = s.member || (s.run && s.run.provider ? s.run.provider : 'subagent')
  const description = s.description || s.label || ''
  let dept = reg ? reg.dept : deptHint(description, cfg.departments)
  const avatar = reg ? reg.avatar : avatarFor(agentType, s.id, 'server-engineer')
  if (!dept) dept = cfg.avatar_dept[avatar] || 'dev'
  const baseName = reg ? reg.name : (NAMES[avatar] || agentType)
  const pe = priceEntry(s.provider, s.model)
  return {
    id: s.id,
    agentType,
    baseName,
    name: baseName,
    avatar,
    dept,
    roleTitle: reg ? reg.role : (def ? def.role : (s.run && s.run.provider ? `${s.run.provider} 子代理` : '子代理')),
    description,
    prompt: s.prompt || s.lastUserPrompt || '',
    status: st,
    startedAt: s.firstAt || s.createdAt,
    endedAt: st === 'completed' ? ((s.run && s.run.endedAt) || s.lastAt) : null,
    lastActivityAt: s.lastAt || s.createdAt,
    dispatchedAt: s.dispatchedAt || null,
    dispatchName: s.member || '',
    dispatchModel: s.dispatchModel || '',
    toolUseId: s.dispatchCallId || '',
    toolCount: s.toolCount,
    thinkingCount: s.thinkingCount,
    outputTokens: s.usage.out,
    usage: uc.usage,
    totalTokens: uc.totalTokens,
    cacheHit: uc.cacheHit,
    cost: uc.cost,
    priced: uc.cost != null,
    priceKey: pe ? pe[0] : '',
    provider: s.provider,
    model: s.model,
    modelFamily: uc.family,
    definedModel: def ? def.model : '',
    effort: def ? def.effort : '',
    custom: def ? !!def.custom : false,
    hasDef: !!reg,
    pet: (cfg.member_pets || {})[s.id] || (reg && reg.pet) || '',
    petScope: (cfg.member_pets || {})[s.id] ? 'member' : (reg && reg.pet ? 'type' : ''),
    current: currentTool(s),
    timeline: s.timeline.slice(-60),
    lastText: s.lastText,
    messages: s.messages,
    writes: s.writes,
    reads: s.reads,
    group: null,
  }
}

export function buildSnapshot({ session = '', project = '' } = {}) {
  const now = Date.now() / 1000
  const cfg = teamCfg()
  const members = loadMembers()
  const leads = store.leads()
  let lead0 = null
  if (session) lead0 = leads.find(s => s.id.startsWith(session)) || null
  else if (project) lead0 = leads.find(s => s.cwd.replace(/\\/g, '/').includes(project)) || null
  else lead0 = leads[0] || null

  const ms = lead0 ? store.descendants(lead0.id).map(s => memberView(s, now, members, cfg)) : []
  ms.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  const seen = {}
  for (const m of ms) {
    seen[m.avatar] = (seen[m.avatar] || 0) + 1
    m.name = seen[m.avatar] === 1 ? m.baseName : `${m.baseName}·${seen[m.avatar]}`
  }
  const byId = new Map(ms.map(m => [m.id, m]))

  // 派工与沟通
  const comms = []
  if (lead0) {
    for (const d of lead0.dispatches) {
      const m = d.childId ? byId.get(d.childId) : null
      if (m) {
        m.dispatchedAt = d.ts
        m.dispatchModel = d.model ? `${d.provider ? `${d.provider}/` : ''}${d.model}` : ''
        comms.push({ ts: d.ts, kind: 'assign', from: '__lead', fromName: '队长', fromAvatar: 'team-lead', to: m.id, toName: m.name, toAvatar: m.avatar, text: d.description || m.description })
        // 队长转达：派工指令里点名了先前成员
        const ptxt = (d.prompt || '').replace(/你是[^。，,\n]{0,16}/g, '')
        const seenBase = new Set()
        for (const other of [...ms].sort((a, b) => ((b.dispatchedAt || b.startedAt || 0) - (a.dispatchedAt || a.startedAt || 0)))) {
          if (other.id === m.id || (other.dispatchedAt || 0) > (d.ts || 0)) continue
          if (other.baseName === m.baseName && !other.name.includes('·')) continue
          if (seenBase.has(other.baseName) || other.name.length < 2) continue
          const re = new RegExp(`(?:${escapeRe(other.name)}|${escapeRe(other.baseName)}(?!·))[^。\\n]{0,40}(已交付|已写好|已完成|已实现|交接|handoffs?/|产出|导出|接口|结论|留言)`)
          if (re.test(ptxt)) {
            comms.push({ ts: d.ts, kind: 'relay', from: other.id, fromName: other.name, fromAvatar: other.avatar, to: m.id, toName: m.name, toAvatar: m.avatar, text: `队长把 ${other.name} 的成果/问题转达给 ${m.name}` })
            seenBase.add(other.baseName)
          }
        }
      } else if (!d.done) {
        comms.push({ ts: d.ts, kind: 'assign', from: '__lead', fromName: '队长', fromAvatar: 'team-lead', to: 'pending', toName: d.description || '新成员', toAvatar: 'docs-coordinator', text: `派工中：${d.description}` })
      }
    }
    for (const msg of lead0.messages) {
      const target = ms.find(m => m.id === msg.to || msg.to.includes(m.id) || m.agentType === msg.to || m.name === msg.to) || null
      comms.push({ ts: msg.ts, kind: 'direct', from: '__lead', fromName: '队长', fromAvatar: 'team-lead', to: target ? target.id : msg.to, toName: target ? target.name : msg.to, toAvatar: target ? target.avatar : 'docs-coordinator', text: msg.text })
    }
  }
  const findMember = (ref) => {
    ref = String(ref || '').trim().toLowerCase()
    if (!ref || ['main', 'lead', '__lead', '队长', 'parent'].includes(ref)) return null
    return ms.find(m => [m.id, m.agentType, m.name, m.baseName].some(x => String(x).toLowerCase() === ref)) || ms.find(m => m.id.toLowerCase().includes(ref) || (ref.length > 3 && m.description.toLowerCase().includes(ref))) || null
  }
  for (const m of ms) {
    for (const msg of m.messages) {
      const target = findMember(msg.to)
      if (!msg.delivered) { comms.push({ ts: msg.ts, kind: 'undelivered', from: m.id, fromName: m.name, fromAvatar: m.avatar, to: target ? target.id : '__lead', toName: target ? target.name : msg.to, toAvatar: target ? target.avatar : 'team-lead', text: `私信 ${msg.to} 未送达：${msg.text}` }); continue }
      if (target && target.id !== m.id) comms.push({ ts: msg.ts, kind: 'peer', from: m.id, fromName: m.name, fromAvatar: m.avatar, to: target.id, toName: target.name, toAvatar: target.avatar, text: msg.text })
      else comms.push({ ts: msg.ts, kind: 'report', from: m.id, fromName: m.name, fromAvatar: m.avatar, to: '__lead', toName: '队长', toAvatar: 'team-lead', text: `私信队长：${msg.text}` })
    }
  }
  // 文件交接：B 读了 A 写过的文件
  const writers = new Map()
  for (const m of ms) for (const w of m.writes) { if (!writers.has(w.path)) writers.set(w.path, []); writers.get(w.path).push([w.ts || 0, m]) }
  const seenHandoff = new Set()
  for (const m of ms) {
    for (const r of m.reads) {
      for (const [wts, author] of writers.get(r.path) || []) {
        if (author.id === m.id || (r.ts || 0) < wts) continue
        const key = `${author.id}|${m.id}|${r.path}`
        if (seenHandoff.has(key)) continue
        seenHandoff.add(key)
        comms.push({ ts: r.ts, kind: 'handoff', from: author.id, fromName: author.name, fromAvatar: author.avatar, to: m.id, toName: m.name, toAvatar: m.avatar, text: `交接文件 ${r.label}`, file: r.label })
        break
      }
    }
  }
  for (const m of ms) {
    if (m.status === 'completed' && m.endedAt) comms.push({ ts: m.endedAt, kind: 'report', from: m.id, fromName: m.name, fromAvatar: m.avatar, to: '__lead', toName: '队长', toAvatar: 'team-lead', text: shortStr(m.lastText, 200) || '已完成' })
    else if (m.status === 'error') comms.push({ ts: m.lastActivityAt, kind: 'error', from: m.id, fromName: m.name, fromAvatar: m.avatar, to: '__lead', toName: '队长', toAvatar: 'team-lead', text: `中断：${byId.get(m.id) ? (store.sessions.get(m.id) || {}).error || 'error' : 'error'}` })
  }
  comms.sort((a, b) => (b.ts || 0) - (a.ts || 0))

  const running = ms.filter(m => m.status === 'running').length
  const done = ms.filter(m => m.status === 'completed').length
  const phase = !ms.length ? 'forming' : running ? 'coordinating' : done === ms.length ? 'finished' : 'waiting'

  const feed = []
  for (const m of ms) for (const it of m.timeline) if (it.kind === 'tool' && it.ts) feed.push({ ts: it.ts, memberId: m.id, name: m.name, avatar: m.avatar, label: it.label, error: !!it.error, done: !!it.done })
  if (lead0) for (const it of lead0.timeline) if (it.kind === 'tool' && it.ts) feed.push({ ts: it.ts, memberId: '__lead', name: '队长', avatar: 'team-lead', label: it.label, error: !!it.error, done: !!it.done })
  feed.sort((a, b) => b.ts - a.ts)

  const lead = { name: '队长', avatar: 'team-lead', phase, running, done, total: ms.length, dept: 'hq', model: '', provider: '', cost: 0, usage: {}, pet: cfg.lead_pet || '' }
  if (lead0) {
    const uc = store.usageWithCost(lead0)
    const lst = store.status(lead0, now)
    Object.assign(lead, {
      active: lead0.turnOpen && lead0.live, current: currentTool(lead0), toolCount: lead0.toolCount, outputTokens: lead0.usage.out,
      timeline: lead0.timeline.slice(-60), lastUserPrompt: lead0.lastUserPrompt, lastActivityAt: lead0.lastAt || lead0.createdAt,
      provider: lead0.provider, model: lead0.model, modelFamily: uc.family, cost: uc.cost, usage: uc.usage, totalTokens: uc.totalTokens, cacheHit: uc.cacheHit,
      startedAt: lead0.firstAt || lead0.createdAt, endedAt: lst === 'running' ? null : lead0.lastAt, status: lst,
    })
  }

  const coders = ms.filter(m => m.dept === 'dev' || m.writes.length)
  const departments = cfg.departments.map(d => {
    const dm = ms.filter(m => m.dept === d.id)
    const req = d.required
    const needed = req === 'always' || (req === 'code' && coders.length > 0) || (req === 'code2' && coders.length >= 2) || (req === 'deliver' && coders.length >= 2)
    let st
    if (d.id === 'hq') st = phase === 'coordinating' ? 'running' : phase === 'finished' ? 'completed' : 'idle'
    else if (dm.some(m => m.status === 'running')) st = 'running'
    else if (dm.length && dm.every(m => m.status === 'completed')) st = 'completed'
    else if (dm.some(m => m.status === 'error' || m.status === 'stalled')) st = 'stalled'
    else st = dm.length ? 'idle' : 'empty'
    const du = sumUsage(dm.map(m => m.usage))
    const dctx = du.in + du.cache_read + du.cache_write
    const dur = dm.reduce((a, m) => a + (m.startedAt ? ((m.endedAt || m.lastActivityAt || 0) - m.startedAt) : 0), 0)
    return {
      ...d, members: dm.map(m => m.id), status: st, needed,
      missing: needed && !dm.length && d.id !== 'hq' && phase === 'finished',
      cost: Math.round(dm.reduce((a, m) => a + (m.cost || 0), 0) * 1e4) / 1e4,
      unpriced: dm.filter(m => m.cost == null).length,
      running: dm.filter(m => m.status === 'running').length,
      done: dm.filter(m => m.status === 'completed').length,
      failed: dm.filter(m => m.status === 'error' || m.status === 'stalled').length,
      tools: dm.reduce((a, m) => a + m.toolCount, 0),
      tokens: dctx + du.out, outTokens: du.out, cacheHit: dctx ? Math.round(du.cache_read / dctx * 1e4) / 1e4 : 0,
      seconds: Math.round(dur),
      models: [...new Set(dm.map(m => m.modelFamily).filter(Boolean))].sort(),
    }
  })

  const modelMix = {}
  for (const m of ms) { const f = m.modelFamily || '?'; modelMix[f] = (modelMix[f] || 0) + 1 }
  const membersUsage = sumUsage(ms.map(m => m.usage))
  const leadUsage = sumUsage([lead.usage])
  const allUsage = sumUsage([membersUsage, leadUsage])
  const unpricedModels = new Set(ms.filter(m => m.cost == null && m.model).map(m => `${m.provider ? `${m.provider}/` : ''}${m.model}`))
  if (lead.cost == null && lead.model) unpricedModels.add(`${lead.provider ? `${lead.provider}/` : ''}${lead.model}`)
  const totals = {
    cost: Math.round((ms.reduce((a, m) => a + (m.cost || 0), 0) + (lead.cost || 0)) * 1e4) / 1e4,
    membersCost: Math.round(ms.reduce((a, m) => a + (m.cost || 0), 0) * 1e4) / 1e4,
    unpriced: ms.filter(m => m.cost == null && m.model).length + (lead.cost == null && lead.model ? 1 : 0),
    unpricedModels: [...unpricedModels].sort(),
    modelMix, tokens: membersUsage.out, usage: membersUsage, leadUsage, allUsage,
  }
  const roster = Object.values(members).map(v => ({
    name: v.name, description: v.description, provider: v.provider, model: v.model, effort: v.effort, color: v.color, custom: v.custom, builtin: !v.custom,
    dept: v.dept, avatar: v.avatar, display: v.display, role: v.role, pet: v.pet,
  }))
  const sessions = leads.slice(0, 12).map(s => ({ id: s.id, project: shortStr(s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || '(无目录)', 60), mtime: s.lastAt || s.createdAt, count: store.descendants(s.id).length }))
  return {
    pets: petList(), petInfo: petInfo(),
    generatedAt: now, version: version(), update: null, harness: 'dsh',
    session: lead0 ? { id: lead0.id, project: shortStr(lead0.cwd, 80), lastActivity: lead0.lastAt || lead0.createdAt } : null,
    sessions, lead, members: ms, departments, totals, roster, feed: feed.slice(0, 100), comms: comms.slice(0, 80),
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { modelFamily, DEPT_AVATAR }
