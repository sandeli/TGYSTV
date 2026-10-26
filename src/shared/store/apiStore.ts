import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { VideoSource, SourceStore } from '@tgys/cms-core'
import {
  addSource,
  removeSource,
  setSourceEnabled,
  selectAllSources,
  deselectAllSources,
  getEnabledSources,
  importSources,
  type ImportResult,
} from '@tgys/cms-core/source'
import {
  expandApiSiteSources,
  extractTvboxSources,
  getInitialVideoSources,
  getManagedSourceEnabled,
} from '@/shared/config/api.config'
import { DEFAULT_SETTINGS } from '@/shared/config/settings.config'
import { v4 as uuidv4 } from 'uuid'
import { useSettingStore } from './settingStore'
import { useAuthStore } from './authStore'
import { INITIAL_CONFIG } from '@/shared/config/initialConfig'
import { applyAccountMirror } from '@/shared/lib/accountSources'

// 保持向后兼容的类型别名
export type VideoApi = VideoSource

/**
 * 用户导入的源条目：除标准字段外，还允许携带 KVideo 格式的兼容字段
 *（baseUrl 完整接口地址、enabled 开关），导入时会自动归一化。
 */
export type VideoSourceImportInput = Partial<VideoSource> & {
  baseUrl?: string
  enabled?: boolean
}

/** MoonTV 订阅文件的顶层结构：{ api_site: { <键>: { name, api } } }，导入时先展开成数组 */
export interface MoonTvConfigInput {
  api_site: Record<string, { name?: unknown; api?: unknown }>
}

/** TVBox 播放器配置的顶层结构：{ sites: [...] }，导入时提取其中 type=1 的 CMS 源 */
export interface TvboxConfigInput {
  sites: Array<Record<string, unknown>>
}

/** importVideoAPIs 可接受的输入：源数组、MoonTV 配置或 TVBox 配置 */
export type VideoSourceImportBatch = VideoSourceImportInput[] | MoonTvConfigInput | TvboxConfigInput

interface ApiState {
  // 视频源列表
  videoAPIs: VideoSource[]
  // 广告过滤开关
  adFilteringEnabled: boolean
  // 管理员统一提供的源（环境变量/管理员后台设置的初始源）的 id 集合：
  // 这些源对所有用户生效，但普通用户的「视频源管理」列表中不显示，只能看到自己添加的源
  managedSourceIds: string[]
  // 托管标记的存量补全版本：0 = 还没给旧版本导入的源补过标记
  managedTrackingVersion: number
  // 账号源 id 集合：这些源随当前登录用户的账户同步（存服务端），换设备登录也在；
  // 站长的源中开启「全站生效」的会以托管源形态出现，id 同样登记在这里
  accountSourceIds: string[]
  // 账号源归属的用户 id：同一浏览器换账号登录时，据此清掉上一账号同步下来的源、防止串号
  accountSourceOwnerId: number | null
}

