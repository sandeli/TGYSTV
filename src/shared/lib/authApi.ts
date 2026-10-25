/**
 * 账号系统前端客户端（对接 functions/api 下的 Pages Functions 接口）。
 * 非 Cloudflare Pages 部署或未绑定 D1 时，config 接口不可用 → authEnabled=false，站点回退旧单密码模式。
 */

export interface AuthUser {
  id: number
  username: string
  role: 'admin' | 'user'
  isMaster?: boolean
}

export interface AnnouncementConfig {
  enabled: boolean
  content: string
  version: number
}

export interface DoubanProxyConfig {
  /** 数据代理：direct=本站服务器转发 / cors-proxy-zwei / cmliussss-cdn-tencent / cmliussss-cdn-ali / custom */
  dataType: string
  dataUrl: string
  /** 图片代理：server=本站代理 / direct / img3 / cmliussss-cdn-tencent / cmliussss-cdn-ali / custom */
  imageType: string
  imageUrl: string
}

export const DEFAULT_DOUBAN_PROXY: DoubanProxyConfig = {
  dataType: 'direct',
  dataUrl: '',
  imageType: 'server',
  imageUrl: '',
}

export type RegistrationMode = 'open' | 'invite' | 'closed'

/** 站点级「系统行为」设置（管理员后台维护、经公共配置下发全站；字段缺失 = 管理员未设置，客户端回退本地/环境默认） */
export interface SiteBehaviorConfig {
  updateLogEnabled?: boolean
  scrollChromeAnimationEnabled?: boolean
  tmdbApiToken?: string
  tmdbEnabled?: boolean
  tmdbApiBaseUrl?: string
  tmdbImageBaseUrl?: string
  tmdbLanguage?: string
  tmdbImageQuality?: string
  /** 站点默认弹幕接口地址（管理员后台维护）；优先级低于用户个人设置、高于部署变量 */
  danmakuApiUrl?: string
  /** 关站维护开关（管理员后台维护）：开启后仅站长可登录 */
  siteClosed?: boolean
  /** 关站说明（维护页展示） */
  siteClosedMessage?: string
  /** 无会员模式（免登录开放）：访客直接观看、无需登录；除站长外所有人进不了设置中心 */
  openAccess?: boolean
  /** 车机自动免登录：车机浏览器自动按访客模式进入，普通浏览器仍走会员制 */
  carOpenAccess?: boolean
}

export function sanitizeSiteBehavior(raw: unknown): SiteBehaviorConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: SiteBehaviorConfig = {}
  if (typeof r.updateLogEnabled === 'boolean') out.updateLogEnabled = r.updateLogEnabled
  if (typeof r.scrollChromeAnimationEnabled === 'boolean') {
    out.scrollChromeAnimationEnabled = r.scrollChromeAnimationEnabled
  }
  if (typeof r.tmdbApiToken === 'string') out.tmdbApiToken = r.tmdbApiToken
  if (typeof r.tmdbEnabled === 'boolean') out.tmdbEnabled = r.tmdbEnabled
  if (typeof r.tmdbApiBaseUrl === 'string') out.tmdbApiBaseUrl = r.tmdbApiBaseUrl
  if (typeof r.tmdbImageBaseUrl === 'string') out.tmdbImageBaseUrl = r.tmdbImageBaseUrl
  if (typeof r.danmakuApiUrl === 'string') out.danmakuApiUrl = r.danmakuApiUrl
  if (typeof r.siteClosed === 'boolean') out.siteClosed = r.siteClosed
  if (typeof r.siteClosedMessage === 'string') out.siteClosedMessage = r.siteClosedMessage
  if (typeof r.openAccess === 'boolean') out.openAccess = r.openAccess
  if (typeof r.carOpenAccess === 'boolean') out.carOpenAccess = r.carOpenAccess
  if (r.tmdbLanguage === 'zh-CN' || r.tmdbLanguage === 'zh-TW' || r.tmdbLanguage === 'en-US' || r.tmdbLanguage === 'ja-JP') {
    out.tmdbLanguage = r.tmdbLanguage
  }
  if (r.tmdbImageQuality === 'low' || r.tmdbImageQuality === 'medium' || r.tmdbImageQuality === 'high') {
    out.tmdbImageQuality = r.tmdbImageQuality
  }
  return out
}

