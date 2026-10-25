import {
  getSettings,
  setSetting,
  type AccountSourceEntry,
  type D1Database,
} from './auth'

/**
 * 站长订阅源的服务端自动更新（借鉴 MoonTV 的「配置订阅」到期检查模式）。
 *
 * 背景：订阅原本只存在站长打开的浏览器里，靠页面开着时本机刷新；浏览器不开就没人更新。
 * 现在站长客户端把订阅清单（链接+间隔）同步一份到服务端（settings 键 master_subscriptions），
 * 公开配置接口被访问时顺带做一次到期检查：到期的订阅由服务端抓取、把该订阅产出的源
 * （id 前缀 sub:<订阅id>:）整段换新，结果存 master_subscription_sources，站长下次打开
 * 任意设备时经账号源接口取回。手动源、后台托管源、普通用户的源一律不经过这条链路。
 */

export const MASTER_SUBSCRIPTIONS_KEY = 'master_subscriptions'
export const MASTER_SUBSCRIPTION_STATE_KEY = 'master_subscription_state'
export const MASTER_SUBSCRIPTION_SOURCES_KEY = 'master_subscription_sources'

/** 站长订阅清单条目（客户端同步上来的最小信息） */
export interface MasterSubscription {
  id: string
  name: string
  url: string
  /** 自动刷新间隔（分钟），0 = 不自动更新 */
  refreshInterval: number
}

/** 单个订阅的服务端刷新状态 */
export interface MasterSubscriptionState {
  /** 上次尝试刷新时间（unix 秒） */
  lastAttemptAt: number
  lastSuccess: boolean
  /** 上次成功产出的源数量；失败时保留上一次的数量 */
  lastCount: number
  lastError: string | null
}

export type MasterSubscriptionStateMap = Record<string, MasterSubscriptionState>

const MAX_SUBSCRIPTIONS = 20
const MAX_SOURCES_PER_SUBSCRIPTION = 200
/** 单次到期检查最多实际抓取的订阅数，控制子请求与耗时 */
const MAX_FETCH_PER_CHECK = 5
const FETCH_TIMEOUT_MS = 10_000
const MAX_REFRESH_INTERVAL_MINUTES = 7 * 24 * 60

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** 清洗站长订阅清单（不可信输入）：结构合法才保留，按 id 与链接去重 */
export function parseMasterSubscriptions(input: unknown): MasterSubscription[] {
  if (!Array.isArray(input)) return []
  const out: MasterSubscription[] = []
  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()
  for (const raw of input) {
    if (out.length >= MAX_SUBSCRIPTIONS) break
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim().slice(0, 128) : ''
    // id 会拼进源 id 前缀（sub:<id>:<序号>），含冒号会让归属解析歧义，直接丢弃
    if (!id || id.includes(':') || seenIds.has(id)) continue
    const url = typeof e.url === 'string' ? e.url.trim().slice(0, 2048) : ''
    if (!isHttpUrl(url) || seenUrls.has(url)) continue
    let name = typeof e.name === 'string' ? e.name.trim().slice(0, 100) : ''
    if (!name) {
      try {
        name = new URL(url).hostname
      } catch {
        name = '未命名订阅'
      }
    }
    const intervalRaw =
      typeof e.refreshInterval === 'number' && Number.isFinite(e.refreshInterval)
        ? Math.round(e.refreshInterval)
        : 60
    seenIds.add(id)
    seenUrls.add(url)
    out.push({
      id,
      name,
      url,
      refreshInterval: Math.min(MAX_REFRESH_INTERVAL_MINUTES, Math.max(0, intervalRaw)),
    })
  }
  return out
}

/** 解析订阅刷新状态表（损坏内容按空表处理） */
export function parseMasterSubscriptionState(raw: string | null): MasterSubscriptionStateMap {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: MasterSubscriptionStateMap = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      out[id] = {
        lastAttemptAt:
          typeof v.lastAttemptAt === 'number' && Number.isFinite(v.lastAttemptAt)
            ? Math.floor(v.lastAttemptAt)
            : 0,
        lastSuccess: v.lastSuccess === true,
        lastCount:
          typeof v.lastCount === 'number' && Number.isFinite(v.lastCount)
            ? Math.max(0, Math.floor(v.lastCount))
            : 0,
        lastError: typeof v.lastError === 'string' ? v.lastError.slice(0, 200) : null,
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 从订阅源 id（sub:<订阅id>:<序号>）提取订阅 id；不是订阅源返回 null */
export function subscriptionIdOfSource(sourceId: string): string | null {
  if (!sourceId.startsWith('sub:')) return null
  const rest = sourceId.slice(4)
  const sep = rest.indexOf(':')
  return sep > 0 ? rest.slice(0, sep) : null
}

function clampTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(60_000, Math.max(300, Math.round(value)))
    : undefined
}

function clampRetry(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10, Math.max(0, Math.round(value)))
    : undefined
}

