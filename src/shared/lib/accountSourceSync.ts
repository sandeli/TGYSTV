import { toast } from 'sonner'
import type { VideoSource } from '@tgys/cms-core'
import { useApiStore } from '@/shared/store/apiStore'
import { useAuthStore } from '@/shared/store/authStore'
import { useSubscriptionStore } from '@/shared/store/subscriptionStore'
import { fetchUserSources, saveMasterSubscriptions, saveUserSources } from '@/shared/lib/authApi'
import {
  collectAccountSources,
  dedupeAccountSources,
  stripSiteWideFlags,
  findMirrorDroppedSources,
  fromAccountSourcePayload,
  groupServerSubscriptionSources,
  serializeAccountSources,
  toAccountSourcePayload,
} from '@/shared/lib/accountSources'

/**
 * 账号源同步引擎（服务器账号模式下登录用户启动，随账户走、不随浏览器）：
 * - 启动时先按归属用户隔离上一账号的源，再拉取服务端账户源，与本地手动源并集后
 *   镜像进本地（老本地源自动迁上账户）；
 * - 之后本地账户源集合有任何变化（增删改、开关、全站标记）都防抖整体回存服务端；
 * - 站长保存时服务端会把开启「全站生效」的源派生进全站分发列表，本端随后刷新
 *   公开配置，托管镜像随即跟上（含站长自己这台设备）；普通用户的源只对自己生效。
 * 返回停止函数（登出/身份变化时由调用方清理）。
 */
