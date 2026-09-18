import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tmpHome, FakeCtx, fakeSession, feed, assistant, toolCall, toolResult, usage } from './helpers.js'

const home = tmpHome()
const core = await import('../lib/index.js')
const board = await import('../lib/board.js')
const { store } = await import('../lib/store.js')
const team = await import('../lib/team.js')

function makeTools() {
  const tools = new Map()
  return { tools, register(def) { tools.set(def.name, def); return () => tools.delete(def.name) }, get(name) { return tools.get(name) } }
}

function makeServices({ startImpl } = {}) {
  const sessionsList = []
  const sections = []
  const routes = []
  const taps = []
  return {
    sessions: { list: () => sessionsList, _list: sessionsList },
    tools: makeTools(),
    subagents: { start: startImpl || (async () => { throw new Error('no provider') }) },
    systemPrompt: { section(s) { sections.push(s); return () => sections.splice(sections.indexOf(s), 1) }, _sections: sections },
    webServer: { port: 0, register(r) { routes.push(r); return () => routes.splice(routes.indexOf(r), 1) }, tapIndex(fn) { taps.push(fn); return () => taps.splice(taps.indexOf(fn), 1) }, _routes: routes, _taps: taps },
    agents: { get: () => undefined },
    llm: { listProviders: async () => [{ id: 'deepseek-official', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, reasoning: model === 'deepseek-v4-pro' ? { efforts: [{ id: 'high' }, { id: 'medium' }] } : undefined }) },
  }
}

test('首次加载会把默认成员与 team.json 放到用户目录', () => {
  const ctx = new FakeCtx(makeServices())
  core.apply(ctx, { port: 0 })
  const dir = process.env.DSH_AGENT_TEAM_HOME
  assert.ok(fs.existsSync(path.join(dir, 'team.json')))
  assert.equal(fs.readdirSync(path.join(dir, 'members')).filter(f => f.endsWith('.md')).length, 8)
  assert.ok(ctx.services.tools.get('dispatch_member'), '注册了派工工具')
  assert.equal(ctx.services.systemPrompt._sections.length, 1)
  const text = ctx.services.systemPrompt._sections[0].text({ scope: undefined })
  assert.match(text, /backend-dev/)
  assert.match(text, /dispatch_member/)
  ctx.dispose()   // 真实 cordis 里 ctx.inject 子 fiber 的注册随插件卸载自动清理；假 ctx 不模拟这一层
})

test('实时折叠：队长派工 → 子会话 → 用量 / 成本 / 状态 / 沟通', async () => {
  const svc = makeServices()
  const ctx = new FakeCtx(svc)
  core.apply(ctx, { port: 0 })
  const t0 = Date.now()
  const lead = fakeSession('session-lead', { cwd: 'C:/proj/demo' })
  ctx.emit('session/created', lead)
  feed(ctx, lead, 'turn/start', { turn: 1 }, t0)
  feed(ctx, lead, 'user/message', { role: 'user', content: [{ type: 'text', text: '用 agent team 做个演示' }], source: { kind: 'user' } }, t0 + 1)
  toolCall(ctx, lead, 'call-1', 'subagent', { description: '研发部·实现数据层', prompt: '写 store.js' }, t0 + 10)
  // 子会话由 spawn provider 建立
  const kid = fakeSession('session-kid', { cwd: 'C:/proj/demo', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 })
  ctx.emit('session/created', kid)
  ctx.emit('subagent/start', { runId: 'run-1', provider: 'spawn', id: 'session-kid', local: true })
  feed(ctx, kid, 'turn/start', { turn: 1 }, t0 + 20)
  toolCall(ctx, kid, 'k1', 'write', { path: 'C:/proj/demo/src/store.js', content: 'x' }, t0 + 30)
  toolResult(ctx, kid, 'k1', 'ok', false, t0 + 40)
  assistant(ctx, kid, '已写好 store.js，导出 createStore', usage(100, 50, 1000, 20), 'deepseek-official', 'deepseek-v4-flash', t0 + 50)
  assistant(ctx, kid, '', usage(100, 50, 1000, 20), 'deepseek-official', 'deepseek-v4-flash', t0 + 51)

  let snap = (await import('../lib/snapshot.js')).buildSnapshot({})
  assert.equal(snap.session.id, 'session-lead')
  assert.equal(snap.members.length, 1)
  const m = snap.members[0]
  assert.equal(m.status, 'running')
  assert.equal(m.dept, 'dev', '按“研发部·标题”归到研发部')
  assert.equal(m.usage.in, 200); assert.equal(m.usage.out, 100); assert.equal(m.usage.cache_read, 2000); assert.equal(m.usage.cache_write, 40)
  assert.equal(m.totalTokens, 2340)
  assert.equal(m.modelFamily, 'deepseek')
  assert.equal(m.priceKey, 'deepseek-v4-flash')
  assert.ok(m.cost > 0 && m.cost < 0.01)
  assert.equal(m.writes.length, 1)
  assert.ok(snap.comms.some(c => c.kind === 'assign' && c.to === 'session-kid'))

  // 收工：turn/end + subagent/end + 队长收到 tool/result
  feed(ctx, kid, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 60)
  ctx.emit('subagent/end', { runId: 'run-1', provider: 'spawn', id: 'session-kid', local: true, stopReason: 'completed' })
  toolResult(ctx, lead, 'call-1', '已写好 store.js', false, t0 + 70)
  assistant(ctx, lead, '阿服完成了', usage(10, 5), 'deepseek-official', 'deepseek-v4-pro', t0 + 80)
  feed(ctx, lead, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 90)
  snap = (await import('../lib/snapshot.js')).buildSnapshot({})
  assert.equal(snap.members[0].status, 'completed')
  assert.equal(snap.lead.phase, 'finished')
  assert.equal(snap.lead.model, 'deepseek-v4-pro')
  assert.ok(snap.comms.some(c => c.kind === 'report' && c.from === 'session-kid'))
  assert.equal(snap.departments.find(d => d.id === 'dev').done, 1)
  assert.equal(snap.totals.unpriced, 0)
  // 同一事件重复喂（两个插件都挂了监听）不重复计数
  const before = snap.members[0].usage.out
  ctx.emit('session/event', kid, kid.events[kid.events.length - 3])
  snap = (await import('../lib/snapshot.js')).buildSnapshot({})
  assert.equal(snap.members[0].usage.out, before)
  ctx.dispose()
})

