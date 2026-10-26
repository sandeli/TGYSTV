import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  clampText,
  DEFAULT_USER_VALID_DAYS,
  defaultUserExpiresAt,
  generateInviteCode,
  changeUserPassword,
  formatRegistrationOpenAt,
  getRegistrationCloseAt,
  getRegistrationMaxUsers,
  getRegistrationMode,
  getRegistrationOpenAt,
  registrationFull,
  registrationWindowState,
  isSiteClosed,
  isOpenAccess,
  clearLoginFailures,
  getLoginLockSeconds,
  recordLoginFailure,
  readSiteBehavior,
  getSettings,
  parseSiteBehavior,
  hashPassword,
  inviteCodeStatus,
  randomHex,
  sha256Hex,
  validatePassword,
  validateUsername,
  verifyPassword,
  parseAccountSources,
  extractSiteWideSources,
  normalizeAccountSourcesForUser,
  parseDeletedSourceIds,
  resolveDeletedSourceIds,
  saveUserSources,
  getUserSourcesMeta,
  MASTER_USER_ID,
  type AuthEnv,
  type D1Database,
} from './auth'

describe('账号校验', () => {
  it('用户名：3-24 位文字/数字/下划线/连字符，admin 保留', () => {
    expect(validateUsername('abc')).toBe('abc')
    expect(validateUsername(' 张三_9-x ')).toBe('张三_9-x')
    expect(validateUsername('ab')).toBeNull()
    expect(validateUsername('admin')).toBeNull()
    expect(validateUsername('ADMIN')).toBeNull()
    expect(validateUsername('a b')).toBeNull()
    expect(validateUsername('x'.repeat(25))).toBeNull()
    expect(validateUsername(123)).toBeNull()
  })

  it('密码：6-64 位', () => {
    expect(validatePassword('123456')).toBe('123456')
    expect(validatePassword('12345')).toBeNull()
    expect(validatePassword('x'.repeat(65))).toBeNull()
  })

  it('clamp 工具', () => {
    expect(clampText('abcdef', 3)).toBe('abc')
    expect(clampText(42, 3)).toBe('')
    expect(clampNumber(120, 0, 100)).toBe(100)
    expect(clampNumber(Number.NaN, 0, 100)).toBe(0)
  })
})

describe('密码哈希与令牌摘要', () => {
  it('同盐同密码结果一致，异盐不同；校验可通过/拒绝', async () => {
    const salt = randomHex(16)
    const hash1 = await hashPassword('p@ssw0rd', salt)
    const hash2 = await hashPassword('p@ssw0rd', salt)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)

    const otherSaltHash = await hashPassword('p@ssw0rd', randomHex(16))
    expect(otherSaltHash).not.toBe(hash1)

    expect(await verifyPassword('p@ssw0rd', salt, hash1)).toBe(true)
    expect(await verifyPassword('wrong-pass', salt, hash1)).toBe(false)
  })

  it('sha256Hex 稳定且为 64 位十六进制', async () => {
    const digest = await sha256Hex('tgys-token')
    expect(digest).toHaveLength(64)
    expect(await sha256Hex('tgys-token')).toBe(digest)
  })
})

/** 只实现 settings 读取的最小 D1 假实现（getSetting 只用 prepare→bind→first） */
function fakeDb(settings: Record<string, string>): D1Database {
  return {
    prepare: () => ({
      bind: (...keys: string[]) => ({
        first: async () =>
          keys.length > 0 && settings[keys[0]] !== undefined
            ? { value: settings[keys[0]] }
            : null,
        all: async () => ({
          results: keys
            .filter(key => settings[key] !== undefined)
            .map(key => ({ key, value: settings[key] })),
        }),
      }),
    }),
  } as unknown as D1Database
}

describe('批量读设置', () => {
  it('getSettings 一次返回存在的键，缺失键不在 Map 中', async () => {
    const map = await getSettings(fakeDb({ a: '1', b: 'x' }), ['a', 'b', 'c'])
    expect(map.get('a')).toBe('1')
    expect(map.get('b')).toBe('x')
    expect(map.has('c')).toBe(false)
    expect((await getSettings(fakeDb({}), [])).size).toBe(0)
  })
  it('parseSiteBehavior 与 readSiteBehavior 口径一致（批量路径）', async () => {
    const settings = { open_access: '1', site_closed: '0', tmdb_enabled: '1' }
    const viaParse = parseSiteBehavior(key => settings[key as keyof typeof settings] ?? null)
    const viaRead = await readSiteBehavior(fakeDb(settings))
    expect(viaParse).toEqual(viaRead)
    expect(viaParse.openAccess).toBe(true)
    expect(viaParse.siteClosed).toBe(false)
  })
})