interface ApiActions {
  // 设置 API 启用状态
  setApiEnabled: (apiId: string, enabled: boolean) => void
  // 设置手动源的「全站生效」标记（仅站长，卡片快捷开关与编辑弹窗共用口径）
  setApiSiteWide: (apiId: string, siteWide: boolean) => void
  // 添加视频 API
  addAndUpdateVideoAPI: (api: VideoSource) => void
  // 删除视频 API
  removeVideoAPI: (apiId: string) => void
  // 设置广告过滤
  setAdFilteringEnabled: (enabled: boolean) => void
  // 全选 API
  selectAllAPIs: () => void
  // 取消全选
  deselectAllAPIs: () => void
  // 初始化环境变量中的视频源
  initializeEnvSources: () => Promise<number>
  // 按 id 批量设置启用状态（普通用户在管理页对自己可见的源做全选/全不选）
  setVideoSourcesEnabled: (ids: string[], enabled: boolean) => void
  // 批量导入视频源（返回真实的导入结果：成功/跳过数量与原因）
  importVideoAPIs: (apis: VideoSourceImportBatch) => ImportResult
  // 获取选中的视频源
  getSelectedAPIs: () => VideoSource[]
  // 重置视频源
  resetVideoSources: () => Promise<void>
  // 替换指定订阅的所有视频源（保留用户之前的 isEnabled 设置）
  replaceSubscriptionSources: (subscriptionId: string, sources: VideoSource[]) => void
  // 移除指定订阅的所有视频源
  removeSubscriptionSources: (subscriptionId: string) => void
  // 按 ID 数组顺序重排视频源（拖拽排序 / 一键按延迟排序）
  reorderVideoAPIs: (orderedIds: string[]) => void
  // 把服务端账户源镜像进本地列表（登录后同步用，逻辑见 lib/accountSources）
  applyAccountSources: (sources: VideoSource[]) => void
  // 按 id 直接摘除一批源（账号同步执行服务端已删名单时用：连未登记的本地残留副本一并清掉）
  removeSourcesByIds: (ids: string[]) => void
  // 账号源同步开始前调用：归属用户变了就先清掉上一账号同步下来的源并改记归属
  beginAccountSyncForUser: (userId: number) => void
}

type ApiStore = ApiState & ApiActions

/**
 * 将ApiState转换为SourceStore格式以便使用cms-core纯函数
 */
function toSourceStore(state: ApiState): SourceStore {
  return {
    sources: state.videoAPIs,
    version: 1,
  }
}

/**
 * 从SourceStore提取sources到videoAPIs
 */
function fromSourceStore(store: SourceStore): VideoSource[] {
  return store.sources
}

