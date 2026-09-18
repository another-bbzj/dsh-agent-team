// 路径约定：插件自带素材在包内 assets/，用户数据在 $DSH_HOME/agent-team/（node_modules 可能只读、更新会被清空）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS = path.join(PACKAGE_ROOT, 'assets')
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const DATA_DIR = process.env.DSH_AGENT_TEAM_HOME || path.join(DSH_HOME, 'agent-team')
export const MEMBERS_DIR = path.join(DATA_DIR, 'members')
export const USER_SPRITES = path.join(DATA_DIR, 'sprites')
export const TEAM_JSON = path.join(DATA_DIR, 'team.json')

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

export function version() {
  return readJson(path.join(PACKAGE_ROOT, 'package.json'), {}).version || '0.0.0'
}
