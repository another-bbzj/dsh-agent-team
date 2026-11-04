import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BattleCardError, buildCard, publicView, stallAlertCount } from '../lib/battle_card.js'

const fixturePath = fileURLToPath(new URL('./fixtures/battle-snapshot.json', import.meta.url))
const cliPath = fileURLToPath(new URL('../tools/battle_card.js', import.meta.url))
const samplePath = fileURLToPath(new URL('../docs/img/battle-card.svg', import.meta.url))
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const POISON = [
  '0123456789abcdef0123456789abcdef',
  'abcdefabcdefabcdefabcdefabcdefab',
  'fedcba9876543210fedcba9876543210',
  '11112222333344445555666677778888',
  'C:/Users/me/secret-proj',
  'src/store.js',
  'hidden@example.com',
  'sk-testsecret',
  'SECRET_TOOL_ARG',
  'rm -rf /tmp/nope',
  '/home/me/.ssh/id_rsa',
  'https://evil.example/steal',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-official',
  '把密钥',
  '生产库密码',
  'session-running',
]

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
}

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('样例快照只画出公开字段，毒字段不进 SVG', () => {
  const view = publicView(fixture)
  assert.deepEqual(view.summary, ['3 名成员', '1 已完成', '1 进行中', '1 停滞', '停滞提醒 1'])
  assert.equal(view.partial, true)
  assert.equal(view.tiles[1].value, '$0.21875')
  assert.equal(view.tiles[2].value, '600')
  assert.equal(view.usage.note.includes('未定价 1'), true)
  assert.equal(view.tasks.map(row => row.title).join('|'), '研发部·实现数据层|质量部·补测试')
  assert.equal(view.tasks.some(row => row.title.includes('README')), false)
  assert.equal(view.members.map(row => row.title).join('|'), '阿服|测测|小界')
  assert.equal(view.departments.some(row => row.title.includes('文档部') && row.bits.includes('建议补位')), true)
  assert.equal(view.departments.some(row => row.title.includes('运维部')), false)
  assert.equal(view.lead.status, '协调中')
  const svg = buildCard(fixture, 'auto', false)
  assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /dsh-agent-team/)
  assert.match(svg, /停滞提醒 1/)
  assert.match(svg, /未定价/)
  assert.match(svg, /<animate /)
  for (const secret of POISON) assert.equal(svg.includes(secret), false, secret)
  assert.equal(svg, fs.readFileSync(samplePath, 'utf8'))
})

test('没有 stallAlerts 不画停滞人数；有但人数是 0 要画 0；结构坏了不编', () => {
  const copy = structuredClone(fixture)
  delete copy.stallAlerts
  assert.equal(stallAlertCount(copy), null)
  assert.equal(publicView(copy).summary.includes('停滞提醒 0'), false)
  assert.equal(buildCard(copy).includes('停滞提醒'), false)
  copy.stallAlerts = { thresholdSec: 600, candidates: [{ status: 'idle', idleSeconds: 10 }] }
  assert.equal(stallAlertCount(copy), 0)
  assert.match(buildCard(copy), /停滞提醒 0/)
  copy.stallAlerts = { candidates: [] }
  assert.equal(stallAlertCount(copy), null)
  assert.equal(buildCard(copy).includes('停滞提醒'), false)
  copy.stallAlerts = null
  assert.equal(stallAlertCount(copy), null)
})

test('合计字段不齐就只画人数；字段在但不是数字则拒绝，不画错账', () => {
  const copy = structuredClone(fixture)
  delete copy.totals.allUsage
  const view = publicView(copy)
  assert.equal(view.usage, null)
  assert.deepEqual(view.tiles, [{ label: '成员', value: '3' }])
  copy.totals.allUsage = fixture.totals.allUsage
  copy.totals.cost = '0.2'
  assert.throws(() => buildCard(copy), BattleCardError)
  assert.throws(() => buildCard(null), BattleCardError)
  assert.throws(() => buildCard(fixture, 'blue'), /主题/)
  const still = buildCard(fixture, 'dark', true)
  assert.match(still, /#070a11/)
  assert.doesNotMatch(still, /prefers-color-scheme/)
  assert.doesNotMatch(still, /<animate /)
  assert.match(buildCard(fixture, 'auto', false), /prefers-color-scheme: dark/)
})

test('名字里的标记会被转义，过长或像路径的任务标题整段省略', () => {
  const copy = structuredClone(fixture)
  copy.members[0].name = '阿服&<队长>'
  const svg = buildCard(copy)
  assert.match(svg, /阿服&amp;&lt;队长&gt;/)
  assert.doesNotMatch(svg, /<队长>/)
  copy.members[0].description = 'A'.repeat(73)
  assert.equal(publicView(copy).tasks.some(row => row.title.startsWith('AAA')), false)
})

test('人数和部门超过上限时注明还有多少，不把名单撑破', () => {
  const copy = structuredClone(fixture)
  copy.members = Array.from({ length: 10 }, (_, i) => ({ name: `成员甲${i}`, status: 'completed', description: `任务${i}`, dept: 'dev' }))
  copy.departments = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, name: `部门${i}`, status: 'running', members: ['x'] }))
  delete copy.totals
  const view = publicView(copy)
  assert.equal(view.members.length, 8)
  assert.equal(view.moreMembers, 2)
  assert.equal(view.departments.length, 6)
  assert.equal(view.moreDepartments, 2)
  assert.equal(view.tasks.length, 6)
  assert.equal(view.moreTasks, 4)
  const svg = buildCard(copy)
  assert.match(svg, /另有 2 位未列入/)
  assert.match(svg, /另有 2 个部门未列入/)
  assert.match(svg, /另有 4 项未列入/)
})

