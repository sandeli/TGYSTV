/**
 * TGYS 账号系统共享库（Cloudflare Pages Functions 专用）。
 * 数据存 D1（绑定名 TGYS_DB），首次调用时自动建表。
 * 密码 PBKDF2-SHA256 加盐哈希；会话令牌只存 SHA-256 摘要。
 * 站长：用户名 admin + 环境变量 TGYS_ACCESS_PASSWORD，不占 users 表（user_id = 0）。
 */

export interface D1PreparedStatement {
  bind: (...values: unknown[]) => D1PreparedStatement
  run: () => Promise<unknown>
  first: <T = Record<string, unknown>>() => Promise<T | null>
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>
}

export interface D1Database {
  prepare: (query: string) => D1PreparedStatement
  batch: (statements: D1PreparedStatement[]) => Promise<unknown>
}

export interface AuthEnv {
  TGYS_DB?: D1Database
  TGYS_ACCESS_PASSWORD?: string
  TGYS_REGISTRATION_OPEN?: string
  TGYS_TURNSTILE_SECRET?: string
  TGYS_TURNSTILE_SITE_KEY?: string
  TGYS_INITIAL_VIDEO_SOURCES?: string
}

export interface PagesContext {
  request: Request
  env: AuthEnv
  params: Record<string, string | string[]>
  /** Pages 运行时提供：让响应返回后继续执行的后台任务（如电报通知） */
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface SessionUser {
  userId: number
  username: string
  role: 'admin' | 'user'
  isMaster: boolean
}

export const MASTER_USER_ID = 0
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Cloudflare 边缘在请求上附带的地理信息（国家代码/省份/城市），本地/非 CF 环境为空 */
export function getRequestGeo(request: Request): { country: string; region: string; city: string } {
  const cf = (request as Request & { cf?: { country?: string; region?: string; city?: string } }).cf
  return { country: cf?.country ?? '', region: cf?.region ?? '', city: cf?.city ?? '' }
}

// ---------- 建表（幂等，进程内只跑一次） ----------

let schemaPromise: Promise<void> | null = null

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            disabled INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_login_at INTEGER
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS login_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            created_at INTEGER NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs (user_id, created_at DESC)`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS watch_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            source_code TEXT NOT NULL DEFAULT '',
            source_name TEXT NOT NULL DEFAULT '',
            vod_id TEXT NOT NULL DEFAULT '',
            episode_index INTEGER NOT NULL DEFAULT 0,
            episode_name TEXT NOT NULL DEFAULT '',
            progress REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (user_id, source_code, vod_id, episode_index)
          )`,
        ),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_records (user_id, updated_at DESC)`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS tvbox_tokens (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS user_sources (
            user_id INTEGER PRIMARY KEY,
            sources TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL DEFAULT 0
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS invite_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            note TEXT NOT NULL DEFAULT '',
            max_uses INTEGER NOT NULL DEFAULT 1,
            used_count INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER,
            created_at INTEGER NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS login_attempts (
            key TEXT PRIMARY KEY,
            fail_count INTEGER NOT NULL DEFAULT 0,
            window_start INTEGER NOT NULL DEFAULT 0,
            locked_until INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
          )`,
        ),
      ])
      // 老表补列（列已存在时 ALTER 会报错，忽略即可）
      const columnAdditions: Array<[string, string, string]> = [
        ['login_logs', 'country', 'TEXT'],
        ['login_logs', 'region', 'TEXT'],
        ['login_logs', 'city', 'TEXT'],
        // 用户到期时间（unix 秒，NULL = 无限制），由管理员在后台设置
        ['users', 'expires_at', 'INTEGER'],
        // 电报上线通知开关（1 = 该用户登录时给管理员发 TG 通知）
        ['users', 'tg_watch', 'INTEGER NOT NULL DEFAULT 0'],
        // 账号源已删名单（JSON 数组）：防旧设备带着已删源的旧列表整体回存时把源复活
        ['user_sources', 'deleted_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ]
      for (const [table, column, type] of columnAdditions) {
        try {
          await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run()
        } catch {
          // 列已存在
        }
      }
    })().catch(error => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

// ---------- 加密工具 ----------

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(digest)
}

const PBKDF2_ITERATIONS = 100000

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromHex(saltHex) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    256,
  )
  return toHex(bits)
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHashHex: string,
): Promise<boolean> {
  const actual = await hashPassword(password, saltHex)
  return timingSafeEqualHex(actual, expectedHashHex)
}

export type ChangePasswordResult = 'ok' | 'wrong-current' | 'not-found'

/**
 * 修改密码：校验现密码 → 换新盐新哈希 → 吊销该用户的其他会话（保留 currentTokenHash 对应的当前会话）。
 * 站长（user_id=0）不在 users 表内，调用方需提前拦下（其密码在环境变量中）。
 */
