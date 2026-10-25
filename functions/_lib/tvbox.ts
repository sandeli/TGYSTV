import {
  getSetting,
  isSiteClosed,
  MASTER_USER_ID,
  nowSeconds,
  randomHex,
  readDoubanProxySettings,
  readManagedSourceEnabled,
  type AuthEnv,
  type D1Database,
} from './auth'
import { MASTER_SUBSCRIPTION_SOURCES_KEY } from './subscriptionUpdate'

/**
 * TVBox 接口（兼容影视、OK影视等 TVBox 系客户端）：
 * - 每位用户一个专属令牌，配置地址 /api/tvbox/<token>，令牌即身份
 * - 配置里第一个站是本站聚合站（/api/tvbox/<token>/vod）：跨托管源搜索，
 *   详情把各源线路按「标题匹配档位 → 实测首集速度」排序返回，第一条即最快
 * - 其余站点为各托管源的真实接口地址（直连，type 1），与 MoonTV 的做法一致
 * 本模块自包含（Pages Functions 不能直接 import src/），协议参数与 cms-core 对齐：
 * 搜索/详情/列表统一走源的 MacCMS provide 接口（ac=videolist&wd=/ids=/t=/pg=）。
 */

// ---------- 令牌 ----------

export async function getOrCreateTvboxToken(db: D1Database, userId: number): Promise<string> {
  const existing = await db
    .prepare('SELECT token FROM tvbox_tokens WHERE user_id = ?')
    .bind(userId)
    .first<{ token: string }>()
  if (existing?.token) return existing.token
  const token = randomHex(16)
  await db
    .prepare('INSERT OR IGNORE INTO tvbox_tokens (token, user_id, created_at) VALUES (?, ?, ?)')
    .bind(token, userId, nowSeconds())
    .run()
  const again = await db
    .prepare('SELECT token FROM tvbox_tokens WHERE user_id = ?')
    .bind(userId)
    .first<{ token: string }>()
  return again?.token ?? token
}

export async function resetTvboxToken(db: D1Database, userId: number): Promise<string> {
  const token = randomHex(16)
  await db
    .prepare(
      `INSERT INTO tvbox_tokens (token, user_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
    )
    .bind(token, userId, nowSeconds())
    .run()
  return token
}

export async function findTvboxUserId(db: D1Database, token: string): Promise<number | null> {
  if (!token || token.length > 128) return null
  const row = await db
    .prepare('SELECT user_id AS userId FROM tvbox_tokens WHERE token = ?')
    .bind(token)
    .first<{ userId: number }>()
  return row ? row.userId : null
}

/** 令牌持有者当前是否可用：站长恒可用；普通用户需未禁用、未到期且站点未关站 */
export async function assertTvboxAccess(db: D1Database, userId: number): Promise<boolean> {
  if (userId === MASTER_USER_ID) return true
  if (await isSiteClosed(db)) return false
  const row = await db
    .prepare('SELECT disabled, expires_at AS expiresAt FROM users WHERE id = ?')
    .bind(userId)
    .first<{ disabled: number; expiresAt: number | null }>()
  if (!row || row.disabled === 1) return false
  if (row.expiresAt !== null && row.expiresAt < nowSeconds()) return false
  return true
}

// ---------- 托管源（服务端视角） ----------

export interface TvboxSource {
  id: string
  name: string
  api: string
}

interface ParsedSourceEntry {
  id: string
  name: string
  api: string
  enabled: boolean
}

/** 解析源清单 JSON（兼容标准 url/isEnabled、KVideo 的 baseUrl/enabled、MoonTV 的 api_site、TVBox 配置 sites 四种格式） */
export function parseManagedSourcesJson(raw: string): ParsedSourceEntry[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  let list: unknown[] = []
  if (Array.isArray(data)) {
    list = data
  } else if (data && typeof data === 'object') {
    const obj = data as { sources?: unknown; api_site?: unknown }
    if (Array.isArray(obj.sources)) {
      list = obj.sources
    } else if (Array.isArray((obj as { sites?: unknown }).sites)) {
      // TVBox 播放器配置：只提取 type=1 且 api 为 http(s) 的 CMS 源，爬虫/XML 站点本站用不了直接跳过
      list = ((obj as { sites: unknown[] }).sites as Array<Record<string, unknown>>)
        .filter(site => {
          const api = typeof site?.api === 'string' ? site.api.trim() : ''
          return (site?.type === 1 || site?.type === '1') && /^https?:\/\//i.test(api)
        })
        .map(site => ({ id: site.key, name: site.name, url: site.api }))
    } else if (obj.api_site && typeof obj.api_site === 'object' && !Array.isArray(obj.api_site)) {
      // MoonTV 订阅格式：{ api_site: { <键>: { name, api } } } → 展开成条目数组，键作 id（后续统一清洗）
      list = Object.entries(obj.api_site as Record<string, unknown>).map(([key, rawSite]) => {
        const site = (rawSite ?? {}) as { name?: unknown; api?: unknown }
        return { id: key, name: site.name, url: site.api }
      })
    }
  }
  if (!Array.isArray(list)) return []
  const out: ParsedSourceEntry[] = []
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') continue
    const api = String(entry.url ?? entry.baseUrl ?? entry.api ?? '').trim()
    if (!api) continue
    const name = String(entry.name ?? '').trim() || api
    const rawId = String(entry.id ?? '').trim()
    const id = (rawId || `src${out.length + 1}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
    const enabledField = entry.isEnabled ?? entry.enabled
    out.push({ id, name, api, enabled: enabledField !== false })
  }
  return out
}