describe('注册模式', () => {
  const env = {} as AuthEnv
  it('默认开放；旧开关关闭则关闭', async () => {
    expect(await getRegistrationMode(fakeDb({}), env)).toBe('open')
    expect(await getRegistrationMode(fakeDb({ registration_open: '0' }), env)).toBe('closed')
    expect(
      await getRegistrationMode(fakeDb({}), { TGYS_REGISTRATION_OPEN: '0' } as AuthEnv),
    ).toBe('closed')
  })
  it('registration_mode 优先于旧开关', async () => {
    expect(
      await getRegistrationMode(fakeDb({ registration_mode: 'invite', registration_open: '1' }), env),
    ).toBe('invite')
    expect(
      await getRegistrationMode(fakeDb({ registration_mode: 'open', registration_open: '0' }), env),
    ).toBe('open')
    expect(await getRegistrationMode(fakeDb({ registration_mode: 'bogus' }), env)).toBe('open')
  })
  it('注册定时开放时刻：未设置/非法为 0，合法时间戳原样读出', async () => {
    expect(await getRegistrationOpenAt(fakeDb({}))).toBe(0)
    expect(await getRegistrationOpenAt(fakeDb({ registration_open_at: '0' }))).toBe(0)
    expect(await getRegistrationOpenAt(fakeDb({ registration_open_at: 'bogus' }))).toBe(0)
    expect(
      await getRegistrationOpenAt(fakeDb({ registration_open_at: '1893456000' })),
    ).toBe(1893456000)
  })
  it('开放时刻文案为北京时间、精确到分钟', () => {
    // 1893456000 = 2030-01-01 00:00:00 UTC = 北京时间 08:00
    expect(formatRegistrationOpenAt(1893456000)).toContain('2030年1月1日')
    expect(formatRegistrationOpenAt(1893456000)).toContain('08:00')
  })
  it('注册开放时段结束时刻：未设置/非法为 0，合法时间戳原样读出', async () => {
    expect(await getRegistrationCloseAt(fakeDb({}))).toBe(0)
    expect(await getRegistrationCloseAt(fakeDb({ registration_close_at: 'bogus' }))).toBe(0)
    expect(
      await getRegistrationCloseAt(fakeDb({ registration_close_at: '1893456000' })),
    ).toBe(1893456000)
  })
  it('开放时段位置判断：开始前 before、结束后 after、时段内或未设边界 in', () => {
    const open = 2000
    const close = 3000
    expect(registrationWindowState(open, close, 1999)).toBe('before')
    expect(registrationWindowState(open, close, 2000)).toBe('in')
    expect(registrationWindowState(open, close, 2999)).toBe('in')
    expect(registrationWindowState(open, close, 3000)).toBe('after')
    // 只设开始：到点后长期 in；只设结束：到点前 in、到点后 after；都没设恒 in
    expect(registrationWindowState(open, 0, 9999)).toBe('in')
    expect(registrationWindowState(0, close, 2000)).toBe('in')
    expect(registrationWindowState(0, close, 3000)).toBe('after')
    expect(registrationWindowState(0, 0, 12345)).toBe('in')
  })
  it('注册人数上限：未设置/0/非法为 0（不限），合法整数原样读出', async () => {
    expect(await getRegistrationMaxUsers(fakeDb({}))).toBe(0)
    expect(await getRegistrationMaxUsers(fakeDb({ registration_max_users: '0' }))).toBe(0)
    expect(await getRegistrationMaxUsers(fakeDb({ registration_max_users: 'bogus' }))).toBe(0)
    expect(await getRegistrationMaxUsers(fakeDb({ registration_max_users: '100' }))).toBe(100)
  })
  it('满员判断：不限恒不满，达到或超过上限为满', () => {
    expect(registrationFull(0, 9999)).toBe(false)
    expect(registrationFull(100, 99)).toBe(false)
    expect(registrationFull(100, 100)).toBe(true)
    expect(registrationFull(100, 101)).toBe(true)
  })
})

