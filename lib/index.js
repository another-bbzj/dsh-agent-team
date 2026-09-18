// dsh-agent-team 核心插件：实时状态折叠 + dispatch_member 工具（按部门成员派工）+ 队长的系统提示词。
// 纯 ESM、零依赖、不依赖任何 @deepseek-ai/* 运行时导入，所以 git / npm / 本地 link 三种安装都不需要构建。
import { store, attach, contentText, shortStr } from './store.js'
import { ensureData, loadMembers, teamCfg, readMember } from './team.js'
import { version } from './paths.js'
import { mountBoard } from './board.js'

export const name = 'dsh-agent-team'
// 只硬依赖 sessions（任何组合都有）；tools/subagents/systemPrompt/webServer 都通过 ctx.inject 按需挂载：
// 缺哪个就只少哪块功能（例如 headless 组合没有 Web 服务 → 没看板，但派工照常），绝不让整棵插件树启动失败。
export const inject = ['sessions']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-agent-team',
    validate(value) {
      const v = value && typeof value === 'object' ? { ...value } : {}
      const out = {
        subagentProvider: typeof v.subagentProvider === 'string' && v.subagentProvider ? v.subagentProvider : 'spawn',
        toolName: typeof v.toolName === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(v.toolName) ? v.toolName : 'dispatch_member',
        promptSection: v.promptSection !== false,
        promptOrder: Number.isFinite(v.promptOrder) ? v.promptOrder : 5000,
        maxPromptChars: Number.isFinite(v.maxPromptChars) ? v.maxPromptChars : 20000,
        board: v.board !== false,
        basePath: typeof v.basePath === 'string' && /^\/[a-z0-9-]+$/.test(v.basePath) ? v.basePath : '/agent-team',
        launcher: v.launcher !== false,
        checkUpdates: v.checkUpdates !== false,
      }
      return { value: out }
    },
  },
}

/** 成员表（给队长看的系统提示词片段）。 */
export function membersPrompt(toolName) {
  const cfg = teamCfg()
  const members = loadMembers()
  const lines = []
  lines.push('# Agent Team（部门制多代理）')
  lines.push(`当用户说“用 agent team / 团队 / 多代理 / 分头做”，或任务需要 ≥ 3 个独立模块并行时，用 \`${toolName}\` 工具把工作派给下面的常驻成员（每人自带模型与思考强度）；S 级小任务直接做并说明原因。一次模型回合里可以同时发出多个 \`${toolName}\` 调用，它们会并行执行。`)
  lines.push('派工 prompt 要自包含（成员看不到本对话）：目标、文件路径、接口约定、完成标准。成员回报后，用一两句话转述每个人的结论，不要只说“完成了”。≥ 2 人写了代码时收尾建议派质量部复核；交付给人用的东西建议派文档部。')
  lines.push('')
  for (const d of cfg.departments) {
    const ms = Object.values(members).filter(m => m.dept === d.id)
    if (!ms.length) continue
    lines.push(`## ${d.icon || ''} ${d.name}（${d.id}）`)
    for (const m of ms) {
      const route = [m.provider, m.model].filter(Boolean).join('/')
      lines.push(`- \`${m.name}\`：${m.display}·${m.role || ''}${route ? `（${route}${m.effort ? ` · ${m.effort}` : ''}）` : ''}。${m.description}`)
    }
  }
  lines.push('')
  lines.push('看板：DSH Web 右下角「Agent Team」按钮，或打开 /agent-team/ 。成员之间靠项目里的 `.team/` 办公目录交流（工单 tickets/、收件箱 inbox/<成员id>.md、交接单 handoffs/）；派工 prompt 只给路径指针，成员汇报 ≤ 200 字。')
  return lines.join('\n')
}

/** ctx.inject 的保险版：服务永远不来就永远不跑（不是错误）；回调抛错只打日志。 */
function safeInject(ctx, deps, fn) {
  try {
    if (typeof ctx.inject === 'function') return ctx.inject(deps, (c) => { try { fn(c) } catch (err) { console.warn(`[dsh-agent-team] ${deps.join('+')} 挂载失败: ${err && err.message}`) } })
    if (deps.every(d => (ctx.get ? ctx.get(d) : ctx[d]))) fn(ctx)
  } catch (err) {
    console.warn(`[dsh-agent-team] 无法等待服务 ${deps.join('+')}: ${err && err.message}`)
  }
}