let sourcesCache: { key: string; at: number; sources: TvboxSource[] } | null = null
const SOURCES_CACHE_MS = 60_000

/** 读取全站托管源并应用管理员显式开关表（与网页端同一口径），只返回启用中的源 */
export async function readTvboxSources(db: D1Database, env: AuthEnv): Promise<TvboxSource[]> {
  let raw = (await getSetting(db, 'initial_video_sources')) ?? env.TGYS_INITIAL_VIDEO_SOURCES ?? ''
  raw = raw.trim()
  // 站长开启「全站生效」的手动源（服务端派生，与网页端托管清单同一口径合并）
  const siteWideRaw = ((await getSetting(db, 'admin_sitewide_sources')) ?? '').trim()
  // 站长订阅源（服务端自动更新维护，与网页端全站分发同一口径）
  const subscriptionRaw = ((await getSetting(db, MASTER_SUBSCRIPTION_SOURCES_KEY)) ?? '').trim()
  if (!raw && !siteWideRaw && !subscriptionRaw) return []
  const cacheKey = `${raw}\n${siteWideRaw}\n${subscriptionRaw}`
  if (
    sourcesCache &&
    sourcesCache.key === cacheKey &&
    Date.now() - sourcesCache.at < SOURCES_CACHE_MS
  ) {
    return sourcesCache.sources
  }
  let text = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      const res = await fetch(raw, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return []
      text = await res.text()
    } catch {
      return []
    }
  }
  const switches = await readManagedSourceEnabled(db)
  const seen = new Set<string>()
  const sources: TvboxSource[] = []
  const appendEntries = (entries: ParsedSourceEntry[]) => {
    for (const entry of entries) {
      const enabled = entry.id in switches ? switches[entry.id] : entry.enabled
      if (!enabled || seen.has(entry.id)) continue
      seen.add(entry.id)
      sources.push({ id: entry.id, name: entry.name, api: entry.api })
    }
  }
  appendEntries(parseManagedSourcesJson(text))
  if (siteWideRaw) appendEntries(parseManagedSourcesJson(siteWideRaw))
  if (subscriptionRaw) appendEntries(parseManagedSourcesJson(subscriptionRaw))
  sourcesCache = { key: cacheKey, at: Date.now(), sources }
  return sources
}

// ---------- 源站 MacCMS 协议（服务端代请求） ----------

const CMS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** 与 cms-core buildApiUrl 同逻辑：源地址已含 /provide/vod 时只拼参数，否则补完整路径 */
export function buildCmsUrl(api: string, query: string): string {
  const url = api.replace(/\/+$/, '')
  if (
    url.toLowerCase().includes('/api.php/provide/vod') ||
    /\/provide\/vod\/?$/.test(url.toLowerCase())
  ) {
    return `${url}${url.includes('?') ? '&' : '?'}${query}`
  }
  return `${url}/api.php/provide/vod/?${query}`
}

export type CmsRecord = Record<string, unknown>

interface CmsListData {
  list: CmsRecord[]
  pagecount: number
  total: number
  classes: Array<{ type_id: string; type_name: string }>
}

