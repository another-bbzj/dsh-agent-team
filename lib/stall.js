// 成员停滞提醒：空闲 / 出错 / 停滞，并且能算出安静时间的才进入名单。
// 默认 10 分钟。进行中和已完成的不提醒。没有活动时间的不补一个数字。
// 与 assets/index.html 里 stall-alerts 段的 stallIdleAge / stallCandidatesFromMembers 保持一致。
// 快照带了 stallAlerts.candidates 时，页面只用这份，再在浏览器里套阈值和「知道了」。

export const DEFAULT_STALL_ALERT_SEC = 600
export const MIN_STALL_ALERT_SEC = 60
export const MAX_STALL_ALERT_SEC = 24 * 60 * 60
const ALERT_STATUSES = new Set(['idle', 'error', 'stalled'])

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function clip(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

/** 收成整数秒。缺省或非法用默认；过小抬到 60 秒，过大压到 24 小时。 */
export function normalizeThreshold(value, fallback = DEFAULT_STALL_ALERT_SEC) {
  let number = finite(value)
  if (number == null) number = finite(fallback)
  if (number == null) number = DEFAULT_STALL_ALERT_SEC
  if (number < MIN_STALL_ALERT_SEC) number = MIN_STALL_ALERT_SEC
  if (number > MAX_STALL_ALERT_SEC) number = MAX_STALL_ALERT_SEC
  return Math.trunc(number)
}

/**
 * 安静了多久。返回 { seconds, basis, anchor }，算不出则 null。
 * 优先非负的 idleSeconds（本插件的快照不写这个字段，留给页面回退）。
 * 其次 lastActivityAt。再其次时间线里最新的 ts，或 endedAt。
 * startedAt 只是开工，单独出现时不算一次活动，不提醒。
 */
export function memberIdleAge(member, now) {
  const nowN = finite(now)
  if (nowN == null || !member || typeof member !== 'object') return null
  const explicit = finite(member.idleSeconds)
  if (explicit != null && explicit >= 0) return { seconds: explicit, basis: 'idleSeconds', anchor: nowN - explicit }
  const last = finite(member.lastActivityAt)
  if (last != null && last > 0) {
    if (last > nowN) return { seconds: 0, basis: 'lastActivityAt', anchor: last }
    return { seconds: nowN - last, basis: 'lastActivityAt', anchor: last }
  }
  let newest = null
  const timeline = Array.isArray(member.timeline) ? member.timeline : []
  for (const event of timeline) {
    const ts = event && finite(event.ts)
    if (ts != null && ts > 0 && (newest == null || ts > newest)) newest = ts
  }
  const ended = finite(member.endedAt)
  if (ended != null && ended > 0 && (newest == null || ended > newest)) newest = ended
  if (newest == null) return null
  if (newest > nowN) return { seconds: 0, basis: 'lastEvent', anchor: newest }
  return { seconds: nowN - newest, basis: 'lastEvent', anchor: newest }
}

/** 空闲、出错、停滞且能计时的成员，安静久的在前。没到阈值的也返回，由调用方过滤。 */
export function stallCandidates(members, now) {
  if (!Array.isArray(members)) return []
  const found = []
  for (const member of members) {
    if (!member || typeof member !== 'object' || !ALERT_STATUSES.has(member.status)) continue
    const age = memberIdleAge(member, now)
    if (!age) continue
    const ident = typeof member.id === 'string' ? member.id : ''
    found.push({
      id: ident,
      name: clip(member.name, 80) || ident || '成员',
      status: member.status,
      idleSeconds: Math.floor(age.seconds),
      basis: age.basis,
      anchor: age.anchor,
      errorReason: clip(member.errorReason, 120),
    })
  }
  found.sort((a, b) => (b.idleSeconds - a.idleSeconds) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.status < b.status ? -1 : a.status > b.status ? 1 : 0))
  return found
}

export function activeStallAlerts(candidates, thresholdSec) {
  const threshold = normalizeThreshold(thresholdSec)
  if (!Array.isArray(candidates)) return []
  return candidates.filter(item => item && typeof item === 'object' && finite(item.idleSeconds) != null && item.idleSeconds >= threshold)
}

/** 往快照上挂 stallAlerts。不复制快照。thresholdSec 来自 team.json 的 stallAlertSec，缺了就是 600。 */
export function attachStallAlerts(snapshot, now = null, thresholdSec = DEFAULT_STALL_ALERT_SEC) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot
  const clock = now == null ? snapshot.generatedAt : now
  const threshold = normalizeThreshold(thresholdSec)
  snapshot.stallAlerts = {
    thresholdSec: threshold,
    defaultThresholdSec: DEFAULT_STALL_ALERT_SEC,
    candidates: stallCandidates(snapshot.members, clock),
  }
  return snapshot
}
