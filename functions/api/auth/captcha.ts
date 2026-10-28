import {
  createCaptchaChallenge,
  ensureSchema,
  json,
  type PagesContext,
} from '../../_lib/auth'

/**
 * 数字验证码出题接口（GET）：本站自托管，不依赖任何第三方验证服务。
 * 返回题目 id 与 SVG 图片（4 位数字，5 分钟有效、校验一次即作废）；
 * 登录/注册时把 id 与用户输入的数字一并回传，由服务端校验。
 */
export const onRequest = async (context: PagesContext) => {
  if (context.request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405)
  const db = context.env.TGYS_DB
  if (!db) return json({ error: '账号系统未配置' }, 503)
  await ensureSchema(db)
  const challenge = await createCaptchaChallenge(db)
  return json({ id: challenge.id, image: challenge.image })
}