async function cmsJson(api: string, query: string, timeoutMs = 10_000): Promise<CmsRecord | null> {
  try {
    const res = await fetch(buildCmsUrl(api, query), {
      headers: { 'User-Agent': CMS_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return null
    return data as CmsRecord
  } catch {
    return null
  }
}

function toListData(data: CmsRecord | null): CmsListData {
  if (!data) return { list: [], pagecount: 0, total: 0, classes: [] }
  const list = Array.isArray(data.list) ? (data.list as CmsRecord[]) : []
  const classes = (Array.isArray(data.class) ? data.class : []).map(c => {
    const r = c as CmsRecord
    return { type_id: String(r.type_id ?? ''), type_name: String(r.type_name ?? '') }
  })
  return {
    list,
    pagecount: Number(data.pagecount) || 0,
    total: Number(data.total) || list.length,
    classes,
  }
}

export async function cmsVideolist(
  api: string,
  opts: { wd?: string; ids?: string; t?: string; pg?: number },
): Promise<CmsListData> {
  const params = ['ac=videolist']
  if (opts.wd) params.push(`wd=${encodeURIComponent(opts.wd)}`)
  if (opts.ids) params.push(`ids=${encodeURIComponent(opts.ids)}`)
  if (opts.t) params.push(`t=${encodeURIComponent(opts.t)}`)
  if (opts.pg && opts.pg > 1) params.push(`pg=${opts.pg}`)
  return toListData(await cmsJson(api, params.join('&')))
}

export async function cmsClassList(api: string): Promise<CmsListData> {
  return toListData(await cmsJson(api, 'ac=list'))
}

// ---------- 聚合 ----------

export function encodeAggId(sourceId: string, vodId: string): string {
  return `${sourceId}__${vodId}`
}

export function decodeAggId(id: string): { sourceId: string; vodId: string } | null {
  const idx = id.indexOf('__')
  if (idx <= 0) return null
  return { sourceId: id.slice(0, idx), vodId: id.slice(idx + 2) }
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[\s·•・:：\-—_()（）[\]《》"“”'‘’.,，。!！?？/\\|]/g, '')
}

/** 标题匹配档位（与弹幕/直连搜索同口径）：0 完全一致 / 1 前缀 / 2 包含 / 3 无关 */
export function titleTier(title: string, query: string): number {
  const t = normalizeTitle(title)
  const q = normalizeTitle(query)
  if (!t || !q) return 3
  if (t === q) return 0
  if (t.startsWith(q) || q.startsWith(t)) return 1
  if (t.includes(q) || q.includes(t)) return 2
  return 3
}

function namespacedItem(source: TvboxSource, item: CmsRecord): CmsRecord {
  return { ...item, vod_id: encodeAggId(source.id, String(item.vod_id ?? '')) }
}

/** 聚合搜索：并行搜全部源，只收标题档位 ≤2 的结果，按源顺序合并 */
export async function aggSearch(
  sources: TvboxSource[],
  wd: string,
  pg: number,
): Promise<CmsRecord[]> {
  const perSource = await Promise.all(
    sources.map(async source => {
      const data = await cmsVideolist(source.api, { wd, pg })
      return data.list
        .filter(item => titleTier(String(item.vod_name ?? ''), wd) <= 2)
        .map(item => namespacedItem(source, item))
    }),
  )
  const merged: CmsRecord[] = []
  const seen = new Set<string>()
  for (const items of perSource) {
    for (const item of items) {
      const key = String(item.vod_id)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
      if (merged.length >= 60) return merged
    }
  }
  return merged
}

/** 聚合分类：全部源的分类名并集（同名只取一次） */
export async function aggClasses(
  sources: TvboxSource[],
): Promise<Array<{ type_id: string; type_name: string }>> {
  const perSource = await Promise.all(sources.map(s => cmsClassList(s.api)))
  const seen = new Set<string>()
  const classes: Array<{ type_id: string; type_name: string }> = []
  for (const data of perSource) {
    for (const c of data.classes) {
      if (!c.type_name || seen.has(c.type_name)) continue
      seen.add(c.type_name)
      // 聚合站用分类名本身作 type_id，请求时按名回查各源自己的 id
      classes.push({ type_id: c.type_name, type_name: c.type_name })
      if (classes.length >= 30) return classes
    }
  }
  return classes
}

/** 聚合列表：无分类时合并各源最新（轮询交错、按片名去重）；有分类时只查拥有同名分类的源 */
export async function aggList(
  sources: TvboxSource[],
  typeName: string,
  pg: number,
): Promise<CmsRecord[]> {
  let targets = sources
  if (typeName) {
    const perSource = await Promise.all(
      sources.map(async source => {
        const data = await cmsClassList(source.api)
        const hit = data.classes.find(c => c.type_name === typeName)
        return hit ? { source, typeId: hit.type_id } : null
      }),
    )
    targets = []
    const jobs: Array<Promise<CmsRecord[]>> = []
    for (const entry of perSource) {
      if (!entry) continue
      targets.push(entry.source)
      jobs.push(
        cmsVideolist(entry.source.api, { t: entry.typeId, pg }).then(d =>
          d.list.map(item => namespacedItem(entry.source, item)),
        ),
      )
    }
    const results = await Promise.all(jobs)
    return results.flat().slice(0, 60)
  }
  const perSource = await Promise.all(
    sources.map(async source => {
      const data = await cmsVideolist(source.api, { pg })
      return data.list.map(item => namespacedItem(source, item))
    }),
  )
  const merged: CmsRecord[] = []
  const seenTitles = new Set<string>()
  const maxLen = Math.max(0, ...perSource.map(l => l.length))
  for (let i = 0; i < maxLen; i += 1) {
    for (const items of perSource) {
      const item = items[i]
      if (!item) continue
      const key = normalizeTitle(String(item.vod_name ?? ''))
      if (key && seenTitles.has(key)) continue
      if (key) seenTitles.add(key)
      merged.push(item)
      if (merged.length >= 60) return merged
    }
  }
  return merged
}

/** 播放测速结果：ok=分片吞吐测通；kbps=分片下载吞吐（KB/s）；ttfbMs=清单响应耗时（兜底排序用） */
export interface PlaybackProbe {
  ok: boolean
  kbps: number
  ttfbMs: number
}

const PROBE_FAIL: PlaybackProbe = { ok: false, kbps: 0, ttfbMs: 9999 }
const PROBE_BYTES = 256 * 1024

/** 从主清单取第一个子清单地址（相对地址按清单自身地址解析）；非主清单返回空 */
export function variantPlaylistUrl(playlistText: string, baseUrl: string): string {
  if (!playlistText.includes('#EXT-X-STREAM-INF')) return ''
  for (const line of playlistText.split(/\r?\n/)) {
    const t = line.trim()
    if (t && !t.startsWith('#')) {
      try {
        return new URL(t, baseUrl).toString()
      } catch {
        return ''
      }
    }
  }
  return ''
}

/** 从媒体清单取第一个分片地址；取不到返回空 */
export function firstSegmentUrl(playlistText: string, baseUrl: string): string {
  for (const line of playlistText.split(/\r?\n/)) {
    const t = line.trim()
    if (t && !t.startsWith('#')) {
      try {
        return new URL(t, baseUrl).toString()
      } catch {
        return ''
      }
    }
  }
  return ''
}

/** 吞吐展示：≥1024KB/s 显示 MB/s */
export function formatThroughput(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)}MB/s`
  return `${Math.max(1, Math.round(kbps))}KB/s`
}

interface ProbeAttempt {
  /** 撞上确定性失败（4xx）时置真：这类失败重试也没用，别浪费子请求预算 */
  hardFail: boolean
}

async function fetchProbeText(
  url: string,
  timeoutMs: number,
  attempt: ProbeAttempt,
): Promise<{ text: string; ms: number } | null> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CMS_UA },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) attempt.hardFail = true
      return null
    }
    const text = await res.text()
    return { text, ms: Date.now() - start }
  } catch {
    return null
  }
}

/** 从已打开的响应体测下载吞吐（分片与直链媒体共用，读满 PROBE_BYTES 即停） */
async function measureDownload(
  res: Response,
  start: number,
): Promise<{ kbps: number; ttfbMs: number }> {
  let bytes = 0
  let ttfbMs = 9999
  if (!res.body) return { kbps: 0, ttfbMs }
  try {
    const reader = res.body.getReader()
    while (bytes < PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (ttfbMs === 9999) ttfbMs = Date.now() - start
      bytes += value?.byteLength ?? 0
    }
    void reader.cancel().catch(() => {})
  } catch {
    if (bytes === 0) return { kbps: 0, ttfbMs }
  }
  const seconds = (Date.now() - start) / 1000
  if (bytes < 16 * 1024 || seconds <= 0) return { kbps: 0, ttfbMs }
  return { kbps: bytes / 1024 / seconds, ttfbMs }
}

const M3U8_IN_TEXT = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/

/** 在网页文本（解析页/分享页）里提取首个 m3u8 地址，取不到返回空 */
export function extractM3u8Url(text: string): string {
  const m = text.match(M3U8_IN_TEXT)
  return m ? m[0] : ''
}

/** 已拿到清单文本：解析主/媒体清单 → 测首分片吞吐 */
async function probeFromPlaylistText(
  text: string,
  playlistUrl: string,
  ttfbMs: number,
  attempt: ProbeAttempt,
): Promise<PlaybackProbe> {
  let mediaUrl = playlistUrl
  let mediaText = text
  const variant = variantPlaylistUrl(text, playlistUrl)
  if (variant) {
    const sub = await fetchProbeText(variant, 4000, attempt)
    if (!sub) return { ok: false, kbps: 0, ttfbMs }
    mediaUrl = variant
    mediaText = sub.text
  }
  const segment = firstSegmentUrl(mediaText, mediaUrl)
  if (!segment) return { ok: false, kbps: 0, ttfbMs }
  const segStart = Date.now()
  try {
    const res = await fetch(segment, {
      headers: { 'User-Agent': CMS_UA },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) attempt.hardFail = true
      return { ok: false, kbps: 0, ttfbMs }
    }
    const d = await measureDownload(res, segStart)
    return d.kbps > 0
      ? { ok: true, kbps: d.kbps, ttfbMs }
      : { ok: false, kbps: 0, ttfbMs }
  } catch {
    return { ok: false, kbps: 0, ttfbMs }
  }
}

async function probeViaPlaylist(
  episodeUrl: string,
  fallbackTtfbMs: number,
  attempt: ProbeAttempt,
): Promise<PlaybackProbe> {
  const playlist = await fetchProbeText(episodeUrl, 4000, attempt)
  if (!playlist) return { ok: false, kbps: 0, ttfbMs: fallbackTtfbMs }
  if (!playlist.text.includes('#EXTM3U')) {
    return { ok: false, kbps: 0, ttfbMs: Math.min(playlist.ms, fallbackTtfbMs) }
  }
  return probeFromPlaylistText(playlist.text, episodeUrl, playlist.ms, attempt)
}

async function probePlaybackOnce(
  episodeUrl: string,
  attempt: ProbeAttempt,
): Promise<PlaybackProbe> {
  if (!episodeUrl) return PROBE_FAIL
  if (/\.m3u8($|\?)/i.test(episodeUrl)) return probeViaPlaylist(episodeUrl, 9999, attempt)
  // 非 m3u8 地址：可能是直链媒体，也可能是解析/分享网页（量子、非凡等源的 /share、/play 页）
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(episodeUrl, {
      headers: { 'User-Agent': CMS_UA },
      signal: AbortSignal.timeout(6000),
    })
  } catch {
    return PROBE_FAIL
  }
  const ttfbMs = Date.now() - start
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) attempt.hardFail = true
    return { ok: false, kbps: 0, ttfbMs }
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('mpegurl')) {
    const text = await res.text().catch(() => '')
    return text.includes('#EXTM3U')
      ? probeFromPlaylistText(text, episodeUrl, ttfbMs, attempt)
      : { ok: false, kbps: 0, ttfbMs }
  }
  if (contentType.includes('text/')) {
    // 网页：提取其中的真实 m3u8 再测（与播放器解析同路），提不到就只留响应耗时兜底排序
    const text = await res.text().catch(() => '')
    const inner = extractM3u8Url(text)
    if (inner && inner !== episodeUrl) return probeViaPlaylist(inner, ttfbMs, attempt)
    return { ok: false, kbps: 0, ttfbMs }
  }
  // 二进制直链媒体：就着这个响应把吞吐测完
  const d = await measureDownload(res, start)
  return d.kbps > 0
    ? { ok: true, kbps: d.kbps, ttfbMs }
    : { ok: false, kbps: 0, ttfbMs }
}

const probeCache = new Map<string, { at: number; probe: PlaybackProbe }>()
const PROBE_OK_CACHE_MS = 10 * 60_000
const PROBE_FAIL_CACHE_MS = 60_000

/**
 * 播放测速：拉第一集首个视频分片的前 256KB 测真实下载吞吐，
 * 比只测清单响应时间接近真实播放得多；解析/分享页型源（量子、非凡等）
 * 先从页面提取真实 m3u8 再测。瞬时失败（超时/网络抖动）自动重试一次，
 * 确定性失败（4xx）不重试——Cloudflare 单请求子请求预算有限（免费版 50 个），
 * 详情聚合已占大头，测速不能浪费。结果带缓存：成功 10 分钟、失败 1 分钟。
 * 测点在服务端，代表的是源站产能，不等同于电视本机直连速度。
 */
export async function probePlaybackSpeed(episodeUrl: string): Promise<PlaybackProbe> {
  if (!episodeUrl) return PROBE_FAIL
  const cached = probeCache.get(episodeUrl)
  if (cached) {
    const ttl = cached.probe.ok ? PROBE_OK_CACHE_MS : PROBE_FAIL_CACHE_MS
    if (Date.now() - cached.at < ttl) return cached.probe
  }
  const attempt: ProbeAttempt = { hardFail: false }
  let probe = await probePlaybackOnce(episodeUrl, attempt)
  if (!probe.ok && !attempt.hardFail) {
    probe = await probePlaybackOnce(episodeUrl, { hardFail: false })
  }
  if (probeCache.size > 300) probeCache.clear()
  probeCache.set(episodeUrl, { at: Date.now(), probe })
  return probe
}

export function splitPlayGroups(
  playFrom: unknown,
  playUrl: unknown,
): Array<{ from: string; episodes: string[] }> {
  const froms = String(playFrom ?? '').split('$$$')
  const urls = String(playUrl ?? '').split('$$$')
  const groups: Array<{ from: string; episodes: string[] }> = []
  for (let i = 0; i < urls.length; i += 1) {
    const episodes = urls[i].split('#').filter(Boolean)
    if (episodes.length === 0) continue
    groups.push({ from: froms[i] ?? '', episodes })
  }
  return groups
}

function firstEpisodeUrl(episodes: string[]): string {
  const first = episodes[0] ?? ''
  const idx = first.lastIndexOf('$')
  return idx >= 0 ? first.slice(idx + 1) : first
}

interface DetailCandidate {
  source: TvboxSource
  record: CmsRecord
  tier: number
  probe: PlaybackProbe
  groups: Array<{ from: string; episodes: string[] }>
}

const detailCache = new Map<string, { at: number; record: CmsRecord }>()
const DETAIL_CACHE_MS = 5 * 60_000

/**
 * 聚合详情：以主源记录为底，跨源找同名片（档位 ≤2），逐源取详情并测速，
 * 全部线路按（档位、速度）排序拼成一个多线路记录——APP 默认播第一条即最快源。
 */
/** 跨源命中（调用方已搜到时传入，省去 aggDetail 里再逐源搜一遍的子请求） */
export interface AggHit {
  sourceId: string
  vodId: string
  tier: number
}

/** 聚合详情最多取几个源（主源 + 跨源）：线路全量下发，仅受 Cloudflare 单请求子请求预算约束必须封顶 */
const MAX_DETAIL_CANDIDATES = 10
/** 最多给多少条线路做分片测速（其余按档位排在后面，标签不带速度） */
const MAX_PROBE_CANDIDATES = 10
/** 测速分批大小：全并发会把子请求预算半路耗尽、随机打死一片；分批保证靠前的线路先测完 */
const PROBE_BATCH_SIZE = 3

export async function aggDetail(
  sources: TvboxSource[],
  sourceId: string,
  vodId: string,
  knownHits?: AggHit[],
): Promise<CmsRecord | null> {
  const cacheKey = `${sourceId}:${vodId}`
  const cached = detailCache.get(cacheKey)
  if (cached && Date.now() - cached.at < DETAIL_CACHE_MS) return cached.record

  const primary = sources.find(s => s.id === sourceId) ?? sources[0]
  if (!primary) return null
  const primaryData = await cmsVideolist(primary.api, { ids: vodId })
  const primaryRecord = primaryData.list[0]
  if (!primaryRecord) return null
  const title = String(primaryRecord.vod_name ?? '')

  const candidates: DetailCandidate[] = [
    {
      source: primary,
      record: primaryRecord,
      tier: 0,
      probe: { ...PROBE_FAIL },
      groups: splitPlayGroups(primaryRecord.vod_play_from, primaryRecord.vod_play_url),
    },
  ]

  // 跨源候选组装：有现成命中就直接用（点墙路径刚搜过），没有才逐源现搜
  let targets: Array<{ source: TvboxSource; vodId: string; tier: number }> = []
  if (knownHits) {
    const seen = new Set<string>([primary.id])
    for (const hit of [...knownHits].sort((a, b) => a.tier - b.tier)) {
      if (seen.has(hit.sourceId)) continue
      const source = sources.find(s => s.id === hit.sourceId)
      if (!source) continue
      seen.add(hit.sourceId)
      targets.push({ source, vodId: hit.vodId, tier: hit.tier })
      if (targets.length >= MAX_DETAIL_CANDIDATES - 1) break
    }
  } else {
    const others = sources
      .filter(s => s.id !== primary.id)
      .slice(0, MAX_DETAIL_CANDIDATES - 1)
    const searched = await Promise.all(
      others.map(async source => {
        const search = await cmsVideolist(source.api, { wd: title, pg: 1 })
        let best: { id: string; tier: number } | null = null
        for (const item of search.list) {
          const tier = titleTier(String(item.vod_name ?? ''), title)
          if (tier > 2) continue
          if (!best || tier < best.tier) best = { id: String(item.vod_id ?? ''), tier }
          if (tier === 0) break
        }
        return best && best.id ? { source, vodId: best.id, tier: best.tier } : null
      }),
    )
    targets = searched.filter((t): t is NonNullable<typeof t> => t !== null)
  }

  const found = await Promise.all(
    targets.map(async t => {
      const detail = await cmsVideolist(t.source.api, { ids: t.vodId })
      const record = detail.list[0]
      if (!record) return null
      return {
        source: t.source,
        record,
        tier: t.tier,
        probe: { ...PROBE_FAIL },
        groups: splitPlayGroups(record.vod_play_from, record.vod_play_url),
      } as DetailCandidate
    }),
  )
  for (const c of found) if (c) candidates.push(c)

  // 先按档位排，只给靠前的若干条测速；分批按优先级推进，
  // 预算不够时只影响末尾线路，用户真正会播的前几条必有测速结果
  candidates.sort((a, b) => a.tier - b.tier)
  const toProbe = candidates.slice(0, MAX_PROBE_CANDIDATES)
  for (let i = 0; i < toProbe.length; i += PROBE_BATCH_SIZE) {
    await Promise.all(
      toProbe.slice(i, i + PROBE_BATCH_SIZE).map(async c => {
        c.probe = await probePlaybackSpeed(firstEpisodeUrl(c.groups[0]?.episodes ?? []))
      }),
    )
  }
  // 同档内：测通的优先，吞吐高的优先，吞吐接近时清单响应快的优先
  candidates.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.probe.ok) - Number(a.probe.ok) ||
      b.probe.kbps - a.probe.kbps ||
      a.probe.ttfbMs - b.probe.ttfbMs,
  )

  // 线路与集数全量下发（用户明确要求）：每个源的全部线路组、每组完整剧集都拼进详情，
  // 按（档位，测通，吞吐）排序、最快源排第一。曾试过 MoonTV 式「每源一条线只含第一集」
  // 来绕影视 5.6.4 的切线路崩溃，被用户否决；崩溃是 APP 自身 bug，根治靠升级 APP。
  const lineNames: string[] = []
  const lineUrls: string[] = []
  for (const c of candidates) {
    c.groups.slice(0, 3).forEach((group, idx) => {
      const label =
        idx === 0
          ? c.probe.ok
            ? `[⚡${formatThroughput(c.probe.kbps)}] ${c.source.name}`
            : c.source.name
          : `${c.source.name}·线路${idx + 1}`
      lineNames.push(label)
      lineUrls.push(group.episodes.join('#'))
    })
  }
  if (lineNames.length === 0) return primaryRecord

  const record: CmsRecord = {
    ...primaryRecord,
    vod_id: encodeAggId(primary.id, vodId),
    vod_play_from: lineNames.join('$$$'),
    vod_play_url: lineUrls.join('$$$'),
    vod_remarks:
      String(primaryRecord.vod_remarks ?? '') ||
      `已按速度排序 ${lineNames.length} 条线路`,
  }
  if (detailCache.size > 200) detailCache.clear()
  detailCache.set(cacheKey, { at: Date.now(), record })
  return record
}

// ---------- 豆瓣图片墙（聚合站首页，与网站首页同款分类） ----------

export interface DoubanWallCategory {
  label: string
  type: 'movie' | 'tv'
  tag: string
}

/** 与网站首页 src/shared/lib/douban.ts 的 DOUBAN_CATEGORIES 逐项一致（顺序即展示顺序） */
export const DOUBAN_WALL_CATEGORIES: DoubanWallCategory[] = [
  { label: '热门电影', type: 'movie', tag: '热门' },
  { label: '国产剧', type: 'tv', tag: '国产剧' },
  { label: '韩剧', type: 'tv', tag: '韩剧' },
  { label: '美剧', type: 'tv', tag: '美剧' },
  { label: '日剧', type: 'tv', tag: '日剧' },
  { label: '热门综艺', type: 'tv', tag: '综艺' },
  // 豆瓣 tv 侧没有「动画」标签，动漫的官方标签是「日本动画」，用错恒返回空
  { label: '热门动漫', type: 'tv', tag: '日本动画' },
  { label: '豆瓣高分', type: 'movie', tag: '豆瓣高分' },
  { label: '经典电影', type: 'movie', tag: '经典' },
]

const WALL_ID_PREFIX = 'wall__'

export function encodeWallId(title: string): string {
  return `${WALL_ID_PREFIX}${title}`
}

export function decodeWallTitle(id: string): string | null {
  if (!id.startsWith(WALL_ID_PREFIX)) return null
  const title = id.slice(WALL_ID_PREFIX.length).trim()
  return title || null
}

/** 豆瓣条目 → 图片墙条目：vod_id 编入片名，点击后走「按片名聚合」详情 */
export function mapDoubanSubjects(subjects: unknown[]): CmsRecord[] {
  const items: CmsRecord[] = []
  for (const raw of subjects) {
    const s = (raw ?? {}) as CmsRecord
    const title = String(s.title ?? '').trim()
    if (!title) continue
    const cover = String(s.cover ?? '').trim()
    items.push({
      vod_id: encodeWallId(title),
      vod_name: title,
      // TVBox 生态的防盗链约定：图片地址后拼 @Referer/@User-Agent 提示
      vod_pic: cover
        ? `${cover}@Referer=https://movie.douban.com/@User-Agent=${CMS_UA}`
        : '',
      vod_remarks: s.rate ? `⭐ ${String(s.rate)}` : '',
    })
  }
  return items
}

