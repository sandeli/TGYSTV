import {
  countRegisteredUsers,
  DEFAULT_DOUBAN_PROXY,
  DOUBAN_PROXY_SETTING_KEYS,
  ensureSchema,
  getSettings,
  json,
  parseDoubanProxySettings,
  parseManagedSourceEnabled,
  parseRegistrationMaxUsers,
  parseRegistrationMode,
  parseRegistrationTimestamp,
  parseSiteBehavior,
  registrationFull,
  SITE_BEHAVIOR_SETTING_KEYS,
  type PagesContext,
} from '../../_lib/auth'
import {
  MASTER_SUBSCRIPTION_SOURCES_KEY,
  maybeUpdateMasterSubscriptions,
  mergeSiteWideWithSubscriptionSources,
  parseStoredSubscriptionSources,
} from '../../_lib/subscriptionUpdate'

/** 公开配置一次要读的全部 settings 键：一条 IN 查询拿完，避免逐项往返拖慢首屏 */
const CONFIG_SETTING_KEYS = [
  'announcement_popup_enabled',
  'announcement_popup_content',
  'announcement_popup_version',
  'announcement_bar_content',
  'initial_video_sources',
  'admin_sitewide_sources',
  MASTER_SUBSCRIPTION_SOURCES_KEY,
  'managed_source_enabled',
  'registration_mode',
  'registration_open',
  'registration_open_at',
  'registration_close_at',
  'registration_max_users',
  ...DOUBAN_PROXY_SETTING_KEYS,
  ...SITE_BEHAVIOR_SETTING_KEYS,
]

/** 账号系统公开配置：前端据此决定走服务器账号还是旧单密码模式，并读取首页弹窗公告 */
export const onRequest = async (context: PagesContext) => {
  const db = context.env.TGYS_DB
  if (!db) {
    return json({
      authEnabled: false,
      registrationOpen: false,
      registrationMode: 'closed',
      registrationOpenAt: 0,
      registrationCloseAt: 0,
      registrationFull: false,
      turnstileSiteKey: '',
      announcement: null,
      announcementBar: '',
      doubanProxy: DEFAULT_DOUBAN_PROXY,
      initialVideoSources: '',
      siteWideSources: '',
      managedSourceEnabled: {} as Record<string, boolean>,
      siteBehavior: {},
    })
  }
  await ensureSchema(db)
  const settings = await getSettings(db, CONFIG_SETTING_KEYS)
  const get = (key: string) => settings.get(key) ?? null

  const registrationMode = parseRegistrationMode(get, context.env)
  const maxUsers = parseRegistrationMaxUsers(get('registration_max_users'))
  const full =
    maxUsers > 0 ? registrationFull(maxUsers, await countRegisteredUsers(db)) : false

  // 站长订阅源到期检查（MoonTV 式「有人访问就顺带查」）：不阻塞本次响应，
  // 到期时由服务端在后台抓取更新，结果在后续访问中生效；无到期订阅时仅一次轻量读取
  if (context.waitUntil) {
    context.waitUntil(maybeUpdateMasterSubscriptions(db))
  }

  return json({
    authEnabled: true,
    registrationOpen: registrationMode !== 'closed',
    registrationMode,
    registrationOpenAt: parseRegistrationTimestamp(get('registration_open_at')),
    registrationCloseAt: parseRegistrationTimestamp(get('registration_close_at')),
    registrationFull: full,
    turnstileSiteKey: context.env.TGYS_TURNSTILE_SITE_KEY ?? '',
    announcement: {
      enabled: get('announcement_popup_enabled') === '1',
      content: get('announcement_popup_content') ?? '',
      version: Number.parseInt(get('announcement_popup_version') ?? '0', 10) || 0,
    },
    announcementBar: get('announcement_bar_content') ?? '',
    doubanProxy: parseDoubanProxySettings(get),
    initialVideoSources: get('initial_video_sources') ?? '',
    // 全站分发 = 站长手动全站源 + 服务端自动更新的站长订阅源（订阅数据变了全站随之变）
    siteWideSources: mergeSiteWideWithSubscriptionSources(
      get('admin_sitewide_sources'),
      parseStoredSubscriptionSources(get(MASTER_SUBSCRIPTION_SOURCES_KEY) ?? null),
    ),
    managedSourceEnabled: parseManagedSourceEnabled(get('managed_source_enabled')),
    siteBehavior: parseSiteBehavior(get),
  })
}
