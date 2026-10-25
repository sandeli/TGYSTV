import {
  getUserSources,
  json,
  MASTER_USER_ID,
  readJson,
  requireUser,
  saveUserSources,
  type PagesContext,
} from '../../_lib/auth'
import { readMasterSubscriptionData } from '../../_lib/subscriptionUpdate'

/**
 * 账号源（随账户走，不随浏览器）：每个登录用户一份，按 user_id 隔离。
 * - GET：读取当前用户在设置页手动维护的源列表
 * - PUT { sources }：整体保存
 * 只有站长（主账号）的源可以带「全站生效」标记，保存时由服务端派生进全站
 * 分发列表；普通用户传来的全站标记会被剥掉，源只对自己账户生效。
 */
export const onRequest = async (context: PagesContext) => {
  const result = await requireUser(context)
  if (result instanceof Response) return result
  const { db, user } = result

  if (context.request.method === 'GET') {
    const sources = await getUserSources(db, user.userId)
    // 站长额外带回服务端自动更新的最新订阅源与刷新状态（普通用户没有站长订阅）
    if (user.userId === MASTER_USER_ID) {
      const subscription = await readMasterSubscriptionData(db)
      return json({
        sources,
        subscriptionSources: subscription.sources,
        subscriptionMeta: subscription.meta,
      })
    }
    return json({ sources })
  }

  if (context.request.method === 'PUT') {
    const body = await readJson<{ sources?: unknown }>(context.request)
    if (!Array.isArray(body?.sources)) {
      return json({ error: '源列表格式不正确' }, 400)
    }
    if (JSON.stringify(body.sources).length > 262_144) {
      return json({ error: '源列表过大' }, 400)
    }
    const saved = await saveUserSources(db, user.userId, body.sources)
    return json({ ok: true, sources: saved })
  }

  return json({ error: 'Method Not Allowed' }, 405)
}
