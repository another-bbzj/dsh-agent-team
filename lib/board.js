// dsh-agent-team 看板插件：在 DSH Web 的 HTTP 服务上挂 /agent-team/（页面 + snapshot.json + 管理 API），
// 并往 Web UI 注入一个右下角的「Agent Team」启动按钮（点开是内嵌看板面板）。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { store, attach } from './store.js'
import { buildSnapshot } from './snapshot.js'
import { ensureData, teamCfg, loadMembers, readMember, writeMember, deleteMember, writeDepartment, deleteDepartment, petList, petInfo, petFiles, parsePetPackage, savePet, deletePet, setMemberPet, SHIPPED_PETS, COLORS, REQUIRED_OPTS, PET_MAX_BYTES } from './team.js'
import { ASSETS, version } from './paths.js'

export const name = 'dsh-agent-team-board'
export const inject = ['webServer']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-agent-team',
    validate(value) {
      const v = value && typeof value === 'object' ? value : {}
      return { value: {
        basePath: typeof v.basePath === 'string' && /^\/[a-z0-9-]+$/.test(v.basePath) ? v.basePath : '/agent-team',
        launcher: v.launcher !== false,
        checkUpdates: v.checkUpdates !== false,
      } }
    },
  },
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' }

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(buf.length), 'Cache-Control': 'no-store', ...extra })
  res.end(buf)
}

const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj))

function readBody(req, limit = PET_MAX_BYTES * 2) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req, 4 * 1024 * 1024 + PET_MAX_BYTES)
  if (!raw.length) return {}
  try { return JSON.parse(raw.toString('utf8')) } catch { throw new Error('请求体不是合法 JSON') }
}

let updateState = { checkedAt: 0, result: null, busy: false }
function updateCheck(force) {
  const now = Date.now()
  if (updateState.result && !force && now - updateState.checkedAt < 12 * 3600 * 1000) return updateState.result
  if (updateState.busy) return updateState.result || { local: version(), remote: '', hasUpdate: false, pending: true }
  updateState.busy = true
  const registry = process.env.DSH_AGENT_TEAM_REGISTRY || 'https://registry.npmjs.org'
  fetch(`${registry}/dsh-agent-team/latest`, { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(info => {
      const remote = String(info.version || '')
      updateState.result = { local: version(), remote, hasUpdate: cmpVer(remote, version()) > 0, checkedAt: now / 1000, command: 'dsh plugin --profile web add dsh-agent-team@latest' }
    })
    .catch(err => { updateState.result = { local: version(), remote: '', hasUpdate: false, error: String(err && err.message || err) } })
    .finally(() => { updateState.checkedAt = Date.now(); updateState.busy = false })
  return updateState.result || { local: version(), remote: '', hasUpdate: false, pending: true }
}

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0)
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
  return 0
}