describe('修改密码', () => {
  /** 内存假 D1：只实现 changeUserPassword 用到的三条语句 */
  function fakeUserDb(
    user: { passwordHash: string; passwordSalt: string } | null,
    sessionHashes: string[],
  ) {
    const state = {
      user: user ? { ...user } : null,
      sessions: [...sessionHashes],
    }
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () =>
            sql.includes('FROM users') && state.user
              ? { passwordHash: state.user.passwordHash, passwordSalt: state.user.passwordSalt }
              : null,
          run: async () => {
            if (sql.includes('UPDATE users') && state.user) {
              state.user.passwordHash = args[0] as string
              state.user.passwordSalt = args[1] as string
            }
            if (sql.includes('DELETE FROM sessions')) {
              const keep = args[1] as string
              state.sessions = state.sessions.filter(h => h === keep)
            }
            return { success: true }
          },
        }),
      }),
    }
    return { db: db as unknown as D1Database, state }
  }

  it('现密码不对拒绝且不改任何东西', async () => {
    const salt = 'aa'.repeat(16)
    const hash = await hashPassword('old-pass', salt)
    const { db, state } = fakeUserDb({ passwordHash: hash, passwordSalt: salt }, ['tok_cur', 'tok_other'])
    const result = await changeUserPassword(db, 5, 'WRONG-pass', 'new-pass-1', 'tok_cur')
    expect(result).toBe('wrong-current')
    expect(state.user?.passwordHash).toBe(hash)
    expect(state.sessions).toEqual(['tok_cur', 'tok_other'])
  })

  it('现密码正确：换哈希、旧密码失效新密码生效、其他会话被踢', async () => {
    const salt = 'bb'.repeat(16)
    const hash = await hashPassword('old-pass', salt)
    const { db, state } = fakeUserDb({ passwordHash: hash, passwordSalt: salt }, ['tok_cur', 'tok_other'])
    const result = await changeUserPassword(db, 5, 'old-pass', 'new-pass-1', 'tok_cur')
    expect(result).toBe('ok')
    expect(state.user).not.toBeNull()
    expect(await verifyPassword('old-pass', state.user!.passwordSalt, state.user!.passwordHash)).toBe(false)
    expect(await verifyPassword('new-pass-1', state.user!.passwordSalt, state.user!.passwordHash)).toBe(true)
    expect(state.sessions).toEqual(['tok_cur'])
  })

  it('用户不存在返回 not-found', async () => {
    const { db } = fakeUserDb(null, [])
    expect(await changeUserPassword(db, 99, 'whatever', 'new-pass-1', 'tok_cur')).toBe('not-found')
  })
})

describe('关站维护', () => {
  it('isSiteClosed 只认 site_closed=1', async () => {
    expect(await isSiteClosed(fakeDb({}))).toBe(false)
    expect(await isSiteClosed(fakeDb({ site_closed: '0' }))).toBe(false)
    expect(await isSiteClosed(fakeDb({ site_closed: '1' }))).toBe(true)
  })
  it('isOpenAccess 只认 open_access=1（无会员模式下站长登录据此强制人机验证）', async () => {
    expect(await isOpenAccess(fakeDb({}))).toBe(false)
    expect(await isOpenAccess(fakeDb({ open_access: '0' }))).toBe(false)
    expect(await isOpenAccess(fakeDb({ open_access: '1' }))).toBe(true)
  })
  it('readSiteBehavior 带出关站开关与说明', async () => {
    const b = await readSiteBehavior(fakeDb({ site_closed: '1', site_closed_message: '今晚维护' }))
    expect(b.siteClosed).toBe(true)
    expect(b.siteClosedMessage).toBe('今晚维护')
    const b2 = await readSiteBehavior(fakeDb({}))
    expect(b2.siteClosed).toBeUndefined()
  })
  it('readSiteBehavior 带出无会员模式开关（open_access）', async () => {
    const b = await readSiteBehavior(fakeDb({ open_access: '1' }))
    expect(b.openAccess).toBe(true)
    const b2 = await readSiteBehavior(fakeDb({ open_access: '0' }))
    expect(b2.openAccess).toBe(false)
    const b3 = await readSiteBehavior(fakeDb({}))
    expect(b3.openAccess).toBeUndefined()
  })
  it('readSiteBehavior 带出车机自动免登录开关（car_open_access）', async () => {
    const b = await readSiteBehavior(fakeDb({ car_open_access: '1' }))
    expect(b.carOpenAccess).toBe(true)
    const b2 = await readSiteBehavior(fakeDb({ car_open_access: '0' }))
    expect(b2.carOpenAccess).toBe(false)
    const b3 = await readSiteBehavior(fakeDb({}))
    expect(b3.carOpenAccess).toBeUndefined()
  })
})

