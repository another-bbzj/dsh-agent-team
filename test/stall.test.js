import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpHome, FakeCtx, fakeSession, feed } from './helpers.js'

const home = tmpHome()
const stall = await import('../lib/stall.js')
const { store } = await import('../lib/store.js')
const core = await import('../lib/index.js')
const { buildSnapshot } = await import('../lib/snapshot.js')
const team = await import('../lib/team.js')

function member(extra = {}) {
  return { id: 'm', name: '合成成员', status: 'stalled', ...extra }
}

function services() {
  const tools = new Map()
  return {
    sessions: { list: () => [] },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) }, get(name) { return tools.get(name) } },
    subagents: { start: async () => { throw new Error('no provider') } },
    systemPrompt: { section() { return () => {} } },
    webServer: { port: 0, register() { return () => {} }, tapIndex() { return () => {} } },
    llm: { resolveModelInfo: async () => ({}) },
  }
}

test('安静时间：活动时间优先于更早的事件，开工时间单独不算', () => {
  assert.deepEqual(
    stall.memberIdleAge(member({ lastActivityAt: 1000, timeline: [{ ts: 100 }], endedAt: 50, startedAt: 1 }), 1600),
    { seconds: 600, basis: 'lastActivityAt', anchor: 1000 },
  )
  assert.deepEqual(
    stall.memberIdleAge(member({ idleSeconds: 90, lastActivityAt: 1 }), 1000),
    { seconds: 90, basis: 'idleSeconds', anchor: 910 },
  )
  assert.deepEqual(
    stall.memberIdleAge(member({ lastActivityAt: null, startedAt: 10, endedAt: 400, timeline: [{ ts: 100 }, { kind: 'note' }, { ts: 250 }] }), 1000),
    { seconds: 600, basis: 'lastEvent', anchor: 400 },
  )
  assert.equal(stall.memberIdleAge(member({ lastActivityAt: null, startedAt: 10, timeline: [] }), 1000), null)
  assert.equal(stall.memberIdleAge(member({ lastActivityAt: true, idleSeconds: false, timeline: [{ ts: '100' }] }), 1000), null)
  const future = stall.memberIdleAge(member({ lastActivityAt: 5000 }), 1000)
  assert.equal(future.seconds, 0)
  assert.equal(future.basis, 'lastActivityAt')
})

test('阈值缺省 10 分钟，非法值回默认，过小过大被夹住', () => {
  assert.equal(stall.normalizeThreshold(undefined), 600)
  assert.equal(stall.normalizeThreshold('600'), 600)
  assert.equal(stall.normalizeThreshold(true), 600)
  assert.equal(stall.normalizeThreshold(1), 60)
  assert.equal(stall.normalizeThreshold(1e9), 86400)
})

test('只有空闲、出错、停滞且能计时的成员进入名单', () => {
  const now = 2000
  const members = [
    member({ id: 'run', status: 'running', lastActivityAt: 1 }),
    member({ id: 'done', status: 'completed', lastActivityAt: 1 }),
    member({ id: 'fresh-error', status: 'error', lastActivityAt: 1900, errorReason: 'token 上限' }),
    member({ id: 'old-error', status: 'error', lastActivityAt: 1000, errorReason: 'x'.repeat(200) }),
    member({ id: 'idle-unknown', name: '官方队友', status: 'idle', lastActivityAt: null, timeline: [] }),
    member({ id: 'idle-old', status: 'idle', lastActivityAt: 1500 }),
    member({ id: 'stall', status: 'stalled', lastActivityAt: 1000 }),
    'not-a-member',
    { status: 'stalled', lastActivityAt: 1000 },
  ]
  const found = stall.stallCandidates(members, now)
  assert.deepEqual(found.map(item => item.id), ['', 'old-error', 'stall', 'idle-old', 'fresh-error'])
  assert.equal(found[0].name, '成员')
  assert.equal(found[1].errorReason, 'x'.repeat(120))
  assert.equal(found[1].idleSeconds, 1000)
  const active = stall.activeStallAlerts(found, 600)
  assert.deepEqual(active.map(item => item.id), ['', 'old-error', 'stall'])
  assert.ok(!active.some(item => item.id === 'fresh-error'))
  assert.ok(!found.some(item => item.id === 'idle-unknown'))
})