test('未定价的第三方模型显示未定价而不是瞎算；provider/model 行优先', async () => {
  const { buildSnapshot } = await import('../lib/snapshot.js')
  const svc = makeServices(); const ctx = new FakeCtx(svc); core.apply(ctx, { port: 0 })
  const lead = fakeSession('session-p'); ctx.emit('session/created', lead)
  feed(ctx, lead, 'turn/start', { turn: 1 })
  assistant(ctx, lead, 'hi', usage(100000, 100000), 'my-relay', 'Mystery-Model-9')
  let snap = buildSnapshot({ session: 'session-p' })
  assert.equal(snap.lead.cost, null)
  assert.deepEqual(snap.totals.unpricedModels, ['my-relay/Mystery-Model-9'])
  // 加一行 provider/model 前缀价格
  const cfg = team.teamCfg(); cfg.pricing_usd_per_mtok['my-relay/mystery-model'] = { in: 1, out: 2, cache_read: 0.1, cache_write: 1 }; team.saveTeamCfg()
  snap = buildSnapshot({ session: 'session-p' })
  assert.ok(snap.lead.cost > 0)
  assert.equal(team.priceEntry('my-relay', 'Mystery-Model-9')[0], 'my-relay/mystery-model')
  // 中转站带倍率后缀的 id 也能按前缀匹配到官方行
  assert.equal(team.priceEntry('baomiao', 'DeepSeek-V4-Flash-Vision-Exp (1.20x)')[0], 'deepseek-v4-flash')
  assert.equal(team.modelFamily('openai/gpt-5'), 'gpt')
  ctx.dispose()
})