describe('邀请码', () => {
  it('生成 6 位易读码（无易混字符）且多次不重复', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode()
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
      codes.add(code)
    }
    expect(codes.size).toBe(50)
  })
  it('状态：可用 / 用完 / 过期（过期优先）', () => {
    const now = 1_700_000_000
    expect(inviteCodeStatus({ maxUses: 1, usedCount: 0, expiresAt: null }, now)).toBe('usable')
    expect(inviteCodeStatus({ maxUses: 1, usedCount: 1, expiresAt: null }, now)).toBe('exhausted')
    expect(inviteCodeStatus({ maxUses: 3, usedCount: 1, expiresAt: now - 1 }, now)).toBe('expired')
    expect(inviteCodeStatus({ maxUses: 3, usedCount: 1, expiresAt: now + 60 }, now)).toBe('usable')
  })
})

describe('站长账号源清洗', () => {
  it('保留合法条目并归一字段（siteWide/isEnabled/timeout 钳制）', () => {
    const out = parseAccountSources([
      { id: 'a1', name: ' 源一 ', url: ' https://a.example/api ', isEnabled: false, siteWide: true, timeout: 999999, retry: -2 },
      { id: 'b2', name: '源二', url: 'https://b.example/api', detailUrl: 'https://b.example/detail' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 'a1', name: '源一', url: 'https://a.example/api', isEnabled: false, siteWide: true, timeout: 60000, retry: 0 })
    expect(out[1]).toMatchObject({ id: 'b2', isEnabled: true, siteWide: false, detailUrl: 'https://b.example/detail' })
  })

  it('剔除非法条目：无名、无址、非 http 地址、订阅源 id 改派、重复 id 改派', () => {
    const out = parseAccountSources([
      { name: '', url: 'https://x.example/api' },
      { name: '无址', url: '' },
      { name: '坏址', url: 'ftp://x.example/api' },
      { id: 'sub:sub1:1', name: '订阅形态', url: 'https://s.example/api' },
      { id: 'dup', name: '甲', url: 'https://a.example/api' },
      { id: 'dup', name: '乙', url: 'https://b.example/api' },
      'garbage',
      null,
    ])
    expect(out.map(s => s.name)).toEqual(['订阅形态', '甲', '乙'])
    expect(out[0].id).not.toContain('sub:')
    expect(new Set(out.map(s => s.id)).size).toBe(3)
  })

  it('非数组输入返回空；条数上限 200', () => {
    expect(parseAccountSources(null)).toEqual([])
    expect(parseAccountSources('nope')).toEqual([])
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `源${i}`, url: 'https://x.example/api' }))
    expect(parseAccountSources(many)).toHaveLength(200)
  })

  it('extractSiteWideSources 只挑开启全站生效的', () => {
    const list = parseAccountSources([
      { id: 'a', name: '甲', url: 'https://a.example/api', siteWide: true },
      { id: 'b', name: '乙', url: 'https://b.example/api' },
    ])
    expect(extractSiteWideSources(list).map(s => s.id)).toEqual(['a'])
  })

  it('名称+地址完全相同的重复源会被丢弃（不同设备各加一次的同名源）', () => {
    const list = parseAccountSources([
      { id: 'uuid-1', name: '量子', url: 'https://cj.example/api' },
      { id: 'uuid-2', name: '量子', url: 'https://cj.example/api' },
      { id: 'uuid-3', name: '量子', url: 'https://other.example/api' },
    ])
    expect(list.map(s => s.id)).toEqual(['uuid-1', 'uuid-3'])
  })

  it('普通用户的全站标记会被剥掉，站长的保留（防越权分发）', () => {
    const list = parseAccountSources([
      { id: 'a', name: '甲', url: 'https://a.example/api', siteWide: true },
    ])
    expect(normalizeAccountSourcesForUser(list, 42)[0].siteWide).toBe(false)
    expect(normalizeAccountSourcesForUser(list, MASTER_USER_ID)[0].siteWide).toBe(true)
  })
})

