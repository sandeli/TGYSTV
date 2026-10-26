import type { VideoSource } from '@tgys/cms-core'
import type { AccountSourcePayload } from '@/shared/lib/authApi'

/** 订阅源 id 约定前缀（与 apiStore 内部判定一致；此处不引 subscriptionStore 以免模块循环） */
const isSubscriptionSourceId = (id: string) => id.startsWith('sub:')

/**
 * 账号源的本地口径（纯函数集合）：
 * 账户源 = 当前登录用户手动维护、随账户同步的源，包括两部分：
 * 1. 已登记的账户源（accountSourceIds）——哪怕已开启全站生效、正以托管源形态展示；
 * 2. 尚未同步过的手动源（非订阅、非托管）。
 * 订阅源与站点基础托管源不属于账户源。
 */
export function collectAccountSources(
  videoAPIs: VideoSource[],
  managedSourceIds: string[],
  accountSourceIds: string[],
): VideoSource[] {
  const managed = new Set(managedSourceIds)
  const registered = new Set(accountSourceIds)
  return videoAPIs.filter(
    s => !isSubscriptionSourceId(s.id) && (registered.has(s.id) || !managed.has(s.id)),
  )
}

/**
 * 账户源去重（先出现者优先）：同一 id 只留一份；名称+地址完全相同的也只留一份。
 * 同一个源在不同设备上添加会生成不同 id，账号合并时若只按 id 并集就会变成两条重复源；
 * 与站点 addSource 的判定保持一致——名称与地址都相同即视为同一个源。
 */
export function dedupeAccountSources(list: VideoSource[]): VideoSource[] {
  const seenIds = new Set<string>()
  const seenPairs = new Set<string>()
  return list.filter(s => {
    const pair = `${s.name}\n${s.url}`
    if (seenIds.has(s.id) || seenPairs.has(pair)) return false
    seenIds.add(s.id)
    seenPairs.add(pair)
    return true
  })
}

/**
 * 剥掉一批源的「全站生效」标记（普通用户专用口径）：
 * 只有站长的源可以全站生效；普通用户导入/同步进来的源哪怕自带标记也一律清掉，
 * 只在添加者自己账户中启用（服务端保存时也会再剥一次，这里保证本地展示与上行都干净）。
 */
export function stripSiteWideFlags(list: VideoSource[]): VideoSource[] {
  return list.map(s => (s.siteWide ? { ...s, siteWide: false } : s))
}

/** VideoSource → 上行载荷（字段固定，序列化稳定，便于哈希比对） */
export function toAccountSourcePayload(source: VideoSource): AccountSourcePayload {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    ...(source.detailUrl && source.detailUrl !== source.url
      ? { detailUrl: source.detailUrl }
      : {}),
    ...(typeof source.timeout === 'number' ? { timeout: source.timeout } : {}),
    ...(typeof source.retry === 'number' ? { retry: source.retry } : {}),
    isEnabled: source.isEnabled !== false,
    siteWide: source.siteWide === true,
  }
}

/** 上行/下行载荷 → 本地 VideoSource */
export function fromAccountSourcePayload(payload: AccountSourcePayload): VideoSource {
  return {
    id: payload.id,
    name: payload.name,
    url: payload.url,
    detailUrl: payload.detailUrl || payload.url,
    timeout: payload.timeout,
    retry: payload.retry,
    isEnabled: payload.isEnabled !== false,
    siteWide: payload.siteWide === true,
    updatedAt: new Date(),
  }
}

/** 账户源集合的稳定序列化（不含 updatedAt 等易变字段），用于变更检测 */
export function serializeAccountSources(list: VideoSource[]): string {
  return JSON.stringify(list.map(toAccountSourcePayload))
}

/**
 * 从一批源里剔除已删名单命中的条目（防复活口径）：
 * 名单由服务端维护（任一设备删除都会进名单），名单内的源哪怕还残留在某台
 * 旧设备的本地列表里，也不许再参与同步上传；本次会话明确重新添加的源除外。
 */
export function excludeDeletedSources(
  list: VideoSource[],
  deletedIds: readonly string[],
  revivedIds: readonly string[] = [],
): VideoSource[] {
  if (deletedIds.length === 0) return list
  const dead = new Set(deletedIds)
  const revived = new Set(revivedIds)
  return list.filter(s => !dead.has(s.id) || revived.has(s.id))
}

/**
 * 本次要上报服务端的删除：服务端已知的源 id 里、本地集合已不存在的那些。
 * 上报后它们进入服务端的已删名单，之后任何设备再传回都会被拦下。
 */
export function computeReportedDeletions(
  serverKnownIds: readonly string[],
  localIds: ReadonlySet<string>,
): string[] {
  return serverKnownIds.filter(id => !localIds.has(id))
}

/**
 * 把服务端下发的订阅源按订阅 id 分组（id 约定 sub:<订阅id>:<序号>）。
 * 服务端自动更新维护的是站长订阅的最新源快照，站长端登录时按组应用到本地，
 * 每组交给 apiStore.replaceSubscriptionSources 整体换新；非订阅形态的条目跳过。
 */
export function groupServerSubscriptionSources(
  entries: AccountSourcePayload[],
): Map<string, VideoSource[]> {
  const grouped = new Map<string, VideoSource[]>()
  for (const entry of entries) {
    if (!isSubscriptionSourceId(entry.id)) continue
    const subId = entry.id.split(':')[1]
    if (!subId) continue
    const list = grouped.get(subId) ?? []
    list.push(fromAccountSourcePayload(entry))
    grouped.set(subId, list)
  }
  return grouped
}

/**
 * 托管镜像运行后，找出「服务端有、本机列表里却缺失、且不是正以托管形态展示」的账户源。
 * 这类条目是被托管镜像摘除的（典型：关闭某源的「全站生效」后它退出托管清单），
 * 应以个人形态补回本地，而不是当作已删除。注意只能在托管镜像刚运行完时调用它对账：
 * 用户主动删除同样会让条目从列表消失，但那是删除意图、必须生效，不能拿这个结果去恢复。
 */
export function findMirrorDroppedSources(
  serverKnown: VideoSource[],
  videoAPIs: VideoSource[],
  managedSourceIds: string[],
): VideoSource[] {
  const managed = new Set(managedSourceIds)
  return serverKnown.filter(
    s => !managed.has(s.id) && !videoAPIs.some(v => v.id === s.id),
  )
}

export interface AccountMirrorResult {
  videoAPIs: VideoSource[]
  accountSourceIds: string[]
}

/**
 * 把服务端账户源镜像进本地列表（与托管源镜像同一手法）：
 * - 旧账户源中「以个人形态存在」的条目先摘除，再把新集合插回它们原来的位置；
 * - 已开启全站生效、正以托管形态展示的条目由托管镜像负责，这里只登记 id、不重复插入；
 * - 订阅源与其他手动源原样保留。
 */
export function applyAccountMirror(
  videoAPIs: VideoSource[],
  prevAccountSourceIds: string[],
  incoming: VideoSource[],
  managedSourceIds: string[],
): AccountMirrorResult {
  const managed = new Set(managedSourceIds)
  const incomingLocal = incoming.filter(s => !managed.has(s.id))
  const prevLocalIds = new Set(prevAccountSourceIds.filter(id => !managed.has(id)))
  const insertAt = videoAPIs.findIndex(s => prevLocalIds.has(s.id))
  // 即将插入的源若已在本地以「未登记手动源」形态存在（刚添加、还没被登记进
  // accountSourceIds 就刷新了），旧副本也要摘掉，否则同一 id 会出现两条：
  // 一条是本地的、一条是刚镜像进来的（下次刷新登记生效后又会自愈为一条）
  const incomingLocalIds = new Set(incomingLocal.map(s => s.id))
  const rest = videoAPIs.filter(s => !prevLocalIds.has(s.id) && !incomingLocalIds.has(s.id))
  const at = insertAt === -1 ? rest.length : Math.min(insertAt, rest.length)
  return {
    videoAPIs: [...rest.slice(0, at), ...incomingLocal, ...rest.slice(at)],
    accountSourceIds: incoming.map(s => s.id),
  }
}
