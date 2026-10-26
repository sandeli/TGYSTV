import { describe, expect, it } from 'vitest'
import type { VideoSource } from '@tgys/cms-core'
import {
  applyAccountMirror,
  collectAccountSources,
  computeReportedDeletions,
  dedupeAccountSources,
  excludeDeletedSources,
  findMirrorDroppedSources,
  fromAccountSourcePayload,
  groupServerSubscriptionSources,
  serializeAccountSources,
  stripSiteWideFlags,
  toAccountSourcePayload,
} from './accountSources'

const src = (partial: Partial<VideoSource> & { id: string }): VideoSource => ({
  name: partial.id,
  url: `https://${partial.id}.example/api`,
  isEnabled: true,
  ...partial,
})

describe('collectAccountSources 账户源集合口径', () => {
  it('包含手动源与已登记的托管形态全站源，排除订阅源与基础托管源', () => {
    const list = [
      src({ id: 'manual1' }),
      src({ id: 'managed_base' }),
      src({ id: 'managed_sitewide', siteWide: true }),
      src({ id: 'sub:sub1:xyz' }),
    ]
    const out = collectAccountSources(list, ['managed_base', 'managed_sitewide'], ['managed_sitewide'])
    expect(out.map(s => s.id)).toEqual(['manual1', 'managed_sitewide'])
  })

  it('未登记的手动源即使不在 accountSourceIds 里也会被收集（待同步）', () => {
    const out = collectAccountSources([src({ id: 'fresh' })], [], [])
    expect(out.map(s => s.id)).toEqual(['fresh'])
  })
})

describe('stripSiteWideFlags 普通用户剥全站标记', () => {
  it('带标记的源被清掉标记，其他字段不动', () => {
    const list = [src({ id: 'a', siteWide: true }), src({ id: 'b' })]
    const out = stripSiteWideFlags(list)
    expect(out[0].siteWide).toBe(false)
    expect(out[0].name).toBe('a')
    expect(out[1]).toBe(list[1])
  })

  it('剥标记后序列化不再含全站标记（上行与变更检测口径一致）', () => {
    const out = stripSiteWideFlags([src({ id: 'a', siteWide: true })])
    expect(toAccountSourcePayload(out[0]).siteWide).toBe(false)
  })
})

describe('载荷映射与序列化', () => {
  it('toAccountSourcePayload 固定字段且 detailUrl 与 url 相同则省略', () => {
    const a = toAccountSourcePayload(src({ id: 'x', detailUrl: 'https://x.example/api' }))
    expect(a).toEqual({ id: 'x', name: 'x', url: 'https://x.example/api', isEnabled: true, siteWide: false })
    const b = toAccountSourcePayload(src({ id: 'y', detailUrl: 'https://y.example/detail', siteWide: true }))
    expect(b.detailUrl).toBe('https://y.example/detail')
    expect(b.siteWide).toBe(true)
  })

  it('序列化不受 updatedAt 变化影响（变更检测稳定）', () => {
    const a = src({ id: 'x', updatedAt: new Date('2026-01-01T00:00:00Z') })
    const b = src({ id: 'x', updatedAt: new Date('2026-06-01T00:00:00Z') })
    expect(serializeAccountSources([a])).toBe(serializeAccountSources([b]))
    expect(serializeAccountSources([a])).not.toBe(
      serializeAccountSources([{ ...b, siteWide: true }]),
    )
  })

  it('fromAccountSourcePayload 还原成本地源（detailUrl 缺省回退 url）', () => {
    const out = fromAccountSourcePayload({
      id: 'x',
      name: '甲',
      url: 'https://x.example/api',
      isEnabled: false,
      siteWide: true,
    })
    expect(out).toMatchObject({
      id: 'x',
      name: '甲',
      detailUrl: 'https://x.example/api',
      isEnabled: false,
      siteWide: true,
    })
  })
})

describe('applyAccountMirror 账户源镜像', () => {
  it('摘除旧个人账户源、把新集合插回原位置，托管与订阅源不动', () => {
    const current = [
      src({ id: 'managed_base' }),
      src({ id: 'acct_old1' }),
      src({ id: 'acct_old2' }),
      src({ id: 'sub:sub1:1' }),
    ]
    const incoming = [src({ id: 'acct_new1' }), src({ id: 'acct_old2', name: '改名' })]
    const result = applyAccountMirror(current, ['acct_old1', 'acct_old2'], incoming, ['managed_base'])
    expect(result.videoAPIs.map(s => s.id)).toEqual(['managed_base', 'acct_new1', 'acct_old2', 'sub:sub1:1'])
    expect(result.videoAPIs.find(s => s.id === 'acct_old2')?.name).toBe('改名')
    expect(result.accountSourceIds).toEqual(['acct_new1', 'acct_old2'])
  })

  it('已以托管形态展示的全站源只登记 id、不重复插入', () => {
    const current = [src({ id: 'managed_sitewide', siteWide: true }), src({ id: 'acct_a' })]
    const incoming = [src({ id: 'managed_sitewide', siteWide: true }), src({ id: 'acct_a' })]
    const result = applyAccountMirror(current, ['acct_a'], incoming, ['managed_sitewide'])
    expect(result.videoAPIs.map(s => s.id)).toEqual(['managed_sitewide', 'acct_a'])
    expect(result.accountSourceIds).toEqual(['managed_sitewide', 'acct_a'])
  })

  it('未登记的新源与镜像同 id 时只剩一份（刚添加就刷新不重复）', () => {
    // 本地刚添加的源 X 还没登记进 accountSourceIds，服务端已存回同一 id 的副本
    const local = [src({ id: 'm1' }), src({ id: 'x', name: '新源' }), src({ id: 'm2' })]
    const incoming = [src({ id: 'a1' }), src({ id: 'x', name: '新源' })]
    const { videoAPIs, accountSourceIds } = applyAccountMirror(local, ['a1'], incoming, [])
    expect(videoAPIs.filter(s => s.id === 'x')).toHaveLength(1)
    expect(videoAPIs.map(s => s.id)).toEqual(['m1', 'm2', 'a1', 'x'])
    expect(accountSourceIds).toEqual(['a1', 'x'])
  })

  it('服务端删掉的个人源在镜像后消失（删除跨设备传播）', () => {
    const current = [src({ id: 'acct_a' }), src({ id: 'acct_b' })]
    const result = applyAccountMirror(current, ['acct_a', 'acct_b'], [src({ id: 'acct_a' })], [])
    expect(result.videoAPIs.map(s => s.id)).toEqual(['acct_a'])
    expect(result.accountSourceIds).toEqual(['acct_a'])
  })
})