export interface AuthPublicConfig {
  authEnabled: boolean
  registrationOpen: boolean
  /** 注册模式：开放 / 仅邀请码 / 关闭（旧后端无此字段时按 registrationOpen 推导） */
  registrationMode?: RegistrationMode
  /** 注册开放时段开始时刻（unix 秒）：未到该时刻前注册关闭、登录页显示开放日期通知；0/缺失 = 未设置 */
  registrationOpenAt?: number
  /** 注册开放时段结束时刻（unix 秒）：超过后注册关闭；0/缺失 = 不设结束 */
  registrationCloseAt?: number
  /** 注册人数已达上限：登录页显示「注册名额已满」（上限数值本身不下发） */
  registrationFull?: boolean
  turnstileSiteKey: string
  announcement: AnnouncementConfig | null
  /** 首页滚动公告（管理员后台设置；空字符串表示未设置，前端回退环境变量） */
  announcementBar: string
  /** 豆瓣数据/图片代理（管理员后台设置） */
  doubanProxy: DoubanProxyConfig
  /** 管理员后台设置的视频源（与 TGYS_INITIAL_VIDEO_SOURCES 同格式）；非空时优先于环境变量 */
  initialVideoSources?: string
  /** 站长开启「全站生效」的手动源（内联 JSON 数组，服务端从站长账号源派生）；与初始源合并后全站分发 */
  siteWideSources?: string
  /** 管理员对托管源的显式开关表（id→布尔）：表中源全站按此开关使用，未入表按源文件默认 */
  managedSourceEnabled?: Record<string, boolean>
  /** 站点级「系统行为」设置（管理员后台维护）：含 TMDB 令牌/开关等，配置后全站生效 */
  siteBehavior?: SiteBehaviorConfig
}

export class AuthApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response: Response
  try {
    response = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })
  } catch {
    throw new AuthApiError('网络异常，请稍后重试', 0)
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `请求失败 (${response.status})`
    throw new AuthApiError(message, response.status)
  }
  return data as T
}

/** 拉取账号系统公开配置；任何异常都视为未启用账号系统 */
export async function fetchAuthConfig(): Promise<AuthPublicConfig> {
  try {
    const response = await fetch('/api/auth/config')
    if (!response.ok) throw new Error('bad status')
    const data = (await response.json()) as Partial<AuthPublicConfig>
    const announcement =
      data.announcement && typeof data.announcement === 'object'
        ? {
            enabled: data.announcement.enabled === true,
            content: typeof data.announcement.content === 'string' ? data.announcement.content : '',
            version: typeof data.announcement.version === 'number' ? data.announcement.version : 0,
          }
        : null
    return {
      authEnabled: data.authEnabled === true,
      registrationOpen: data.registrationOpen === true,
      registrationMode:
        data.registrationMode === 'open' ||
        data.registrationMode === 'invite' ||
        data.registrationMode === 'closed'
          ? data.registrationMode
          : data.registrationOpen === true
            ? 'open'
            : 'closed',
      registrationOpenAt:
        typeof data.registrationOpenAt === 'number' &&
        Number.isFinite(data.registrationOpenAt) &&
        data.registrationOpenAt > 0
          ? Math.floor(data.registrationOpenAt)
          : 0,
      registrationCloseAt:
        typeof data.registrationCloseAt === 'number' &&
        Number.isFinite(data.registrationCloseAt) &&
        data.registrationCloseAt > 0
          ? Math.floor(data.registrationCloseAt)
          : 0,
      registrationFull: data.registrationFull === true,
      turnstileSiteKey: typeof data.turnstileSiteKey === 'string' ? data.turnstileSiteKey : '',
      announcement,
      announcementBar: typeof data.announcementBar === 'string' ? data.announcementBar : '',
      doubanProxy:
        data.doubanProxy && typeof data.doubanProxy === 'object'
          ? {
              dataType:
                typeof data.doubanProxy.dataType === 'string'
                  ? data.doubanProxy.dataType
                  : DEFAULT_DOUBAN_PROXY.dataType,
              dataUrl: typeof data.doubanProxy.dataUrl === 'string' ? data.doubanProxy.dataUrl : '',
              imageType:
                typeof data.doubanProxy.imageType === 'string'
                  ? data.doubanProxy.imageType
                  : DEFAULT_DOUBAN_PROXY.imageType,
              imageUrl:
                typeof data.doubanProxy.imageUrl === 'string' ? data.doubanProxy.imageUrl : '',
            }
          : DEFAULT_DOUBAN_PROXY,
      initialVideoSources:
        typeof data.initialVideoSources === 'string' ? data.initialVideoSources : '',
      siteWideSources: typeof data.siteWideSources === 'string' ? data.siteWideSources : '',
      managedSourceEnabled:
        data.managedSourceEnabled &&
        typeof data.managedSourceEnabled === 'object' &&
        !Array.isArray(data.managedSourceEnabled)
          ? Object.fromEntries(
              Object.entries(data.managedSourceEnabled as Record<string, unknown>).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
              ),
            )
          : {},
      siteBehavior: sanitizeSiteBehavior(data.siteBehavior),
    }
  } catch {
    return {
      authEnabled: false,
      registrationOpen: false,
      registrationMode: 'closed' as const,
      registrationOpenAt: 0,
      registrationCloseAt: 0,
      registrationFull: false,
      turnstileSiteKey: '',
      announcement: null,
      announcementBar: '',
      doubanProxy: DEFAULT_DOUBAN_PROXY,
    }
  }
}