export async function changeUserPassword(
  db: D1Database,
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentTokenHash: string,
): Promise<ChangePasswordResult> {
  const row = await db
    .prepare('SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE id = ?')
    .bind(userId)
    .first<{ passwordHash: string; passwordSalt: string }>()
  if (!row) return 'not-found'
  if (!(await verifyPassword(currentPassword, row.passwordSalt, row.passwordHash))) {
    return 'wrong-current'
  }
  const salt = randomHex(16)
  const passwordHash = await hashPassword(newPassword, salt)
  await db
    .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .bind(passwordHash, salt, userId)
    .run()
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .bind(userId, currentTokenHash)
    .run()
  return 'ok'
}

// ---------- 输入校验 ----------

export function validateUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const username = raw.trim()
  if (username.length < 3 || username.length > 24) return null
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) return null
  if (username.toLowerCase() === 'admin') return null
  return username
}

export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length < 6 || raw.length > 64) return null
  return raw
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

export function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, maxLength)
}

export function clampNumber(value: unknown, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

// ---------- 会话 ----------

export async function createSession(
  db: D1Database,
  user: SessionUser,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32)
  const tokenHash = await sha256Hex(token)
  const createdAt = nowSeconds()
  const expiresAt = createdAt + SESSION_TTL_SECONDS
  await db
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(tokenHash, user.userId, user.username, user.role, createdAt, expiresAt)
    .run()
  return { token, expiresAt }
}