/** 给成员表单用的元数据：部门、成员、形象、可选路由 / 模型（来自 ctx.llm，拿不到就空）。 */
async function agentsMeta(ctx) {
  const cfg = teamCfg()
  const members = loadMembers()
  let providers = []
  let models = {}
  try {
    const llm = ctx.get ? ctx.get('llm') : ctx.llm
    if (llm && typeof llm.listProviders === 'function') {
      const list = await llm.listProviders()
      providers = (Array.isArray(list) ? list : []).map(p => (typeof p === 'string' ? p : p && (p.provider || p.name || p.id))).filter(Boolean)
      if (typeof llm.listModels === 'function') {
        await Promise.all(providers.slice(0, 12).map(async (p) => {
          try { const ms = await Promise.race([llm.listModels(p), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); models[p] = (Array.isArray(ms) ? ms : []).map(m => (typeof m === 'string' ? m : m && (m.id || m.model || m.name))).filter(Boolean).slice(0, 200) } catch { models[p] = [] }
        }))
      }
    }
  } catch { /* llm 不可用也无所谓 */ }
  return {
    agents: Object.values(members).map(m => ({ name: m.name, description: m.description, provider: m.provider, model: m.model, effort: m.effort, color: m.color, custom: m.custom, builtin: !m.custom, dept: m.dept, avatar: m.avatar, display: m.display, role: m.role, pet: m.pet })),
    departments: cfg.departments, providers, models, efforts: ['', 'low', 'medium', 'high'], colors: COLORS, required: REQUIRED_OPTS,
    pets: petList(), petInfo: petInfo(), shippedPets: [...SHIPPED_PETS].sort(), toolName: 'dispatch_member', harness: 'dsh', version: version(),
  }
}

const LAUNCHER_JS = (base) => `(function(){
if (window.__dshAgentTeam) return; window.__dshAgentTeam = true;
var BASE = ${JSON.stringify(base)};
var css = '.dat-btn{position:fixed;right:18px;bottom:18px;z-index:9998;display:flex;align-items:center;gap:8px;padding:8px 14px 8px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:#fff;color:#1f2328;font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.14);cursor:pointer;user-select:none}'+
'.dat-btn:hover{transform:translateY(-1px)}.dat-btn .dot{width:8px;height:8px;border-radius:50%;background:#9aa4b2}.dat-btn.live .dot{background:#22a06b;box-shadow:0 0 0 4px rgba(34,160,107,.18)}'+
'.dat-panel{position:fixed;top:0;right:0;bottom:0;width:min(1180px,92vw);z-index:9999;background:#f3f1ec;box-shadow:-12px 0 40px rgba(0,0,0,.25);transform:translateX(102%);transition:transform .25s ease;display:flex;flex-direction:column}'+
'.dat-panel.open{transform:none}.dat-bar{display:flex;align-items:center;gap:10px;padding:6px 10px;background:#fff;border-bottom:1px solid rgba(0,0,0,.08);font:600 13px system-ui,sans-serif;color:#1f2328}'+
'.dat-bar a{color:#3670c2;text-decoration:none;font-weight:500}.dat-bar .sp{flex:1}.dat-bar button{border:1px solid rgba(0,0,0,.12);background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;font:inherit}'+
'.dat-panel iframe{flex:1;border:0;width:100%;background:#f3f1ec}@media (prefers-color-scheme:dark){.dat-btn,.dat-bar,.dat-bar button{background:#1f2328;color:#e6e8eb;border-color:rgba(255,255,255,.14)}}';
var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
var btn = document.createElement('div'); btn.className = 'dat-btn'; btn.innerHTML = '<span class="dot"></span><span>Agent Team</span><span class="n" style="opacity:.7;font-weight:500"></span>'; btn.title = '打开 Agent Team 指挥室看板';
var panel = document.createElement('div'); panel.className = 'dat-panel';
panel.innerHTML = '<div class="dat-bar"><span>Agent Team 指挥室</span><a href="'+BASE+'/" target="_blank" rel="noopener">新标签打开 ↗</a><span class="sp"></span><button class="x">关闭</button></div>';
var iframe = null;
function open(){ if(!iframe){ iframe=document.createElement('iframe'); iframe.src=BASE+'/?embed=1'; panel.appendChild(iframe);} panel.classList.add('open'); }
function close(){ panel.classList.remove('open'); }
btn.addEventListener('click', function(){ panel.classList.contains('open') ? close() : open(); });
panel.querySelector('.x').addEventListener('click', close);
document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
document.body.appendChild(btn); document.body.appendChild(panel);
function poll(){ fetch(BASE+'/status.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){ btn.classList.toggle('live', !!s.running); btn.querySelector('.n').textContent = s.running ? s.running+' 进行中' : (s.members ? s.members+' 人' : ''); }).catch(function(){}); }
poll(); setInterval(poll, 5000);
})();`

export function apply(ctx, config = {}) {
  mountBoard(ctx, Config['~standard'].validate(config).value)
}

/** 在一个已经拿到 webServer 的 ctx 上挂看板；被 index.js 的 ctx.inject(['webServer']) 调用，也可单独作为插件行加载。 */
export function mountBoard(ctx, cfgIn) {
  const disposers = []
  const dispose = (d) => { if (typeof d === 'function') disposers.push(d) }
  const { handler, base } = createBoardHandler(ctx, cfgIn)
  dispose(ctx.webServer.register({ kind: 'prefix', path: base, handler }))
  if (cfgIn.launcher !== false) {
    dispose(ctx.webServer.register({ kind: 'exact', path: `${base}-launcher.js`, handler: (req, res) => send(res, 200, LAUNCHER_JS(base), MIME['.js']) }))
    dispose(ctx.webServer.tapIndex((html) => {
      const tag = `<script defer src="${base}-launcher.js"></script>`
      if (html.includes(tag)) return html
      return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
    }))
  }
  let port = ''
  try { port = ctx.webServer.port ? `:${ctx.webServer.port}` : '' } catch { port = '' }
  console.log(`[dsh-agent-team] 看板 http://127.0.0.1${port}${base}/`)
  ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })
}