interface SessionResponse {
  token: string
  expiresAt: number
  user: AuthUser
}

export function loginAccount(
  username: string,
  password: string,
  turnstileToken?: string,
): Promise<SessionResponse> {
  return request<SessionResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, turnstileToken }),
  })
}

export function registerAccount(
  username: string,
  password: string,
  turnstileToken?: string,
  inviteCode?: string,
): Promise<SessionResponse> {
  return request<SessionResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, turnstileToken, inviteCode }),
  })
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const data = await request<{ user: AuthUser }>('/api/auth/me', undefined, token)
  return data.user
}

export async function logoutAccount(token: string): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' }, token).catch(() => undefined)
}

export interface WatchReportPayload {
  title: string
  sourceCode: string
  sourceName: string
  vodId: string
  episodeIndex: number
  episodeName?: string
  progress: number
  duration: number
}

export async function reportWatch(token: string, payload: WatchReportPayload): Promise<void> {
  await request('/api/activity/watch', { method: 'POST', body: JSON.stringify(payload) }, token)
}

// ---------- 管理员接口 ----------

export interface AdminUserRow {
  id: number
  username: string
  role: string
  disabled: number
  createdAt: number
  lastLoginAt: number | null
  expiresAt: number | null
  tgWatch: number | null
  loginCount: number
  watchCount: number
  lastWatchAt: number | null
  lastWatchTitle: string | null
}

export interface AdminLoginLog {
  id: number
  ip: string | null
  userAgent: string | null
  country: string | null
  region: string | null
  city: string | null
  createdAt: number
}

export interface AdminWatchRecord {
  id: number
  title: string
  sourceCode: string
  sourceName: string
  vodId: string
  episodeIndex: number
  episodeName: string
  progress: number
  duration: number
  createdAt: number
  updatedAt: number
}

export interface AdminUserDetail {
  user: {
    id: number
    username: string
    role: string
    disabled: number
    createdAt: number
    lastLoginAt: number | null
    expiresAt: number | null
  }
  loginLogs: AdminLoginLog[]
  watchRecords: AdminWatchRecord[]
}

export async function adminListUsers(token: string): Promise<AdminUserRow[]> {
  const data = await request<{ users: AdminUserRow[] }>('/api/admin/users', undefined, token)
  return data.users
}

/** 管理员直接创建用户（用户名+密码；不受开放注册开关限制） */
export function adminCreateUser(
  token: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; user: { id: number; username: string } }> {
  return request(
    '/api/admin/users',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    token,
  )
}

export function adminGetUserDetail(token: string, userId: number): Promise<AdminUserDetail> {
  return request<AdminUserDetail>(`/api/admin/users/${userId}`, undefined, token)
}