test('挂到快照上不改成员，非法对象原样返回', () => {
  const snapshot = { generatedAt: 1900, members: [member({ id: 'a', status: 'stalled', lastActivityAt: 1000 })] }
  stall.attachStallAlerts(snapshot)
  assert.equal(snapshot.stallAlerts.thresholdSec, 600)
  assert.equal(snapshot.stallAlerts.defaultThresholdSec, 600)
  assert.equal(snapshot.stallAlerts.candidates[0].idleSeconds, 900)
  assert.equal(snapshot.members[0].name, '合成成员')
  const bad = ['nope']
  assert.equal(stall.attachStallAlerts(bad), bad)
})

test('页面里的计时函数和 lib/stall.js 对同一批成员结果一致', () => {
  const html = fs.readFileSync(new URL('../assets/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('/* stall-alerts:start */')
  const end = html.indexOf('/* stall-alerts:end */')
  assert.ok(start >= 0 && end > start, '页面缺少 stall-alerts 标记')
  const cases = [
    member({ status: 'stalled', lastActivityAt: 1000, timeline: [{ ts: 100 }], startedAt: 1 }),
    member({ status: 'error', idleSeconds: 90, lastActivityAt: 1, errorReason: '上限' }),
    member({ status: 'idle', lastActivityAt: null, startedAt: 10, endedAt: 400, timeline: [{ ts: 250 }] }),
    member({ status: 'idle', lastActivityAt: null, startedAt: 10, timeline: [] }),
    member({ status: 'running', lastActivityAt: 1 }),
    member({ status: 'stalled', lastActivityAt: 5000 }),
    { status: 'stalled', lastActivityAt: 1000, idleSeconds: true },
  ]
  const now = 1600
  const expected = cases.map(item => stall.stallCandidates([item], now))
  const script = path.join(os.tmpdir(), `dsh-stall-parity-${process.pid}.mjs`)
  fs.writeFileSync(script, `${html.slice(start, end)}\nconst cases = ${JSON.stringify(cases)};\nconst now = ${now};\nprocess.stdout.write(JSON.stringify(cases.map(item => stallCandidatesFromMembers([item], now))));\n`)
  const completed = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 })
  fs.rmSync(script, { force: true })
  assert.equal(completed.status, 0, completed.stderr)
  const canon = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value === Math.trunc(value)) return Math.trunc(value)
    if (Array.isArray(value)) return value.map(canon)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canon(v)]))
    return value
  }
  assert.deepEqual(canon(JSON.parse(completed.stdout)), canon(expected))
})