describe('findMirrorDroppedSources 托管镜像对账口径', () => {
  it('镜像摘除的个人源会被找出（应以个人形态补回）', () => {
    const serverKnown = [src({ id: 'personal1' }), src({ id: 'site1', siteWide: true })]
    // site1 已退出托管清单、从本地列表消失；personal1 还在列表里
    const out = findMirrorDroppedSources(serverKnown, [src({ id: 'personal1' })], [])
    expect(out.map(s => s.id)).toEqual(['site1'])
  })

  it('正以托管形态展示的全站源不算被摘除', () => {
    const serverKnown = [src({ id: 'site1', siteWide: true })]
    const out = findMirrorDroppedSources(serverKnown, [src({ id: 'site1', siteWide: true })], ['site1'])
    expect(out).toEqual([])
  })

  it('列表里还在的源不算缺失', () => {
    const serverKnown = [src({ id: 'a' }), src({ id: 'b' })]
    const out = findMirrorDroppedSources(serverKnown, [src({ id: 'a' }), src({ id: 'b' })], [])
    expect(out).toEqual([])
  })
})

describe('dedupeAccountSources 去重口径', () => {
  it('同 id 只留一份（先出现者优先）', () => {
    const out = dedupeAccountSources([src({ id: 'a', name: '甲' }), src({ id: 'a', name: '甲改' })])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('甲')
  })

  it('id 不同但名称+地址相同的视为同一个源，只留一份', () => {
    const out = dedupeAccountSources([
      src({ id: 'uuid-1', name: '量子', url: 'https://cj.example/api' }),
      src({ id: 'uuid-2', name: '量子', url: 'https://cj.example/api' }),
    ])
    expect(out.map(s => s.id)).toEqual(['uuid-1'])
  })

  it('名称或地址任一不同都是不同的源，全部保留', () => {
    const out = dedupeAccountSources([
      src({ id: 'a', name: '量子', url: 'https://cj.example/api' }),
      src({ id: 'b', name: '量子', url: 'https://cj2.example/api' }),
      src({ id: 'c', name: '非凡', url: 'https://cj.example/api' }),
    ])
    expect(out.map(s => s.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('groupServerSubscriptionSources 服务端订阅源分组', () => {
  it('按订阅 id 分组，非订阅条目跳过', () => {
    const payload = (id: string) => ({
      id,
      name: id,
      url: 'https://x.example/api',
      isEnabled: true,
      siteWide: false,
    })
    const grouped = groupServerSubscriptionSources([
      payload('sub:aaa:0'),
      payload('sub:aaa:1'),
      payload('sub:bbb:0'),
      payload('manual-1'),
      payload('sub::0'),
    ])
    expect([...grouped.keys()].sort()).toEqual(['aaa', 'bbb'])
    expect(grouped.get('aaa')?.map(s => s.id)).toEqual(['sub:aaa:0', 'sub:aaa:1'])
    expect(grouped.get('bbb')).toHaveLength(1)
  })
})

describe('excludeDeletedSources 已删名单过滤', () => {
  it('剔除名单内的源，其余原样保留', () => {
    const list = [src({ id: 'keep1' }), src({ id: 'dead1' }), src({ id: 'keep2' })]
    const out = excludeDeletedSources(list, ['dead1'])
    expect(out.map(s => s.id)).toEqual(['keep1', 'keep2'])
  })

  it('本次明确重新添加的源不受名单拦截', () => {
    const list = [src({ id: 'dead1' }), src({ id: 'dead2' })]
    const out = excludeDeletedSources(list, ['dead1', 'dead2'], ['dead2'])
    expect(out.map(s => s.id)).toEqual(['dead2'])
  })

  it('名单为空时原样返回', () => {
    const list = [src({ id: 'a' })]
    expect(excludeDeletedSources(list, [])).toBe(list)
  })
})

describe('computeReportedDeletions 上报删除计算', () => {
  it('服务端已知、本地已不存在的 id 即为删除', () => {
    expect(computeReportedDeletions(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b'])
  })

  it('本地都在时无删除', () => {
    expect(computeReportedDeletions(['a'], new Set(['a', 'b']))).toEqual([])
  })
})