/** 成员的思考强度只在目标路由明确声明支持时才发（发了不支持的 effort，子代理会在准备请求时直接报错）。 */
const effortCache = new Map()
async function effectiveEffort(ctx, provider, model, wanted) {
  if (!wanted || !provider || !model) return ''
  const key = `${provider}/${model}`
  let efforts = effortCache.get(key)
  if (efforts === undefined) {
    efforts = null
    try {
      const llm = ctx.get ? ctx.get('llm') : ctx.llm
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await Promise.race([llm.resolveModelInfo(provider, model), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
        const list = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : null
        efforts = list ? list.map(e => String(e && (e.id || e))).filter(Boolean) : []
      }
    } catch { efforts = null }
    effortCache.set(key, efforts)
    if (effortCache.size > 200) effortCache.delete(effortCache.keys().next().value)
  }
  if (!efforts) return ''                       // 路由信息拿不到：宁可不发
  if (efforts.includes(wanted)) return wanted
  // 常见同义映射：xhigh/max → high，minimal/none → low
  const alias = { xhigh: 'high', max: 'high', minimal: 'low', none: 'low', med: 'medium' }[wanted]
  return alias && efforts.includes(alias) ? alias : ''
}

function isChildScope(ctx, scope) {
  try {
    const agents = ctx.get ? ctx.get('agents') : ctx.agents
    const agent = agents && scope ? agents.get(scope) : null
    const header = agent && agent.session && agent.session.header
    return !!(header && (header.origin === 'subagent' || (header.delegationDepth || 0) > 0))
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const cfgIn = Config['~standard'].validate(config).value
  ensureData()
  const disposers = []
  const dispose = (d) => { if (typeof d === 'function') disposers.push(d) }

  // 1) 实时状态
  dispose(attach(ctx, ctx.sessions))
  // 调试 / 报 bug 用：DSH_AGENT_TEAM_DUMP=<文件> 时每个回合结束把 snapshot.json 写到该文件（headless 也能看到看板数据）
  if (process.env.DSH_AGENT_TEAM_DUMP) {
    const dumpTo = process.env.DSH_AGENT_TEAM_DUMP
    let timer = null
    dispose(ctx.on('session/event', (session, event) => {
      if (!event || (event.type !== 'turn/end' && event.type !== 'tool/result')) return
      clearTimeout(timer)
      timer = setTimeout(async () => {
        try { const { buildSnapshot } = await import('./snapshot.js'); const fs = await import('node:fs'); fs.writeFileSync(dumpTo, JSON.stringify(buildSnapshot({}), null, 1)) } catch (err) { console.warn(`[dsh-agent-team] dump 失败: ${err && err.message}`) }
      }, 200)
    }))
  }

  // 2) 派工工具（tools + subagents 就绪时挂上；provider 重载时自动重挂）
  const toolName = cfgIn.toolName
  const mountTool = (ctx) => { try {
    ctx.tools.register({
      name: toolName,
      description: `把一项自包含的任务派给 Agent Team 的常驻成员（每位成员有自己的岗位提示词、模型与思考强度，来自 ~/.dsh/agent-team/members/*.md）。member 填成员标识（如 backend-dev、qa-tester）；description 是 3-8 个字的任务标题（看板上显示）；prompt 必须自包含：目标、文件路径、接口约定、完成标准——成员看不到本对话。返回成员的最终回报。同一回合可并行发出多个调用。`,
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: '成员标识，见系统提示词里的 Agent Team 成员表' },
          description: { type: 'string', description: '3-8 个字的任务标题，看板上显示' },
          prompt: { type: 'string', description: '给成员的完整、自包含的任务说明' },
        },
        required: ['member', 'description', 'prompt'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      async execute(args, exec) {
        const a = args && typeof args === 'object' ? args : {}
        const memberId = String(a.member || '').trim()
        const description = shortStr(String(a.description || ''), 120)
        const prompt = String(a.prompt || '')
        if (!memberId) throw new Error('member 不能为空')
        if (!prompt.trim()) throw new Error('prompt 不能为空')
        if (prompt.length > cfgIn.maxPromptChars) throw new Error(`prompt 超过 ${cfgIn.maxPromptChars} 字符，请只给路径指针，不要贴整段内容`)
        const m = readMember(memberId)
        if (!m) {
          const all = Object.keys(loadMembers()).join('、')
          throw new Error(`没有成员 ${memberId}。现有：${all || '（无）'}；可在看板「新建成员」里添加`)
        }
        if (!exec || !exec.agent) throw new Error('这个工具只能由正在运行的 Agent 调用')
        const parentId = exec.agent.session && exec.agent.session.id ? exec.agent.session.id : ''
        const agentOptions = {}
        let parentRoute = {}
        try { const h = exec.agent.session && exec.agent.session.requestHeader && exec.agent.session.requestHeader(); if (h && h.config) parentRoute = { provider: h.config.provider || '', model: h.config.model || '' } } catch { parentRoute = {} }
        if (m.provider) agentOptions.provider = m.provider
        if (m.model) agentOptions.model = m.model
        if (agentOptions.model && !agentOptions.provider && parentRoute.provider) agentOptions.provider = parentRoute.provider   // 只填了模型没填路由：沿用父会话的路由
        if (m.effort) {
          const eff = await effectiveEffort(ctx, agentOptions.provider || parentRoute.provider, agentOptions.model || parentRoute.model, m.effort)
          if (eff) agentOptions.reasoningEffort = eff
          else if (process.env.DSH_AGENT_TEAM_DEBUG) console.error(`[dsh-agent-team] 路由 ${agentOptions.provider || parentRoute.provider}/${agentOptions.model || parentRoute.model} 不支持 effort=${m.effort}，本次不发`)
        }
        const persona = `${m.body}\n\n（你是 Agent Team 的成员「${m.display}」，标识 ${m.name}，岗位 ${m.role || '成员'}；本次任务：${description}）`
        const base = { label: description, prompt: [{ type: 'text', text: prompt }], parent: exec.agent, signal: exec.signal }
        const attempts = [
          { ...base, persona, ...(Object.keys(agentOptions).length ? { agentOptions } : {}) },
          { ...base, prompt: [{ type: 'text', text: `${persona}\n\n---\n\n${prompt}` }], ...(Object.keys(agentOptions).length ? { agentOptions } : {}) },
          { ...base, prompt: [{ type: 'text', text: `${persona}\n\n---\n\n${prompt}` }] },
        ]
        let run = null
        let lastErr = null
        for (const req of attempts) {
          try {
            run = await ctx.subagents.start(cfgIn.subagentProvider, req)
            break
          } catch (err) {
            lastErr = err
            const code = err && (err.code || err.name || '')
            if (process.env.DSH_AGENT_TEAM_DEBUG) console.error(`[dsh-agent-team] start attempt failed: ${code} ${err && err.message}`)
            if (!/UNSUPPORTED_CAPABILITY|capabilit|persona|agentOptions/i.test(`${code} ${err && err.message}`)) throw err
          }
        }
        if (!run) throw lastErr || new Error('子代理启动失败')
        if (process.env.DSH_AGENT_TEAM_DEBUG) console.error(`[dsh-agent-team] dispatch ${m.name} -> child ${run.id} (${cfgIn.subagentProvider})`)
        store.link(run.id, parentId, exec.callId, { member: m.name, description, prompt: shortStr(prompt, 2000), dispatchedAt: Date.now() / 1000, dispatchModel: [agentOptions.provider, agentOptions.model].filter(Boolean).join('/') })
        try {
          let result = await run.result
          if (result && result.stopReason === 'error' && Object.keys(agentOptions).length && !(contentText(result.output) || '').trim()) {
            // 子代理还没干活就错了（多半是路由 / 模型 / 思考强度不被接受）：不带任何覆盖再试一次
            const child = store.sessions.get(run.id)
            if (!child || (child.toolCount === 0 && child.usage.out === 0)) {
              if (process.env.DSH_AGENT_TEAM_DEBUG) console.error(`[dsh-agent-team] child ${run.id} errored before doing work; retrying without agentOptions`)
              try { await run.dispose() } catch { /* ignore */ }
              run = await ctx.subagents.start(cfgIn.subagentProvider, { ...base, persona })
              store.link(run.id, parentId, exec.callId, { member: m.name, description, prompt: shortStr(prompt, 2000), dispatchedAt: Date.now() / 1000, dispatchModel: '' })
              result = await run.result
            }
          }
          if (process.env.DSH_AGENT_TEAM_DEBUG) console.error(`[dsh-agent-team] child ${run.id} settled: ${result && result.stopReason} diag=${JSON.stringify(result && result.diagnostic || '').slice(0, 300)} out=${JSON.stringify(result && result.output || '').slice(0, 300)}`)
          const text = contentText(result && result.output) || ''
          const stop = result && result.stopReason ? String(result.stopReason) : 'completed'
          if (stop !== 'completed') {
            const diag = result && result.diagnostic ? `\n${String(result.diagnostic).slice(0, 1000)}` : ''
            throw new Error(`成员 ${m.display} 未正常完成（${stop}）${diag}${text ? `\n部分输出：\n${text.slice(0, 4000)}` : ''}`)
          }
          return `【${m.display}·${m.role || m.name} 回报】\n${text || '（成员没有输出文字）'}`
        } finally {
          try { await run.dispose() } catch { /* ignore */ }
        }
      },
    })
  } catch (err) {
    console.warn(`[dsh-agent-team] 派工工具注册失败（看板仍可用）: ${err && err.message}`)
  } }
  safeInject(ctx, ['tools', 'subagents'], mountTool)

  // 3) 队长看的系统提示词片段（子代理不显示，省 token）
  if (cfgIn.promptSection) {
    safeInject(ctx, ['systemPrompt'], (ctx) => { try {
      ctx.systemPrompt.section({
        name: 'dsh-agent-team',
        order: cfgIn.promptOrder,
        interpolate: false,
        text: (context) => {
          try {
            if (isChildScope(ctx, context && context.scope)) return ''
            return membersPrompt(toolName)
          } catch {
            return ''
          }
        },
      })
    } catch (err) {
      console.warn(`[dsh-agent-team] 系统提示词注册失败: ${err && err.message}`)
    } })
  }

  // 4) 看板（有 Web 服务才挂；headless / ACP 等组合没有就跳过）
  if (cfgIn.board) safeInject(ctx, ['webServer'], (ctx) => mountBoard(ctx, cfgIn))

  console.log(`[dsh-agent-team] v${version()} 已加载：工具 ${toolName}，${Object.keys(loadMembers()).length} 位成员`)
  ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })
}

export default { name, inject, Config, apply }
