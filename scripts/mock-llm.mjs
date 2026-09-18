#!/usr/bin/env node
// 脚本化的 OpenAI 兼容 mock 模型服务（/v1/chat/completions，支持流式），用于零成本地端到端验证：
// 队长收到用户消息 → 调 dispatch_member 派两位成员 → 成员各自回复 → 队长汇总。
// 用法：node scripts/mock-llm.mjs [port]   （默认 3911）；在 DSH 的 llm-pi-ai 里配一个 openai-completions 路由指向它。
import http from 'node:http'

const port = Number(process.argv[2] || 3911)
let counter = 0

function reply(body) {
  const messages = body.messages || []
  const tools = (body.tools || []).map(t => (t.function && t.function.name) || t.name)
  const system = messages.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
  const last = messages[messages.length - 1] || {}
  const hasToolResult = messages.some(m => m.role === 'tool')
  const isMember = /Agent Team 的成员「/.test(system) || /你是(研发部|质量部|文档部|指挥部|研究部|运维部)/.test(system) || (process.env.MOCK_TOOL === 'subagent' && !tools.includes('subagent') && !tools.includes('dispatch_member'))
  if (isMember) {
    const who = (/成员「([^」]+)」/.exec(system) || [])[1] || '成员'
    return { text: `【${who}】任务完成：按要求写好了 lib/add.js（导出 add(a,b)），并自测通过。汇报：产出 1 个文件 / 无偏差 / 无风险。` }
  }
  if (process.env.MOCK_TOOL === 'subagent' && tools.includes('subagent') && !hasToolResult) {
    return { toolCalls: [{ name: 'subagent', args: { description: '实现 add 函数', prompt: '在 lib/add.js 里实现并导出 add(a,b)。完成后一句话汇报。' } }] }
  }
  if (tools.includes('dispatch_member') && !hasToolResult) {
    const members = (process.env.MOCK_MEMBERS || 'backend-dev,qa-tester').split(',').map(x => x.trim()).filter(Boolean)
    return {
      toolCalls: members.map((member, i) => ({ name: 'dispatch_member', args: { member, description: i === 0 ? '实现 add 函数' : `任务 ${i + 1}`, prompt: i === 0 ? '在 lib/add.js 里实现并导出 add(a,b)，纯 JS，不要依赖。完成后一句话汇报。' : '为 lib/add.js 的 add(a,b) 写 node --test 单元测试 test/add.test.js。完成后一句话汇报。' } })),
    }
  }
  if (last.role === 'tool' || hasToolResult) {
    return { text: '两位成员都已回报：阿服实现了 add(a,b)，测测补了单元测试并通过。收尾：本次没有跨文件接缝，不必再派质量部复核。' }
  }
  return { text: '（mock）你好！说“用 agent team 做点什么”我就会派工。' }
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-lead', object: 'model' }, { id: 'mock-member', object: 'model' }] }))
    }
    if (!/chat\/completions$/.test(req.url || '')) { res.writeHead(404); return res.end('{}') }
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const r = reply(body)
    const id = `chatcmpl-mock-${++counter}`
    const usage = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 900 } }
    console.log(`[mock-llm] #${counter} model=${body.model} msgs=${(body.messages || []).length} tools=${(body.tools || []).length} -> ${r.toolCalls ? 'tool_calls' : 'text'}`)
    if (body.stream) {
      const chunks = []
      const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
      if (r.toolCalls) {
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        r.toolCalls.forEach((tc, i) => {
          chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${counter}_${i}`, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }] })
          chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args) } }] }, finish_reason: null }] })
        })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
      } else {
        chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        for (const piece of r.text.match(/.{1,12}/g) || []) chunks.push({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
      }
      return sse(res, chunks)
    }
    const message = r.toolCalls
      ? { role: 'assistant', content: null, tool_calls: r.toolCalls.map((tc, i) => ({ id: `call_${counter}_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }
      : { role: 'assistant', content: r.text }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message, finish_reason: r.toolCalls ? 'tool_calls' : 'stop' }], usage }))
  })
})
server.listen(port, '127.0.0.1', () => console.log(`[mock-llm] listening on http://127.0.0.1:${port}/v1`))