export async function getSessionUser(
  db: D1Database,
  request: Request,
): Promise<SessionUser | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const tokenHash = await sha256Hex(match[1].trim())
  const row = await db
    .prepare(
      `SELECT s.user_id AS userId, s.username AS username, s.role AS role, s.expires_at AS expiresAt,
              u.disabled AS disabled, u.id AS realUserId, u.expires_at AS userExpiresAt
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{
      userId: number
      username: string
      role: string
      expiresAt: number
      disabled: number | null
      realUserId: number | null
      userExpiresAt: number | null
    }>()
  if (!row) return null
  if (row.expiresAt < nowSeconds()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  const isMaster = row.userId === MASTER_USER_ID
  if (!isMaster) {
    // 账号被删、被禁用或已到期 时会话立即失效
    if (row.realUserId === null || row.disabled === 1) return null
    if (row.userExpiresAt !== null && row.userExpiresAt < nowSeconds()) return null
  }
  return {
    userId: row.userId,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    isMaster,
  }
}

export async function deleteSession(db: D1Database, request: Request): Promise<void> {
  const auth = request.headers.get('Authorization') ?? ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return
  const tokenHash = await sha256Hex(match[1].trim())
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
}

/** 站点是否处于关站维护状态（管理员后台开关，settings 键 site_closed） */
export async function isSiteClosed(db: D1Database): Promise<boolean> {
  return (await getSetting(db, 'site_closed')) === '1'
}

/** 无会员模式（免登录开放）是否开启 */
export async function isOpenAccess(db: D1Database): Promise<boolean> {
  return (await getSetting(db, 'open_access')) === '1'
}

// ---------- 登录失败锁定（防暴力破解） ----------
// 按 key 计数（当前用于站长登录，key = master-login:<IP>，按 IP 锁不会误伤其他网络的站长本人）：
// 15 分钟窗口内失败满 5 次 → 锁定 10 分钟；窗口过期自动重新计数；登录成功清零。
export const LOGIN_LOCK_THRESHOLD = 5
export const LOGIN_LOCK_WINDOW_SECONDS = 15 * 60
export const LOGIN_LOCK_DURATION_SECONDS = 10 * 60

interface LoginAttemptRow {
  failCount: number
  windowStart: number
  lockedUntil: number
}

async function readLoginAttempt(db: D1Database, key: string): Promise<LoginAttemptRow | null> {
  return db
    .prepare(
      'SELECT fail_count AS failCount, window_start AS windowStart, locked_until AS lockedUntil FROM login_attempts WHERE key = ?',
    )
    .bind(key)
    .first<LoginAttemptRow>()
}

/** 剩余锁定秒数（0 = 未锁定） */
export async function getLoginLockSeconds(
  db: D1Database,
  key: string,
  now: number = nowSeconds(),
): Promise<number> {
  const row = await readLoginAttempt(db, key)
  if (!row) return 0
  return row.lockedUntil > now ? row.lockedUntil - now : 0
}

/** 记录一次登录失败；达到阈值即进入锁定。返回本次记录后是否处于锁定 */
export async function recordLoginFailure(
  db: D1Database,
  key: string,
  now: number = nowSeconds(),
): Promise<boolean> {
  const row = await readLoginAttempt(db, key)
  const inWindow = row !== null && now - row.windowStart < LOGIN_LOCK_WINDOW_SECONDS
  const failCount = inWindow ? row.failCount + 1 : 1
  const windowStart = inWindow ? row.windowStart : now
  const lockedUntil = failCount >= LOGIN_LOCK_THRESHOLD ? now + LOGIN_LOCK_DURATION_SECONDS : 0
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fail_count, window_start, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = excluded.fail_count,
         window_start = excluded.window_start,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(key, failCount, windowStart, lockedUntil, now)
    .run()
  return lockedUntil > 0
}

/** 登录成功后清除该 key 的失败记录 */
export async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run()
}

export async function requireUser(
  context: PagesContext,
): Promise<{ db: D1Database; user: SessionUser } | Response> {
  const db = context.env.TGYS_DB
  if (!db) return json({ error: '账号系统未配置' }, 503)
  await ensureSchema(db)
  const user = await getSessionUser(db, context.request)
  if (!user) return json({ error: '未登录或登录已过期' }, 401)
  // 关站维护期间仅站长（主账号）可继续使用，其余会话一律拒绝，
  // 客户端复查会话失败后会退出登录并展示维护页
  if (user.userId !== MASTER_USER_ID && (await isSiteClosed(db))) {
    return json({ error: '站点维护中，仅管理员可登录' }, 403)
  }
  return { db, user }
}

export async function requireAdmin(
  context: PagesContext,
): Promise<{ db: D1Database; user: SessionUser } | Response> {
  const result = await requireUser(context)
  if (result instanceof Response) return result
  if (result.user.role !== 'admin') return json({ error: '无管理员权限' }, 403)
  return result
}

// ---------- 站点设置（注册开关） ----------

export const DOUBAN_DATA_PROXY_TYPES = [
  'direct',
  'cors-proxy-zwei',
  'cmliussss-cdn-tencent',
  'cmliussss-cdn-ali',
  'custom',
] as const

export const DOUBAN_IMAGE_PROXY_TYPES = [
  'server',
  'direct',
  'img3',
  'cmliussss-cdn-tencent',
  'cmliussss-cdn-ali',
  'custom',
] as const

export interface DoubanProxySettings {
  dataType: string
  dataUrl: string
  imageType: string
  imageUrl: string
}

export const DEFAULT_DOUBAN_PROXY: DoubanProxySettings = {
  dataType: 'direct',
  dataUrl: '',
  imageType: 'server',
  imageUrl: '',
}

/** 豆瓣代理涉及的 settings 键 */
export const DOUBAN_PROXY_SETTING_KEYS = [
  'douban_data_proxy_type',
  'douban_data_proxy_url',
  'douban_image_proxy_type',
  'douban_image_proxy_url',
] as const

/** 从设置取值器组装豆瓣代理设置（纯函数）；非法值回退默认 */
export function parseDoubanProxySettings(
  get: (key: string) => string | null,
): DoubanProxySettings {
  const dataType = get('douban_data_proxy_type')
  const dataUrl = get('douban_data_proxy_url')
  const imageType = get('douban_image_proxy_type')
  const imageUrl = get('douban_image_proxy_url')
  return {
    dataType: (DOUBAN_DATA_PROXY_TYPES as readonly string[]).includes(dataType ?? '')
      ? (dataType as string)
      : DEFAULT_DOUBAN_PROXY.dataType,
    dataUrl: dataUrl ?? '',
    imageType: (DOUBAN_IMAGE_PROXY_TYPES as readonly string[]).includes(imageType ?? '')
      ? (imageType as string)
      : DEFAULT_DOUBAN_PROXY.imageType,
    imageUrl: imageUrl ?? '',
  }
}

/** 读取豆瓣代理设置（管理员后台配置，存 settings 表）；非法值回退默认 */
export async function readDoubanProxySettings(db: D1Database): Promise<DoubanProxySettings> {
  const settings = await getSettings(db, [...DOUBAN_PROXY_SETTING_KEYS])
  return parseDoubanProxySettings(key => settings.get(key) ?? null)
}

/**
 * 管理员对托管源（环境变量/管理员后台设置的初始源）的显式开关表
 * （settings 键 managed_source_enabled，JSON 对象 id→布尔）。
 * 表中有的源：全站所有用户按表中的开关使用；表里没有的源：按源文件自身的默认开关。
 * 用户自己添加的源不在此列，仍归各人本地控制。
 */
/** 解析托管源开关表 JSON（纯函数） */
export function parseManagedSourceEnabled(raw: string | null): Record<string, boolean> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean' && key) result[key] = value
      if (Object.keys(result).length >= 500) break
    }
    return result
  } catch {
    return {}
  }
}

export async function readManagedSourceEnabled(db: D1Database): Promise<Record<string, boolean>> {
  return parseManagedSourceEnabled(await getSetting(db, 'managed_source_enabled'))
}

/** 校验并规整待保存的开关表：只留布尔值条目、键限长、限条数 */
export function sanitizeManagedSourceEnabled(value: unknown): Record<string, boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: Record<string, boolean> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val !== 'boolean') continue
    const id = key.trim().slice(0, 128)
    if (id) result[id] = val
    if (Object.keys(result).length >= 500) break
  }
  return result
}

// ---------- 站长账号源（随账户走，不随浏览器） ----------

/** 站长在设置页手动维护的源条目（存 user_sources 表，随账号在任意设备登录可见） */
export interface AccountSourceEntry {
  id: string
  name: string
  url: string
  detailUrl?: string
  timeout?: number
  retry?: number
  isEnabled: boolean
  /** 全站生效：开启后该源派生进全站分发列表，所有用户都能用 */
  siteWide: boolean
}

export const ACCOUNT_SOURCES_LIMIT = 200

/**
 * 清洗站长账号源列表（不可信输入）：仅保留结构合法的条目。
 * id 原样保留（uuid/自定义 id 都行），但订阅源 id（sub: 前缀）与重复 id 会被改派为 acct_N；
 * 名称/地址必填且地址必须是 http(s)；名称+地址与已保留条目完全相同的视为重复源、直接丢弃
 * （同一个源在不同设备上添加会生成不同 id，只按 id 去重会存下两条重复源）。
 */
export function parseAccountSources(input: unknown): AccountSourceEntry[] {
  if (!Array.isArray(input)) return []
  const out: AccountSourceEntry[] = []
  const seen = new Set<string>()
  const seenPairs = new Set<string>()
  for (const raw of input) {
    if (out.length >= ACCOUNT_SOURCES_LIMIT) break
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 100) : ''
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    if (!name || !/^https?:\/\//i.test(url)) continue
    const pair = `${name}\n${url}`
    if (seenPairs.has(pair)) continue
    seenPairs.add(pair)
    let id = typeof e.id === 'string' ? e.id.trim().slice(0, 128) : ''
    if (!id || id.startsWith('sub:') || seen.has(id)) {
      let n = out.length + 1
      id = `acct_${n}`
      while (seen.has(id)) id = `acct_${++n}`
    }
    seen.add(id)
    const detailUrl =
      typeof e.detailUrl === 'string' && /^https?:\/\//i.test(e.detailUrl.trim())
        ? e.detailUrl.trim()
        : undefined
    const timeout =
      typeof e.timeout === 'number' && Number.isFinite(e.timeout)
        ? Math.min(60_000, Math.max(300, Math.round(e.timeout)))
        : undefined
    const retry =
      typeof e.retry === 'number' && Number.isFinite(e.retry)
        ? Math.min(10, Math.max(0, Math.round(e.retry)))
        : undefined
    out.push({
      id,
      name,
      url,
      ...(detailUrl ? { detailUrl } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(retry !== undefined ? { retry } : {}),
      isEnabled: e.isEnabled !== false,
      siteWide: e.siteWide === true,
    })
  }
  return out
}

/** 从账号源中挑出开启「全站生效」的子集（派生为全站分发列表的内容） */
export function extractSiteWideSources(
  list: AccountSourceEntry[],
): AccountSourceEntry[] {
  return list.filter(s => s.siteWide)
}

// ---------- 账号源「已删名单」（防已删源被旧设备传回复活） ----------

export const DELETED_SOURCE_IDS_LIMIT = 500

/**
 * 清洗已删源 id 列表（不可信输入）：只保留非空字符串、去重并限量。
 * 订阅源 id（sub: 前缀）不属于账号源、永不入名单。
 */
export function parseDeletedSourceIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (out.length >= DELETED_SOURCE_IDS_LIMIT) break
    if (typeof raw !== 'string') continue
    const id = raw.trim().slice(0, 128)
    if (!id || id.startsWith('sub:') || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 合并已删名单：旧名单 ∪ 本次上报的删除 − 本次明确重新添加的 id。
 * 名单对后到的整体保存有否决权：旧设备带着已删源的旧名单整体回存时，
 * 只要该源没被列入「本次重新添加」，就会被名单拦下、不会复活。
 */
export function resolveDeletedSourceIds(
  prev: string[],
  reported: unknown,
  revived: unknown,
): string[] {
  const revivedSet = new Set(parseDeletedSourceIds(revived))
  const merged = [...prev, ...parseDeletedSourceIds(reported)].filter(id => !revivedSet.has(id))
  return [...new Set(merged)].slice(0, DELETED_SOURCE_IDS_LIMIT)
}

/** 读取账号源 + 已删名单；名单兜底过滤：历史数据里残留的已删条目读出时一并滤掉 */
async function readUserSources(
  db: D1Database,
  userId: number,
): Promise<{ sources: AccountSourceEntry[]; deletedIds: string[] }> {
  let row: { sources: string; deleted_ids?: string | null } | null = null
  try {
    row = await db
      .prepare('SELECT sources, deleted_ids FROM user_sources WHERE user_id = ?')
      .bind(userId)
      .first<{ sources: string; deleted_ids?: string | null }>()
  } catch {
    // deleted_ids 列尚未补上（极旧数据库）：退回只读源列表
    row = await db
      .prepare('SELECT sources FROM user_sources WHERE user_id = ?')
      .bind(userId)
      .first<{ sources: string }>()
  }
  if (!row?.sources) return { sources: [], deletedIds: [] }
  let deletedIds: string[] = []
  try {
    deletedIds = parseDeletedSourceIds(JSON.parse(row.deleted_ids ?? '[]'))
  } catch {
    deletedIds = []
  }
  let sources: AccountSourceEntry[] = []
  try {
    sources = parseAccountSources(JSON.parse(row.sources))
  } catch {
    sources = []
  }
  if (deletedIds.length > 0) {
    const dead = new Set(deletedIds)
    sources = sources.filter(s => !dead.has(s.id))
  }
  return { sources, deletedIds }
}

export async function getUserSources(
  db: D1Database,
  userId: number,
): Promise<AccountSourceEntry[]> {
  return (await readUserSources(db, userId)).sources
}

/** 与 getUserSources 相同，但同时带回已删名单（账号源接口下发给客户端同步引擎用） */
export async function getUserSourcesMeta(
  db: D1Database,
  userId: number,
): Promise<{ sources: AccountSourceEntry[]; deletedIds: string[] }> {
  return readUserSources(db, userId)
}

/** 账号源按用户归一：只有站长的源可以带「全站生效」标记，普通用户的标记一律剥掉（防越权分发） */
export function normalizeAccountSourcesForUser(
  list: AccountSourceEntry[],
  userId: number,
): AccountSourceEntry[] {
  if (userId === MASTER_USER_ID) return list
  return list.map(s => (s.siteWide ? { ...s, siteWide: false } : s))
}

/**
 * 保存账号源（清洗后整体覆盖）。站长保存时同步派生全站分发列表
 * （settings 键 admin_sitewide_sources，公开配置与 TVBox 接口都读它）。
 * opts.deletedIds 是客户端本次上报的删除，opts.revivedIds 是本次明确重新添加的源：
 * 合并后的已删名单会否决名单内的源进入保存结果，旧设备的过期名单无法把已删源带回复活；
 * 只有被明确重新添加（revivedIds）的源才能离开名单、重新保存。
 */
export async function saveUserSources(
  db: D1Database,
  userId: number,
  sources: unknown,
  opts: { deletedIds?: unknown; revivedIds?: unknown } = {},
): Promise<{ sources: AccountSourceEntry[]; deletedIds: string[] }> {
  const prev = await readUserSources(db, userId)
  const deletedIds = resolveDeletedSourceIds(prev.deletedIds, opts.deletedIds, opts.revivedIds)
  const dead = new Set(deletedIds)
  const cleaned = normalizeAccountSourcesForUser(parseAccountSources(sources), userId).filter(
    s => !dead.has(s.id),
  )
  await db
    .prepare(
      'INSERT INTO user_sources (user_id, sources, deleted_ids, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET sources = excluded.sources, deleted_ids = excluded.deleted_ids, updated_at = excluded.updated_at',
    )
    .bind(userId, JSON.stringify(cleaned), JSON.stringify(deletedIds), Math.floor(Date.now() / 1000))
    .run()
  if (userId === MASTER_USER_ID) {
    await setSetting(db, 'admin_sitewide_sources', JSON.stringify(extractSiteWideSources(cleaned)))
  }
  return { sources: cleaned, deletedIds }
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

/**
 * 一次批量读取多个设置项（一条 IN 查询代替逐项往返）。
 * 首屏配置接口是关键路径，D1 往返次数直接决定打开速度，批量读收益最大。
 * 返回 Map 只含存在的键；取值用 `map.get(key) ?? null` 与 getSetting 同语义。
 */
export async function getSettings(
  db: D1Database,
  keys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (keys.length === 0) return out
  const placeholders = keys.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()
  for (const row of results ?? []) {
    if (row && typeof row.key === 'string') out.set(row.key, row.value)
  }
  return out
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value)
    .run()
}

/** 注册是否开放：后台设置优先，其次环境变量 TGYS_REGISTRATION_OPEN，默认开放 */
export async function isRegistrationOpen(db: D1Database, env: AuthEnv): Promise<boolean> {
  const stored = await getSetting(db, 'registration_open')
  return parseRegistrationOpen(key => (key === 'registration_open' ? stored : null), env)
}

// ---------- 新注册用户默认有效期 ----------

/** 自助注册新用户的默认可用天数（从注册时刻起算）；管理员手动添加的用户不适用（默认无限制） */
export const DEFAULT_USER_VALID_DAYS = 365

/** 新注册用户的到期时间（unix 秒，纯函数，可测） */
export function defaultUserExpiresAt(createdAtSec: number): number {
  return createdAtSec + DEFAULT_USER_VALID_DAYS * 86400
}

// ---------- 注册模式（开放 / 仅邀请 / 关闭） ----------

export type RegistrationMode = 'open' | 'invite' | 'closed'

/** 注册开放推导（纯函数）：后台 registration_open 优先，其次环境变量，默认开放 */
export function parseRegistrationOpen(
  get: (key: string) => string | null,
  env: AuthEnv,
): boolean {
  const stored = get('registration_open')
  if (stored === '1') return true
  if (stored === '0') return false
  const envValue = (env.TGYS_REGISTRATION_OPEN ?? '').trim().toLowerCase()
  return envValue !== '0' && envValue !== 'false'
}

/** 注册模式推导（纯函数）：后台 registration_mode 优先；未设置时由旧的 registration_open 推导 */
export function parseRegistrationMode(
  get: (key: string) => string | null,
  env: AuthEnv,
): RegistrationMode {
  const stored = get('registration_mode')
  if (stored === 'open' || stored === 'invite' || stored === 'closed') return stored
  return parseRegistrationOpen(get, env) ? 'open' : 'closed'
}

/** 注册模式：后台 registration_mode 优先；未设置时由旧的 registration_open 推导 */
export async function getRegistrationMode(
  db: D1Database,
  env: AuthEnv,
): Promise<RegistrationMode> {
  const settings = await getSettings(db, ['registration_mode', 'registration_open'])
  return parseRegistrationMode(key => settings.get(key) ?? null, env)
}

// ---------- 注册定时开放 ----------

/** 解析注册时段时刻（纯函数）：合法正整数原样读出，其余为 0（未设置） */
export function parseRegistrationTimestamp(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 注册定时开放时刻（unix 秒）：后台 registration_open_at；0 = 未设置。未到该时刻前注册通道关闭（邀请码亦不可用），到点后按注册模式执行 */
export async function getRegistrationOpenAt(db: D1Database): Promise<number> {
  return parseRegistrationTimestamp(await getSetting(db, 'registration_open_at'))
}

/** 注册开放时段的结束时刻（unix 秒）：后台 registration_close_at；0 = 不设结束（到点开放后长期有效） */
export async function getRegistrationCloseAt(db: D1Database): Promise<number> {
  return parseRegistrationTimestamp(await getSetting(db, 'registration_close_at'))
}

export type RegistrationWindowState = 'before' | 'in' | 'after'

/**
 * 当前时刻在注册开放时段中的位置（纯函数，可测）：
 * 未到开始 → before；已过结束 → after；其余（时段内，或两个边界都没设）→ in。
 * 时段只是一层时间闸门，最终能否注册还看注册模式本身。
 */
export function registrationWindowState(
  openAt: number,
  closeAt: number,
  now: number,
): RegistrationWindowState {
  if (openAt > 0 && now < openAt) return 'before'
  if (closeAt > 0 && now >= closeAt) return 'after'
  return 'in'
}

// ---------- 注册人数上限 ----------

/** 解析注册人数上限（纯函数）：合法正整数原样读出，其余为 0（不限） */
export function parseRegistrationMaxUsers(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 注册人数上限：后台 registration_max_users；0 = 不限 */
export async function getRegistrationMaxUsers(db: D1Database): Promise<number> {
  return parseRegistrationMaxUsers(await getSetting(db, 'registration_max_users'))
}

/** 当前注册用户数（users 表行数；站长不在表内、不计） */
export async function countRegisteredUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM users')
    .first<{ total: number }>()
  return row?.total ?? 0
}

/** 是否已满员（纯函数，可测）：上限为 0（不限）恒不满员 */
export function registrationFull(maxUsers: number, currentCount: number): boolean {
  return maxUsers > 0 && currentCount >= maxUsers
}

/** 自助注册是否因人数上限被拦（只拦注册接口，站长后台建号不受此限） */
export async function isRegistrationFull(db: D1Database): Promise<boolean> {
  const maxUsers = await getRegistrationMaxUsers(db)
  if (maxUsers <= 0) return false
  return registrationFull(maxUsers, await countRegisteredUsers(db))
}

/** 开放时刻的中文展示（北京时间，精确到分钟），用于注册拦截提示与登录页通知 */
export function formatRegistrationOpenAt(openAtSec: number): string {
  return new Date(openAtSec * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// ---------- 邀请码 ----------

export interface InviteCodeRow {
  id: number
  code: string
  note: string
  maxUses: number
  usedCount: number
  expiresAt: number | null
  createdAt: number
}

// 易读字母表：去掉 0/O/1/I/L 等易混字符
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** 生成 6 位邀请码（纯函数，可测）；校验按完整字符串匹配，已生成的老码不受长度影响 */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('')
}

/** 邀请码状态（纯函数，可测）：可用 / 已用完 / 已过期 */
export function inviteCodeStatus(
  row: { maxUses: number; usedCount: number; expiresAt: number | null },
  nowSec: number,
): 'usable' | 'exhausted' | 'expired' {
  if (row.expiresAt !== null && row.expiresAt < nowSec) return 'expired'
  if (row.usedCount >= row.maxUses) return 'exhausted'
  return 'usable'
}

/** 按码查可用邀请（大小写不敏感、忽略首尾空白）；不可用返回 null */
export async function findUsableInvite(
  db: D1Database,
  rawCode: string,
): Promise<InviteCodeRow | null> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return null
  const row = await db
    .prepare(
      'SELECT id, code, note, max_uses AS maxUses, used_count AS usedCount, expires_at AS expiresAt, created_at AS createdAt FROM invite_codes WHERE code = ?',
    )
    .bind(code)
    .first<InviteCodeRow>()
  if (!row) return null
  return inviteCodeStatus(row, nowSeconds()) === 'usable' ? row : null
}

/** 核销一次邀请码使用次数 */
export async function consumeInvite(db: D1Database, inviteId: number): Promise<void> {
  await db
    .prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?')
    .bind(inviteId)
    .run()
}

// ---------- 电报上线通知 ----------

export interface TgNotifyConfig {
  botToken: string
  chatId: string
}

/** 电报通知配置（管理员后台设置，存 settings 表） */
export const TMDB_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP'] as const
export const TMDB_IMAGE_QUALITIES = ['low', 'medium', 'high'] as const

/** 站点级「系统行为」设置（管理员后台维护，下发给全站客户端；仅包含已保存过的字段，未保存的为 undefined，客户端据此回退本地/环境默认值） */
export interface SiteBehaviorSettings {
  updateLogEnabled?: boolean
  scrollChromeAnimationEnabled?: boolean
  tmdbApiToken?: string
  tmdbEnabled?: boolean
  tmdbApiBaseUrl?: string
  tmdbImageBaseUrl?: string
  tmdbLanguage?: string
  tmdbImageQuality?: string
  /** 站点默认弹幕接口地址（弹弹play 兼容接口）；优先级低于用户个人设置、高于部署变量 */
  danmakuApiUrl?: string
  /** 关站维护：开启后仅站长可登录，普通用户会话一律拒绝 */
  siteClosed?: boolean
  /** 关站说明（展示在维护页）；未填时客户端用默认文案 */
  siteClosedMessage?: string
  /** 无会员模式（免登录开放）：开启后访客打开网站直接观看、无需登录；除站长外所有人进不了设置中心。关站维护开启时以关站为准 */
  openAccess?: boolean
  /** 车机自动免登录：开启后车机浏览器（如特斯拉，UA 带 Tesla/ 标记）自动按访客模式进入，与无会员模式同通道；普通浏览器仍走会员制。关站维护开启时以关站为准 */
  carOpenAccess?: boolean
}

/** readSiteBehavior 涉及的 settings 键（供批量读取与公开配置接口复用） */
export const SITE_BEHAVIOR_SETTING_KEYS = [
  'site_update_log_enabled',
  'site_scroll_chrome_animation',
  'tmdb_api_token',
  'tmdb_enabled',
  'tmdb_api_base_url',
  'tmdb_image_base_url',
  'tmdb_language',
  'tmdb_image_quality',
  'site_danmaku_api_url',
  'site_closed',
  'site_closed_message',
  'open_access',
  'car_open_access',
] as const

/** 从设置取值器组装站点行为配置（纯函数，可测）；get 返回 null 表示该项未设置 */
export function parseSiteBehavior(
  get: (key: string) => string | null,
): SiteBehaviorSettings {
  const out: SiteBehaviorSettings = {}
  const updateLog = get('site_update_log_enabled')
  const scrollAnim = get('site_scroll_chrome_animation')
  const tmdbToken = get('tmdb_api_token')
  const tmdbEnabled = get('tmdb_enabled')
  const tmdbApiBase = get('tmdb_api_base_url')
  const tmdbImageBase = get('tmdb_image_base_url')
  const tmdbLang = get('tmdb_language')
  const tmdbQuality = get('tmdb_image_quality')
  const danmakuUrl = get('site_danmaku_api_url')
  const closedFlag = get('site_closed')
  const closedMessage = get('site_closed_message')
  const openAccessFlag = get('open_access')
  const carOpenAccessFlag = get('car_open_access')
  if (updateLog !== null) out.updateLogEnabled = updateLog === '1'
  if (scrollAnim !== null) out.scrollChromeAnimationEnabled = scrollAnim === '1'
  if (tmdbToken !== null) out.tmdbApiToken = tmdbToken
  if (tmdbEnabled !== null) out.tmdbEnabled = tmdbEnabled === '1'
  if (tmdbApiBase !== null) out.tmdbApiBaseUrl = tmdbApiBase
  if (tmdbImageBase !== null) out.tmdbImageBaseUrl = tmdbImageBase
  if (tmdbLang !== null && (TMDB_LANGUAGES as readonly string[]).includes(tmdbLang)) {
    out.tmdbLanguage = tmdbLang
  }
  if (tmdbQuality !== null && (TMDB_IMAGE_QUALITIES as readonly string[]).includes(tmdbQuality)) {
    out.tmdbImageQuality = tmdbQuality
  }
  if (danmakuUrl !== null) out.danmakuApiUrl = danmakuUrl
  if (closedFlag !== null) out.siteClosed = closedFlag === '1'
  if (closedMessage !== null) out.siteClosedMessage = closedMessage
  if (openAccessFlag !== null) out.openAccess = openAccessFlag === '1'
  if (carOpenAccessFlag !== null) out.carOpenAccess = carOpenAccessFlag === '1'
  return out
}

export async function readSiteBehavior(db: D1Database): Promise<SiteBehaviorSettings> {
  const settings = await getSettings(db, [...SITE_BEHAVIOR_SETTING_KEYS])
  return parseSiteBehavior(key => settings.get(key) ?? null)
}

export async function readTgNotifyConfig(db: D1Database): Promise<TgNotifyConfig> {
  const [botToken, chatId] = await Promise.all([
    getSetting(db, 'tg_notify_bot_token'),
    getSetting(db, 'tg_notify_chat_id'),
  ])
  return { botToken: botToken ?? '', chatId: chatId ?? '' }
}

const TG_COUNTRY_NAMES: Record<string, string> = {
  CN: '中国',
  HK: '中国香港',
  TW: '中国台湾',
  MO: '中国澳门',
  US: '美国',
  JP: '日本',
  KR: '韩国',
  SG: '新加坡',
  GB: '英国',
  DE: '德国',
  FR: '法国',
  CA: '加拿大',
  AU: '澳大利亚',
}

/** 发送一条 Telegram 消息（5 秒超时）；返回是否成功及失败原因 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; description?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    })
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean
      description?: string
    } | null
    if (response.ok && data?.ok) return { ok: true }
    return { ok: false, description: data?.description ?? `HTTP ${response.status}` }
  } catch {
    return { ok: false, description: '网络异常或超时' }
  } finally {
    clearTimeout(timer)
  }
}

/** 用户上线（登录成功）通知：配置缺失时静默跳过；发送失败不影响登录 */
export async function notifyUserLoginTg(
  db: D1Database,
  info: { username: string; ip: string; country: string; region: string; city: string; at: number },
): Promise<void> {
  const { botToken, chatId } = await readTgNotifyConfig(db)
  if (!botToken || !chatId) return
  const when = new Date(info.at * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
  const place = [
    info.country ? (TG_COUNTRY_NAMES[info.country] ?? info.country) : '',
    info.region,
    info.city,
  ]
    .filter(Boolean)
    .join(' ')
  const lines = [
    '🟢 TGYS TV 用户上线',
    `用户：${info.username}`,
    `时间：${when}（北京时间）`,
  ]
  if (place) lines.push(`地点：${place}`)
  if (info.ip) lines.push(`IP：${info.ip}`)
  await sendTelegramMessage(botToken, chatId, lines.join('\n'))
}

// ---------- Turnstile（可选：配置了 Secret 才校验） ----------

export async function verifyTurnstile(env: AuthEnv, token: string | undefined): Promise<boolean> {
  const secret = env.TGYS_TURNSTILE_SECRET
  if (!secret) return true
  if (!token) return false
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
    })
    const data = (await response.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}