test('dispatch_member 工具：找成员 → 调 ctx.subagents.start → 返回回报，并把子会话关联到队长', async () => {
  const calls = []
  const svc = makeServices({
    startImpl: async (provider, req) => {
      calls.push({ provider, req })
      return { id: 'session-child-1', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '测试写好了' }] }), dispose: async () => {} }
    },
  })
  const ctx = new FakeCtx(svc); core.apply(ctx, { port: 0 })
  const tool = svc.tools.get('dispatch_member')
  const agent = { session: fakeSession('session-boss') }
  ctx.emit('session/created', agent.session)
  const out = await tool.execute({ member: 'qa-tester', description: '写测试', prompt: '给 store.js 写单元测试' }, { agent, signal: new AbortController().signal, callId: 'c9' })
  assert.match(out, /测测/); assert.match(out, /测试写好了/)
  assert.equal(calls[0].provider, 'spawn')
  assert.match(calls[0].req.persona, /测试工程师/)
  assert.equal(calls[0].req.agentOptions, undefined, '路由没声明支持 effort 时不发，避免子代理准备请求就报错')
  assert.equal(calls[0].req.label, '写测试')
  const child = store.sessions.get('session-child-1')
  assert.equal(child.parent, 'session-boss'); assert.equal(child.member, 'qa-tester')
  await assert.rejects(tool.execute({ member: 'nobody', description: 'x', prompt: 'y' }, { agent, signal: new AbortController().signal, callId: 'c10' }), /没有成员 nobody/)
  // 成员指定了路由与模型、模型声明支持 high → 三个字段都发
  fs.writeFileSync(path.join(process.env.DSH_AGENT_TEAM_HOME, 'members', 'pro-dev.md'), "---\nname: pro-dev\ndescription: 高档工程师，复杂算法时用\nprovider: deepseek-official\nmodel: deepseek-v4-pro\neffort: xhigh\ndept: dev\n---\n你是 pro-dev。\n", 'utf8')
  await tool.execute({ member: 'pro-dev', description: '算法', prompt: '写个排序' }, { agent, signal: new AbortController().signal, callId: 'c11' })
  assert.deepEqual(calls[1].req.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, 'xhigh 映射到路由支持的 high')
  fs.unlinkSync(path.join(process.env.DSH_AGENT_TEAM_HOME, 'members', 'pro-dev.md'))
  ctx.dispose()
})

test('子代理带覆盖参数时还没干活就出错 → 自动去掉覆盖重试一次', async () => {
  let n = 0
  const svc = makeServices({
    startImpl: async (provider, req) => {
      n++
      const bad = !!req.agentOptions
      return { id: `session-r${n}`, result: Promise.resolve(bad ? { stopReason: 'error', output: [] } : { stopReason: 'completed', output: [{ type: 'text', text: '成了' }] }), dispose: async () => {} }
    },
  })
  const ctx = new FakeCtx(svc); core.apply(ctx, { port: 0 })
  fs.writeFileSync(path.join(process.env.DSH_AGENT_TEAM_HOME, 'members', 'odd-dev.md'), "---\nname: odd-dev\ndescription: 路由不存在的成员，测试用\nprovider: ghost\nmodel: ghost-1\ndept: dev\n---\n你是 odd-dev。\n", 'utf8')
  const out = await svc.tools.get('dispatch_member').execute({ member: 'odd-dev', description: 'x', prompt: 'y' }, { agent: { session: fakeSession('s2') }, signal: new AbortController().signal, callId: 'c1' })
  assert.match(out, /成了/); assert.equal(n, 2)
  fs.unlinkSync(path.join(process.env.DSH_AGENT_TEAM_HOME, 'members', 'odd-dev.md'))
  ctx.dispose()
})

test('provider 不支持 persona 时退回到把 persona 写进 prompt', async () => {
  let n = 0
  const svc = makeServices({
    startImpl: async (provider, req) => {
      n++
      if (req.persona) { const e = new Error('UNSUPPORTED_CAPABILITY: persona'); e.code = 'UNSUPPORTED_CAPABILITY'; throw e }
      return { id: `session-c${n}`, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }
    },
  })
  const ctx = new FakeCtx(svc); core.apply(ctx, { port: 0 })
  const out = await svc.tools.get('dispatch_member').execute({ member: 'docs-writer', description: '写文档', prompt: '写 README' }, { agent: { session: fakeSession('s') }, signal: new AbortController().signal, callId: 'c1' })
  assert.match(out, /文文/); assert.equal(n, 2)
  ctx.dispose()
})