test('CLI：离线文件、标准输出和 --static 与 buildCard 逐字相同', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battle-card-'))
  const out = path.join(dir, 'card.svg')
  const still = path.join(dir, 'still.svg')
  try {
    const help = run(['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /--port/)
    assert.equal(run(['--input', fixturePath, '--output', out]).status, 0)
    assert.equal(fs.readFileSync(out, 'utf8'), buildCard(fixture, 'auto', false))
    const stdout = run(['--input', fixturePath, '--theme', 'light'])
    assert.equal(stdout.status, 0)
    assert.equal(stdout.stdout, buildCard(fixture, 'light', false))
    assert.equal(run(['--input', fixturePath, '--static', '--output', still]).status, 0)
    assert.equal(fs.readFileSync(still, 'utf8'), buildCard(fixture, 'auto', true))
    const same = run(['--input', fixturePath, '--output', fixturePath])
    assert.equal(same.status, 1)
    assert.match(same.stderr, /同一个/)
    assert.equal(fs.readFileSync(fixturePath, 'utf8').includes('"harness"'), true)
    assert.equal(run(['--session', 'abc']).status, 1)
    assert.match(run(['--session', 'abc']).stderr, /--port/)
    assert.equal(run(['--port', '7790', '--session', '  ']).status, 1)
    assert.equal(run(['--input', fixturePath, '--port', '7790']).status, 1)
    assert.equal(run(['--port', '0']).status, 1)
    assert.equal(run(['--input', path.join(dir, 'missing.json')]).status, 1)
    assert.match(run(['--nope']).stderr, /参数不正确/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：只向 127.0.0.1 要快照，查询参数原样交给看板', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push(`${url.pathname}?${url.searchParams.toString()}`)
    if (url.pathname !== '/agent-team/snapshot.json') {
      res.writeHead(404)
      res.end('no')
      return
    }
    if (url.searchParams.get('session') === 'missing') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...fixture, session: null }))
      return
    }
    res.writeHead(302, { Location: 'http://example.com/snapshot.json' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = String(server.address().port)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battle-card-port-'))
  const out = path.join(dir, 'card.svg')
  try {
    const bad = await runAsync(['--port', port, '--output', out])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /连不上本机看板/)
    assert.equal(fs.existsSync(out), false)
    const miss = await runAsync(['--port', port, '--session', 'missing'])
    assert.equal(miss.status, 1)
    assert.match(miss.stderr, /没有匹配的会话/)
    assert.doesNotMatch(miss.stderr, /missing/)
    assert.equal(seen.some(item => item.startsWith('/agent-team/snapshot.json?')), true)
    assert.equal(seen.some(item => item.includes('session=missing')), true)
    const customSeen = []
    const custom = http.createServer((req, res) => {
      customSeen.push(req.url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(fixture))
    })
    await new Promise((resolve) => custom.listen(0, '127.0.0.1', resolve))
    try {
      const ok = await runAsync(['--port', String(custom.address().port), '--base-path', '/custom-board', '--project', 'demo', '--output', out])
      assert.equal(ok.status, 0, ok.stderr)
      assert.equal(fs.readFileSync(out, 'utf8'), buildCard(fixture, 'auto', false))
      assert.equal(customSeen[0].startsWith('/custom-board/snapshot.json?'), true)
      assert.match(customSeen[0], /project=demo/)
      for (const secret of POISON) {
        assert.equal(ok.stderr.includes(secret), false)
        assert.equal(ok.stdout.includes(secret), false)
      }
    } finally {
      custom.close()
    }
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
