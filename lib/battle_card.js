// 把看板快照画成一张自包含 SVG。只读快照里已经有的字段。
// 不写路径、会话 id、邮箱、提示词、工具参数。stallAlerts 不在快照上就不画停滞人数。
// 看板按钮和 tools/battle_card.js 都调用这里，同一份快照得到同一张图。

const WIDTH = 960
const PAD = 36
const INNER = WIDTH - PAD * 2
const MAX_MEMBERS = 8
const MAX_DEPARTMENTS = 6
const MAX_TASKS = 6
const SANS = 'Segoe UI, PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif'
const MONO = 'ui-monospace, Cascadia Mono, SF Mono, Consolas, monospace'
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/
const HEX_ID = /[0-9a-fA-F]{16,}/
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
const STATUS = {
  running: '进行中',
  completed: '已完成',
  stalled: '停滞',
  error: '出错',
  idle: '待命',
  empty: '未出场',
  finished: '收尾完成',
  coordinating: '协调中',
  waiting: '等待中',
  forming: '组队中',
}
const PALETTES = {
  light: {
    paper: '#e7e9ed', card: '#ffffff', ink: '#131722', muted: '#465066',
    faint: '#858c9d', line: '#d2d6de', accent: '#9c7818', ok: '#2b8466',
    run: '#1c74a8', warn: '#b36f0b',
  },
  dark: {
    paper: '#070a11', card: '#141926', ink: '#eceae3', muted: '#a6acba',
    faint: '#676f83', line: '#232a3a', accent: '#d3b35c', ok: '#62b596',
    run: '#5fb1e3', warn: '#e3a444',
  },
}
const ACTIVE_DEPT = new Set(['进行中', '已完成', '停滞', '出错', '收尾完成', '协调中'])

