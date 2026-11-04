#!/usr/bin/env node
// 从离线 snapshot.json 或本机看板端口画一张 SVG 战报卡。画图逻辑在 lib/battle_card.js。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { BattleCardError, buildCard } from '../lib/battle_card.js'

const MAX_BYTES = 8 * 1024 * 1024
const HELP = `用法：node tools/battle_card.js (--input <快照.json> | --port <端口>) [选项]

从看板快照画一张纯 SVG 战报卡。只画快照里已有的字段。
不写路径、会话 id、邮箱、提示词和工具参数。
快照里有 stallAlerts 才写停滞人数。

  --input       离线 snapshot.json
  --port        本机看板端口。独立看板一般是 7790；DSH Web 的 3080 需要登录时请用 7790
  --base-path   看板路径，默认 /agent-team
  --session     会话 id 前缀，交给看板挑选（必须和 --port 一起用）
  --project     项目名片段，交给看板挑选（必须和 --port 一起用）
  --output      写入这个 svg；省略则打到标准输出
  --theme       auto | light | dark，默认 auto
  --static      不要虚线动画
`

function fail(message) {
  console.error(`战报卡失败：${message}`)
  return 1
}

function parsePort(value) {
  if (!/^[0-9]+$/.test(String(value))) throw new BattleCardError('端口必须是 1 到 65535 的整数')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BattleCardError('端口必须是 1 到 65535 的整数')
  return port
}

function parseBase(value) {
  if (!/^\/[a-z0-9-]+$/.test(String(value || ''))) throw new BattleCardError('看板路径必须是 / 加小写字母、数字或连字符')
  return value
}

function decodeUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    throw new BattleCardError('快照不是合法的 UTF-8 JSON')
  }
}

function parseSnapshot(buf) {
  let text = decodeUtf8(buf)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new BattleCardError('快照不是合法的 UTF-8 JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BattleCardError('快照必须是对象')
  return data
}

function readFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new BattleCardError('读不到快照文件')
  }
  if (!stat.isFile()) throw new BattleCardError('快照输入必须是文件')
  if (stat.size > MAX_BYTES) throw new BattleCardError('快照超过 8 MiB')
  try {
    const buf = fs.readFileSync(file)
    if (buf.length > MAX_BYTES) throw new BattleCardError('快照超过 8 MiB')
    return buf
  } catch (err) {
    if (err instanceof BattleCardError) throw err
    throw new BattleCardError('读不到快照文件')
  }
}

async function readBody(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new BattleCardError('快照超过 8 MiB')
    return buf
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new BattleCardError('快照超过 8 MiB')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function readPort(port, base, session, project) {
  const url = new URL(`http://127.0.0.1:${port}${base}/snapshot.json`)
  if (session) url.searchParams.set('session', session)
  if (project) url.searchParams.set('project', project)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  let response
  try {
    response = await fetch(url, { signal: ctrl.signal, redirect: 'error' })
  } catch {
    throw new BattleCardError('连不上本机看板')
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new BattleCardError('看板没有返回快照')
  const declared = Number(response.headers.get('content-length') || '0')
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new BattleCardError('快照超过 8 MiB')
  return readBody(response)
}

function assertDifferent(input, output) {
  const left = path.resolve(input)
  const right = path.resolve(output)
  if (left === right) throw new BattleCardError('输出文件不能和快照输入是同一个')
  try {
    if (fs.existsSync(right)) {
      const a = fs.statSync(left)
      const b = fs.statSync(right)
      if (a.ino === b.ino && a.dev === b.dev) throw new BattleCardError('输出文件不能和快照输入是同一个')
    }
  } catch (err) {
    if (err instanceof BattleCardError) throw err
    throw new BattleCardError('无法比较输入和输出文件')
  }
}

function selectorMissed(snapshot) {
  const session = snapshot.session
  return !session || typeof session !== 'object' || Array.isArray(session) || session.id == null || session.id === ''
}

export async function main(argv = process.argv.slice(2)) {
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: {
        input: { type: 'string' },
        port: { type: 'string' },
        session: { type: 'string' },
        project: { type: 'string' },
        output: { type: 'string' },
        theme: { type: 'string', default: 'auto' },
        static: { type: 'boolean', default: false },
        'base-path': { type: 'string', default: '/agent-team' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch {
    return fail('参数不正确。运行 node tools/battle_card.js --help')
  }
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  const hasInput = values.input !== undefined
  const hasPort = values.port !== undefined
  if (hasInput === hasPort) return fail(hasInput ? '--input 和 --port 只能选一个' : '需要 --input 或 --port')
  if ((values.session !== undefined || values.project !== undefined) && !hasPort) return fail('会话和项目选择要配合 --port')
  if (values.session !== undefined && values.project !== undefined) return fail('会话和项目只能选一个')
  if ([values.session, values.project].some((value) => value !== undefined && !String(value).trim())) return fail('会话和项目选择不能是空的')
  try {
    const theme = values.theme
    if (theme !== 'auto' && theme !== 'light' && theme !== 'dark') throw new BattleCardError('主题只能是 auto、light 或 dark')
    const base = parseBase(values['base-path'])
    if (hasInput && values.output) assertDifferent(values.input, values.output)
    const buf = hasInput
      ? readFile(values.input)
      : await readPort(parsePort(values.port), base, values.session, values.project)
    const snapshot = parseSnapshot(buf)
    if ((values.session !== undefined || values.project !== undefined) && selectorMissed(snapshot)) {
      throw new BattleCardError('看板没有匹配的会话')
    }
    const svg = buildCard(snapshot, theme, values.static === true)
    if (values.output) {
      try {
        fs.writeFileSync(values.output, svg)
      } catch {
        throw new BattleCardError('写不出战报卡')
      }
    } else {
      process.stdout.write(svg)
    }
    return 0
  } catch (err) {
    return fail(err instanceof BattleCardError ? err.message : '画不出战报卡')
  }
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code })
}