export function startAccountSourceSync(userId: number): () => void {
  useApiStore.getState().beginAccountSyncForUser(userId)
  let disposed = false
  let applying = false
  let timer: number | null = null
  let lastHash: string | null = null
  let failureNotified = false
  /** 服务端已知的账户源（最近一次拉取/保存回显）：用于识别「本机还没加载到」的已发布源 */
  let serverKnown: VideoSource[] = []
  /** 本次会话里在本地列表中出现过的源 id：出现过又消失 = 被删，不再从服务端副本里带回 */
  const seenIds = new Set<string>(useApiStore.getState().videoAPIs.map(s => s.id))

  // 只有站长（userId=0）的源可以带「全站生效」标记；普通用户收集时一律剥掉，
  // 保证本地展示、上行载荷与服务端落库口径一致（源只在自己账户中启用）
  const isMaster = userId === 0
  const collect = () => {
    const state = useApiStore.getState()
    const collected = collectAccountSources(state.videoAPIs, state.managedSourceIds, state.accountSourceIds)
    return isMaster ? collected : stripSiteWideFlags(collected)
  }

  const pushNow = async () => {
    if (disposed) return
    const token = useAuthStore.getState().token
    if (!token) return
    const local = collect()
    const localIds = new Set(local.map(s => s.id))
    // 已发布（全站生效）的源在托管镜像没加载到本机时不出现在本地列表里，
    // 回存时把这类「服务端有、本机没见过」的条目原样带回，避免一次本地编辑把它们误删下架
    const carried = serverKnown.filter(
      s => s.siteWide === true && !localIds.has(s.id) && !seenIds.has(s.id),
    )
    const list = dedupeAccountSources([...local, ...carried])
    const hash = serializeAccountSources(list)
    if (hash === lastHash) return
    // 先乐观更新服务端副本：托管镜像随后摘除/恢复条目时，对账以这份最新意图为准
    serverKnown = list
    try {
      const saved = await saveUserSources(token, list.map(toAccountSourcePayload))
      serverKnown = saved.sources.map(fromAccountSourcePayload)
      lastHash = hash
      failureNotified = false
      // 全站分发可能变化：刷新公开配置，托管镜像（本站长设备与其他用户）随后跟上
      void useAuthStore.getState().probeConfig()
    } catch {
      if (!failureNotified) {
        failureNotified = true
        toast.error('源同步到账户失败，改动暂存在本机，之后会自动重试')
      }
    }
  }

  // 站长订阅清单上行：订阅定义只存本机时服务端无从自动更新，这里把清单（链接+间隔）
  // 同步一份到服务端；服务端到期自己抓取，站长不必开着浏览器。仅站长会话做，失败静默。
  let registryHash: string | null = null
  let registryTimer: number | null = null
  const pushRegistry = async () => {
    if (!isMaster || disposed) return
    const token = useAuthStore.getState().token
    if (!token) return
    const subs = useSubscriptionStore
      .getState()
      .subscriptions.map(s => ({ id: s.id, name: s.name, url: s.url, refreshInterval: s.refreshInterval }))
    const hash = JSON.stringify(subs)
    if (hash === registryHash) return
    try {
      await saveMasterSubscriptions(token, subs)
      registryHash = hash
    } catch {
      // 静默：下次订阅变更或下次打开站点时会再同步
    }
  }
  const scheduleRegistryPush = () => {
    if (registryTimer !== null) window.clearTimeout(registryTimer)
    registryTimer = window.setTimeout(() => {
      registryTimer = null
      void pushRegistry()
    }, 1200)
  }
  const unsubscribeSubs = isMaster ? useSubscriptionStore.subscribe(scheduleRegistryPush) : () => {}

  const schedulePush = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      void pushNow()
    }, 1200)
  }

  const init = async () => {
    const token = useAuthStore.getState().token
    if (!token || disposed) return
    try {
      const remote = await fetchUserSources(token)
      if (disposed) return
      serverKnown = remote.sources.map(fromAccountSourcePayload)
      const localList = collect()
      // 并集（同 id 以服务端为准）：把这台设备上还没上过账户的老手动源迁上去；
      // 再按（名称+地址）去重——同一个源在不同设备上添加的 id 不同，不去重就会变成两条重复源
      const remoteIds = new Set(serverKnown.map(s => s.id))
      const merged = dedupeAccountSources([
        ...serverKnown,
        ...localList.filter(s => !remoteIds.has(s.id)),
      ])
      applying = true
      useApiStore.getState().applyAccountSources(merged)
      applying = false
      // 先刷新配置并跑一遍托管镜像，让已发布的源以托管形态回到本地列表，
      // 之后的变更检测才不会把它们误判为「已删除」
      await useAuthStore.getState().probeConfig()
      if (disposed) return
      await useApiStore.getState().initializeEnvSources()
      if (disposed) return
      // 站长：把本机订阅清单上行服务端（供服务端到期自动更新），并应用服务端
      // 已自动更新好的订阅源快照与刷新状态——换设备打开也是最新的一份
      if (isMaster) {
        void pushRegistry()
        if (remote.subscriptionSources && remote.subscriptionSources.length > 0) {
          const grouped = groupServerSubscriptionSources(remote.subscriptionSources)
          applying = true
          for (const [subId, list] of grouped) {
            useApiStore.getState().replaceSubscriptionSources(subId, list)
          }
          applying = false
        }
        if (remote.subscriptionMeta) {
          useSubscriptionStore.getState().applyServerRefreshMeta(remote.subscriptionMeta)
        }
      }
      for (const s of useApiStore.getState().videoAPIs) seenIds.add(s.id)
      lastHash = serializeAccountSources(collect())
      if (serializeAccountSources(serverKnown) !== serializeAccountSources(merged)) {
        const saved = await saveUserSources(token, merged.map(toAccountSourcePayload))
        serverKnown = saved.sources.map(fromAccountSourcePayload)
        lastHash = serializeAccountSources(collect())
        if (!disposed) void useAuthStore.getState().probeConfig()
      }
    } catch {
      // 拉取失败不打扰：本地源照常可用，下次打开站点会再同步
    }
  }
  void init()

  const unsubscribe = useApiStore.subscribe((state, prevState) => {
    if (disposed) return
    for (const s of state.videoAPIs) seenIds.add(s.id)
    if (applying) return
    if (state.videoAPIs === prevState.videoAPIs) return
    if (state.managedSourceIds !== prevState.managedSourceIds) {
      // 本次变化来自托管源镜像（它与源列表在同一次状态更新里改动托管 id 集合）：
      // 账户源若被镜像摘除，以个人形态补回。典型场景：关闭某源的「全站生效」后
      // 托管镜像把它摘除，但它仍是个人账户源，不应被删掉
      const missing = findMirrorDroppedSources(serverKnown, state.videoAPIs, state.managedSourceIds)
      if (missing.length > 0) {
        applying = true
        useApiStore.getState().applyAccountSources(serverKnown)
        applying = false
      }
    } else {
      // 用户自己的增删改（含删除源）：以本地为准，服务端副本跟随，
      // 删除随之生效、随后回存时同步删掉服务端那份，不会被对账恢复回来
      serverKnown = collect()
    }
    schedulePush()
  })

  return () => {
    disposed = true
    unsubscribe()
    unsubscribeSubs()
    if (timer !== null) window.clearTimeout(timer)
    if (registryTimer !== null) window.clearTimeout(registryTimer)
  }
}