export class BattleCardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BattleCardError'
  }
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isDict(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 与看板同一套小数写法：整数原样，其余最多 6 位小数，不使用科学计数法。 */
export function numText(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  const scaled = Math.floor(value * 1000000 + 0.5)
  const whole = Math.trunc(scaled / 1000000)
  const frac = scaled % 1000000
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(6, '0').replace(/0+$/, '')}`
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isCost(value) {
  return finite(value) && value >= 0
}

function isRatio(value) {
  return isCost(value) && value <= 1
}

function positive(value, kind) {
  if (kind === 'count') return isCount(value) && value > 0
  if (kind === 'ratio') return isRatio(value) && value > 0
  return isCost(value) && value > 0
}

function number(value, field, kind) {
  const ok = kind === 'count' ? isCount(value) : kind === 'ratio' ? isRatio(value) : isCost(value)
  if (!ok) throw new BattleCardError(`${field} 必须是有限非负数字`)
  return value
}

/** 短文本。过长、像路径、像邮箱、像会话号、像密钥的整段丢掉，不截断。 */
export function safeText(value, limit = 48) {
  if (typeof value !== 'string') return null
  const kept = []
  for (const ch of value) {
    if (ch >= ' ' || ch === '\t') kept.push(ch)
  }
  const text = kept.join('').split(/\s+/).filter(Boolean).join(' ')
  if (!text || [...text].length > limit) return null
  if (text.includes('@') || text.includes('\\') || text.includes('/') || text.startsWith('~')) return null
  if (text.includes('://') || /^[A-Za-z]:/.test(text)) return null
  if (EMAIL.test(text) || HEX_ID.test(text) || UUID.test(text)) return null
  if (/javascript\s*:/i.test(text) || /\bsk-[A-Za-z0-9]/i.test(text)) return null
  return text
}

function statusLabel(value) {
  if (typeof value !== 'string') return null
  if (has(STATUS, value)) return STATUS[value]
  return safeText(value, 24)
}

export function formatSeconds(value) {
  if (typeof value === 'number' && !Number.isInteger(value)) return `${numText(value)}s`
  const whole = Math.trunc(value)
  if (whole <= 0) return null
  if (whole < 60) return `${whole}s`
  const sec = whole % 60
  let minutes = Math.trunc(whole / 60)
  if (minutes < 60) return `${minutes}m ${sec}s`
  const hours = Math.trunc(minutes / 60)
  minutes %= 60
  return `${hours}h ${minutes}m ${sec}s`
}

function duration(obj) {
  if (!has(obj, 'startedAt') || !has(obj, 'endedAt')) return null
  const start = obj.startedAt
  const end = obj.endedAt
  if (!isCost(start) || !isCost(end) || end < start) return null
  return end - start
}

function money(obj, key) {
  if (!has(obj, key)) return 'missing'
  const value = obj[key]
  if (value === null) return 'unpriced'
  if (isCost(value)) return value
  return 'missing'
}

function deptLabel(snapshot, dept) {
  if (typeof dept !== 'string') return null
  const departments = snapshot.departments
  if (Array.isArray(departments)) {
    for (const item of departments) {
      if (isDict(item) && item.id === dept) {
        const name = typeof item.name === 'string' ? safeText(item.name, 32) : null
        return name || safeText(dept, 32)
      }
    }
  }
  return safeText(dept, 32)
}

function iconOf(value) {
  const icon = typeof value === 'string' ? safeText(value, 4) : null
  if (icon && [...icon].length <= 2) return icon
  return null
}

function formatGenerated(value) {
  if (!finite(value) || value < 0 || value > 10000000000) return null
  const date = new Date(Math.floor(value) * 1000)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function formatVersion(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)) return value
  return null
}

function exportMetrics(snapshot) {
  if (!isDict(snapshot) || !isDict(snapshot.totals)) throw new BattleCardError('快照必须是带 totals 的对象')
  const members = snapshot.members
  if (!Array.isArray(members) || members.some((item) => !isDict(item))) {
    throw new BattleCardError('快照的 members 必须是对象数组')
  }
  const totals = snapshot.totals
  const out = {}
  for (const key of ['cost', 'membersCost', 'unpriced', 'tokens']) {
    out[key] = number(totals[key], `totals.${key}`, key === 'unpriced' || key === 'tokens' ? 'count' : 'cost')
  }
  for (const name of ['usage', 'leadUsage', 'allUsage']) {
    const usage = totals[name]
    if (!isDict(usage)) throw new BattleCardError(`totals.${name} 必须是对象`)
    const copied = {}
    for (const key of ['in', 'out', 'cache_read', 'cache_write', 'total']) {
      copied[key] = number(usage[key], `totals.${name}.${key}`, 'count')
    }
    copied.cacheHit = number(usage.cacheHit, `totals.${name}.cacheHit`, 'ratio')
    out[name] = copied
  }
  return { schemaVersion: 1, memberCount: members.length, totals: out }
}

function metricsOf(snapshot) {
  const totals = snapshot.totals
  const members = snapshot.members
  const needed = ['cost', 'membersCost', 'unpriced', 'tokens', 'usage', 'leadUsage', 'allUsage']
  if (isDict(totals) && Array.isArray(members)) {
    for (const key of needed) if (!has(totals, key)) return null
    return exportMetrics(snapshot)
  }
  return null
}

function memberDicts(snapshot) {
  const members = snapshot.members
  if (!Array.isArray(members) || members.some((item) => !isDict(item))) return []
  return members
}

function personBits(obj, title) {
  const bits = []
  let role = has(obj, 'roleTitle') ? safeText(obj.roleTitle, 32) : null
  if (role == null && has(obj, 'agentType')) role = safeText(obj.agentType, 32)
  if (role && role !== title) bits.push(role)
  const family = has(obj, 'modelFamily') ? safeText(obj.modelFamily, 24) : null
  if (family) bits.push(family)
  const effort = has(obj, 'effort') ? safeText(obj.effort, 16) : null
  if (effort) bits.push(effort)
  const priced = money(obj, 'cost')
  if (priced === 'unpriced') bits.push('未定价')
  else if (priced !== 'missing' && priced > 0) bits.push(`$${numText(priced)}`)
  if (positive(obj.totalTokens, 'count')) bits.push(`${numText(obj.totalTokens)} tok`)
  if (positive(obj.cacheHit, 'ratio')) bits.push(`缓存 ${numText(obj.cacheHit)}`)
  if (positive(obj.toolCount, 'count')) bits.push(`工具 ${numText(obj.toolCount)}`)
  if (has(obj, 'writes') && Array.isArray(obj.writes) && obj.writes.length && obj.writes.every(isDict)) {
    bits.push(`写入 ${numText(obj.writes.length)}`)
  }
  const span = duration(obj)
  const rendered = span == null ? null : formatSeconds(span)
  if (rendered) bits.push(`用时 ${rendered}`)
  return bits
}

function leadRow(snapshot) {
  const lead = snapshot.lead
  if (!isDict(lead)) return null
  const name = has(lead, 'name') ? safeText(lead.name, 32) : null
  const phase = has(lead, 'phase') ? statusLabel(lead.phase) : null
  const bits = []
  for (const [key, label] of [['running', '进行中'], ['done', '已完成'], ['total', '成员']]) {
    if (has(lead, key) && positive(lead[key], 'count')) bits.push(`${numText(lead[key])} ${label}`)
  }
  bits.push(...personBits(lead, name || ''))
  if (!name && !phase && !bits.length) return null
  return { title: name || '队长', status: phase, bits }
}

function departmentRows(snapshot) {
  const departments = snapshot.departments
  if (!Array.isArray(departments)) return []
  const rows = []
  for (const dept of departments) {
    if (!isDict(dept)) continue
    let name = has(dept, 'name') ? safeText(dept.name, 32) : null
    if (name == null && has(dept, 'id')) name = safeText(dept.id, 24)
    if (!name) continue
    const icon = has(dept, 'icon') ? iconOf(dept.icon) : null
    const title = icon ? `${icon} ${name}` : name
    const status = has(dept, 'status') ? statusLabel(dept.status) : null
    const members = has(dept, 'members') ? dept.members : null
    const count = Array.isArray(members) ? members.length : null
    let active = (count || 0) > 0 || ACTIVE_DEPT.has(status)
    const bits = []
    if (count != null) bits.push(`${numText(count)} 人`)
    const priced = money(dept, 'cost')
    if (priced === 'unpriced') {
      bits.push('未定价')
      active = true
    } else if (priced !== 'missing' && priced > 0) {
      bits.push(`$${numText(priced)}`)
      active = true
    }
    if (positive(dept.tokens, 'count')) {
      bits.push(`${numText(dept.tokens)} tok`)
      active = true
    }
    if (positive(dept.cacheHit, 'ratio') && positive(dept.tokens, 'count')) bits.push(`缓存 ${numText(dept.cacheHit)}`)
    const rendered = has(dept, 'seconds') && isCount(dept.seconds) ? formatSeconds(dept.seconds) : null
    if (rendered) {
      bits.push(`用时 ${rendered}`)
      active = true
    }
    for (const [key, label] of [['running', '进行中'], ['done', '完成'], ['failed', '失败'], ['tools', '工具'], ['unpriced', '未定价']]) {
      if (has(dept, key) && positive(dept[key], 'count')) {
        bits.push(`${label} ${numText(dept[key])}`)
        active = true
      }
    }
    if (dept.missing === true) {
      bits.push('建议补位')
      active = true
    }
    const models = has(dept, 'models') ? dept.models : null
    if (Array.isArray(models) && models.length) {
      const names = []
      let safe = true
      for (const item of models) {
        const label = safeText(item, 24)
        if (!label) { safe = false; break }
        names.push(label)
      }
      if (safe && names.length) {
        bits.push(names.join('、'))
        active = true
      }
    }
    if (active) rows.push({ title, status, bits })
  }
  return rows
}

function memberRows(snapshot) {
  const rows = []
  memberDicts(snapshot).forEach((member, index) => {
    const name = has(member, 'name') ? safeText(member.name, 32) : null
    const title = name || `成员 ${String(index + 1).padStart(2, '0')}`
    const dept = has(member, 'dept') ? deptLabel(snapshot, member.dept) : null
    const bits = personBits(member, title)
    if (dept && !bits.includes(dept) && dept !== title) bits.unshift(dept)
    const status = has(member, 'status') ? statusLabel(member.status) : null
    if (name || status || bits.length) rows.push({ title, status, bits })
  })
  return rows
}

/** 任务标题用成员的 description（看板上的任务卡标题），不用 prompt。 */
function taskRows(snapshot) {
  const rows = []
  for (const member of memberDicts(snapshot)) {
    if (!has(member, 'description')) continue
    const title = safeText(member.description, 72)
    if (!title) continue
    const name = has(member, 'name') ? safeText(member.name, 32) : null
    const bits = name && name !== title ? [name] : []
    const status = has(member, 'status') ? statusLabel(member.status) : null
    rows.push({ title, status, bits })
  }
  return rows
}

/** 快照没有 stallAlerts 时返回 null。结构读不出来也返回 null，不编一个 0。 */
export function stallAlertCount(snapshot) {
  if (!isDict(snapshot) || !has(snapshot, 'stallAlerts')) return null
  const block = snapshot.stallAlerts
  if (!isDict(block) || !has(block, 'candidates') || !has(block, 'thresholdSec')) return null
  const threshold = block.thresholdSec
  const candidates = block.candidates
  if (!finite(threshold) || threshold < 0 || !Array.isArray(candidates)) return null
  let count = 0
  for (const item of candidates) {
    if (!isDict(item) || !has(item, 'status') || !has(item, 'idleSeconds')) continue
    if (item.status !== 'idle' && item.status !== 'error' && item.status !== 'stalled') continue
    const age = item.idleSeconds
    if (!finite(age) || age < 0 || age < threshold) continue
    count += 1
  }
  return count
}

function summaryOf(snapshot, metrics) {
  const members = memberDicts(snapshot)
  let count = null
  if (metrics) count = metrics.memberCount
  else if (members.length) count = members.length
  const parts = []
  if (count != null) parts.push(`${numText(count)} 名成员`)
  const seen = {}
  for (const member of members) {
    if (!has(member, 'status')) continue
    if (has(STATUS, member.status)) seen[member.status] = (seen[member.status] || 0) + 1
  }
  for (const key of ['completed', 'running', 'stalled', 'error']) {
    if (seen[key]) parts.push(`${numText(seen[key])} ${STATUS[key]}`)
  }
  const stall = stallAlertCount(snapshot)
  if (stall != null) parts.push(`停滞提醒 ${numText(stall)}`)
  return parts
}

function tilesOf(metrics, summaryCount) {
  if (!metrics) {
    if (summaryCount == null) return []
    return [{ label: '成员', value: numText(summaryCount) }]
  }
  const totals = metrics.totals
  const partial = totals.unpriced > 0
  return [
    { label: '成员', value: numText(metrics.memberCount) },
    { label: partial ? '估算成本 · 部分' : '估算成本', value: `$${numText(totals.cost)}` },
    { label: '合计 token', value: numText(totals.allUsage.total) },
    { label: '缓存命中', value: numText(totals.allUsage.cacheHit) },
  ]
}

function usageOf(metrics) {
  if (!metrics) return null
  const groups = ['usage', 'leadUsage', 'allUsage'].map((name) => metrics.totals[name])
  const rows = []
  for (const [label, key] of [['输入', 'in'], ['输出', 'out'], ['缓存读', 'cache_read'], ['缓存写', 'cache_write'], ['合计', 'total'], ['缓存命中', 'cacheHit']]) {
    rows.push({ label, cells: groups.map((group) => numText(group[key])) })
  }
  const totals = metrics.totals
  let note = `成员成本 ${numText(totals.membersCost)} · 成员输出 ${numText(totals.tokens)} · 未定价 ${numText(totals.unpriced)}`
  if (totals.unpriced > 0) note += ' · 部分'
  return { columns: ['成员', '队长', '合计'], rows, note }
}

export function publicView(snapshot) {
  if (!isDict(snapshot)) throw new BattleCardError('快照必须是对象')
  const metrics = metricsOf(snapshot)
  const members = memberRows(snapshot)
  const departments = departmentRows(snapshot)
  const tasks = taskRows(snapshot)
  const summary = summaryOf(snapshot, metrics)
  const count = metrics ? metrics.memberCount : (memberDicts(snapshot).length || null)
  const right = []
  const version = has(snapshot, 'version') ? formatVersion(snapshot.version) : null
  if (version) right.push(`v${version}`)
  const generated = has(snapshot, 'generatedAt') ? formatGenerated(snapshot.generatedAt) : null
  if (generated) right.push(generated)
  return {
    right,
    summary,
    tiles: tilesOf(metrics, members.length || metrics ? count : null),
    usage: usageOf(metrics),
    partial: !!(metrics && metrics.totals.unpriced > 0),
    lead: leadRow(snapshot),
    departments: departments.slice(0, MAX_DEPARTMENTS),
    moreDepartments: Math.max(0, departments.length - MAX_DEPARTMENTS),
    members: members.slice(0, MAX_MEMBERS),
    moreMembers: Math.max(0, members.length - MAX_MEMBERS),
    tasks: tasks.slice(0, MAX_TASKS),
    moreTasks: Math.max(0, tasks.length - MAX_TASKS),
  }
}

function describe(view) {
  const parts = ['Agent Team 战报。只包含快照里已有的字段。']
  if (view.summary.length) parts.push(`${view.summary.join(' · ')}。`)
  if (view.usage) parts.push(`${view.usage.note}。`)
  if (view.partial) parts.push('成本为部分估算。')
  else if (view.usage) parts.push('成本是估算，不是服务商账单。')
  return parts.join('')
}

function stylesheet(theme, still) {
  const lines = [
    'text { font-family: "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; }',
    '.mono { font-family: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace; }',
  ]
  const paint = (palette, indent = '') => {
    const painted = []
    for (const [key, color] of Object.entries(palette)) {
      if (key === 'line') continue
      painted.push(`${indent}.${key} { fill: ${color}; }`)
    }
    painted.push(`${indent}.card { stroke: ${palette.line}; }`)
    painted.push(`${indent}.rule { stroke: ${palette.accent}; }`)
    return painted
  }
  if (theme === 'auto') {
    lines.push(...paint(PALETTES.light))
    lines.push('@media (prefers-color-scheme: dark) {')
    lines.push(...paint(PALETTES.dark, '  '))
    lines.push('}')
  } else {
    lines.push(...paint(PALETTES[theme]))
  }
  if (!still) {
    lines.push('@media (prefers-reduced-motion: no-preference) {')
    lines.push('  .dash { animation: battle-dash 7s linear infinite; }')
    lines.push('}')
    lines.push(`@keyframes battle-dash { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -${WIDTH}; } }`)
  }
  return lines.join('\n')
}

function fontFamily(cls) {
  return cls.split(/\s+/).includes('mono') ? MONO : SANS
}

function text(x, y, content, cls, size, palette, weight, anchor) {
  const key = cls.split(/\s+/)[0]
  const attrs = [
    `class="${cls}"`,
    `fill="${palette[key]}"`,
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${fontFamily(cls)}"`,
    `font-size="${size}"`,
  ]
  if (weight) attrs.push(`font-weight="${weight}"`)
  if (anchor) attrs.push(`text-anchor="${anchor}"`)
  return `<text ${attrs.join(' ')}>${xmlEscape(content)}</text>`
}