/** 解析服务端保存的订阅源快照（只接受 sub: 前缀条目，字段口径同 AccountSourceEntry） */
export function parseStoredSubscriptionSources(raw: string | null): AccountSourceEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: AccountSourceEntry[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const id = typeof e.id === 'string' ? e.id : ''
      if (!subscriptionIdOfSource(id)) continue
      const name = typeof e.name === 'string' ? e.name.trim().slice(0, 100) : ''
      const url = typeof e.url === 'string' ? e.url.trim() : ''
      if (!name || !isHttpUrl(url)) continue
      const detailUrl =
        typeof e.detailUrl === 'string' && isHttpUrl(e.detailUrl.trim())
          ? e.detailUrl.trim()
          : undefined
      out.push({
        id,
        name,
        url,
        ...(detailUrl && detailUrl !== url ? { detailUrl } : {}),
        ...(clampTimeout(e.timeout) !== undefined ? { timeout: clampTimeout(e.timeout) } : {}),
        ...(clampRetry(e.retry) !== undefined ? { retry: clampRetry(e.retry) } : {}),
        isEnabled: e.isEnabled !== false,
        siteWide: false,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 把订阅链接返回的原始 JSON 转成订阅源条目（口径与客户端 subscriptionStore 一致）：
 * 只留有名称且有地址（url 或 KVideo 格式的 baseUrl）的条目；启用状态优先沿用
 * 旧快照里同名同址条目的设置，其次用订阅文件自带的值，默认启用。
 */
export function buildSubscriptionEntries(
  subscriptionId: string,
  raw: unknown,
  prevEntries: AccountSourceEntry[],
): AccountSourceEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error('订阅返回数据不是数组格式')
  }
  const prevByPair = new Map(prevEntries.map(e => [`${e.name}\n${e.url}`, e]))
  const out: AccountSourceEntry[] = []
  for (const item of raw) {
    if (out.length >= MAX_SOURCES_PER_SUBSCRIPTION) break
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 100) : ''
    const urlRaw =
      (typeof e.url === 'string' && e.url) || (typeof e.baseUrl === 'string' && e.baseUrl) || ''
    const url = urlRaw.trim()
    if (!name || !isHttpUrl(url)) continue
    const prev = prevByPair.get(`${name}\n${url}`)
    const detailRaw = typeof e.detailUrl === 'string' ? e.detailUrl.trim() : ''
    const detailUrl = isHttpUrl(detailRaw) && detailRaw !== url ? detailRaw : undefined
    const enabledRaw = typeof e.isEnabled === 'boolean' ? e.isEnabled : e.enabled
    out.push({
      id: `sub:${subscriptionId}:${out.length}`,
      name,
      url,
      ...(detailUrl ? { detailUrl } : {}),
      ...(clampTimeout(e.timeout) ?? prev?.timeout !== undefined
        ? { timeout: clampTimeout(e.timeout) ?? prev?.timeout }
        : {}),
      ...(clampRetry(e.retry) ?? prev?.retry !== undefined
        ? { retry: clampRetry(e.retry) ?? prev?.retry }
        : {}),
      isEnabled: prev ? prev.isEnabled : enabledRaw !== false,
      siteWide: false,
    })
  }
  return out
}

/** 是否到期：从未刷过、或距上次尝试已超过该订阅自己的间隔 */
export function isSubscriptionDue(
  sub: MasterSubscription,
  state: MasterSubscriptionState | undefined,
  nowSec: number,
): boolean {
  if (sub.refreshInterval <= 0) return false
  if (!state || state.lastAttemptAt <= 0) return true
  return nowSec - state.lastAttemptAt >= sub.refreshInterval * 60
}

/** 摘除已不在清单里的订阅的源切片与状态；返回是否有变化 */
export function pruneSubscriptionData(
  registry: MasterSubscription[],
  sources: AccountSourceEntry[],
  state: MasterSubscriptionStateMap,
): { sources: AccountSourceEntry[]; state: MasterSubscriptionStateMap; changed: boolean } {
  const ids = new Set(registry.map(s => s.id))
  const nextSources = sources.filter(e => {
    const owner = subscriptionIdOfSource(e.id)
    return owner !== null && ids.has(owner)
  })
  const nextState: MasterSubscriptionStateMap = {}
  for (const [id, value] of Object.entries(state)) {
    if (ids.has(id)) nextState[id] = value
  }
  const changed =
    nextSources.length !== sources.length ||
    Object.keys(nextState).length !== Object.keys(state).length
  return { sources: nextSources, state: nextState, changed }
}

