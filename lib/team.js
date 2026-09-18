// 团队配置：部门 / 成员（persona 文件）/ 形象 / 价格。全部落在 $DSH_HOME/agent-team/，首次加载从 assets/ 复制默认值。
import fs from 'node:fs'
import path from 'node:path'
import { ASSETS, DATA_DIR, MEMBERS_DIR, USER_SPRITES, TEAM_JSON, readJson, writeJson } from './paths.js'

export const MEMBER_ID_RE = /^[a-z][a-z0-9-]{1,40}$/
export const PET_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
export const PET_EXTS = ['webp', 'png']
export const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
export const DEPT_AVATAR = { hq: 'docs-coordinator', dev: 'server-engineer', qa: 'qa-engineer', rnd: 'data-analyst', docs: 'docs-coordinator', ops: 'release-engineer' }
export const REQUIRED_OPTS = ['always', 'code', 'code2', 'deliver', 'optional']
export const SHIPPED_PETS = new Set(['huhu-plan', 'dada-code', 'bubu-fix', 'huihui-build', 'pip', 'cubo', 'drip', 'mush', 'kit', 'spark', 'bolt', 'puff', 'tank'])
export const PET_MAX_BYTES = 12 * 1024 * 1024

let cfg = null
let cfgMtime = 0

function defaults() {
  return readJson(path.join(ASSETS, 'team.json'), { departments: [], agents: {}, avatar_dept: {}, pricing_usd_per_mtok: {} })
}

/** 首次运行：把默认 team.json 与成员文件复制到用户目录（已存在的不动）。 */
export function ensureData() {
  fs.mkdirSync(MEMBERS_DIR, { recursive: true })
  fs.mkdirSync(USER_SPRITES, { recursive: true })
  if (!fs.existsSync(TEAM_JSON)) writeJson(TEAM_JSON, defaults())
  const src = path.join(ASSETS, 'members')
  if (fs.existsSync(src)) {
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.md')) continue
      const dst = path.join(MEMBERS_DIR, f)
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(src, f), dst)
    }
  }
}

/** 读取 team.json（按 mtime 缓存）；缺的默认键补齐（老版本升级）。 */
export function teamCfg() {
  let mt = 0
  try { mt = fs.statSync(TEAM_JSON).mtimeMs } catch { /* 首次 */ }
  if (!cfg || mt !== cfgMtime) {
    const d = defaults()
    const user = readJson(TEAM_JSON, null) || {}
    cfg = { ...d, ...user }
    cfg.departments = Array.isArray(cfg.departments) && cfg.departments.length ? cfg.departments : d.departments
    cfg.agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {}
    cfg.avatar_dept = { ...d.avatar_dept, ...(cfg.avatar_dept || {}) }
    cfg.pricing_usd_per_mtok = { ...d.pricing_usd_per_mtok, ...(cfg.pricing_usd_per_mtok || {}) }
    cfg.member_pets = cfg.member_pets && typeof cfg.member_pets === 'object' ? cfg.member_pets : {}
    cfgMtime = mt
  }
  return cfg
}

