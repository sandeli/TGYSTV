import { describe, expect, it, vi } from 'vitest'
import type { AccountSourceEntry, D1Database } from './auth'
import {
  buildSubscriptionEntries,
  isSubscriptionDue,
  MASTER_SUBSCRIPTION_SOURCES_KEY,
  MASTER_SUBSCRIPTION_STATE_KEY,
  MASTER_SUBSCRIPTIONS_KEY,
  maybeUpdateMasterSubscriptions,
  mergeSiteWideWithSubscriptionSources,
  parseMasterSubscriptions,
  pruneSubscriptionData,
  type MasterSubscription,
} from './subscriptionUpdate'

/** 可读写的最小 D1 假实现：只支撑 settings 的批量读（all）与写入（run） */
function fakeDb(store: Map<string, string>): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({
          results: args
            .filter(k => typeof k === 'string' && store.has(k))
            .map(k => ({ key: k as string, value: store.get(k as string) })),
        }),
        first: async () => null,
        run: async () => {
          if (sql.includes('INSERT INTO settings')) {
            store.set(args[0] as string, args[1] as string)
          }
          return { success: true }
        },
      }),
    }),
  } as unknown as D1Database
}

const sub = (partial: Partial<MasterSubscription> = {}): MasterSubscription => ({
  id: 'subA',
  name: '订阅A',
  url: 'https://example.com/a.json',
  refreshInterval: 60,
  ...partial,
})

const entry = (id: string, name = '源', url = 'https://cdn.example/v'): AccountSourceEntry => ({
  id,
  name,
  url,
  isEnabled: true,
  siteWide: false,
})

describe('parseMasterSubscriptions 清单清洗', () => {
  it('合法条目保留，间隔钳制到 0..10080 分钟', () => {
    const out = parseMasterSubscriptions([
      { id: 'a', name: '甲', url: 'https://x.example/1.json', refreshInterval: 99999 },
      { id: 'b', name: '乙', url: 'https://x.example/2.json', refreshInterval: -5 },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].refreshInterval).toBe(10080)
    expect(out[1].refreshInterval).toBe(0)
  })

  it('含冒号的 id、非 http 地址、重复 id/链接被丢弃', () => {
    const out = parseMasterSubscriptions([
      { id: 'a:bad', name: 'x', url: 'https://x.example/1.json' },
      { id: 'b', name: 'x', url: 'ftp://x.example/2.json' },
      { id: 'c', name: 'x', url: 'https://x.example/3.json' },
      { id: 'c', name: 'y', url: 'https://x.example/4.json' },
      { id: 'd', name: 'y', url: 'https://x.example/3.json' },
      'not-an-object',
    ])
    expect(out.map(s => s.id)).toEqual(['c'])
  })

  it('非数组输入返回空', () => {
    expect(parseMasterSubscriptions(null)).toEqual([])
    expect(parseMasterSubscriptions('x')).toEqual([])
  })
})

describe('buildSubscriptionEntries 订阅数据转源条目', () => {
  it('兼容 baseUrl 格式，过滤无名/无址条目，生成 sub 前缀 id', () => {
    const out = buildSubscriptionEntries(
      'subA',
      [
        { name: '源一', url: 'https://a.example/api' },
        { name: '源二', baseUrl: 'https://b.example/api' },
        { name: '', url: 'https://c.example/api' },
        { name: '源四' },
        { name: '源五', url: 'ftp://d.example/api' },
      ],
      [],
    )
    expect(out.map(e => e.id)).toEqual(['sub:subA:0', 'sub:subA:1'])
    expect(out[1].url).toBe('https://b.example/api')
  })

  it('启用状态沿用旧快照的同名同址条目，其次用订阅文件自带值', () => {
    const prev = [{ ...entry('sub:subA:0', '源一', 'https://a.example/api'), isEnabled: false }]
    const out = buildSubscriptionEntries(
      'subA',
      [
        { name: '源一', url: 'https://a.example/api', isEnabled: true },
        { name: '源二', url: 'https://b.example/api', enabled: false },
        { name: '源三', url: 'https://c.example/api' },
      ],
      prev,
    )
    expect(out.map(e => e.isEnabled)).toEqual([false, false, true])
  })

  it('非数组数据抛错（由调用方记为刷新失败）', () => {
    expect(() => buildSubscriptionEntries('subA', { nope: 1 }, [])).toThrow()
  })
})

describe('isSubscriptionDue 到期判定', () => {
  it('间隔为 0 永不到期；无状态视为到期；按上次尝试时间比较', () => {
    expect(isSubscriptionDue(sub({ refreshInterval: 0 }), undefined, 1000)).toBe(false)
    expect(isSubscriptionDue(sub(), undefined, 1000)).toBe(true)
    const state = { lastAttemptAt: 1000, lastSuccess: true, lastCount: 1, lastError: null }
    expect(isSubscriptionDue(sub(), state, 1000 + 59 * 60)).toBe(false)
    expect(isSubscriptionDue(sub(), state, 1000 + 60 * 60)).toBe(true)
  })
})

