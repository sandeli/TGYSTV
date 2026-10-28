import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthConfig } from './authApi'

describe('fetchAuthConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('透传注册模式 registrationMode（邀请模式不能被漏掉）', async () => {
    const stub = (payload: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
      )
    stub({ authEnabled: true, registrationOpen: true, registrationMode: 'invite' })
    expect((await fetchAuthConfig()).registrationMode).toBe('invite')
    // 旧后端无 registrationMode 字段时按 registrationOpen 推导
    stub({ authEnabled: true, registrationOpen: true })
    expect((await fetchAuthConfig()).registrationMode).toBe('open')
    stub({ authEnabled: true, registrationOpen: false })
    expect((await fetchAuthConfig()).registrationMode).toBe('closed')
    // 非法值同样回退推导
    stub({ authEnabled: true, registrationOpen: false, registrationMode: 'bogus' })
    expect((await fetchAuthConfig()).registrationMode).toBe('closed')
  })

  it('透传注册定时开放时刻 registrationOpenAt（非法/缺失为 0）', async () => {
    const stub = (payload: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
      )
    stub({ authEnabled: true, registrationOpen: false, registrationOpenAt: 1893456000 })
    expect((await fetchAuthConfig()).registrationOpenAt).toBe(1893456000)
    stub({ authEnabled: true, registrationOpen: false })
    expect((await fetchAuthConfig()).registrationOpenAt).toBe(0)
    stub({ authEnabled: true, registrationOpen: false, registrationOpenAt: 'bogus' })
    expect((await fetchAuthConfig()).registrationOpenAt).toBe(0)
  })

  it('透传注册开放时段结束时刻 registrationCloseAt（非法/缺失为 0）', async () => {
    const stub = (payload: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
      )
    stub({ authEnabled: true, registrationOpen: true, registrationCloseAt: 1893456000 })
    expect((await fetchAuthConfig()).registrationCloseAt).toBe(1893456000)
    stub({ authEnabled: true, registrationOpen: true })
    expect((await fetchAuthConfig()).registrationCloseAt).toBe(0)
  })

  it('透传站长全站源 siteWideSources（非法/缺失为空串）', async () => {
    const stub = (payload: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
      )
    const raw = '[{"id":"a1","name":"甲源","url":"https://a.example/api"}]'
    stub({ authEnabled: true, siteWideSources: raw })
    expect((await fetchAuthConfig()).siteWideSources).toBe(raw)
    stub({ authEnabled: true })
    expect((await fetchAuthConfig()).siteWideSources).toBe('')
    stub({ authEnabled: true, siteWideSources: 42 })
    expect((await fetchAuthConfig()).siteWideSources).toBe('')
  })

  it('透传注册满员标记 registrationFull（缺失为 false）', async () => {
    const stub = (payload: Record<string, unknown>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
      )
    stub({ authEnabled: true, registrationOpen: true, registrationFull: true })
    expect((await fetchAuthConfig()).registrationFull).toBe(true)
    stub({ authEnabled: true, registrationOpen: true })
    expect((await fetchAuthConfig()).registrationFull).toBe(false)
  })

  it('透传管理员视频源字段 initialVideoSources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authEnabled: true,
          registrationOpen: true,
          announcement: null,
          announcementBar: '',
          doubanProxy: { dataType: 'direct', dataUrl: '', imageType: 'server', imageUrl: '' },
          initialVideoSources: 'https://example.com/sources.json',
        }),
      }),
    )
    const config = await fetchAuthConfig()
    expect(config.initialVideoSources).toBe('https://example.com/sources.json')
  })

  it('透传管理员托管源开关表 managedSourceEnabled（只保留布尔条目）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authEnabled: true,
          managedSourceEnabled: { a: false, b: true, bad: 'yes' },
        }),
      }),
    )
    const config = await fetchAuthConfig()
    expect(config.managedSourceEnabled).toEqual({ a: false, b: true })
  })

  it('透传站点系统行为 siteBehavior（过滤非法枚举与非布尔值）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authEnabled: true,
          siteBehavior: {
            tmdbApiToken: 'site-token-123',
            tmdbEnabled: true,
            danmakuApiUrl: 'https://danmaku.example.com',
            siteClosed: true,
            siteClosedMessage: '维护中，今晚恢复',
            openAccess: true,
            carOpenAccess: true,
            tmdbLanguage: 'zh-CN',
            tmdbImageQuality: 'ultra',
            updateLogEnabled: 'yes',
            scrollChromeAnimationEnabled: false,
          },
        }),
      }),
    )
    const config = await fetchAuthConfig()
    expect(config.siteBehavior).toEqual({
      tmdbApiToken: 'site-token-123',
      tmdbEnabled: true,
      danmakuApiUrl: 'https://danmaku.example.com',
      siteClosed: true,
      siteClosedMessage: '维护中，今晚恢复',
      openAccess: true,
      carOpenAccess: true,
      tmdbLanguage: 'zh-CN',
      scrollChromeAnimationEnabled: false,
    })
  })

  it('缺失 initialVideoSources 时默认为空串（回退环境变量）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ authEnabled: false }),
      }),
    )
    const config = await fetchAuthConfig()
    expect(config.initialVideoSources).toBe('')
  })
})