function rect(x, y, w, h, cls, palette, rx) {
  const stroke = cls === 'card' ? ` stroke="${palette.line}"` : ''
  return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${palette[cls]}"${stroke}/>`
}

function statusClass(label) {
  if (label === '已完成' || label === '收尾完成') return 'ok'
  if (label === '进行中' || label === '协调中') return 'run'
  if (label === '停滞' || label === '出错' || label === '等待中') return 'warn'
  return 'muted'
}

function section(elements, y, title, rows, more, moreLabel, palette) {
  if (!rows.length && !more) return y
  elements.push(text(PAD, y + 18, title, 'ink', 15, palette, '600'))
  y += 30
  for (const row of rows) {
    const height = row.bits.length ? 54 : 38
    elements.push(rect(PAD, y, INNER, height, 'card', palette, 8))
    elements.push(text(PAD + 16, y + 24, row.title, 'ink', 15, palette, '600'))
    if (row.status) elements.push(text(WIDTH - PAD - 16, y + 24, row.status, statusClass(row.status), 13, palette, null, 'end'))
    if (row.bits.length) elements.push(text(PAD + 16, y + 44, row.bits.join(' · '), 'muted', 12, palette))
    y += height + 8
  }
  if (more) {
    elements.push(text(PAD, y + 16, moreLabel(more), 'faint', 12, palette))
    y += 24
  }
  return y + 8
}

