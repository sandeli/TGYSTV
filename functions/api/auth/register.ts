import {
  consumeInvite,
  createSession,
  defaultUserExpiresAt,
  ensureSchema,
  findUsableInvite,
  formatRegistrationOpenAt,
  getRegistrationCloseAt,
  getRegistrationMode,
  getRegistrationOpenAt,
  isRegistrationFull,
  registrationWindowState,
  getRequestGeo,
  hashPassword,
  isSiteClosed,
  json,
  type InviteCodeRow,
  nowSeconds,
  randomHex,
  readJson,
  validatePassword,
  validateUsername,
  verifyCaptchaChallenge,
  type PagesContext,
} from '../../_lib/auth'

interface RegisterBody {
  username?: unknown
  password?: unknown
  captchaId?: unknown
  captchaCode?: unknown
  inviteCode?: unknown
}

export const onRequest = async (context: PagesContext) => {
  if (context.request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
  const db = context.env.TGYS_DB
  if (!db) return json({ error: '账号系统未配置' }, 503)
  await ensureSchema(db)
  if (await isSiteClosed(db)) {
    return json({ error: '站点维护中，暂停注册' }, 403)
  }

  // 开放时段之外：注册通道关闭（邀请码也不可用），时段内才按注册模式执行
  const registrationOpenAt = await getRegistrationOpenAt(db)
  const registrationCloseAt = await getRegistrationCloseAt(db)
  const windowState = registrationWindowState(registrationOpenAt, registrationCloseAt, nowSeconds())
  if (windowState === 'before') {
    return json({ error: `注册将于 ${formatRegistrationOpenAt(registrationOpenAt)} 开放` }, 403)
  }
  if (windowState === 'after') {
    return json({ error: '本次注册开放时段已结束' }, 403)
  }

  const registrationMode = await getRegistrationMode(db, context.env)
  if (registrationMode === 'closed') {
    return json({ error: '注册已关闭' }, 403)
  }

  if (await isRegistrationFull(db)) {
    return json({ error: '注册名额已满' }, 403)
  }

  const body = await readJson<RegisterBody>(context.request)
  const username = validateUsername(body?.username)
  const password = validatePassword(body?.password)
  if (!username) return json({ error: '用户名需 3-24 位，仅限文字、数字、下划线、连字符' }, 400)
  if (!password) return json({ error: '密码需 6-64 位' }, 400)

  if (!(await verifyCaptchaChallenge(db, body?.captchaId, body?.captchaCode))) {
    return json({ error: '验证码错误或已过期，请重新输入' }, 400)
  }

  // 仅邀请模式：先验邀请码（无效/用完/过期一律拒绝），建号成功后再核销次数
  let invite: InviteCodeRow | null = null
  if (registrationMode === 'invite') {
    invite = await findUsableInvite(
      db,
      typeof body?.inviteCode === 'string' ? body.inviteCode : '',
    )
    if (!invite) return json({ error: '邀请码无效、已用完或已过期' }, 400)
  }

  const salt = randomHex(16)
  const passwordHash = await hashPassword(password, salt)
  const createdAt = nowSeconds()
  const ip = context.request.headers.get('CF-Connecting-IP') ?? ''
  const userAgent = context.request.headers.get('User-Agent') ?? ''

  let userId: number
  try {
    const result = (await db
      .prepare(
        'INSERT INTO users (username, password_hash, password_salt, role, disabled, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      // 新注册用户默认可用 365 天（管理员可在用户管理里改天数或设为无限制）
      .bind(username, passwordHash, salt, 'user', createdAt, defaultUserExpiresAt(createdAt))
      .run()) as { meta?: { last_row_id?: number } }
    userId = result.meta?.last_row_id ?? 0
  } catch {
    return json({ error: '用户名已被注册' }, 409)
  }

  if (invite) await consumeInvite(db, invite.id)

  // 注册即登录：同步记一条登录日志与最近登录时间，后台登录记录才完整
  await db
    .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(createdAt, userId)
    .run()
  const geo = getRequestGeo(context.request)
  await db
    .prepare(
      'INSERT INTO login_logs (user_id, username, ip, user_agent, country, region, city, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(userId, username, ip, userAgent, geo.country, geo.region, geo.city, createdAt)
    .run()

  const { token, expiresAt } = await createSession(db, {
    userId,
    username,
    role: 'user',
    isMaster: false,
  })
  return json({ token, expiresAt, user: { id: userId, username, role: 'user' } })
}
