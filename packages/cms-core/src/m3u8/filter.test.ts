import { describe, expect, it } from 'vitest'
import { createDefaultAdFilter } from './filter'

const filter = createDefaultAdFilter()

function seg(duration: number, uri: string): string {
  return `#EXTINF:${duration},\n${uri}`
}

const HEADER = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0']

describe('createDefaultAdFilter 段级广告移除', () => {
  it('移除异域名插播广告组，正片完整保留', () => {
    const content = [
      ...HEADER,
      seg(10, 'https://cdn.main.com/v/1.ts'),
      seg(10, 'https://cdn.main.com/v/2.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(5, 'https://ads.other.com/ad/1.ts'),
      seg(5, 'https://ads.other.com/ad/2.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(10, 'https://cdn.main.com/v/3.ts'),
      seg(10, 'https://cdn.main.com/v/4.ts'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
    const out = filter(content)
    expect(out).not.toContain('ads.other.com')
    expect(out).toContain('https://cdn.main.com/v/1.ts')
    expect(out).toContain('https://cdn.main.com/v/4.ts')
    expect(out).not.toContain('#EXT-X-DISCONTINUITY')
    expect(out).toContain('#EXT-X-ENDLIST')
  })

  it('移除同域名短包夹组（同 CDN 插播）', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY', seg(6, 'https://cdn.main.com/ad/x.ts'), '#EXT-X-DISCONTINUITY')
    for (let i = 21; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/ad/x.ts')
    expect(out).toContain('https://cdn.main.com/v/40.ts')
  })

  it('片头异域名广告移除时 MEDIA-SEQUENCE 按移除分片数前移', () => {
    const content = [
      ...HEADER,
      seg(5, 'https://ads.other.com/pre/1.ts'),
      seg(5, 'https://ads.other.com/pre/2.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(10, 'https://cdn.main.com/v/1.ts'),
      seg(10, 'https://cdn.main.com/v/2.ts'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
    const out = filter(content)
    expect(out).not.toContain('ads.other.com')
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:2')
  })

  it('无广告清单只删标记行，分片一个不少', () => {
    const content = [
      ...HEADER,
      seg(10, 'https://cdn.main.com/v/1.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(10, 'https://cdn.main.com/v/2.ts'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
    const out = filter(content)
    expect(out).toContain('https://cdn.main.com/v/1.ts')
    expect(out).toContain('https://cdn.main.com/v/2.ts')
    expect(out).not.toContain('#EXT-X-DISCONTINUITY')
  })

  it('直播清单（无 ENDLIST）不删分片，仅回退删标记行', () => {
    const content = [
      ...HEADER,
      seg(10, 'https://cdn.main.com/v/1.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(5, 'https://ads.other.com/ad/1.ts'),
      '',
    ].join('\n')
    const out = filter(content)
    expect(out).toContain('https://ads.other.com/ad/1.ts')
    expect(out).not.toContain('#EXT-X-DISCONTINUITY')
  })

  it('主清单（无 EXTINF）原样回退，不误删流地址', () => {
    const content = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      'https://cdn.main.com/low/index.m3u8',
      '',
    ].join('\n')
    expect(filter(content)).toBe(content)
  })

  it('每片都有标记的异常清单触发保底，分片不删', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 6; i += 1) {
      if (i > 1) parts.push('#EXT-X-DISCONTINUITY')
      parts.push(seg(5, `https://cdn.main.com/v/${i}.ts`))
    }
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    for (let i = 1; i <= 6; i += 1) {
      expect(out).toContain(`https://cdn.main.com/v/${i}.ts`)
    }
  })

  it('正片中间的长段落（超过短组阈值）不误删', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 10; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    // 中间插一段 90 秒的正片内容（如精彩回放），超过 60 秒阈值且同域名
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 1; i <= 9; i += 1) parts.push(seg(10, `https://cdn.main.com/replay/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 11; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).toContain('https://cdn.main.com/replay/1.ts')
    expect(out).toContain('https://cdn.main.com/replay/9.ts')
  })

  it('移除片头同域名短组（片头口播招商段最常见形态）', () => {
    const parts = [...HEADER]
    parts.push(seg(5, 'https://cdn.main.com/promo/1.ts'), seg(5, 'https://cdn.main.com/promo/2.ts'))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 1; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/promo/')
    expect(out).toContain('https://cdn.main.com/v/1.ts')
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:2')
  })

  it('移除片尾同域名短组（片尾招商段）', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY', seg(6, 'https://cdn.main.com/tail/1.ts'), seg(6, 'https://cdn.main.com/tail/2.ts'))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/tail/')
    expect(out).toContain('https://cdn.main.com/v/40.ts')
  })

  it('短片里片头短组占比过高时保留（防误删短视频的正片开头）', () => {
    const content = [
      ...HEADER,
      seg(10, 'https://cdn.main.com/v/1.ts'),
      seg(10, 'https://cdn.main.com/v/2.ts'),
      seg(10, 'https://cdn.main.com/v/3.ts'),
      '#EXT-X-DISCONTINUITY',
      seg(10, 'https://cdn.main.com/v/4.ts'),
      seg(10, 'https://cdn.main.com/v/5.ts'),
      seg(10, 'https://cdn.main.com/v/6.ts'),
      seg(10, 'https://cdn.main.com/v/7.ts'),
      seg(10, 'https://cdn.main.com/v/8.ts'),
      seg(10, 'https://cdn.main.com/v/9.ts'),
      seg(10, 'https://cdn.main.com/v/10.ts'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
    const out = filter(content)
    for (let i = 1; i <= 10; i += 1) {
      expect(out).toContain(`https://cdn.main.com/v/${i}.ts`)
    }
  })

  it('移除 SCTE-35 CUE 广告窗组（同域名、时长超过短组阈值，只有 CUE 信号能抓）', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY', '#EXT-X-CUE-OUT:DURATION=120')
    for (let i = 1; i <= 12; i += 1) {
      if (i === 2) parts.push('#EXT-X-CUE-OUT-CONT:DURATION=120,ELAPSED=10')
      parts.push(seg(10, `https://cdn.main.com/mid/${i}.ts`))
    }
    parts.push('#EXT-X-CUE-IN', '#EXT-X-DISCONTINUITY')
    for (let i = 21; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/mid/')
    expect(out).toContain('https://cdn.main.com/v/1.ts')
    expect(out).toContain('https://cdn.main.com/v/40.ts')
    // 广告窗标记不残留
    expect(out).not.toContain('#EXT-X-CUE')
  })

  it('CUE 广告窗超过 300 秒上限时不移除（防异常标记误伤正片）', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY', '#EXT-X-CUE-OUT:DURATION=400')
    for (let i = 1; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/mid/${i}.ts`))
    parts.push('#EXT-X-CUE-IN', '#EXT-X-DISCONTINUITY')
    for (let i = 21; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).toContain('https://cdn.main.com/mid/1.ts')
    expect(out).toContain('https://cdn.main.com/mid/40.ts')
  })

  it('移除整组广告地址组（同域名、时长超过短组阈值，全部命中广告词）', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 1; i <= 10; i += 1) parts.push(seg(10, `https://cdn.main.com/ad/seg${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 21; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/ad/seg')
    expect(out).toContain('https://cdn.main.com/v/40.ts')
  })

  it('较短组部分分片带广告地址（preroll）时整组移除', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 1; i <= 8; i += 1) {
      parts.push(seg(10, i <= 3 ? `https://cdn.main.com/preroll/${i}.ts` : `https://cdn.main.com/x/${i}.ts`))
    }
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 41; i <= 80; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).not.toContain('/preroll/')
    expect(out).not.toContain('/x/')
    expect(out).toContain('https://cdn.main.com/v/80.ts')
  })

  it('广告词边界防误判：shadow、adventure 等正常地址不删', () => {
    const parts = [...HEADER]
    for (let i = 1; i <= 20; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 1; i <= 10; i += 1) {
      parts.push(seg(10, i % 2 ? `https://cdn.main.com/shadow/${i}.ts` : `https://cdn.main.com/adventure/${i}.ts`))
    }
    parts.push('#EXT-X-DISCONTINUITY')
    for (let i = 21; i <= 40; i += 1) parts.push(seg(10, `https://cdn.main.com/v/${i}.ts`))
    parts.push('#EXT-X-ENDLIST', '')
    const out = filter(parts.join('\n'))
    expect(out).toContain('https://cdn.main.com/shadow/1.ts')
    expect(out).toContain('https://cdn.main.com/adventure/2.ts')
  })

  it('空内容返回空串', () => {
    expect(filter('')).toBe('')
  })
})