const wallCache = new Map<string, { at: number; items: CmsRecord[] }>()
const WALL_CACHE_MS = 10 * 60_000
const WALL_PAGE_LIMIT = 60

/** 拉一页豆瓣分类墙（服务端直拉，遵循管理员的豆瓣数据代理设置：自定义前缀 / cmliussss 换域名） */
export async function fetchDoubanWall(
  db: D1Database,
  category: DoubanWallCategory,
  pg: number,
): Promise<CmsRecord[]> {
  const cacheKey = `${category.type}:${category.tag}:${pg}`
  const cached = wallCache.get(cacheKey)
  if (cached && Date.now() - cached.at < WALL_CACHE_MS) return cached.items

  const target =
    `https://movie.douban.com/j/search_subjects?type=${category.type}` +
    `&tag=${encodeURIComponent(category.tag)}&sort=recommend` +
    `&page_limit=${WALL_PAGE_LIMIT}&page_start=${(pg - 1) * WALL_PAGE_LIMIT}`

  let requestUrl = target
  try {
    const proxy = await readDoubanProxySettings(db)
    if (proxy.dataType === 'custom' && proxy.dataUrl.trim()) {
      requestUrl = `${proxy.dataUrl.trim()}${encodeURIComponent(target)}`
    } else if (proxy.dataType === 'cmliussss-cdn-tencent') {
      requestUrl = target.replace('movie.douban.com', 'movie.douban.cmliussss.net')
    } else if (proxy.dataType === 'cmliussss-cdn-ali') {
      requestUrl = target.replace('movie.douban.com', 'movie.douban.cmliussss.com')
    }
  } catch {
    // 读不到代理设置就直拉
  }

  let items: CmsRecord[] = []
  try {
    const res = await fetch(requestUrl, {
      headers: { 'User-Agent': CMS_UA, Referer: 'https://movie.douban.com/' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const data = (await res.json()) as { subjects?: unknown }
      items = mapDoubanSubjects(Array.isArray(data.subjects) ? data.subjects : [])
    }
  } catch {
    items = []
  }
  if (wallCache.size > 100) wallCache.clear()
  wallCache.set(cacheKey, { at: Date.now(), items })
  return items
}

/**
 * 图片墙点击 → 按片名聚合详情：先跨源搜片名（档位 ≤2），
 * 挑最佳命中作主源走 aggDetail（跨源匹配 + 测速排序多线路），APP 默认播第一条即最快。
 */
export async function aggWallDetail(
  sources: TvboxSource[],
  title: string,
): Promise<CmsRecord | null> {
  const hits = await aggSearch(sources, title, 1)
  if (hits.length === 0) {
    return {
      vod_id: encodeWallId(title),
      vod_name: title,
      vod_remarks: '未找到可播放的源',
      vod_content: '本站的源里暂时没有这部片，可以换个片名在站内搜索试试。',
      vod_play_from: '',
      vod_play_url: '',
    }
  }
  // 命中按档位整理成 AggHit 传给 aggDetail 复用：点墙这一次请求里不再重复逐源搜索
  const aggHits: AggHit[] = []
  for (const hit of hits) {
    const decoded = decodeAggId(String(hit.vod_id ?? ''))
    if (!decoded) continue
    aggHits.push({
      sourceId: decoded.sourceId,
      vodId: decoded.vodId,
      tier: titleTier(String(hit.vod_name ?? ''), title),
    })
  }
  if (aggHits.length === 0) return null
  aggHits.sort((a, b) => a.tier - b.tier)
  const primary = aggHits[0]
  const record = await aggDetail(sources, primary.sourceId, primary.vodId, aggHits)
  if (!record) return null
  // 详情 id 固定为 wall__<片名>，不随「这次哪个源测速最快」漂移：
  // 主源 id 每次可能不同，APP 的历史/收藏按 id 对号，漂移会让历史对不上、
  // 切线路时更容易踩中影视 5.6.4 的空值崩溃。注意 aggDetail 的记录带缓存共享，只覆写副本。
  return { ...record, vod_id: encodeWallId(title) }
}