function renderSvg(view, theme, still) {
  const palette = PALETTES[theme === 'auto' ? 'light' : theme]
  const elements = []
  let y = 48
  elements.push(text(PAD, y, 'AGENT TEAM', 'faint mono', 12, palette))
  if (view.right.length) elements.push(text(WIDTH - PAD, y, view.right.join(' · '), 'faint mono', 12, palette, null, 'end'))
  y += 42
  elements.push(text(PAD, y, '战报', 'ink', 36, palette, '600'))
  elements.push(text(WIDTH - PAD, y, 'BATTLE CARD', 'faint mono', 13, palette, null, 'end'))
  y += 28
  if (view.summary.length) {
    elements.push(text(PAD, y, view.summary.join(' · '), 'muted', 15, palette))
    y += 22
  }
  y += 10
  const ruleY = y
  y += 26
  const tiles = view.tiles
  if (tiles.length) {
    const tileH = 86
    const gap = 12
    const count = tiles.length
    const base = Math.floor((INNER - gap * (count - 1)) / count)
    const remain = INNER - (base * count + gap * (count - 1))
    let x = PAD
    tiles.forEach((tile, index) => {
      const tileW = base + (index < remain ? 1 : 0)
      elements.push(rect(x, y, tileW, tileH, 'card', palette, 8))
      elements.push(text(x + 16, y + 30, tile.label, 'faint', 12, palette))
      elements.push(text(x + 16, y + 64, tile.value, 'ink mono', 26, palette, '600'))
      x += tileW + gap
    })
    y += tileH + 18
  }
  const usage = view.usage
  if (usage) {
    const rowH = 26
    const blockH = 56 + rowH * usage.rows.length + 28
    elements.push(rect(PAD, y, INNER, blockH, 'card', palette, 8))
    elements.push(text(PAD + 18, y + 28, '用量', 'ink', 15, palette, '600'))
    const rights = [0, 1, 2].map((index) => WIDTH - PAD - 18 - 176 * (2 - index))
    usage.columns.forEach((column, index) => {
      elements.push(text(rights[index], y + 28, column, 'faint', 12, palette, null, 'end'))
    })
    usage.rows.forEach((row, index) => {
      const rowY = y + 56 + index * rowH
      elements.push(text(PAD + 18, rowY, row.label, 'muted', 13, palette))
      row.cells.forEach((cell, cellIndex) => {
        elements.push(text(rights[cellIndex], rowY, cell, 'ink mono', 13, palette, null, 'end'))
      })
    })
    elements.push(text(PAD + 18, y + blockH - 16, usage.note, 'faint', 12, palette))
    y += blockH + 16
  }
  if (view.lead) y = section(elements, y, '队长', [view.lead], 0, () => '', palette)
  y = section(elements, y, '部门', view.departments, view.moreDepartments, (n) => `另有 ${numText(n)} 个部门未列入`, palette)
  y = section(elements, y, '成员', view.members, view.moreMembers, (n) => `另有 ${numText(n)} 位未列入`, palette)
  y = section(elements, y, '任务', view.tasks, view.moreTasks, (n) => `另有 ${numText(n)} 项未列入`, palette)
  y += 6
  const footer = ['未出现的字段不补']
  if (view.partial) footer.push('成本是部分估算，未定价的没有计入')
  else if (usage) footer.push('估算成本，不是服务商账单')
  elements.push(text(PAD, y + 14, footer.join(' · '), 'faint', 12, palette))
  elements.push(text(WIDTH - PAD, y + 14, 'dsh-agent-team', 'faint mono', 12, palette, null, 'end'))
  const height = y + 36
  let rule = `<line class="rule${still ? '' : ' dash'}" x1="${PAD}" y1="${ruleY}" x2="${WIDTH - PAD}" y2="${ruleY}" stroke="${palette.accent}" stroke-width="1"${still ? '' : ' stroke-dasharray="64 896"'}/>`
  if (!still) {
    rule = `${rule.slice(0, -2)}><animate attributeName="stroke-dashoffset" from="0" to="-${WIDTH}" dur="7s" repeatCount="indefinite"/></line>`
  }
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="battleTitle battleDesc">`,
    '<title id="battleTitle">Agent Team 战报</title>',
    `<desc id="battleDesc">${xmlEscape(describe(view))}</desc>`,
    '<style>',
    stylesheet(theme, still),
    '</style>',
    rect(0, 0, WIDTH, height, 'paper', palette, 0),
    rect(0, 0, 4, height, 'accent', palette, 0),
    rule,
  ]
  return `${head.concat(elements).join('\n')}\n</svg>\n`
}

export function buildCard(snapshot, theme = 'auto', still = false) {
  if (theme !== 'auto' && !has(PALETTES, theme)) throw new BattleCardError('主题只能是 auto、light 或 dark')
  if (typeof still !== 'boolean') throw new BattleCardError('静止开关必须是布尔值')
  return renderSvg(publicView(snapshot), theme, still)
}
