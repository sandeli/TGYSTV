import { describe, expect, it } from 'vitest'
import {
  pickBestCandidate,
  qualifiesForEarlyStart,
  resolveStatusText,
  shouldEarlyStart,
  type AutoPlayCandidate,
} from './AutoPlayResolveView'
import type { PlaybackProbeResult } from '@/shared/lib/playbackProbe'

const probe = (partial: Partial<PlaybackProbeResult>): PlaybackProbeResult => ({
  startupMs: 500,
  throughputMbps: 10,
  ...partial,
})

const c = (partial: Partial<AutoPlayCandidate>): AutoPlayCandidate => ({
  sourceId: 's',
  sourceName: '源',
  vodId: '1',
  tier: 2,
  probe: null,
  ...partial,
})

describe('pickBestCandidate', () => {
  it('空候选返回 null', () => {
    expect(pickBestCandidate([])).toBeNull()
  })

  it('档位优先于测速：档位 0 的低余量源胜过档位 2 的高余量源', () => {
    const best = pickBestCandidate([
      c({ sourceId: 'a', tier: 2, probe: probe({ headroom: 8, throughputMbps: 40 }) }),
      c({ sourceId: 'b', tier: 0, probe: probe({ headroom: 1.2, throughputMbps: 6 }) }),
    ])
    expect(best?.sourceId).toBe('b')
  })

  it('同档位比吞吐余量：起播慢但余量大的源胜出（播得稳优先）', () => {
    const best = pickBestCandidate([
      c({ sourceId: 'a', tier: 1, probe: probe({ startupMs: 200, headroom: 1.1, throughputMbps: 5.5 }) }),
      c({ sourceId: 'b', tier: 1, probe: probe({ startupMs: 900, headroom: 4, throughputMbps: 20 }) }),
    ])
    expect(best?.sourceId).toBe('b')
  })

  it('同档位已测速优先于未测速', () => {
    const best = pickBestCandidate([
      c({ sourceId: 'a', tier: 1, probe: null }),
      c({ sourceId: 'b', tier: 1, probe: probe({ headroom: 2 }) }),
    ])
    expect(best?.sourceId).toBe('b')
  })

  it('全未测速时返回第一个候选', () => {
    const best = pickBestCandidate([c({ sourceId: 'a' }), c({ sourceId: 'b' })])
    expect(best?.sourceId).toBe('a')
  })
})

describe('qualifiesForEarlyStart 好源即开播门槛', () => {
  it('精确匹配 + 起播快 + 余量足 → 提前开播', () => {
    expect(
      qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 800, headroom: 3 }) })),
    ).toBe(true)
    // 门槛边界：起播恰好 1.2 秒、余量恰好 3 倍也放行
    expect(
      qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 1200, headroom: 3 }) })),
    ).toBe(true)
  })

  it('非精确匹配（档位 >0）哪怕测速好也不提前', () => {
    expect(
      qualifiesForEarlyStart(c({ tier: 1, probe: probe({ startupMs: 300, headroom: 9 }) })),
    ).toBe(false)
  })

  it('起播慢或余量不足不提前', () => {
    expect(
      qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 2600, headroom: 5 }) })),
    ).toBe(false)
    expect(
      qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 500, headroom: 1.4 }) })),
    ).toBe(false)
    // 旧门槛（2 秒 / 2 倍）能过的源，新门槛下不再提前——防「秒开但播不动」
    expect(
      qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 1800, headroom: 2.5 }) })),
    ).toBe(false)
  })

  it('无余量数据时用绝对吞吐兜底判定', () => {
    expect(qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 500, throughputMbps: 12 }) }))).toBe(
      true,
    )
    expect(qualifiesForEarlyStart(c({ tier: 0, probe: probe({ startupMs: 500, throughputMbps: 5 }) }))).toBe(
      false,
    )
  })

  it('未测速（probe 为空）不提前', () => {
    expect(qualifiesForEarlyStart(c({ tier: 0, probe: null }))).toBe(false)
  })
})

describe('shouldEarlyStart 至少测三个再提前开播', () => {
  const good = c({ sourceId: 'good', tier: 0, probe: probe({ startupMs: 600, headroom: 3 }) })
  const meh = c({ sourceId: 'meh', tier: 0, probe: probe({ startupMs: 900, headroom: 1.2 }) })

  it('只测完 1~2 个时，哪怕有好源也不提前', () => {
    expect(shouldEarlyStart([good], 1)).toBe(false)
    expect(shouldEarlyStart([good, meh], 2)).toBe(false)
  })

  it('测完 3 个且最佳候选达标 → 提前开播', () => {
    expect(shouldEarlyStart([meh, good, meh], 3)).toBe(true)
    expect(shouldEarlyStart([meh, good, meh], 6)).toBe(true)
  })

  it('测完 3 个但最佳候选不达标 → 继续等', () => {
    expect(shouldEarlyStart([meh, meh, meh], 3)).toBe(false)
    expect(shouldEarlyStart([], 3)).toBe(false)
  })
})

describe('resolveStatusText', () => {
  it('搜索未到九成时显示优选进行中（不报计数）', () => {
    expect(resolveStatusText({ searched: 0, total: 20 })).toBe('正在优选播放源…')
    expect(resolveStatusText({ searched: 10, total: 20 })).toBe('正在优选播放源…')
    expect(resolveStatusText({ searched: 17, total: 20 })).toBe('正在优选播放源…')
  })

  it('进度条快到底（≥90%）时显示准备就绪', () => {
    expect(resolveStatusText({ searched: 18, total: 20 })).toBe('准备就绪，即将开始播放…')
    expect(resolveStatusText({ searched: 20, total: 20 })).toBe('准备就绪，即将开始播放…')
    expect(resolveStatusText({ searched: 9, total: 10 })).toBe('准备就绪，即将开始播放…')
  })

  it('没有源时保持优选文案（页面会立即兜底跳转）', () => {
    expect(resolveStatusText({ searched: 0, total: 0 })).toBe('正在优选播放源…')
  })
})
