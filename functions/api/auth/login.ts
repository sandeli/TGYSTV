import {
  clearLoginFailures,
  createSession,
  ensureSchema,
  getLoginLockSeconds,
  getRequestGeo,
  isSiteClosed,
  json,
  MASTER_USER_ID,
  notifyUserLoginTg,
  nowSeconds,
  readJson,
  recordLoginFailure,
  verifyCaptchaChallenge,
  verifyPassword,
  type PagesContext,
  type SessionUser,
} from '../../_lib/auth'

interface LoginBody {
  username?: unknown
  password?: unknown
  captchaId?: unknown
  captchaCode?: unknown
}

export const onRequest = async (context: PagesContext) => {
  if (context.request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
  const db = context.env.TGYS_DB
  if (!db) return json({ error: '账号系统未配置' }, 503)
  await ensureSchema(db)

  const body = await readJson<LoginBody>(context.request)
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password) return json({ error: '用户名或密码错误' }, 401)

  const ip = context.request.headers.get('CF-Connecting-IP') ?? ''
  const userAgent = context.request.headers.get('User-Agent') ?? ''
  const loginAt = nowSeconds()

  let sessionUser: SessionUser
  // 该用户是否被管理员标记了电报上线通知（仅普通账号有此标记）
  let tgWatch = false

  if (username.toLowerCase() === 'admin') {
    // 站长登录：用户名 admin + 环境变量 TGYS_ACCESS_PASSWORD
    const masterPassword = context.env.TGYS_ACCESS_PASSWORD ?? ''
    if (!masterPassword) return json({ error: '站长登录未启用' }, 403)
    // 站长登录在所有模式下都必须先过数字验证码（防爆破站长密码；
    // 本站自托管出题校验，不依赖 Cloudflare Turnstile 的第三方服务）
    if (!(await verifyCaptchaChallenge(db, body?.captchaId, body?.captchaCode))) {
      return json({ error: '验证码错误或已过期，请重新输入' }, 403)
    }
    // 失败锁定（按 IP 计数，不会误伤其他网络的站长本人）：
    // 同一 IP 15 分钟内站长登录失败满 5 次 → 该 IP 锁定 10 分钟
    const lockKey = `master-login:${ip || 'unknown'}`
    const lockSeconds = await getLoginLockSeconds(db, lockKey, loginAt)
    if (lockSeconds > 0) {
      return json(
        { error: `站长登录失败次数过多，请 ${Math.ceil(lockSeconds / 60)} 分钟后再试` },
        429,
      )
    }
    if (password !== masterPassword) {
      await recordLoginFailure(db, lockKey, loginAt)
      return json({ error: '用户名或密码错误' }, 401)
    }
    await clearLoginFailures(db, lockKey)
    sessionUser = { userId: MASTER_USER_ID, username: 'admin', role: 'admin', isMaster: true }
  } else {
    // 关站维护：普通账号一律拒绝登录（站长走上面的主账号分支，不受影响）
    if (await isSiteClosed(db)) {
      return json({ error: '站点维护中，仅管理员可登录' }, 403)
    }
    const row = await db
      .prepare(
        'SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, role, disabled, expires_at AS expiresAt, tg_watch AS tgWatch FROM users WHERE username = ?',
      )
      .bind(username)
      .first<{
        id: number
        username: string
        passwordHash: string
        passwordSalt: string
        role: string
        disabled: number
        expiresAt: number | null
        tgWatch: number | null
      }>()
    if (!row) return json({ error: '用户名或密码错误' }, 401)
    const ok = await verifyPassword(password, row.passwordSalt, row.passwordHash)
    if (!ok) return json({ error: '用户名或密码错误' }, 401)
    if (row.disabled === 1) return json({ error: '账号已被禁用' }, 403)
    if (row.expiresAt !== null && row.expiresAt < loginAt) {
      return json({ error: '账号已到期，请联系管理员' }, 403)
    }

    tgWatch = row.tgWatch === 1
    sessionUser = {
      userId: row.id,
      username: row.username,
      role: row.role === 'admin' ? 'admin' : 'user',
      isMaster: false,
    }
    await db
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(loginAt, row.id)
      .run()
  }

  const geo = getRequestGeo(context.request)
  await db
    .prepare(
      'INSERT INTO login_logs (user_id, username, ip, user_agent, country, region, city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(sessionUser.userId, sessionUser.username, ip, userAgent, geo.country, geo.region, geo.city, loginAt)
    .run()

  // 电报上线通知（仅被管理员标记的普通用户；后台发送，不阻塞登录响应）
  if (tgWatch) {
    const notifyPromise = notifyUserLoginTg(db, {
      username: sessionUser.username,
      ip,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      at: loginAt,
    }).catch(() => {})
    if (typeof context.waitUntil === 'function') context.waitUntil(notifyPromise)
  }

  const { token, expiresAt } = await createSession(db, sessionUser)
  return json({
    token,
    expiresAt,
    user: {
      id: sessionUser.userId,
      username: sessionUser.username,
      role: sessionUser.role,
      isMaster: sessionUser.isMaster,
    },
  })
}
