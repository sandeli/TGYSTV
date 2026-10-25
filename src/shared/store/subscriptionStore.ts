import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'sonner'
import type { VideoSource } from '@tgys/cms-core'
import type { VideoSourceSubscription } from '@/shared/types/subscription'
import { useApiStore } from './apiStore'
import { useSettingStore } from './settingStore'
import { INITIAL_CONFIG, type SubscriptionConfig } from '@/shared/config/initialConfig'

// ==================== 工具函数 ====================

/** 判断视频源 ID 是否属于订阅源 */
export function isSubscriptionSource(sourceId: string): boolean {
  return sourceId.startsWith('sub:')
}

/** 从视频源 ID 提取订阅 ID */
export function extractSubscriptionId(sourceId: string): string | null {
  if (!isSubscriptionSource(sourceId)) return null
  return sourceId.split(':')[1]
}

/** 为订阅源生成带前缀的 ID */
function buildSubscriptionSourceId(subscriptionId: string, index: number): string {
  return `sub:${subscriptionId}:${index}`
}

// ==================== 远程拉取与转换 ====================

/** 从远程 URL 拉取视频源列表 */
async function fetchSourcesFromUrl(url: string): Promise<Partial<VideoSource>[]> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const data = await response.json()
  if (!Array.isArray(data)) {
    throw new Error('返回数据不是数组格式')
  }
  return data
}

/** 将原始数据转换为带订阅前缀 ID 的 VideoSource 数组 */
function mapToSubscriptionSources(
  subscriptionId: string,
  rawSources: Partial<VideoSource>[],
): VideoSource[] {
  const { defaultTimeout, defaultRetry } = useSettingStore.getState().network
  // 兼容 KVideo 源格式：baseUrl 等价于 url，enabled 等价于 isEnabled
  const urlOf = (s: Partial<VideoSource>) =>
    s.url || (s as { baseUrl?: string }).baseUrl
  return rawSources
    .filter(s => s.name && urlOf(s))
    .map((source, index) => ({
      id: buildSubscriptionSourceId(subscriptionId, index),
      name: source.name!,
      url: urlOf(source)!,
      detailUrl: source.detailUrl || urlOf(source),
      timeout: source.timeout ?? defaultTimeout,
      retry: source.retry ?? defaultRetry,
      isEnabled:
        source.isEnabled ?? (source as { enabled?: boolean }).enabled ?? true,
      updatedAt: new Date(),
    }))
}

// ==================== Store 定义 ====================

interface SubscriptionState {
  /** 所有订阅列表 */
  subscriptions: VideoSourceSubscription[]
}

/** 服务端自动更新回报的单条订阅刷新状态（unix 秒） */
export interface ServerSubscriptionRefreshMeta {
  id: string
  lastRefreshedAt: number | null
  lastRefreshSuccess: boolean
  lastRefreshError: string | null
  sourceCount: number
}

interface SubscriptionActions {
  /** 添加新订阅（添加后立即拉取一次） */
  addSubscription: (url: string, name?: string, refreshInterval?: number) => Promise<void>
  /** 应用服务端自动更新的刷新状态（仅当服务端时间更新时才覆盖本地记录） */
  applyServerRefreshMeta: (meta: ServerSubscriptionRefreshMeta[]) => void
  /** 移除订阅（同时从 apiStore 移除对应视频源） */
  removeSubscription: (subscriptionId: string) => void
  /** 刷新指定订阅 */
  refreshSubscription: (subscriptionId: string) => Promise<void>
  /** 刷新所有订阅 */
  refreshAllSubscriptions: () => Promise<void>
  /** 更新订阅的自动刷新间隔 */
  setRefreshInterval: (subscriptionId: string, intervalMinutes: number) => void
  /** 判断 URL 是否已被订阅 */
  isUrlSubscribed: (url: string) => boolean
  /** 从 TGYS_INITIAL_CONFIG 恢复并拉取订阅 */
  initializeEnvSubscriptions: () => Promise<void>
  /** 用指定订阅替换现有订阅并拉取 */
  replaceSubscriptions: (subscriptions: SubscriptionConfig[]) => Promise<void>
  /** 清空订阅及其视频源 */
  clearSubscriptions: () => void
}

type SubscriptionStore = SubscriptionState & SubscriptionActions