test('看板：路由、页面、快照、成员 / 部门 / 形象 API、启动按钮注入（webServer 到位时由核心插件挂载）', async () => {
  const svc = makeServices(); const ctx = new FakeCtx(svc)
  core.apply(ctx, { port: 0 })
  const prefix = svc.webServer._routes.find(r => r.kind === 'prefix' && r.path === '/agent-team')
  assert.ok(prefix, '注册了 /agent-team 前缀路由')
  assert.ok(svc.webServer._routes.some(r => r.path === '/agent-team-launcher.js'))
  const html = svc.webServer._taps[0]('<html><body></body></html>')
  assert.match(html, /agent-team-launcher\.js/)
  const server = http.createServer((req, res) => prefix.handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/agent-team`
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() } }
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() } }
  try {
    let r = await get('/')
    assert.equal(r.status, 200); assert.match(r.type, /text\/html/); assert.match(r.body, /Agent Team 指挥室/); assert.doesNotMatch(r.body, /fetch\('\//, '页面里不能有绝对路径 fetch')
    r = await get('/snapshot.json'); assert.equal(r.status, 200)
    const snap = JSON.parse(r.body)
    assert.ok(Array.isArray(snap.roster) && snap.roster.length >= 8); assert.ok(snap.pets.includes('pip')); assert.equal(snap.harness, 'dsh')
    r = await get('/sprites/pip.webp'); assert.equal(r.status, 200); assert.match(r.type, /image\/webp/)
    r = await get('/sprites/../package.json'); assert.notEqual(r.status, 200)
    r = await get('/api/agents'); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).toolName, 'dispatch_member')
    // 建成员
    let pr = await post('/api/agents', { name: 'ds-coder', display: '深深', role: '算法工程师', dept: 'dev', provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'high', description: '深深·算法工程师（研发部）。数值算法、性能优化时使用。', body: '你是深深。' })
    assert.equal(pr.status, 200, JSON.stringify(pr.json)); assert.equal(pr.json.agent.model, 'deepseek-v4-pro')
    assert.match(fs.readFileSync(path.join(process.env.DSH_AGENT_TEAM_HOME, 'members', 'ds-coder.md'), 'utf8'), /provider: deepseek-official/)
    pr = await post('/api/agents', { name: 'Bad Name', description: 'xxxxxxxxxx' }); assert.equal(pr.status, 400)
    // 部门
    pr = await post('/api/departments', { id: 'design', name: '设计部', icon: '🎨', required: 'optional' }); assert.equal(pr.status, 200)
    pr = await post('/api/departments/delete', { id: 'hq' }); assert.equal(pr.status, 400)
    pr = await post('/api/departments/delete', { id: 'design' }); assert.equal(pr.status, 200)
    // 形象：上传一张合法尺寸的 png（最小 IHDR 头即可通过尺寸校验）
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 6, 0, 0, 0, 7, 80, 8, 6, 0, 0, 0]), Buffer.alloc(16)])
    pr = await post('/api/pets', { id: 'my-cat', filename: 'my-cat.png', data: png.toString('base64') })
    assert.equal(pr.status, 200, JSON.stringify(pr.json)); assert.equal(pr.json.pet.rows, 9)
    pr = await post('/api/members/pet', { id: 'session-x', pet: 'my-cat', scope: 'member' }); assert.equal(pr.status, 200)
    pr = await post('/api/pets/delete', { id: 'pip' }); assert.equal(pr.status, 400, '自带形象不能删')
    pr = await post('/api/pets/delete', { id: 'my-cat' }); assert.equal(pr.status, 200)
    pr = await post('/api/agents/delete', { name: 'ds-coder' }); assert.equal(pr.status, 200)
    r = await get('/status.json'); assert.equal(r.status, 200)
    r = await get('/nope'); assert.equal(r.status, 404)
  } finally {
    server.close(); ctx.dispose()
  }
})

test('缺 Web 服务的组合（headless）：只硬依赖 sessions，看板挂起等待 webServer，派工与提示词照常，不报错', () => {
  assert.deepEqual(core.inject, ['sessions'])
  assert.deepEqual(board.inject, ['webServer'])
  assert.equal(typeof core.Config['~standard'].validate, 'function', 'Config 实现 Standard Schema')
  assert.equal(core.Config['~standard'].validate({ toolName: 'bad name!' }).value.toolName, 'dispatch_member')
  const svc = makeServices(); delete svc.webServer
  const ctx = new FakeCtx(svc)
  core.apply(ctx, { port: 0 })
  assert.ok(svc.tools.get('dispatch_member')); assert.equal(svc.systemPrompt._sections.length, 1)
  assert.deepEqual(ctx.pendingInjects, [['settings'], ['webServer']])
  ctx.dispose()
})

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ } })

test('浏览器半边：lazy-CJS factory 产物能被宿主的模块加载器执行，导出 apply/inject 并认领 settings.plugin.item', async () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const win = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  new Function('window', src)(win)
  assert.equal(loaded.id, 'dsh-agent-team')
  const react = { createElement: (...a) => a, useState: (v) => [v, () => {}], useEffect: () => {} }
  const mod = loaded.factory((name) => { assert.equal(name, 'react'); return react })
  assert.deepEqual(mod.inject, ['slots'])
  const regs = []
  const slots = { inject: (name, fn) => fn(), register: (spec, comp) => { regs.push({ spec, comp }); return () => {} } }
  mod.apply({ slots })
  const card = regs.find(r => r.spec.name === 'settings.plugin.item')
  assert.equal(card.spec.key, 'agent-team', '与 Host 半边 installSection 的命名空间一致')
  assert.ok(card.comp({ view: 'page' }), '能渲染')
})