describe('新注册用户默认有效期', () => {
  it('默认 365 天，到期时间 = 注册时刻 + 365 天', () => {
    expect(DEFAULT_USER_VALID_DAYS).toBe(365)
    const createdAt = 1_700_000_000
    expect(defaultUserExpiresAt(createdAt)).toBe(createdAt + 365 * 86400)
  })
})

/** login_attempts 的内存假实现：按 SQL 关键字分发 first/run */
function fakeAttemptsDb() {
  const rows = new Map<string, { failCount: number; windowStart: number; lockedUntil: number }>()
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (!sql.includes('FROM login_attempts')) return null
          return rows.get(String(args[0])) ?? null
        },
        run: async () => {
          if (sql.includes('INSERT INTO login_attempts')) {
            const [key, failCount, windowStart, lockedUntil] = args as [
              string,
              number,
              number,
              number,
            ]
            rows.set(key, { failCount, windowStart, lockedUntil })
          } else if (sql.includes('DELETE FROM login_attempts')) {
            rows.delete(String(args[0]))
          }
          return { success: true }
        },
      }),
    }),
  } as unknown as D1Database
  return { db, rows }
}

describe('登录失败锁定', () => {
  const KEY = 'master-login:1.2.3.4'
  const T0 = 1_700_000_000

  it('失败满 5 次锁定 10 分钟，锁定剩余秒数递减', async () => {
    const { db } = fakeAttemptsDb()
    for (let i = 0; i < 4; i++) {
      expect(await recordLoginFailure(db, KEY, T0 + i)).toBe(false)
      expect(await getLoginLockSeconds(db, KEY, T0 + i)).toBe(0)
    }
    expect(await recordLoginFailure(db, KEY, T0 + 4)).toBe(true)
    expect(await getLoginLockSeconds(db, KEY, T0 + 4)).toBe(600)
    expect(await getLoginLockSeconds(db, KEY, T0 + 304)).toBe(300)
    expect(await getLoginLockSeconds(db, KEY, T0 + 604)).toBe(0)
  })

  it('窗口（15 分钟）过期后重新计数，不会累计到锁定', async () => {
    const { db } = fakeAttemptsDb()
    for (let i = 0; i < 4; i++) await recordLoginFailure(db, KEY, T0 + i)
    // 距窗口起点已超过 15 分钟：第 5 次失败开启新窗口，计数回到 1
    expect(await recordLoginFailure(db, KEY, T0 + 901)).toBe(false)
    expect(await getLoginLockSeconds(db, KEY, T0 + 901)).toBe(0)
  })

  it('登录成功清零：清除后重新计数', async () => {
    const { db } = fakeAttemptsDb()
    for (let i = 0; i < 4; i++) await recordLoginFailure(db, KEY, T0 + i)
    await clearLoginFailures(db, KEY)
    for (let i = 0; i < 4; i++) {
      expect(await recordLoginFailure(db, KEY, T0 + 10 + i)).toBe(false)
    }
    expect(await getLoginLockSeconds(db, KEY, T0 + 20)).toBe(0)
  })

  it('不同 key 互不影响', async () => {
    const { db } = fakeAttemptsDb()
    for (let i = 0; i < 5; i++) await recordLoginFailure(db, KEY, T0 + i)
    expect(await getLoginLockSeconds(db, KEY, T0 + 10)).toBeGreaterThan(0)
    expect(await getLoginLockSeconds(db, 'master-login:5.6.7.8', T0 + 10)).toBe(0)
  })
})

