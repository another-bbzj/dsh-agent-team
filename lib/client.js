// dsh-agent-team 的浏览器半边：DSH Web「设置 → 插件」里 dsh-agent-team 这个 bundle 的配置页（plugins.bundle.config 槽位）。
// 这是 Harness 客户端模块协议要求的“lazy-CJS factory”产物，手写成纯 JS 以免引入构建链；
// react 由宿主通过 require 提供，其余一律不 import（跨插件的值导入会被 bundle 纯度门禁拒绝）。
window.__ModuleLoader__.load({
  id: 'dsh-agent-team',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement
    const BASE = '/agent-team'

    function useStatus() {
      const [status, setStatus] = react.useState(null)
      react.useEffect(() => {
        let alive = true
        const load = () => fetch(`${BASE}/status.json`, { cache: 'no-store' }).then(r => r.json()).then(s => { if (alive) setStatus(s) }).catch(() => {})
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      return status
    }

    /** 摘要：插件列表里 bundle 卡片下的一行字。 */
    function Summary() {
      const s = useStatus()
      const n = s ? `${s.roster || 0} 位常驻成员 · ${s.departments || 0} 个部门` : ''
      return h('span', null, `部门制 Agent Team 与可视化看板${n ? ' · ' + n : ''}`)
    }

    /** 配置页：成员 / 部门 / 形象管理（嵌入看板的 manage 视图）+ 快捷入口。 */
    function Page() {
      const s = useStatus()
      const linkStyle = { color: 'var(--dsw-alias-brand-primary, #2864A9)', textDecoration: 'none', fontWeight: 500 }
      const btnStyle = { border: '1px solid var(--dsw-alias-border-primary, rgba(0,0,0,.14))', background: 'transparent', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', font: 'inherit', color: 'inherit' }
      const standalone = s && s.standalonePort ? `http://127.0.0.1:${s.standalonePort}${BASE}/` : ''
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: '70vh' } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'Agent Team · 部门与成员'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 13, lineHeight: 1.6 } },
          h('span', null, s ? (s.running ? `${s.running} 位成员进行中` : (s.members ? `本会话 ${s.members} 位成员` : '当前没有子代理在跑')) : '连接看板…'),
          h('span', { style: { opacity: .6 } }, '·'),
          h('a', { href: `${BASE}/`, target: '_blank', rel: 'noopener', style: linkStyle }, '打开指挥室看板 ↗'),
          standalone ? h('a', { href: standalone, target: '_blank', rel: 'noopener', style: linkStyle, title: '独立端口，不需要 DSH 登录令牌，也可以给局域网里的其它设备看' }, `独立端口 ${s.standalonePort} ↗`) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: btnStyle, onClick: () => { const f = document.getElementById('dsh-agent-team-manage'); if (f) f.src = f.src } }, '刷新'),
        ),
        h('div', { style: { fontSize: 12.5, opacity: .8, lineHeight: 1.6 } },
          '队长用 ', h('code', null, 'dispatch_member'), ' 工具把任务派给下面的常驻成员：每位成员有自己的岗位提示词、路由 provider / 模型 / 思考强度与形象。在这里增删改成员与部门、导入桌宠雪碧图，改动即时生效；文件在 ~/.dsh/agent-team/。'),
        h('iframe', {
          id: 'dsh-agent-team-manage',
          src: `${BASE}/?view=manage`,
          title: 'Agent Team 成员与部门管理',
          style: { flex: 1, width: '100%', minHeight: '68vh', border: '1px solid var(--dsw-alias-border-primary, rgba(0,0,0,.1))', borderRadius: 10, background: 'transparent' },
        }),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      const render = (props) => (props && props.view === 'summary') ? h(Summary) : h(Page)
      // 设置 → 插件 → 插件配置：卡片按 Host 服务的设置命名空间分发；Host 半边注册了 agent-team 命名空间，这里用同一个 key 认领
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'agent-team' }, render))
      // 新版插件管理页里 bundle 自己的配置页（没有这个槽位时 inject 只是挂起等待，不报错）
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-agent-team' }, render))
    }
    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-agent-team-client'
    return module.exports
  },
})
