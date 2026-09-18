#!/usr/bin/env node
// 不装 DSH 也能看看板长什么样：起一个本地 HTTP 服务，用脚本化的 session 事件演一场“队长派 4 位成员干活”。
//   node scripts/demo.mjs [port]     → http://127.0.0.1:7789/agent-team/
// 也用于 README 截图与前端开发。数据写到临时目录，不碰 ~/.dsh。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_AGENT_TEAM_HOME = process.env.DSH_AGENT_TEAM_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-team-demo-'))
const { mountBoard } = await import('../lib/board.js')
const { FakeCtx, fakeSession, feed, assistant, toolCall, toolResult, usage } = await import('../test/helpers.js')

const port = Number(process.argv[2] || 7789)
const routes = []
const ctx = new FakeCtx({
  sessions: { list: () => [] },
  webServer: { port, register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } },
  llm: { listProviders: async () => [{ id: 'deepseek-official' }], listModels: async () => [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] },
})
mountBoard(ctx, { basePath: '/agent-team', launcher: false, checkUpdates: false })
const prefix = routes.find(r => r.kind === 'prefix')
http.createServer((req, res) => {
  if (req.url === '/' ) { res.writeHead(302, { Location: '/agent-team/' }); return res.end() }
  prefix.handler(req, res)
}).listen(port, '127.0.0.1', () => console.log(`demo board: http://127.0.0.1:${port}/agent-team/`))

// ---- 剧本
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const lead = fakeSession('session-demo-lead', { cwd: 'C:/work/todo-app' })
ctx.emit('session/created', lead)
feed(ctx, lead, 'turn/start', { turn: 1 })
feed(ctx, lead, 'user/message', { role: 'user', content: [{ type: 'text', text: '用 agent team 做一个带本地存储的待办清单 demo' }], source: { kind: 'user' } })
assistant(ctx, lead, '我来拆分：数据层 → 界面 → 测试 → 文档。', usage(2000, 300, 8000, 500), 'deepseek-official', 'deepseek-v4-pro')

const plan = [
  ['backend-dev', '实现数据层 store.js', 'deepseek-official', 'deepseek-v4-flash', ['write C:/work/todo-app/src/store.js', 'bash node --check src/store.js']],
  ['frontend-dev', '实现界面 app.js', 'deepseek-official', 'deepseek-v4-flash', ['read C:/work/todo-app/src/store.js', 'write C:/work/todo-app/src/app.js', 'write C:/work/todo-app/index.html']],
  ['qa-tester', '写单元测试', 'deepseek-official', 'deepseek-v4-flash', ['read C:/work/todo-app/src/store.js', 'write C:/work/todo-app/test/store.test.js', 'bash node --test']],
  ['docs-writer', '写 README', 'deepseek-official', 'deepseek-v4-flash', ['read C:/work/todo-app/src/app.js', 'write C:/work/todo-app/README.md']],
]
const kids = []
let n = 0
for (const [member, title] of plan) {
  toolCall(ctx, lead, `call-${++n}`, 'dispatch_member', { member, description: title, prompt: `按 SPEC 完成：${title}` })
}
await sleep(800)
for (const [i, [member, title, provider, model, steps]] of plan.entries()) {
  const kid = fakeSession(`session-demo-${member}`, { cwd: 'C:/work/todo-app', parentSession: lead.id, origin: 'subagent', delegationDepth: 1 })
  ctx.emit('session/created', kid)
  ctx.emit('subagent/start', { runId: `run-${i}`, provider: 'spawn', id: kid.id, local: true })
  const { store } = await import('../lib/store.js')
  store.link(kid.id, lead.id, `call-${i + 1}`, { member, description: title, dispatchedAt: Date.now() / 1000 })
  feed(ctx, kid, 'turn/start', { turn: 1 })
  kids.push({ kid, member, provider, model, steps, i })
}
// 各成员交错干活
let round = 0
while (kids.some(k => k.steps.length)) {
  for (const k of kids) {
    const step = k.steps.shift()
    if (!step) continue
    const [tool, ...rest] = step.split(' ')
    const arg = rest.join(' ')
    const callId = `k-${k.i}-${round}`
    toolCall(ctx, k.kid, callId, tool, tool === 'bash' ? { command: arg } : { path: arg, content: 'x' })
    await sleep(700 + Math.random() * 900)
    toolResult(ctx, k.kid, callId, 'ok')
    assistant(ctx, k.kid, `完成 ${tool}`, usage(400, 120, 3000, 100), k.provider, k.model)
  }
  round++
}
for (const k of kids) {
  await sleep(1200)
  assistant(ctx, k.kid, `已交付：${k.member} 的任务完成，交接单在 .team/handoffs/。`, usage(200, 90, 2500, 0), k.provider, k.model)
  feed(ctx, k.kid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('subagent/end', { runId: `run-${k.i}`, provider: 'spawn', id: k.kid.id, local: true, stopReason: 'completed' })
  toolResult(ctx, lead, `call-${k.i + 1}`, `【${k.member} 回报】已交付`)
}
assistant(ctx, lead, '四位成员都已交付：数据层、界面、测试、文档齐了。', usage(2500, 400, 12000, 300), 'deepseek-official', 'deepseek-v4-pro')
feed(ctx, lead, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
console.log('demo scenario finished; board keeps serving. Ctrl+C to exit')