export const useApiStore = create<ApiStore>()(
  devtools(
    persist(
      immer<ApiStore>((set, get) => ({
        videoAPIs: [],
        adFilteringEnabled: true,
        managedSourceIds: [],
        managedTrackingVersion: 0,
        accountSourceIds: [],
        accountSourceOwnerId: null,

        // Actions - 使用cms-core纯函数
        setApiEnabled: (apiId: string, enabled: boolean) => {
          set(state => {
            const store = toSourceStore(state)
            const newStore = setSourceEnabled(store, apiId, enabled)
            state.videoAPIs = fromSourceStore(newStore)
          })
        },

        setApiSiteWide: (apiId: string, siteWide: boolean) => {
          set(state => {
            state.videoAPIs = state.videoAPIs.map(s =>
              s.id === apiId ? { ...s, siteWide, updatedAt: new Date() } : s,
            )
          })
        },

        addAndUpdateVideoAPI: (api: VideoSource) => {
          set(state => {
            // 与已有源同名同址但 id 不同：底层 addSource 会判定「已存在」并按新 id 更新，
            // 匹配不到任何源 → 添加被静默吞掉（界面仍报保存成功）。这里先行处理：
            // 撞的是托管源 → 给用户建一份自己的副本（托管源对普通用户不可见、且会被
            // 管理员镜像整体替换，更新它等于白加）；撞的是本地源 → 原地更新那一份。
            const twin = state.videoAPIs.find(
              s => s.id !== api.id && s.name === api.name && s.url === api.url,
            )
            if (twin && state.managedSourceIds.includes(twin.id)) {
              state.videoAPIs = [{ ...api, updatedAt: new Date() }, ...state.videoAPIs]
              return
            }
            if (twin) {
              state.videoAPIs = state.videoAPIs.map(s =>
                s.id === twin.id ? { ...s, ...api, id: twin.id, updatedAt: new Date() } : s,
              )
              return
            }
            const store = toSourceStore(state)
            const isExisting = store.sources.some(
              s => s.id === api.id || (s.name === api.name && s.url === api.url),
            )
            // addSource会自动处理添加或更新
            const newStore = addSource(store, {
              ...api,
              updatedAt: new Date(),
            })
            const nextSources = fromSourceStore(newStore)

            // 新增源默认置顶；更新源保持原有顺序
            if (!isExisting) {
              const inserted = nextSources.find(source => source.id === api.id)
              state.videoAPIs = inserted
                ? [inserted, ...nextSources.filter(source => source.id !== inserted.id)]
                : nextSources
            } else {
              state.videoAPIs = nextSources
            }
          })
        },

        removeVideoAPI: (apiId: string) => {
          set(state => {
            const store = toSourceStore(state)
            const newStore = removeSource(store, apiId)
            state.videoAPIs = fromSourceStore(newStore)
          })
        },

        setAdFilteringEnabled: (enabled: boolean) => {
          set(state => {
            state.adFilteringEnabled = enabled
          })
        },

        selectAllAPIs: () => {
          set(state => {
            const store = toSourceStore(state)
            const newStore = selectAllSources(store)
            state.videoAPIs = fromSourceStore(newStore)
          })
        },

        deselectAllAPIs: () => {
          set(state => {
            const store = toSourceStore(state)
            const newStore = deselectAllSources(store)
            state.videoAPIs = fromSourceStore(newStore)
          })
        },

        initializeEnvSources: async () => {
          const envSources = await getInitialVideoSources()
          set(state => {
            if (typeof INITIAL_CONFIG?.adFilteringEnabled === 'boolean') {
              state.adFilteringEnabled = INITIAL_CONFIG.adFilteringEnabled
            }
            if (envSources.length > 0) {
              // 存量补标记（一次性）：托管标记功能上线前导入的源没有记录，
              // 若管理员此后已替换过源文件，没被标记的旧源会永远残留。这里把
              // 「非手动添加（uuid）、非订阅源（sub: 前缀）」的现存源补记为托管源，
              // 交给下面的镜像替换统一清理。手动添加与订阅源不受影响。
              if (state.managedTrackingVersion < 1 && state.managedSourceIds.length === 0) {
                const uuidPattern =
                  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                state.managedSourceIds = state.videoAPIs
                  .filter(s => !uuidPattern.test(s.id) && !s.id.startsWith('sub:'))
                  .map(s => s.id)
              }
              state.managedTrackingVersion = 1

              // 托管源整体镜像：先摘除旧托管源再导入最新列表，管理员替换源文件后
              // 增删、改名、改地址都如实生效，不再被导入的「已存在跳过」卡住；
              // 拉取失败返回空时整段不执行（外层已按 0 条处理为下次重试）。
              const previousManaged = new Set(state.managedSourceIds)
              const insertAt = state.videoAPIs.findIndex(s => previousManaged.has(s.id))
              state.videoAPIs = state.videoAPIs.filter(s => !previousManaged.has(s.id))
              const store = toSourceStore(state)
              const { store: newStore } = importSources(store, envSources, {
                defaultTimeout: useSettingStore.getState().network.defaultTimeout,
                defaultRetry: useSettingStore.getState().network.defaultRetry,
                skipInvalid: true,
              })
              const merged = fromSourceStore(newStore)
              // 托管源回到它们原来所在的位置，避免每次初始化后列表顺序大洗牌
              const freshIds = new Set(envSources.map(s => s.id))
              const imported = merged.filter(s => freshIds.has(s.id))
              const rest = merged.filter(s => !freshIds.has(s.id))
              const at = insertAt === -1 ? rest.length : Math.min(insertAt, rest.length)
              state.videoAPIs = [...rest.slice(0, at), ...imported, ...rest.slice(at)]
              state.managedSourceIds = [...freshIds]
            }
          })
          return envSources.length
        },

        setVideoSourcesEnabled: (ids: string[], enabled: boolean) => {
          set(state => {
            const idSet = new Set(ids)
            state.videoAPIs = state.videoAPIs.map(s =>
              idSet.has(s.id) ? { ...s, isEnabled: enabled } : s,
            )
          })
        },

        importVideoAPIs: (apis: VideoSourceImportBatch) => {
          let result: ImportResult = { success: true, imported: 0, skipped: 0, errors: [] }
          // MoonTV 订阅格式（api_site 字典）与 TVBox 配置（sites）先归一化成数组，
          // 与自家/KVideo 数组格式走同一条导入链路
          let preSkipped = 0
          let preError: string | null = null
          let list: VideoSourceImportInput[]
          if (Array.isArray(apis)) {
            list = apis
          } else {
            const moonTv = expandApiSiteSources(apis)
            const tvbox = moonTv ? null : extractTvboxSources(apis)
            const expanded = moonTv ?? tvbox?.sources ?? []
            if (tvbox && tvbox.unusable > 0) {
              preSkipped = tvbox.unusable
              preError = `TVBox 配置中有 ${tvbox.unusable} 个站点是爬虫/XML 等本站无法使用的类型，已跳过`
            }
            list = expanded.map(s => ({
              id: s.id,
              name: s.name,
              url: s.url,
              isEnabled: s.isEnabled,
            }))
          }
          set(state => {
            const store = toSourceStore(state)
            // 兼容 KVideo 源格式：baseUrl（完整接口地址）等价于 url，enabled 等价于 isEnabled。
            // 与管理员初始源解析（parseVideoSources）保持一致，避免同一份源列表在用户导入时被静默跳过。
            // 「全站生效」只有站长能用：普通用户导入的源哪怕文件里带了全站标记也一律剥掉，
            // 只在添加者自己账户中启用（站长导入则原样保留标记）
            const authState = useAuthStore.getState()
            const canSiteWide = authState.authMode === 'server' && authState.user?.role === 'admin'
            const normalized: Partial<VideoSource>[] = list.map(api => ({
              ...api,
              url: api.url || api.baseUrl,
              isEnabled: api.isEnabled ?? api.enabled ?? true,
              id: api.id || uuidv4(),
              ...(canSiteWide ? {} : { siteWide: false }),
            }))
            const { store: newStore, result: importResult } = importSources(store, normalized, {
              defaultTimeout: useSettingStore.getState().network.defaultTimeout,
              defaultRetry: useSettingStore.getState().network.defaultRetry,
              skipInvalid: true,
            })
            state.videoAPIs = fromSourceStore(newStore)
            result = importResult
          })
          // TVBox 提取阶段跳过的不可用站点并入结果上报，不静默丢弃
          if (preSkipped > 0) {
            result = {
              ...result,
              skipped: result.skipped + preSkipped,
              errors: preError ? [...result.errors, preError] : result.errors,
            }
          }
          return result
        },

        getSelectedAPIs: () => {
          const store = toSourceStore(get())
          const enabled = getEnabledSources(store)
          // 管理员显式开关表优先：托管源只要被管理员动过开关，全站（含本人）按表执行，
          // 不受各浏览器本地开关影响；未入表的托管源与自加源仍按本地/文件默认开关
          const overrides = getManagedSourceEnabled()
          if (Object.keys(overrides).length === 0) return enabled
          const managed = new Set(get().managedSourceIds)
          const enabledIds = new Set(enabled.map(s => s.id))
          return get().videoAPIs.filter(s => {
            if (managed.has(s.id) && Object.prototype.hasOwnProperty.call(overrides, s.id)) {
              return overrides[s.id]
            }
            return enabledIds.has(s.id)
          })
        },

        resetVideoSources: async () => {
          set(state => {
            state.videoAPIs = []
            state.adFilteringEnabled = INITIAL_CONFIG?.adFilteringEnabled ?? true
          })
          await get().initializeEnvSources()
        },

        replaceSubscriptionSources: (subscriptionId: string, sources: VideoSource[]) => {
          set(state => {
            const prefix = `sub:${subscriptionId}:`
            // 记录旧源的 isEnabled 状态（按 name+url 匹配，因为 index 可能变化）
            const oldEnabledMap = new Map<string, boolean>()
            state.videoAPIs
              .filter(s => s.id.startsWith(prefix))
              .forEach(s => {
                oldEnabledMap.set(`${s.name}||${s.url}`, s.isEnabled)
              })

            // 移除旧的订阅源
            const nonSubscriptionSources = state.videoAPIs.filter(s => !s.id.startsWith(prefix))

            // 对新源应用之前的 isEnabled 设置
            const newSources = sources.map(s => {
              const key = `${s.name}||${s.url}`
              const prevEnabled = oldEnabledMap.get(key)
              return {
                ...s,
                isEnabled: prevEnabled !== undefined ? prevEnabled : s.isEnabled,
              }
            })

            // 手动源在前，订阅源追加到末尾
            state.videoAPIs = [...nonSubscriptionSources, ...newSources]
          })
        },

        removeSubscriptionSources: (subscriptionId: string) => {
          set(state => {
            const prefix = `sub:${subscriptionId}:`
            state.videoAPIs = state.videoAPIs.filter(s => !s.id.startsWith(prefix))
          })
        },

        reorderVideoAPIs: (orderedIds: string[]) => {
          set(state => {
            const idIndexMap = new Map(orderedIds.map((id, index) => [id, index]))
            state.videoAPIs = [...state.videoAPIs].sort((a, b) => {
              const indexA = idIndexMap.get(a.id)
              const indexB = idIndexMap.get(b.id)
              if (indexA !== undefined && indexB !== undefined) return indexA - indexB
              if (indexA !== undefined) return -1
              if (indexB !== undefined) return 1
              return 0
            })
          })
        },

        applyAccountSources: (sources: VideoSource[]) => {
          set(state => {
            const mirrored = applyAccountMirror(
              state.videoAPIs,
              state.accountSourceIds,
              sources,
              state.managedSourceIds,
            )
            state.videoAPIs = mirrored.videoAPIs
            state.accountSourceIds = mirrored.accountSourceIds
          })
        },

        removeSourcesByIds: (ids: string[]) => {
          if (ids.length === 0) return
          set(state => {
            const dead = new Set(ids)
            state.videoAPIs = state.videoAPIs.filter(s => !dead.has(s.id))
          })
        },

        beginAccountSyncForUser: (userId: number) => {
          set(state => {
            if (state.accountSourceOwnerId === userId) return
            // 换了账号：上一账号同步下来的个人源先从本地列表摘除（托管源不受影响），再改记归属
            const mirrored = applyAccountMirror(
              state.videoAPIs,
              state.accountSourceIds,
              [],
              state.managedSourceIds,
            )
            state.videoAPIs = mirrored.videoAPIs
            state.accountSourceIds = []
            state.accountSourceOwnerId = userId
          })
        },
      })),
      {
        name: 'tgys-tv-api-store',
        version: 6,
        migrate: (persistedState: unknown, version: number) => {
          const state = persistedState as Partial<ApiState>

          if (version < 4) {
            state.videoAPIs = []
          }

          if (!Array.isArray(state.managedSourceIds)) {
            state.managedSourceIds = []
          }
          if (!Array.isArray(state.accountSourceIds)) {
            state.accountSourceIds = []
          }
          if (typeof state.accountSourceOwnerId !== 'number') {
            state.accountSourceOwnerId = null
          }
          if (typeof state.managedTrackingVersion !== 'number') {
            state.managedTrackingVersion = 0
          }

          if (version < 5) {
            state.videoAPIs =
              state.videoAPIs?.map(api => ({
                ...api,
                timeout: DEFAULT_SETTINGS.network.defaultTimeout,
                retry: DEFAULT_SETTINGS.network.defaultRetry,
                updatedAt: new Date(),
              })) || []
          }

          return state
        },
      },
    ),
    {
      name: 'ApiStore', // DevTools 中显示的名称
    },
  ),
)