export function adminSetUserDisabled(
  token: string,
  userId: number,
  disabled: boolean,
): Promise<{ ok: boolean }> {
  return request(`/api/admin/users/${userId}/disable`, {
    method: 'POST',
    body: JSON.stringify({ disabled }),
  }, token)
}

export function adminSetUserExpiry(
  token: string,
  userId: number,
  days: number,
): Promise<{ ok: boolean; expiresAt: number | null }> {
  return request(
    `/api/admin/users/${userId}/expiry`,
    { method: 'POST', body: JSON.stringify({ days }) },
    token,
  )
}

export function adminKickUser(token: string, userId: number): Promise<{ ok: boolean }> {
  return request(`/api/admin/users/${userId}/kick`, { method: 'POST' }, token)
}

export function adminDeleteUser(token: string, userId: number): Promise<{ ok: boolean }> {
  return request(`/api/admin/users/${userId}`, { method: 'DELETE' }, token)
}

/** 设置某用户的电报上线通知开关 */
export function adminSetUserTgWatch(
  token: string,
  userId: number,
  enabled: boolean,
): Promise<{ ok: boolean; tgWatch: boolean }> {
  return request(
    `/api/admin/users/${userId}/tgwatch`,
    { method: 'POST', body: JSON.stringify({ enabled }) },
    token,
  )
}

export async function adminListInvites(token: string): Promise<InviteCodeRow[]> {
  const data = await request<{ invites: InviteCodeRow[] }>('/api/admin/invites', undefined, token)
  return data.invites
}

export function adminCreateInvite(
  token: string,
  input: { note: string; maxUses: number; expiresDays: number },
): Promise<{ ok: boolean; invite: InviteCodeRow }> {
  return request('/api/admin/invites', { method: 'POST', body: JSON.stringify(input) }, token)
}

export function adminDeleteInvite(token: string, inviteId: number): Promise<{ ok: boolean }> {
  return request(`/api/admin/invites/${inviteId}`, { method: 'DELETE' }, token)
}

/** 用给定的 Bot Token + Chat ID 发送一条电报测试消息 */
export function adminTestTgNotify(
  token: string,
  botToken: string,
  chatId: string,
): Promise<{ ok: boolean }> {
  return request(
    '/api/admin/tg-test',
    { method: 'POST', body: JSON.stringify({ botToken, chatId }) },
    token,
  )
}

export interface InviteCodeRow {
  id: number
  code: string
  note: string
  maxUses: number
  usedCount: number
  expiresAt: number | null
  createdAt: number
}

export interface AdminSettings {
  registrationOpen: boolean
  registrationMode: RegistrationMode
  /** 注册开放时段开始时刻（unix 秒）：0 = 未设置 */
  registrationOpenAt: number
  /** 注册开放时段结束时刻（unix 秒）：0 = 不设结束 */
  registrationCloseAt: number
  /** 注册人数上限：0 = 不限 */
  registrationMaxUsers: number
  /** 当前注册用户数（后台展示用） */
  registeredUserCount: number
  /** 电报上线通知配置（管理员后台维护） */
  tgBotToken: string
  tgChatId: string
  announcement: AnnouncementConfig
  announcementBar: string
  doubanProxy: DoubanProxyConfig
  /** 管理员视频源（与 TGYS_INITIAL_VIDEO_SOURCES 同格式）；空串表示使用环境变量 */
  videoSources: string
  /** 管理员对托管源的显式开关表（id→布尔） */
  managedSourceEnabled: Record<string, boolean>
  /** 站点级「系统行为」设置（管理员后台维护） */
  siteBehavior: SiteBehaviorConfig
}

export interface TvboxInfo {
  token: string
  configUrl: string
}

/** 取当前用户的 TVBox 专属接口（没有令牌时服务端自动生成） */
export function fetchTvboxInfo(token: string): Promise<TvboxInfo> {
  return request<TvboxInfo>('/api/user/tvbox', { method: 'GET' }, token)
}

/** 修改当前账号密码（服务端校验现密码；成功后其他设备的会话会被踢下线，当前设备保持登录） */
export function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    '/api/user/password',
    { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) },
    token,
  )
}

