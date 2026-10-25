import {
  getSettings,
  json,
  MASTER_USER_ID,
  readJson,
  requireUser,
  setSetting,
  type PagesContext,
} from '../../_lib/auth'
import {
  MASTER_SUBSCRIPTIONS_KEY,
  MASTER_SUBSCRIPTION_SOURCES_KEY,
  MASTER_SUBSCRIPTION_STATE_KEY,
  parseMasterSubscriptions,
  parseMasterSubscriptionState,
  parseStoredSubscriptionSources,
  pruneSubscriptionData,
} from '../../_lib/subscriptionUpdate'

/**
 * 站长订阅清单同步（仅主账号）：
 * 站长客户端把本地订阅（链接+自动刷新间隔）同步一份到服务端，服务端据此在订阅
 * 到期时自行抓取更新，站长不必开着浏览器。普通用户没有站长订阅，调用直接拒绝。
 * - PUT { subscriptions }：整体覆盖清单；被移除的订阅在服务端存的源切片与状态一并清掉。
 */
export const onRequest = async (context: PagesContext) => {
  const result = await requireUser(context)
  if (result instanceof Response) return result
  const { db, user } = result

  if (user.userId !== MASTER_USER_ID) {
    return json({ error: '仅站长可同步订阅清单' }, 403)
  }

  if (context.request.method === 'PUT') {
    const body = await readJson<{ subscriptions?: unknown }>(context.request)
    if (!Array.isArray(body?.subscriptions)) {
      return json({ error: '订阅清单格式不正确' }, 400)
    }
    if (JSON.stringify(body.subscriptions).length > 65_536) {
      return json({ error: '订阅清单过大' }, 400)
    }
    const registry = parseMasterSubscriptions(body.subscriptions)
    await setSetting(db, MASTER_SUBSCRIPTIONS_KEY, JSON.stringify(registry))

    // 清单里已删除的订阅：其服务端源切片与刷新状态同步摘除，不留残留
    const settings = await getSettings(db, [
      MASTER_SUBSCRIPTION_SOURCES_KEY,
      MASTER_SUBSCRIPTION_STATE_KEY,
    ])
    const pruned = pruneSubscriptionData(
      registry,
      parseStoredSubscriptionSources(settings.get(MASTER_SUBSCRIPTION_SOURCES_KEY) ?? null),
      parseMasterSubscriptionState(settings.get(MASTER_SUBSCRIPTION_STATE_KEY) ?? null),
    )
    if (pruned.changed) {
      await setSetting(db, MASTER_SUBSCRIPTION_SOURCES_KEY, JSON.stringify(pruned.sources))
      await setSetting(db, MASTER_SUBSCRIPTION_STATE_KEY, JSON.stringify(pruned.state))
    }
    return json({ ok: true, count: registry.length })
  }

  return json({ error: 'Method Not Allowed' }, 405)
}