export function saveTeamCfg() {
  writeJson(TEAM_JSON, cfg)
  try { cfgMtime = fs.statSync(TEAM_JSON).mtimeMs } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 部门
export function writeDepartment(d) {
  const t = teamCfg()
  const id = String(d.id || '').trim()
  if (!/^[a-z][a-z0-9-]{1,20}$/.test(id)) throw new Error('部门标识只能用小写字母、数字、连字符，2-20 位，例如 design')
  const name = String(d.name || '').trim()
  if (!name) throw new Error('部门名称不能为空')
  const required = REQUIRED_OPTS.includes(d.required) ? d.required : 'optional'
  const icon = String(d.icon || '🏢').trim().slice(0, 4)
  const row = { id, name, icon, required }
  const i = t.departments.findIndex(x => x.id === id)
  if (i >= 0) t.departments[i] = { ...t.departments[i], ...row }
  else t.departments.push(row)
  saveTeamCfg()
  return row
}

export function deleteDepartment(id) {
  const t = teamCfg()
  if (id === 'hq') throw new Error('指挥部不能删除')
  const users = Object.entries(t.agents).filter(([, v]) => v.dept === id).map(([k]) => k)
  if (users.length) throw new Error(`还有成员在这个部门：${users.join('、')}，先把他们调走或删除`)
  const n = t.departments.length
  t.departments = t.departments.filter(x => x.id !== id)
  if (t.departments.length === n) throw new Error('部门不存在')
  saveTeamCfg()
}

// ---------------------------------------------------------------- 成员（persona 文件）
export function memberFile(name) {
  return path.join(MEMBERS_DIR, `${name}.md`)
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim(), extras: [] }
  const meta = {}
  const extras = []
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (mm) meta[mm[1]] = mm[2].trim().replace(/^["'](.*)["']$/, '$1')
    else if (line.trim()) extras.push(line)
  }
  return { meta, body: m[2].trim(), extras }
}

/** 读取全部成员定义：{name: {description, provider, model, effort, color, body, dept, ...}} */
export function loadMembers() {
  ensureData()
  const t = teamCfg()
  const out = {}
  let files = []
  try { files = fs.readdirSync(MEMBERS_DIR).filter(f => f.endsWith('.md')).sort() } catch { files = [] }
  for (const f of files) {
    const name = f.slice(0, -3)
    if (!MEMBER_ID_RE.test(name)) continue
    let text = ''
    try { text = fs.readFileSync(path.join(MEMBERS_DIR, f), 'utf8') } catch { continue }
    const { meta, body } = parseFrontmatter(text)
    const reg = t.agents[name] || {}
    out[name] = {
      name,
      description: meta.description || '',
      provider: meta.provider || '',
      model: meta.model || '',
      effort: meta.effort || meta.reasoningEffort || '',
      color: meta.color || '',
      body,
      dept: reg.dept || meta.dept || 'dev',
      avatar: reg.avatar || DEPT_AVATAR[reg.dept || meta.dept] || 'server-engineer',
      display: reg.name || meta.display || name,
      role: reg.role || meta.role || '',
      pet: reg.pet || '',
      custom: !(name in defaults().agents),
    }
  }
  return out
}

export function readMember(name) {
  return loadMembers()[name] || null
}

export function writeMember(d) {
  ensureData()
  const t = teamCfg()
  const name = String(d.name || '').trim()
  if (!MEMBER_ID_RE.test(name)) throw new Error('标识只能用小写字母、数字、连字符，2-40 位，例如 my-reviewer')
  const provider = String(d.provider || '').trim()
  const model = String(d.model || '').trim()
  if (provider && !/^[A-Za-z0-9._:\/-]{1,80}$/.test(provider)) throw new Error('provider 只能是已注册的路由名，例如 deepseek-official')
  if (model && !/^[A-Za-z0-9 ._:()\/+-]{1,120}$/.test(model)) throw new Error('模型 id 含非法字符')
  const effort = String(d.effort || '').trim()
  if (effort && !/^[a-z0-9-]{1,20}$/.test(effort)) throw new Error('思考强度只能是小写字母（low / medium / high 等，取决于模型）或留空')
  const dept = String(d.dept || 'dev').trim()
  if (!t.departments.some(x => x.id === dept)) throw new Error('部门不存在')
  const desc = String(d.description || '').split(/\s+/).join(' ').trim()
  if (desc.length < 8) throw new Error('简介至少 8 个字：写清“什么时候用它”，队长靠这句挑人')
  const display = String(d.display || '').trim() || name
  const body = String(d.body || '').trim() || `你是${display}。按队长的指令工作；只改被指派的文件；完成后汇报 ≤ 200 字（产出 / 偏差 / 风险）。`
  const color = COLORS.includes(d.color) ? d.color : ''
  const lines = ['---', `name: ${name}`, `description: ${desc}`]
  if (provider) lines.push(`provider: ${provider}`)
  if (model) lines.push(`model: ${model}`)
  if (effort) lines.push(`effort: ${effort}`)
  if (color) lines.push(`color: ${color}`)
  lines.push(`dept: ${dept}`, '---')
  fs.writeFileSync(memberFile(name), `${lines.join('\n')}\n${body}\n`, 'utf8')
  const entry = { dept, avatar: DEPT_AVATAR[dept] || 'server-engineer', name: display, role: String(d.role || '').trim() || '自定义成员' }
  const pet = String(d.pet || '').trim()
  if (pet && petFiles()[pet]) entry.pet = pet
  t.agents[name] = entry
  saveTeamCfg()
  return readMember(name)
}

export function deleteMember(name) {
  const t = teamCfg()
  const f = memberFile(name)
  if (!fs.existsSync(f)) throw new Error('成员不存在')
  fs.unlinkSync(f)
  delete t.agents[name]
  saveTeamCfg()
}

// ---------------------------------------------------------------- 价格
export function modelFamily(model) {
  let low = String(model || '').toLowerCase()
  for (const fam of ['opus', 'sonnet', 'haiku', 'fable']) if (low.includes(fam)) return fam
  low = low.split('/').pop()
  return low.split(/[-_/:. (]/, 1)[0] || ''
}

/** 价格行：先按 provider/model 最长前缀，再按 model 最长前缀，再按家族。找不到返回 null（未定价，不瞎算）。 */
export function priceEntry(provider, model) {
  const table = teamCfg().pricing_usd_per_mtok || {}
  const cands = [`${String(provider || '').toLowerCase()}/${String(model || '').toLowerCase()}`, String(model || '').toLowerCase()]
  for (const target of cands) {
    if (!target || target === '/') continue
    let best = null
    for (const [key, p] of Object.entries(table)) {
      const k = key.toLowerCase()
      if (k && target.includes(k) && (!best || k.length > best[0].length)) best = [key, p]
    }
    if (best) return best
  }
  const fam = modelFamily(model)
  if (fam && table[fam]) return [fam, table[fam]]
  return null
}

export function estimateCost(provider, model, u) {
  const e = priceEntry(provider, model)
  if (!e) return null
  const p = e[1]
  return ((u.in || 0) * (p.in || 0) + (u.out || 0) * (p.out || 0) + (u.cache_read || 0) * (p.cache_read || 0) + (u.cache_write || 0) * (p.cache_write || 0)) / 1e6
}

// ---------------------------------------------------------------- 形象
function imageSize(buf) {
  if (buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16)
    if (chunk === 'VP8X') return ['webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1]
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return ['webp', (b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1] }
    if (chunk === 'VP8 ') return ['webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]
    return null
  }
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return ['png', buf.readUInt32BE(16), buf.readUInt32BE(20)]
  return null
}

export function sheetGrid(w, h) {
  if (w <= 0 || h <= 0 || w % 8) return null
  const cw = w / 8
  const ch = cw * 208 / 192
  if (Math.abs(ch - Math.round(ch)) > 0.01) return null
  const chi = Math.round(ch)
  if (h % chi || h / chi < 9) return null
  return [cw, chi, h / chi]
}

function petDirs() {
  return [[path.join(ASSETS, 'sprites'), true], [USER_SPRITES, false]]
}

/** {id: {file, dir, w, h, cw, ch, rows, shipped, displayName?, ...}}；用户目录同名覆盖自带。 */
export function petInfo() {
  const out = {}
  for (const [dir, shipped] of petDirs()) {
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const ext of [...PET_EXTS].reverse()) {
      for (const f of files) {
        if (!f.endsWith(`.${ext}`) || f.includes('.orig.')) continue
        const id = f.slice(0, -(ext.length + 1))
        if (!PET_ID_RE.test(id)) continue
        let info = null
        try {
          const fd = fs.openSync(path.join(dir, f), 'r')
          const head = Buffer.alloc(64)
          fs.readSync(fd, head, 0, 64, 0)
          fs.closeSync(fd)
          info = imageSize(head)
        } catch { info = null }
        const w = info ? info[1] : 1536
        const h = info ? info[2] : 1872
        const g = sheetGrid(w, h) || [192, 208, 9]
        const entry = { file: f, dir, w, h, cw: g[0], ch: g[1], rows: g[2], shipped }
        const meta = readJson(path.join(dir, `${id}.json`), null)
        if (meta && typeof meta === 'object') {
          for (const k of ['displayName', 'description', 'source', 'credit', 'license']) if (meta[k]) entry[k] = String(meta[k]).slice(0, 300)
          if (Array.isArray(meta.fitRows)) entry.fitRows = meta.fitRows.map(Number).slice(0, 16)
          if (typeof meta.fit === 'number') entry.fit = meta.fit
        }
        out[id] = entry
      }
    }
  }
  return out
}

export function petFiles() {
  const out = {}
  for (const [k, v] of Object.entries(petInfo())) out[k] = path.join(v.dir, v.file)
  return out
}

export function petList() {
  return Object.keys(petInfo()).sort()
}

export function slugifyPetId(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '')
}

/** 解析用户上传：裸雪碧图，或 zip（pet.json + spritesheet.webp|png，可在子目录，忽略 __MACOSX）。 */
export async function parsePetPackage(data, hint = '') {
  let meta = {}
  let img = data
  let ext = null
  if (data.length > 4 && data.toString('latin1', 0, 2) === 'PK') {
    const { unzipSync } = await import('./unzip.js')
    const entries = unzipSync(data)
    let sheet = null
    for (const e of entries) {
      const name = e.name.replace(/\\/g, '/')
      if (name.includes('__MACOSX/') || name.endsWith('/')) continue
      const base = name.split('/').pop().toLowerCase()
      if (base === 'pet.json') { try { meta = JSON.parse(e.data.toString('utf8').replace(/^﻿/, '')) } catch { meta = {} } }
      else if (/\.(webp|png)$/.test(base) && (!sheet || /sprite/.test(base))) sheet = e
    }
    if (!sheet) throw new Error('zip 里没有 .webp / .png 雪碧图')
    img = sheet.data
  }
  const info = imageSize(img)
  if (!info) throw new Error('不是 webp / png 图片')
  ext = info[0]
  const g = sheetGrid(info[1], info[2])
  if (!g) throw new Error(`尺寸 ${info[1]}×${info[2]} 不是 8 列 × 9/11 行、每帧 192:208 的雪碧图`)
  const id = slugifyPetId(meta.id || meta.slug || meta.name || meta.displayName || hint)
  if (!id) throw new Error('取不到形象标识，请在表单里填一个')
  return { meta: { ...meta, id, _size: [info[1], info[2], g[2]] }, ext, img }
}

export function savePet(meta, ext, img, { overwrite = false, source = '', credit = '' } = {}) {
  const id = meta.id || ''
  if (!PET_ID_RE.test(id)) throw new Error('形象标识只能用小写字母、数字、连字符，1-40 位，例如 my-cat')
  if (SHIPPED_PETS.has(id)) throw new Error('这个标识是插件自带形象，换一个名字')
  const existing = petInfo()
  if (existing[id] && !overwrite) throw new Error(`形象 ${id} 已存在；勾选覆盖或换个标识`)
  fs.mkdirSync(USER_SPRITES, { recursive: true })
  for (const old of PET_EXTS) {
    const p = path.join(USER_SPRITES, `${id}.${old}`)
    if (old !== ext && fs.existsSync(p)) fs.unlinkSync(p)
  }
  fs.writeFileSync(path.join(USER_SPRITES, `${id}.${ext}`), img)
  const side = {
    id,
    displayName: String(meta.displayName || meta.name || id).slice(0, 80),
    description: String(meta.description || '').slice(0, 300),
    source: source || String(meta.source || ''),
    credit: credit || String(meta.credit || meta.author || meta.submittedBy || ''),
    license: String(meta.license || ''),
    importedAt: new Date().toISOString(),
  }
  if (meta.spriteVersionNumber) side.spriteVersionNumber = meta.spriteVersionNumber
  writeJson(path.join(USER_SPRITES, `${id}.json`), side)
  const [w, h, rows] = meta._size || [0, 0, 0]
  return { id, file: `${id}.${ext}`, width: w, height: h, rows, displayName: side.displayName }
}

export function deletePet(id) {
  const info = petInfo()[id]
  if (!info) throw new Error('形象不存在')
  if (info.shipped) throw new Error('插件自带的形象不能删')
  const t = teamCfg()
  const users = Object.entries(t.agents).filter(([, v]) => v.pet === id).map(([k]) => k)
  if (users.length) throw new Error(`还有成员在用这个形象：${users.join('、')}，先给他们换形象`)
  for (const [k, v] of Object.entries(t.member_pets)) if (v === id) delete t.member_pets[k]
  if (t.lead_pet === id) delete t.lead_pet
  saveTeamCfg()
  for (const suffix of ['.webp', '.png', '.json', '.orig.webp', '.orig.png']) {
    const p = path.join(USER_SPRITES, `${id}${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

/** 给正在工作的成员 / 角色 / 队长换形象。 */
export function setMemberPet({ id = '', pet = '', scope = 'member', agentType = '' }) {
  const t = teamCfg()
  pet = String(pet || '').trim().toLowerCase()
  if (pet && !petInfo()[pet]) throw new Error(`形象不存在：${pet}`)
  if (scope === 'lead') {
    if (pet) t.lead_pet = pet
    else delete t.lead_pet
  } else if (scope === 'type') {
    if (!t.agents[agentType]) throw new Error('这个角色不是常驻成员（临时派的只能“只改这位”）')
    if (pet) t.agents[agentType].pet = pet
    else delete t.agents[agentType].pet
    delete t.member_pets[id]
  } else {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('成员 id 不合法')
    if (pet) t.member_pets[id] = pet
    else delete t.member_pets[id]
    const keys = Object.keys(t.member_pets)
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete t.member_pets[k]
  }
  saveTeamCfg()
  return { id, pet, scope }
}