export interface SubscriptionUpdateSummary {
  attempted: number
  updated: number
  failed: number
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 到期检查与自动更新主流程。只读/写 master_subscriptions* 三个 settings 键，
 * 只替换到期订阅自己的源切片；任何失败都收敛为状态记录，绝不抛错打断调用方
 * （公开配置接口在 waitUntil 里调用它，失败也要静默）。
 */
export async function maybeUpdateMasterSubscriptions(
  db: D1Database,
  opts: { fetchFn?: FetchFn; nowSec?: number } = {},
): Promise<SubscriptionUpdateSummary> {
  const summary: SubscriptionUpdateSummary = { attempted: 0, updated: 0, failed: 0 }
  try {
    const fetchFn = opts.fetchFn ?? fetch
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
    const settings = await getSettings(db, [
      MASTER_SUBSCRIPTIONS_KEY,
      MASTER_SUBSCRIPTION_STATE_KEY,
      MASTER_SUBSCRIPTION_SOURCES_KEY,
    ])
    const registry = parseMasterSubscriptions(
      safeJsonParse(settings.get(MASTER_SUBSCRIPTIONS_KEY)),
    )
    if (registry.length === 0) return summary

    let state = parseMasterSubscriptionState(settings.get(MASTER_SUBSCRIPTION_STATE_KEY) ?? null)
    let sources = parseStoredSubscriptionSources(
      settings.get(MASTER_SUBSCRIPTION_SOURCES_KEY) ?? null,
    )
    const pruned = pruneSubscriptionData(registry, sources, state)
    sources = pruned.sources
    state = pruned.state
    let dirty = pruned.changed

    const due = registry
      .filter(sub => isSubscriptionDue(sub, state[sub.id], nowSec))
      .slice(0, MAX_FETCH_PER_CHECK)
    for (const sub of due) {
      summary.attempted += 1
      const prevSlice = sources.filter(e => subscriptionIdOfSource(e.id) === sub.id)
      try {
        const response = await fetchFn(sub.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TGYS subscription auto-update)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: unknown = await response.json()
        const nextSlice = buildSubscriptionEntries(sub.id, data, prevSlice)
        sources = [
          ...sources.filter(e => subscriptionIdOfSource(e.id) !== sub.id),
          ...nextSlice,
        ]
        state[sub.id] = {
          lastAttemptAt: nowSec,
          lastSuccess: true,
          lastCount: nextSlice.length,
          lastError: null,
        }
        summary.updated += 1
      } catch (error) {
        state[sub.id] = {
          lastAttemptAt: nowSec,
          lastSuccess: false,
          lastCount: prevSlice.length,
          lastError: (error instanceof Error ? error.message : '未知错误').slice(0, 200),
        }
        summary.failed += 1
      }
      dirty = true
    }

    if (dirty) {
      await setSetting(db, MASTER_SUBSCRIPTION_SOURCES_KEY, JSON.stringify(sources))
      await setSetting(db, MASTER_SUBSCRIPTION_STATE_KEY, JSON.stringify(state))
    }
    return summary
  } catch {
    return summary
  }
}

/** 站长账号源接口附带下发的数据：服务端最新订阅源 + 每条订阅的刷新状态 */
export async function readMasterSubscriptionData(db: D1Database): Promise<{
  sources: AccountSourceEntry[]
  meta: Array<{
    id: string
    lastRefreshedAt: number | null
    lastRefreshSuccess: boolean
    lastRefreshError: string | null
    sourceCount: number
  }>
}> {
  const settings = await getSettings(db, [
    MASTER_SUBSCRIPTIONS_KEY,
    MASTER_SUBSCRIPTION_STATE_KEY,
    MASTER_SUBSCRIPTION_SOURCES_KEY,
  ])
  const registry = parseMasterSubscriptions(safeJsonParse(settings.get(MASTER_SUBSCRIPTIONS_KEY)))
  const state = parseMasterSubscriptionState(settings.get(MASTER_SUBSCRIPTION_STATE_KEY) ?? null)
  const sources = parseStoredSubscriptionSources(
    settings.get(MASTER_SUBSCRIPTION_SOURCES_KEY) ?? null,
  )
  return {
    sources,
    meta: registry.map(sub => {
      const s = state[sub.id]
      return {
        id: sub.id,
        lastRefreshedAt: s && s.lastAttemptAt > 0 ? s.lastAttemptAt : null,
        lastRefreshSuccess: s ? s.lastSuccess : false,
        lastRefreshError: s ? s.lastError : null,
        sourceCount: s ? s.lastCount : 0,
      }
    }),
  }
}

function safeJsonParse(raw: string | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 把服务端订阅源并入全站分发列表（网页端公开配置与 TVBox 同一口径）：
 * 手动全站源在前、订阅源在后，按 id 去重（手动优先）。手动列表损坏时按空列表处理，
 * 订阅源照常分发。站长本人的客户端会自行剔除其中的订阅源（他走订阅通道，不走托管镜像，
 * 避免同一批源既是「订阅源」又是「后台源」重复出现）。
 */
export function mergeSiteWideWithSubscriptionSources(
  manualRaw: string | null,
  subscriptionSources: AccountSourceEntry[],
): string {
  let manual: unknown[] = []
  if (manualRaw) {
    const parsed = safeJsonParse(manualRaw)
    if (Array.isArray(parsed)) manual = parsed
  }
  const seen = new Set<string>()
  const merged: unknown[] = []
  for (const entry of manual) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as Record<string, unknown>).id
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    merged.push(entry)
  }
  for (const entry of subscriptionSources) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return JSON.stringify(merged)
}
