import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cacheResolveProbes,
  compareProbeResults,
  estimateBitrateMbps,
  parseHlsPlaylist,
  probePlayback,
  readResolveProbe,
  type CachedSourceProbe,
  type PlaybackProbeResult,
} from './playbackProbe'

describe('parseHlsPlaylist', () => {
  it('主列表：解析各档位码率与相对地址', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
      'hi/index.m3u8',
    ].join('\n')
    const info = parseHlsPlaylist(text, 'https://cdn.example.com/v/9/master.m3u8')
    expect(info.variants).toEqual([
      { url: 'https://cdn.example.com/v/9/low/index.m3u8', bandwidth: 800000, height: 360 },
      { url: 'https://cdn.example.com/v/9/hi/index.m3u8', bandwidth: 5000000, height: 1080 },
    ])
    expect(info.segments).toEqual([])
  })

  it('媒体列表：解析分片与时长，跳过加密与广告标记行', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:5.5,',
      'seg-1.ts',
      '#EXTINF:6.0,',
      'https://other.example.com/seg-2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const info = parseHlsPlaylist(text, 'https://cdn.example.com/v/9/index.m3u8')
    expect(info.segments).toEqual([
      { url: 'https://cdn.example.com/v/9/seg-1.ts', duration: 5.5 },
      { url: 'https://other.example.com/seg-2.ts', duration: 6 },
    ])
  })
})

describe('estimateBitrateMbps', () => {
  it('用完整分片的字节/时长估算码率', () => {
    const segments = [
      { url: 'a', duration: 4 },
      { url: 'b', duration: 4 },
      { url: 'c', duration: 4 },
    ]
    // 前两个分片下完：各 600KB、共 8 秒 → 1.2 Mbps
    expect(estimateBitrateMbps(segments, [600_000, 600_000, 0], 2)).toBe(1.2)
  })

  it('没有完整分片或时长时返回 undefined', () => {
    expect(estimateBitrateMbps([{ url: 'a', duration: 4 }], [100], 0)).toBeUndefined()
    expect(estimateBitrateMbps([{ url: 'a' }], [100], 1)).toBeUndefined()
  })
})

describe('compareProbeResults', () => {
  const p = (partial: Partial<PlaybackProbeResult>): PlaybackProbeResult => ({
    startupMs: 500,
    throughputMbps: 10,
    ...partial,
  })

  it('余量优先于起播速度', () => {
    const fast = p({ startupMs: 150, headroom: 1.1, throughputMbps: 5.5 })
    const steady = p({ startupMs: 900, headroom: 4, throughputMbps: 20 })
    expect(compareProbeResults(steady, fast)).toBeLessThan(0)
    expect(compareProbeResults(fast, steady)).toBeGreaterThan(0)
  })

  it('余量相同比吞吐，吞吐相同比起播', () => {
    const a = p({ headroom: 2, throughputMbps: 12, startupMs: 800 })
    const b = p({ headroom: 2, throughputMbps: 10, startupMs: 100 })
    expect(compareProbeResults(a, b)).toBeLessThan(0)
    const c = p({ headroom: 2, throughputMbps: 10, startupMs: 300 })
    expect(compareProbeResults(b, c)).toBeLessThan(0)
  })

  it('未测速排最后', () => {
    expect(compareProbeResults(null, p({}))).toBeGreaterThan(0)
    expect(compareProbeResults(p({}), undefined)).toBeLessThan(0)
    expect(compareProbeResults(null, null)).toBe(0)
  })
})

function readerOf(chunks: Uint8Array[]) {
  let i = 0
  return {
    read: async () =>
      i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined },
    cancel: async () => {},
  }
}

function streamResponse(chunks: Uint8Array[]) {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => readerOf(chunks) },
    text: async () => chunks.map(c => new TextDecoder().decode(c)).join(''),
  }
}

describe('probePlayback（mock 网络）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('实下分片算出吞吐，并按完整分片估算码率与余量', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:4.0,',
      'seg1.ts',
      '#EXTINF:4.0,',
      'seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const segBytes = new Uint8Array(600_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('index.m3u8')) {
          return streamResponse([new TextEncoder().encode(playlist)])
        }
        return streamResponse([segBytes])
      }),
    )
    const result = await probePlayback('https://cdn.example.com/v/1/index.m3u8')
    expect(result).not.toBeNull()
    // 两个分片共 1.2MB，第一个分片下完即达到起播；码率按已完整下完的分片估算
    expect(result?.startupMs).toBeGreaterThanOrEqual(0)
    expect(result?.throughputMbps).toBeGreaterThan(0)
    expect(result?.bitrateMbps).toBe(1.2)
    expect(result?.headroom).toBeGreaterThan(0)
  })

  it('主列表：按最高档位测速，带出 BANDWIDTH 码率与清晰度标签', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
      'hi.m3u8',
    ].join('\n')
    const media = ['#EXTM3U', '#EXTINF:4.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n')
    const segBytes = new Uint8Array(1_100_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('master.m3u8')) return streamResponse([new TextEncoder().encode(master)])
        if (url.endsWith('hi.m3u8')) return streamResponse([new TextEncoder().encode(media)])
        if (url.endsWith('seg1.ts')) return streamResponse([segBytes])
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    const result = await probePlayback('https://cdn.example.com/v/2/master.m3u8')
    expect(result?.bitrateMbps).toBe(4)
    expect(result?.qualityLabel).toBe('1080p')
    expect(result?.headroom).toBeGreaterThan(0)
  })

  it('非法地址与非 http 协议直接返回 null', async () => {
    expect(await probePlayback('not a url')).toBeNull()
    expect(await probePlayback('magnet:?xt=urn:btih:abc')).toBeNull()
  })
})

describe('cacheResolveProbes / readResolveProbe 解析测速缓存', () => {
  const entry = (mbps: number): CachedSourceProbe => ({
    probe: { startupMs: 500, throughputMbps: mbps },
    episodeUrl: 'https://cdn.example.com/v/1/index.m3u8',
  })

  it('按 源:vod 键存取，键不匹配读不到', () => {
    cacheResolveProbes(new Map([['srcA:vod1', entry(20)]]))
    expect(readResolveProbe('srcA', 'vod1')?.probe.throughputMbps).toBe(20)
    expect(readResolveProbe('srcA', 'vod1')?.episodeUrl).toContain('index.m3u8')
    expect(readResolveProbe('srcA', 'vod2')).toBeUndefined()
    expect(readResolveProbe('srcB', 'vod1')).toBeUndefined()
  })

  it('新一次解析整体替换旧缓存，防串片', () => {
    cacheResolveProbes(new Map([['srcA:vod1', entry(20)]]))
    cacheResolveProbes(new Map([['srcB:vod9', entry(8)]]))
    expect(readResolveProbe('srcA', 'vod1')).toBeUndefined()
    expect(readResolveProbe('srcB', 'vod9')?.probe.throughputMbps).toBe(8)
  })
})