export const useSubscriptionStore = create<SubscriptionStore>()(
  devtools(
    persist(
      immer<SubscriptionStore>((set, get) => ({
        subscriptions: [],

        addSubscription: async (url: string, name?: string, refreshInterval?: number) => {
          if (get().isUrlSubscribed(url)) {
            toast.error('该 URL 已存在订阅')
            return
          }

          // 尝试从 URL 推断名称
          let resolvedName = name || ''
          if (!resolvedName) {
            try {
              resolvedName = new URL(url).hostname
            } catch {
              resolvedName = '未命名订阅'
            }
          }

          const subscriptionId = uuidv4()
          const subscription: VideoSourceSubscription = {
            id: subscriptionId,
            name: resolvedName,
            url,
            sourceCount: 0,
            lastRefreshedAt: null,
            lastRefreshSuccess: false,
            lastRefreshError: null,
            refreshInterval: refreshInterval ?? 60,
            createdAt: new Date(),
          }

          set(state => {
            state.subscriptions.push(subscription)
          })

          // 立即拉取一次
          await get().refreshSubscription(subscriptionId)
        },

        removeSubscription: (subscriptionId: string) => {
          const subscription = get().subscriptions.find(s => s.id === subscriptionId)
          useApiStore.getState().removeSubscriptionSources(subscriptionId)

          set(state => {
            state.subscriptions = state.subscriptions.filter(s => s.id !== subscriptionId)
          })

          if (subscription) {
            toast.success(`已取消订阅「${subscription.name}」`)
          }
        },

        refreshSubscription: async (subscriptionId: string) => {
          const subscription = get().subscriptions.find(s => s.id === subscriptionId)
          if (!subscription) return

          try {
            const rawSources = await fetchSourcesFromUrl(subscription.url)
            const sources = mapToSubscriptionSources(subscriptionId, rawSources)

            useApiStore.getState().replaceSubscriptionSources(subscriptionId, sources)

            set(state => {
              const sub = state.subscriptions.find(s => s.id === subscriptionId)
              if (sub) {
                sub.sourceCount = sources.length
                sub.lastRefreshedAt = new Date()
                sub.lastRefreshSuccess = true
                sub.lastRefreshError = null
              }
            })

            toast.success(`订阅「${subscription.name}」已刷新，共 ${sources.length} 个源`)
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误'

            set(state => {
              const sub = state.subscriptions.find(s => s.id === subscriptionId)
              if (sub) {
                sub.lastRefreshedAt = new Date()
                sub.lastRefreshSuccess = false
                sub.lastRefreshError = errorMessage
              }
            })

            toast.error(`刷新订阅「${subscription.name}」失败：${errorMessage}`)
          }
        },

        applyServerRefreshMeta: (meta: ServerSubscriptionRefreshMeta[]) => {
          set(state => {
            for (const m of meta) {
              if (m.lastRefreshedAt == null) continue
              const sub = state.subscriptions.find(s => s.id === m.id)
              if (!sub) continue
              const serverAt = m.lastRefreshedAt * 1000
              const localAt = sub.lastRefreshedAt ? new Date(sub.lastRefreshedAt).getTime() : 0
              // 本机刚刷过（时间更新）就不被服务端较旧的记录覆盖
              if (serverAt < localAt) continue
              sub.lastRefreshedAt = new Date(serverAt)
              sub.lastRefreshSuccess = m.lastRefreshSuccess
              sub.lastRefreshError = m.lastRefreshError
              sub.sourceCount = m.sourceCount
            }
          })
        },

        refreshAllSubscriptions: async () => {
          const { subscriptions } = get()
          if (subscriptions.length === 0) return

          await Promise.allSettled(subscriptions.map(sub => get().refreshSubscription(sub.id)))
        },

        setRefreshInterval: (subscriptionId: string, intervalMinutes: number) => {
          set(state => {
            const sub = state.subscriptions.find(s => s.id === subscriptionId)
            if (sub) {
              sub.refreshInterval = intervalMinutes
            }
          })
        },

        isUrlSubscribed: (url: string) => {
          return get().subscriptions.some(s => s.url === url)
        },

        replaceSubscriptions: async subscriptions => {
          get().clearSubscriptions()

          const normalizedSubscriptions: VideoSourceSubscription[] = subscriptions.map(sub => ({
            id: sub.id || uuidv4(),
            name:
              sub.name ||
              (() => {
                try {
                  return new URL(sub.url).hostname
                } catch {
                  return '未命名订阅'
                }
              })(),
            url: sub.url,
            sourceCount: sub.sourceCount ?? 0,
            lastRefreshedAt: sub.lastRefreshedAt ? new Date(sub.lastRefreshedAt) : null,
            lastRefreshSuccess: sub.lastRefreshSuccess ?? false,
            lastRefreshError: sub.lastRefreshError ?? null,
            refreshInterval: sub.refreshInterval ?? 60,
            createdAt: sub.createdAt ? new Date(sub.createdAt) : new Date(),
          }))

          set(state => {
            state.subscriptions = normalizedSubscriptions
          })

          await get().refreshAllSubscriptions()
        },

        initializeEnvSubscriptions: async () => {
          if (!INITIAL_CONFIG?.subscriptions) return
          await get().replaceSubscriptions(INITIAL_CONFIG.subscriptions)
        },

        clearSubscriptions: () => {
          for (const subscription of get().subscriptions) {
            useApiStore.getState().removeSubscriptionSources(subscription.id)
          }
          set(state => {
            state.subscriptions = []
          })
        },
      })),
      {
        name: 'tgys-tv-subscription-store',
        version: 1,
      },
    ),
    {
      name: 'SubscriptionStore',
    },
  ),
)