test('真实会话：进行中和已完成不提醒，出错原因只用 Harness 记下的 kind', () => {
  const ctx = new FakeCtx(services())
  core.apply(ctx, { port: 0 })
  const now = Date.now()
  const lead = fakeSession('stall-lead', { cwd: 'C:/proj/stall' })
  ctx.emit('session/created', lead)
  feed(ctx, lead, 'turn/start', { turn: 1 }, now)
  feed(ctx, lead, 'user/message', { role: 'user', content: [{ type: 'text', text: '看谁停了' }], source: { kind: 'user' } }, now)

  const add = (id, memberName, title) => {
    const kid = fakeSession(id, { cwd: 'C:/proj/stall', parentSession: lead.id, origin: 'subagent', delegationDepth: 1 })
    ctx.emit('session/created', kid)
    store.link(id, lead.id, `call-${id}`, { member: memberName, description: title })
    return kid
  }
  const stalled = add('stall-kid', 'backend-dev', '实现数据层')
  feed(ctx, stalled, 'turn/start', { turn: 1 }, now - 20 * 60 * 1000)
  feed(ctx, stalled, 'tool/call', { turn: 1, step: 1, callId: 's1', name: 'write', arguments: JSON.stringify({ path: 'C:/proj/stall/src/store.js' }) }, now - 20 * 60 * 1000 + 1000)
  const errored = add('err-kid', 'qa-tester', '写测试')
  feed(ctx, errored, 'turn/start', { turn: 1 }, now - 25 * 60 * 1000)
  feed(ctx, errored, 'turn/end', { turn: 1, reason: { kind: 'error' } }, now - 25 * 60 * 1000 + 2000)
  const running = add('run-kid', 'frontend-dev', '写界面')
  feed(ctx, running, 'turn/start', { turn: 1 }, now - 30 * 1000)
  const done = add('done-kid', 'docs-writer', '写文档')
  feed(ctx, done, 'turn/start', { turn: 1 }, now - 40 * 60 * 1000)
  feed(ctx, done, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '写好了' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }, now - 40 * 60 * 1000 + 1000)
  feed(ctx, done, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, now - 40 * 60 * 1000 + 2000)
  const idle = add('idle-kid', 'researcher', '先看看')
  feed(ctx, idle, 'user/message', { role: 'user', content: [{ type: 'text', text: '等指令' }], source: { kind: 'user' } }, now - 15 * 60 * 1000)

  const snap = buildSnapshot({ session: 'stall-lead' })
  const byId = Object.fromEntries(snap.members.map(m => [m.id, m]))
  assert.equal(byId['stall-kid'].status, 'stalled')
  assert.equal(byId['err-kid'].status, 'error')
  assert.equal(byId['err-kid'].errorReason, 'error')
  assert.equal(byId['run-kid'].status, 'running')
  assert.equal(byId['done-kid'].status, 'completed')
  assert.equal(byId['done-kid'].errorReason, '')
  assert.equal(byId['idle-kid'].status, 'idle')
  assert.equal(snap.stallAlerts.thresholdSec, 600)
  const ids = snap.stallAlerts.candidates.map(c => c.id)
  for (const absent of ['run-kid', 'done-kid']) assert.ok(!ids.includes(absent), absent)
  for (const present of ['stall-kid', 'err-kid', 'idle-kid']) assert.ok(ids.includes(present), present)
  const active = stall.activeStallAlerts(snap.stallAlerts.candidates, 600)
  assert.deepEqual(active.map(c => c.id), ['err-kid', 'stall-kid', 'idle-kid'])
  assert.equal(active.find(c => c.id === 'stall-kid').name, '阿服')
  assert.equal(active.find(c => c.id === 'err-kid').errorReason, 'error')
  assert.ok(active.every(c => c.idleSeconds >= 600 && c.idleSeconds < 50 * 60))

  const cfg = team.teamCfg()
  cfg.stallAlertSec = 1
  team.saveTeamCfg()
  assert.equal(buildSnapshot({ session: 'stall-lead' }).stallAlerts.thresholdSec, 60)
  cfg.stallAlertSec = 1e12
  team.saveTeamCfg()
  assert.equal(buildSnapshot({ session: 'stall-lead' }).stallAlerts.thresholdSec, 86400)
  cfg.stallAlertSec = 'nope'
  team.saveTeamCfg()
  assert.equal(buildSnapshot({ session: 'stall-lead' }).stallAlerts.thresholdSec, 600)
  delete cfg.stallAlertSec
  team.saveTeamCfg()
  const shipped = JSON.parse(fs.readFileSync(new URL('../assets/team.json', import.meta.url), 'utf8'))
  assert.equal(Object.hasOwn(shipped, 'stallAlertSec'), false)
  const page = fs.readFileSync(new URL('../assets/index.html', import.meta.url), 'utf8')
  assert.match(page, /id="stall-panel"/)
  assert.match(page, /不补一个时长/)
  assert.match(page, /不会提前改写进行中/)
  assert.match(page, /m\.errorReason \?/)
  assert.doesNotMatch(page, /中断（token 上限）/)
  ctx.dispose()
})

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ } })
