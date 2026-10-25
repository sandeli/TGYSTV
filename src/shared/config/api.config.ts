// API 配置
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export const API_CONFIG = {
  search: {
    path: '/api.php/provide/vod/?ac=videolist&wd=',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  },
  detail: {
    path: '/api.php/provide/vod/?ac=videolist&ids=',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  },
}

// 代理地址前缀（可在设置页被覆盖）
export const DEFAULT_PROXY_URL = '/proxy?url='
export const PROXY_URL = DEFAULT_PROXY_URL
export const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g

export const normalizeProxyPrefix = (proxyUrl?: string | null): string => {
  const value = typeof proxyUrl === 'string' ? proxyUrl.trim() : ''
  const base = value || DEFAULT_PROXY_URL

  if (base.includes('{url}')) return base
  if (/[?&]url=$/i.test(base)) return base
  if (/[?&]url=[^&]*$/i.test(base)) {
    return base.replace(/([?&]url=)[^&]*$/i, '$1')
  }
  return base.includes('?') ? `${base}&url=` : `${base}?url=`
}

export const buildProxyRequestUrl = (targetUrl: string, proxyUrl?: string | null): string => {
  const normalized = normalizeProxyPrefix(proxyUrl)
  if (normalized.includes('{url}')) {
    return normalized.split('{url}').join(encodeURIComponent(targetUrl))
  }
  return normalized + encodeURIComponent(targetUrl)
}

import type { VideoApi } from '@/shared/types/video'
import { INITIAL_CONFIG, type VideoSourceConfig } from './initialConfig'
import { DEFAULT_SETTINGS } from './settings.config'
import { getPublicEnv } from './runtimeEnv'
import { useAuthStore } from '@/shared/store/authStore'
import type { SiteBehaviorConfig } from '@/shared/lib/authApi'

type VideoSourceInput = VideoSourceConfig[] | string | undefined

/**
 * MoonTV 订阅格式展开：{ api_site: { <键>: { name, api } } } → 标准源数组。
 * 不是这种结构（或展开后为空）返回 null，调用方按原格式继续处理。
 * 展开后与 KVideo、自家数组格式走同一套解析，三种格式可混用同一条导入链路。
 */
export const expandApiSiteSources = (input: unknown): VideoSourceConfig[] | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const apiSite = (input as { api_site?: unknown }).api_site
  if (!apiSite || typeof apiSite !== 'object' || Array.isArray(apiSite)) return null
  const out: VideoSourceConfig[] = []
  for (const [key, raw] of Object.entries(apiSite as Record<string, unknown>)) {
    const site = (raw ?? {}) as { name?: unknown; api?: unknown }
    const api = typeof site.api === 'string' ? site.api.trim() : ''
    if (!api) continue
    const name = typeof site.name === 'string' && site.name.trim() ? site.name.trim() : key
    // detail 字段是 MoonTV 的详情页地址，TGYS 详情走同一个 CMS 接口，不需要
    out.push({ id: key, name, url: api, isEnabled: true })
  }
  return out.length ? out : null
}

/** TVBox 配置提取结果：sources 为可用的 CMS 源，unusable 为跳过的不可用站点数 */
export interface TvboxExtractResult {
  sources: VideoSourceConfig[]
  unusable: number
}

/**
 * TVBox 播放器配置提取：{ sites: [{ key, name, type, api }] }。
 * 只有 type=1 且 api 是 http(s) 地址的站点是标准 CMS 采集接口，能直接用；
 * type=3 爬虫（csp/drpy，靠播放器内的爬虫运行时）、type=0 XML 等其余站点本站用不了，计入 unusable 如实上报。
 * 不是这种结构返回 null。
 */
export const extractTvboxSources = (input: unknown): TvboxExtractResult | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const sites = (input as { sites?: unknown }).sites
  if (!Array.isArray(sites)) return null
  const sources: VideoSourceConfig[] = []
  let unusable = 0
  for (const raw of sites) {
    const site = (raw ?? {}) as { key?: unknown; name?: unknown; type?: unknown; api?: unknown }
    const api = typeof site.api === 'string' ? site.api.trim() : ''
    const isCmsJson = (site.type === 1 || site.type === '1') && /^https?:\/\//i.test(api)
    if (isCmsJson) {
      const key =
        typeof site.key === 'string' && site.key.trim() ? site.key.trim() : `tvbox_${sources.length + 1}`
      const name = typeof site.name === 'string' && site.name.trim() ? site.name.trim() : key
      sources.push({ id: key, name, url: api, isEnabled: true })
    } else {
      unusable += 1
    }
  }
  return { sources, unusable }
}

export const parseVideoSources = (sources: VideoSourceConfig[]): VideoApi[] => {
  return sources
    .map((source, index) => {
      // 兼容 KVideo 源格式：baseUrl（完整接口地址）等价于 url，enabled 等价于 isEnabled
      const url = source?.url || source?.baseUrl
      if (!source || typeof source !== 'object' || !source.name || !url) {
        console.warn(`跳过无效的视频源配置: ${JSON.stringify(source)}`)
        return null
      }

      return {
        id: source.id || `env_source_${index}`,
        name: source.name,
        url,
        detailUrl: source.detailUrl || url,
        isEnabled: source.isEnabled ?? source.enabled ?? true,
        siteWide: source.siteWide === true ? true : undefined,
        updatedAt: source.updatedAt ? new Date(source.updatedAt) : new Date(),
        timeout: source.timeout ?? DEFAULT_SETTINGS.network.defaultTimeout,
        retry: source.retry ?? DEFAULT_SETTINGS.network.defaultRetry,
      } as VideoApi
    })
    .filter((source): source is VideoApi => source !== null)
}

export const loadVideoSources = async (input: VideoSourceInput): Promise<VideoApi[]> => {
  if (Array.isArray(input)) return parseVideoSources(input)
  if (!input || typeof input !== 'string') return []

  let sourceText = input.trim()
  if (!sourceText) return []

  let remoteUrl: URL | null = null
  try {
    remoteUrl = new URL(sourceText)
  } catch {
    // 不是 URL，按内联 JSON 继续处理
  }

  if (remoteUrl) {
    try {
      const response = await fetch(buildProxyRequestUrl(remoteUrl.toString()))
      if (!response.ok) {
        console.error(`无法获取视频源，HTTP状态: ${response.status}`)
        return []
      }
      sourceText = await response.text()
    } catch (error) {
      console.error('获取远程视频源失败:', error)
      return []
    }
  }

  try {
    const cleanedSources = sourceText
      .replace(/^\s*['"`]/, '') // 移除开头的引号
      .replace(/['"`]\s*$/, '') // 移除结尾的引号
      .trim()

    const jsonSources: unknown = JSON.parse(cleanedSources)
    const sources = Array.isArray(jsonSources)
      ? jsonSources
      : (expandApiSiteSources(jsonSources) ??
        extractTvboxSources(jsonSources)?.sources ?? [jsonSources])

    return parseVideoSources(sources as VideoSourceConfig[])
  } catch (error) {
    console.error('解析环境变量中的视频源失败:', error)
    return []
  }
}

// 初始视频源优先级：管理员后台设置 > TGYS_INITIAL_CONFIG > TGYS_INITIAL_VIDEO_SOURCES 环境变量。
// 管理员值经公开配置下发，与环境变量同格式（远程 JSON 地址或内联 JSON）；留空表示回退环境变量。
/** 管理员对托管源的显式开关表（公开配置下发）：表中源全站按此开关使用，未入表按源文件默认开关 */
/** 站点级「系统行为」设置（管理员后台维护、公开配置下发）：字段缺失 = 管理员未设置，调用方回退本地/环境默认 */
export const getSiteBehavior = (): SiteBehaviorConfig => {
  return useAuthStore.getState().authConfig?.siteBehavior ?? {}
}

export const getManagedSourceEnabled = (): Record<string, boolean> => {
  const map = useAuthStore.getState().authConfig?.managedSourceEnabled
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
  return Object.fromEntries(
    Object.entries(map).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

/** 合并两份托管源清单：extra 中与 base 同 id 的条目覆盖 base，extra 独有条目追加在后 */
export function mergeManagedSourceLists(base: VideoApi[], extra: VideoApi[]): VideoApi[] {
  if (extra.length === 0) return base
  const extraIds = new Set(extra.map(s => s.id))
  return [...base.filter(s => !extraIds.has(s.id)), ...extra]
}

export const getInitialVideoSources = async (): Promise<VideoApi[]> => {
  let base: VideoApi[] | null = null
  try {
    const adminSources = useAuthStore.getState().authConfig?.initialVideoSources
    if (adminSources && adminSources.trim()) {
      base = await loadVideoSources(adminSources)
    }
  } catch {
    // 忽略：未初始化时按环境变量走
  }
  if (base === null) {
    base =
      INITIAL_CONFIG && INITIAL_CONFIG.videoSources !== undefined
        ? await loadVideoSources(INITIAL_CONFIG.videoSources)
        : await loadVideoSources(getPublicEnv('TGYS_INITIAL_VIDEO_SOURCES'))
  }
  // 站长在设置页开启「全站生效」的手动源（随站长账户同步、服务端派生分发）：与基础托管源合并成一份托管清单
  try {
    const siteWideSources = useAuthStore.getState().authConfig?.siteWideSources
    if (siteWideSources && siteWideSources.trim()) {
      const extra = await loadVideoSources(siteWideSources)
      // 全站分发里混有站长订阅源（服务端自动更新）：站长本人剔除这部分——他的订阅源
      // 由订阅通道（本机订阅 + 服务端快照）维护，若再以托管形态镜像进来会同 id 重复
      const isMaster = useAuthStore.getState().user?.id === 0
      const effective = isMaster ? extra.filter(s => !s.id.startsWith('sub:')) : extra
      return mergeManagedSourceLists(base, effective)
    }
  } catch {
    // 忽略：全站源解析失败时只用基础托管源
  }
  return base
}