/** 账号源条目（随账户走）：与服务端 AccountSourceEntry 同结构 */
export interface AccountSourcePayload {
  id: string
  name: string
  url: string
  detailUrl?: string
  timeout?: number
  retry?: number
  isEnabled: boolean
  siteWide: boolean
}

/** 站长订阅清单条目（同步到服务端用于自动更新的最小信息） */
export interface MasterSubscriptionPayload {
  id: string
  name: string
  url: string
  /** 自动刷新间隔（分钟），0 = 不自动刷新 */
  refreshInterval: number
}

/** 服务端维护的单条订阅刷新状态（随站长账号源接口下发） */
export interface SubscriptionRefreshMeta {
  id: string
  /** 上次刷新时间（unix 秒） */
  lastRefreshedAt: number | null
  lastRefreshSuccess: boolean
  lastRefreshError: string | null
  sourceCount: number
}

/** 读取当前登录用户的账号源（随账户走，按账号隔离）；站长额外带回服务端订阅源与刷新状态 */
export function fetchUserSources(token: string): Promise<{
  sources: AccountSourcePayload[]
  subscriptionSources?: AccountSourcePayload[]
  subscriptionMeta?: SubscriptionRefreshMeta[]
}> {
  return request<{
    sources: AccountSourcePayload[]
    subscriptionSources?: AccountSourcePayload[]
    subscriptionMeta?: SubscriptionRefreshMeta[]
  }>('/api/user/sources', { method: 'GET' }, token)
}

/** 同步站长订阅清单到服务端（仅主账号）：服务端据此到期自动抓取更新订阅源 */
export function saveMasterSubscriptions(
  token: string,
  subscriptions: MasterSubscriptionPayload[],
): Promise<{ ok: true; count: number }> {
  return request<{ ok: true; count: number }>(
    '/api/user/subscriptions',
    { method: 'PUT', body: JSON.stringify({ subscriptions }) },
    token,
  )
}

/** 整体保存当前用户的账号源；站长开启全站生效的源由服务端同步派生到全站分发列表 */
export function saveUserSources(
  token: string,
  sources: AccountSourcePayload[],
): Promise<{ ok: true; sources: AccountSourcePayload[] }> {
  return request<{ ok: true; sources: AccountSourcePayload[] }>(
    '/api/user/sources',
    { method: 'PUT', body: JSON.stringify({ sources }) },
    token,
  )
}

/** 重置 TVBox 令牌（旧配置地址立即失效） */
export function resetTvboxToken(token: string): Promise<TvboxInfo> {
  return request<TvboxInfo>(
    '/api/user/tvbox',
    { method: 'POST', body: JSON.stringify({ action: 'reset' }) },
    token,
  )
}

export function adminGetSettings(token: string): Promise<AdminSettings> {
  return request<AdminSettings>('/api/admin/settings', undefined, token)
}

export function adminUpdateSettings(
  token: string,
  patch: {
    registrationOpen?: boolean
    registrationMode?: RegistrationMode
    registrationOpenAt?: number
    registrationCloseAt?: number
    registrationMaxUsers?: number
    tgBotToken?: string
    tgChatId?: string
    announcementEnabled?: boolean
    announcementContent?: string
    announcementBarContent?: string
    doubanDataProxyType?: string
    doubanDataProxyUrl?: string
    doubanImageProxyType?: string
    doubanImageProxyUrl?: string
    videoSources?: string
    managedSourceEnabled?: Record<string, boolean>
    siteUpdateLogEnabled?: boolean
    siteScrollChromeAnimationEnabled?: boolean
    tmdbApiToken?: string
    tmdbEnabled?: boolean
    tmdbApiBaseUrl?: string
    tmdbImageBaseUrl?: string
    tmdbLanguage?: string
    tmdbImageQuality?: string
    danmakuApiUrl?: string
    siteClosed?: boolean
    siteClosedMessage?: string
    openAccess?: boolean
    carOpenAccess?: boolean
  },
): Promise<{ ok: boolean } & AdminSettings> {
  return request('/api/admin/settings', { method: 'POST', body: JSON.stringify(patch) }, token)
}