describe('maybeUpdateMasterSubscriptions 到期更新', () => {
  const NOW = 1_700_000_000

  it('无清单时不抓取', async () => {
    const fetchFn = vi.fn()
    const summary = await maybeUpdateMasterSubscriptions(fakeDb(new Map()), {
      fetchFn,
      nowSec: NOW,
    })
    expect(summary.attempted).toBe(0)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('到期订阅抓取成功：只换新该订阅切片，另一订阅原样保留，并记录状态', async () => {
    const store = new Map<string, string>([
      [
        MASTER_SUBSCRIPTIONS_KEY,
        JSON.stringify([
          sub(),
          sub({ id: 'subB', name: '订阅B', url: 'https://example.com/b.json' }),
        ]),
      ],
      [
        MASTER_SUBSCRIPTION_STATE_KEY,
        JSON.stringify({
          subA: { lastAttemptAt: NOW - 7200, lastSuccess: true, lastCount: 1, lastError: null },
          subB: { lastAttemptAt: NOW - 60, lastSuccess: true, lastCount: 1, lastError: null },
        }),
      ],
      [
        MASTER_SUBSCRIPTION_SOURCES_KEY,
        JSON.stringify([
          entry('sub:subA:0', '旧源', 'https://old.example/api'),
          entry('sub:subB:0', 'B源', 'https://b.example/api'),
        ]),
      ],
    ])
    const fetchFn = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => [{ name: '新源', url: 'https://new.example/api' }],
    }))
    const summary = await maybeUpdateMasterSubscriptions(fakeDb(store), {
      fetchFn: fetchFn as never,
      nowSec: NOW,
    })
    expect(summary).toEqual({ attempted: 1, updated: 1, failed: 0 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe('https://example.com/a.json')
    const sources = JSON.parse(store.get(MASTER_SUBSCRIPTION_SOURCES_KEY)!) as AccountSourceEntry[]
    expect(sources.map(s => s.id)).toEqual(['sub:subB:0', 'sub:subA:0'])
    expect(sources.find(s => s.id === 'sub:subA:0')?.name).toBe('新源')
    const state = JSON.parse(store.get(MASTER_SUBSCRIPTION_STATE_KEY)!)
    expect(state.subA.lastSuccess).toBe(true)
    expect(state.subA.lastCount).toBe(1)
    expect(state.subB.lastAttemptAt).toBe(NOW - 60)
  })

  it('抓取失败保留旧切片并记录失败，不抛错', async () => {
    const store = new Map<string, string>([
      [MASTER_SUBSCRIPTIONS_KEY, JSON.stringify([sub()])],
      [MASTER_SUBSCRIPTION_SOURCES_KEY, JSON.stringify([entry('sub:subA:0', '旧源')])],
    ])
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const summary = await maybeUpdateMasterSubscriptions(fakeDb(store), {
      fetchFn: fetchFn as never,
      nowSec: NOW,
    })
    expect(summary).toEqual({ attempted: 1, updated: 0, failed: 1 })
    const sources = JSON.parse(store.get(MASTER_SUBSCRIPTION_SOURCES_KEY)!) as AccountSourceEntry[]
    expect(sources.map(s => s.id)).toEqual(['sub:subA:0'])
    const state = JSON.parse(store.get(MASTER_SUBSCRIPTION_STATE_KEY)!)
    expect(state.subA.lastSuccess).toBe(false)
    expect(state.subA.lastError).toContain('network down')
  })

  it('未到期不抓取、不写库', async () => {
    const store = new Map<string, string>([
      [MASTER_SUBSCRIPTIONS_KEY, JSON.stringify([sub()])],
      [
        MASTER_SUBSCRIPTION_STATE_KEY,
        JSON.stringify({
          subA: { lastAttemptAt: NOW - 60, lastSuccess: true, lastCount: 0, lastError: null },
        }),
      ],
    ])
    const fetchFn = vi.fn()
    const summary = await maybeUpdateMasterSubscriptions(fakeDb(store), {
      fetchFn,
      nowSec: NOW,
    })
    expect(summary.attempted).toBe(0)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(store.has(MASTER_SUBSCRIPTION_SOURCES_KEY)).toBe(false)
  })
})

describe('pruneSubscriptionData 残留清理', () => {
  it('摘除已删除订阅的源与状态', () => {
    const sources = [entry('sub:subA:0'), entry('sub:subGone:0')]
    const state = {
      subA: { lastAttemptAt: 1, lastSuccess: true, lastCount: 1, lastError: null },
      subGone: { lastAttemptAt: 1, lastSuccess: true, lastCount: 1, lastError: null },
    }
    const out = pruneSubscriptionData([sub()], sources, state)
    expect(out.changed).toBe(true)
    expect(out.sources.map(s => s.id)).toEqual(['sub:subA:0'])
    expect(Object.keys(out.state)).toEqual(['subA'])
  })
})

describe('mergeSiteWideWithSubscriptionSources 全站分发合并', () => {
  it('手动源在前、订阅源在后，按 id 去重（手动优先）', () => {
    const manual = JSON.stringify([entry('m1'), entry('shared')])
    const merged = JSON.parse(
      mergeSiteWideWithSubscriptionSources(manual, [entry('shared'), entry('sub:subA:0')]),
    ) as AccountSourceEntry[]
    expect(merged.map(s => s.id)).toEqual(['m1', 'shared', 'sub:subA:0'])
  })

  it('手动列表为空或损坏时订阅源照常分发；都空时返回空数组串', () => {
    const only = JSON.parse(
      mergeSiteWideWithSubscriptionSources('{bad json', [entry('sub:subA:0')]),
    ) as AccountSourceEntry[]
    expect(only.map(s => s.id)).toEqual(['sub:subA:0'])
    expect(mergeSiteWideWithSubscriptionSources(null, [])).toBe('[]')
  })
})