describe('账号源已删名单（防复活）', () => {
  it('parseDeletedSourceIds 清洗：去重、限长、订阅源 id 不入名单', () => {
    expect(parseDeletedSourceIds(null)).toEqual([])
    expect(parseDeletedSourceIds('x')).toEqual([])
    expect(parseDeletedSourceIds([' a ', 'a', '', 'sub:s1:0', 42, 'b'])).toEqual(['a', 'b'])
  })

  it('resolveDeletedSourceIds：旧名单 ∪ 上报删除 − 明确重加', () => {
    expect(resolveDeletedSourceIds(['old'], ['new1', 'new2'], ['new2'])).toEqual(['old', 'new1'])
    expect(resolveDeletedSourceIds(['old'], [], ['old'])).toEqual([])
    expect(resolveDeletedSourceIds([], null, undefined)).toEqual([])
  })

  /** user_sources + settings 的内存假实现（够 saveUserSources / getUserSourcesMeta 走通） */
  function fakeUserSourcesDb() {
    const rows = new Map<number, { sources: string; deleted_ids: string }>()
    const settings = new Map<string, string>()
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM user_sources')) {
              const row = rows.get(args[0] as number)
              return row ? { sources: row.sources, deleted_ids: row.deleted_ids } : null
            }
            if (sql.includes('FROM settings')) {
              const v = settings.get(args[0] as string)
              return v === undefined ? null : { value: v }
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT INTO user_sources')) {
              rows.set(args[0] as number, {
                sources: args[1] as string,
                deleted_ids: args[2] as string,
              })
            } else if (sql.includes('INSERT INTO settings')) {
              settings.set(args[0] as string, args[1] as string)
            }
            return { success: true }
          },
        }),
      }),
    } as unknown as D1Database
    return { db, rows, settings }
  }

  const entry = (id: string) => ({ id, name: `源${id}`, url: `https://${id}.example/api` })

  it('删除进名单后，旧设备带着已删源整体回存也不会复活；明确重加才恢复', async () => {
    const { db } = fakeUserSourcesDb()
    await saveUserSources(db, 7, [entry('a'), entry('b')])
    const afterDelete = await saveUserSources(db, 7, [entry('a')], { deletedIds: ['b'] })
    expect(afterDelete.sources.map(s => s.id)).toEqual(['a'])
    expect(afterDelete.deletedIds).toEqual(['b'])

    // 旧设备拿着删除前的旧名单整体回存（没有删除上报）：b 被名单否决
    const stale = await saveUserSources(db, 7, [entry('a'), entry('b')])
    expect(stale.sources.map(s => s.id)).toEqual(['a'])
    const meta = await getUserSourcesMeta(db, 7)
    expect(meta.sources.map(s => s.id)).toEqual(['a'])
    expect(meta.deletedIds).toEqual(['b'])

    // 用户明确重新添加 b（revivedIds）：离开名单、恢复保存
    const revived = await saveUserSources(db, 7, [entry('a'), entry('b')], { revivedIds: ['b'] })
    expect(revived.sources.map(s => s.id)).toEqual(['a', 'b'])
    expect(revived.deletedIds).toEqual([])
  })

  it('站长全站派生同样受名单约束：删掉的全站源不再分发', async () => {
    const { db, settings } = fakeUserSourcesDb()
    const wide = { ...entry('w'), siteWide: true }
    await saveUserSources(db, MASTER_USER_ID, [wide])
    expect(JSON.parse(settings.get('admin_sitewide_sources') ?? '[]')).toHaveLength(1)
    await saveUserSources(db, MASTER_USER_ID, [], { deletedIds: ['w'] })
    expect(JSON.parse(settings.get('admin_sitewide_sources') ?? '[]')).toEqual([])
    // 旧名单回存也带不回来
    await saveUserSources(db, MASTER_USER_ID, [wide])
    expect(JSON.parse(settings.get('admin_sitewide_sources') ?? '[]')).toEqual([])
  })

  it('读出时兜底过滤：历史数据里残留的已删条目不下发', async () => {
    const { db, rows } = fakeUserSourcesDb()
    rows.set(9, {
      sources: JSON.stringify([entry('a'), entry('b')]),
      deleted_ids: JSON.stringify(['b']),
    })
    const meta = await getUserSourcesMeta(db, 9)
    expect(meta.sources.map(s => s.id)).toEqual(['a'])
    expect(meta.deletedIds).toEqual(['b'])
  })
})