/** 独立端口：不依赖 DSH 的 Web 服务（headless 也有看板），也避开 Claude Code 版的 7788。端口被占只警告，不影响启动。 */
export function startStandalone(ctx, cfgIn) {
  const port = Number(cfgIn.port)
  if (!port) return
  const { handler, base } = createBoardHandler(ctx, cfgIn)
  const server = http.createServer((req, res) => {
    const u = req.url || '/'
    if (u === '/' || u === '') { res.writeHead(302, { Location: `${base}/` }); return res.end() }
    if (!u.startsWith(base)) { res.writeHead(302, { Location: `${base}${u.startsWith('/') ? u : `/${u}`}` }); return res.end() }
    handler(req, res)
  })
  server.on('error', (err) => { console.warn(`[dsh-agent-team] 独立端口 ${port} 未能监听（${err && err.code}）：${err && err.message}。看板仍可从 DSH Web 打开；改 config.port 换一个端口`) })
  server.listen(port, '127.0.0.1', () => console.log(`[dsh-agent-team] 独立看板 http://127.0.0.1:${port}${base}/`))
  ctx.effect(() => () => { try { server.close(); if (server.closeAllConnections) server.closeAllConnections() } catch { /* ignore */ } })
}

/** 看板的 HTTP 处理器（页面 / 静态 / 快照 / 管理 API），给 DSH Web 前缀路由和独立端口共用。 */
export function createBoardHandler(ctx, cfgIn) {
  const base = cfgIn.basePath || '/agent-team'
  ensureData()
  attach(ctx, ctx.get ? ctx.get('sessions') : ctx.sessions)

  let indexHtml = ''
  const loadIndex = () => {
    if (indexHtml) return indexHtml
    indexHtml = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8')
    return indexHtml
  }

  const routes = {
    'GET /': (req, res) => send(res, 200, loadIndex(), MIME['.html']),
    'GET /index.html': (req, res) => send(res, 200, loadIndex(), MIME['.html']),
    'GET /snapshot.json': (req, res, u) => {
      const snap = buildSnapshot({ session: u.searchParams.get('session') || '', project: u.searchParams.get('project') || '' })
      if (cfgIn.checkUpdates !== false) snap.update = updateCheck(false)
      json(res, snap)
    },
    'GET /status.json': (req, res) => {
      const snap = buildSnapshot({})
      json(res, { running: snap.lead.running || 0, members: snap.members.length, roster: snap.roster.length, departments: snap.departments.length, phase: snap.lead.phase, session: snap.session && snap.session.id, revision: store.revision, version: version(), standalonePort: Number(cfgIn.port) || 0 })
    },
    'GET /api/agents': async (req, res, u) => {
      const nm = u.searchParams.get('name')
      if (nm) { const m = readMember(nm); return m ? json(res, m) : json(res, { error: '成员不存在' }, 404) }
      json(res, await agentsMeta(ctx))
    },
    'POST /api/agents': async (req, res) => json(res, { ok: true, agent: writeMember(await readJsonBody(req)), roster: Object.values(loadMembers()) }),
    'POST /api/agents/delete': async (req, res) => { const b = await readJsonBody(req); deleteMember(String(b.name || '')); json(res, { ok: true }) },
    'POST /api/departments': async (req, res) => json(res, { ok: true, department: writeDepartment(await readJsonBody(req)), departments: teamCfg().departments }),
    'POST /api/departments/delete': async (req, res) => { const b = await readJsonBody(req); deleteDepartment(String(b.id || '')); json(res, { ok: true, departments: teamCfg().departments }) },
    'GET /api/pets': (req, res) => json(res, { pets: petList(), petInfo: petInfo(), shippedPets: [...SHIPPED_PETS].sort() }),
    'POST /api/pets': async (req, res) => {
      const b = await readJsonBody(req)
      let raw = String(b.data || '')
      if (raw.startsWith('data:') && raw.includes(',')) raw = raw.slice(raw.indexOf(',') + 1)
      const data = Buffer.from(raw, 'base64')
      if (!data.length || data.length > PET_MAX_BYTES) throw new Error(`文件为空或超过 ${PET_MAX_BYTES / 1024 / 1024} MB`)
      const hint = String(b.filename || '').split(/[\\/]/).pop().replace(/\.(zip|webp|png)$/i, '').replace(/[-_ ]?sprite(sheet)?.*$/i, '') || ''
      const parsed = await parsePetPackage(data, hint)
      if (String(b.id || '').trim()) parsed.meta.id = String(b.id).trim().toLowerCase()
      const pet = savePet(parsed.meta, parsed.ext, parsed.img, { overwrite: !!b.overwrite, source: String(b.source || ''), credit: String(b.credit || '') })
      json(res, { ok: true, pet, pets: petList(), petInfo: petInfo() })
    },
    'POST /api/pets/delete': async (req, res) => { const b = await readJsonBody(req); deletePet(String(b.id || '')); json(res, { ok: true, pets: petList(), petInfo: petInfo() }) },
    'POST /api/pets/fit': async (req, res) => { await readJsonBody(req); json(res, { ok: true, fit: { skipped: '看板会在浏览器里按主体自动放大（逐动作识别主体）；服务端改图请用 claude-agent-team 的 fit_pet.py' }, petInfo: petInfo() }) },
    'POST /api/members/pet': async (req, res) => { const out = setMemberPet(await readJsonBody(req)); json(res, { ok: true, ...out }) },
    'GET /api/update/check': (req, res, u) => json(res, { version: version(), ...(updateCheck(u.searchParams.has('force')) || {}) }),
    'POST /api/update/apply': async (req, res) => { await readJsonBody(req); json(res, { ok: false, error: '在终端运行：dsh plugin --profile web add dsh-agent-team@latest ，然后重启 dsh web' }) },
  }

  const handler = async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      let rel = u.pathname.slice(base.length)
      if (rel === '') { res.writeHead(302, { Location: `${base}/${u.search}` }); res.end(); return }
      rel = rel.replace(/\/+$/, '') || '/'
      const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${rel}`
      if (routes[key]) return await routes[key](req, res, u)
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, { error: '不支持的方法' }, 405)
      // 静态：sprites/<id>.<ext>（用户目录优先）、favicon、其它 assets
      const m = /^\/sprites\/([a-z0-9-]{1,41})\.(webp|png)$/.exec(rel)
      if (m) {
        const f = petFiles()[m[1]]
        if (!f) return send(res, 404, 'no such pet', 'text/plain')
        return send(res, 200, fs.readFileSync(f), MIME[`.${m[2]}`], { 'Cache-Control': 'public, max-age=60' })
      }
      const safe = rel.replace(/^\/+/, '')
      if (safe && !safe.includes('..')) {
        const p = path.join(ASSETS, safe)
        if (p.startsWith(ASSETS) && fs.existsSync(p) && fs.statSync(p).isFile()) return send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=300' })
      }
      json(res, { error: 'not found' }, 404)
    } catch (err) {
      try { json(res, { error: String(err && err.message || err) }, 400) } catch { /* headers already sent */ }
    }
  }

  return { handler, base }
}

export default { name, inject, Config, apply }
