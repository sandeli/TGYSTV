/**
 * 真实分片吞吐测速（浏览器直连，在观众自己的网络环境里测）：
 * 取分集地址（m3u8）→ 解析播放列表 → 实际下载前几个真实分片（累计约 256KB）→
 * 用真实字节数与耗时算吞吐；码率取自主列表 BANDWIDTH 或按完整分片的字节/时长估算；
 * 排序主指标是「吞吐余量 = 吞吐 / 码率」——余量越大播得越稳，比单看延迟真实得多。
 *
 * 旧测法只测播放列表的首字节耗时，那测的是"起播快不快"，反映不了"播着卡不卡"。
 * 测速失败（跨域/超时/无分片）返回 null，调用方按未测速处理。
 */

export interface PlaybackProbeResult {
  /** 起播耗时（毫秒）：从开始探测到第一个分片下载完成 */
  startupMs: number
  /** 实测下载吞吐（Mbps） */
  throughputMbps: number
  /** 估算码率（Mbps）；无法估算时为空 */
  bitrateMbps?: number
  /** 吞吐余量（吞吐/码率，倍数）；码率未知时为空 */
  headroom?: number
  /** 清晰度标签（如 1080p / 2K / 4K，取自主列表最高分辨率档）；读不到时为空 */
  qualityLabel?: string
}

/**
 * 累计下载目标字节数：原为 1MB（能测出持续吞吐），但用户反馈测速整体太慢——
 * 慢源一个就占满 10 秒预算、并发轮测时面板半天出不齐数。2026-10-25 用户拍板
 * 全站降到 256KB：常见源一两个分片内即结算，速度约为原来的 2~4 倍；代价是短样本
 * 吞吐略带连接初期的爆发水分，排序与筛坏源仍然够用。例外：首个分片总是下完——
 * 起播耗时与「按完整分片估码率」都靠它，半截分片会让余量算不出来（时间预算仍封顶）。
 */
const TARGET_BYTES = 256_000
/** 最多下载的分片数（分片普遍 1~5MB，通常 1 个就够） */
const MAX_SEGMENTS = 4
/** 单次探测总时间预算（毫秒）：慢源下满 256KB 也可能很久，到点用已下载字节结算 */
const TIME_BUDGET_MS = 10_000
/** 部分结算的最低字节数：低于此值样本太小、数据不可信，按测速失败处理 */
const MIN_PARTIAL_BYTES = 128_000

/** 探测采样强度覆盖（默认 256KB / 10 秒）；目前全站统一走默认，保留接口供个别场景调强度 */
export interface ProbeOptions {
  targetBytes?: number
  timeBudgetMs?: number
}

/**
 * 直达播放解析页的测速结果缓存（按 源code:vodId 键）：解析页为了选源已经实测过
 * 若干源，进播放页后换源面板若从零重测，用户要等很久才看到几个「已测」。
 * 解析页离开前把结果存这里，换源钩子进页先灌入缓存命中的源、只补测没测过的。
 * 每次解析只保留最近一次的结果集，避免旧片子的结果串味。
 */
export interface CachedSourceProbe {
  probe: PlaybackProbeResult
  episodeUrl: string
}

let resolveProbeCache = new Map<string, CachedSourceProbe>()

export function cacheResolveProbes(entries: Map<string, CachedSourceProbe>): void {
  resolveProbeCache = new Map(entries)
}

export function readResolveProbe(sourceCode: string, vodId: string): CachedSourceProbe | undefined {
  return resolveProbeCache.get(`${sourceCode}:${vodId}`)
}

/**
 * 解析页的完整候选排名缓存（供播放页起播失败时自动换源）：以胜出源的 源:vod 为键，
 * 存当次全部候选的排名顺序。播放页详情若被源站 503 打死，连片名都拿不到、跨源发现
 * 无从启动，这份排名就是当时唯一的换源名单；键不匹配（不是从解析页来的）读不到。
 */
export interface ResolveCandidateEntry {
  sourceCode: string
  sourceName: string
  vodId: string
}

let resolveCandidatesCache: { winnerKey: string; candidates: ResolveCandidateEntry[] } | null = null

export function cacheResolveCandidates(
  winnerSourceCode: string,
  winnerVodId: string,
  candidates: ResolveCandidateEntry[],
): void {
  resolveCandidatesCache = {
    winnerKey: `${winnerSourceCode}:${winnerVodId}`,
    candidates: [...candidates],
  }
}

export function readResolveCandidates(
  sourceCode: string,
  vodId: string,
): ResolveCandidateEntry[] | undefined {
  if (!resolveCandidatesCache) return undefined
  if (resolveCandidatesCache.winnerKey !== `${sourceCode}:${vodId}`) return undefined
  return resolveCandidatesCache.candidates
}

export interface HlsVariant {
  url: string
  bandwidth?: number
  /** 分辨率高度（像素），来自 RESOLUTION=宽x高 */
  height?: number
}

export interface HlsSegment {
  url: string
  duration?: number
}

export interface HlsPlaylistInfo {
  variants: HlsVariant[]
  segments: HlsSegment[]
}

function resolveUrl(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).toString()
  } catch {
    return null
  }
}

/** 解析 m3u8 文本：主列表取 variants，媒体列表取 segments（纯函数，可测） */
export function parseHlsPlaylist(text: string, baseUrl: string): HlsPlaylistInfo {
  const variants: HlsVariant[] = []
  const segments: HlsSegment[] = []
  const lines = text.split(/\r?\n/)
  let pendingVariant: { bandwidth?: number; height?: number } | null = null
  let pendingDuration: number | undefined
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bw = /BANDWIDTH=(\d+)/.exec(line)
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(line)
      pendingVariant = {
        bandwidth: bw ? Number(bw[1]) : undefined,
        height: res ? Number(res[2]) : undefined,
      }
      continue
    }
    if (line.startsWith('#EXTINF')) {
      const m = /#EXTINF:\s*([\d.]+)/.exec(line)
      pendingDuration = m ? Number(m[1]) : undefined
      continue
    }
    if (line.startsWith('#')) continue
    const url = resolveUrl(line, baseUrl)
    if (!url) continue
    if (pendingVariant) {
      variants.push({ url, bandwidth: pendingVariant.bandwidth, height: pendingVariant.height })
      pendingVariant = null
    } else {
      segments.push({ url, duration: pendingDuration })
      pendingDuration = undefined
    }
  }
  return { variants, segments }
}

interface DownloadSample {
  bytes: number
  /** 每个分片各自的已下载字节数（与 urls 同序；最后一个可能只是部分） */
  segmentBytes: number[]
  /** 完整下完的分片个数 */
  completedSegments: number
  /** 下载阶段耗时（毫秒，不含播放列表请求） */
  elapsedMs: number
  /** 第一个分片下载完成时刻距探测开始的耗时（毫秒） */
  firstSegmentDoneMs: number | null
  /** 是否把计划内的分片全部下完（中止结算时为 false） */
  completedAll: boolean
}

/** 流式下载多个分片，边下边计数；达到目标字节/时间预算即中止并结算已下载部分 */
async function downloadSegments(
  urls: string[],
  signal: AbortSignal,
  startedAt: number,
  targetBytes: number,
  timeBudgetMs: number,
): Promise<DownloadSample> {
  let bytes = 0
  const segmentBytes: number[] = []
  let completedSegments = 0
  let firstSegmentDoneMs: number | null = null
  let completedAll = true
  const downloadStart = performance.now()
  outer: for (const url of urls) {
    // 首个分片总是下完（起播耗时与码率估算都靠完整分片），其后达到目标字节即停；时间预算始终生效
    if (
      (completedSegments >= 1 && bytes >= targetBytes) ||
      performance.now() - startedAt > timeBudgetMs
    ) {
      completedAll = false
      break
    }
    const response = await fetch(url, { method: 'GET', cache: 'no-store', signal })
    if (!response.ok) throw new Error(`segment http ${response.status}`)
    let thisSegment = 0
    const reader = response.body?.getReader()
    if (!reader) {
      const buf = await response.arrayBuffer()
      thisSegment = buf.byteLength
      bytes += thisSegment
    } else {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          thisSegment += value.byteLength
          bytes += value.byteLength
        }
        if (
          (completedSegments >= 1 && bytes >= targetBytes) ||
          performance.now() - startedAt > timeBudgetMs
        ) {
          completedAll = false
          void reader.cancel().catch(() => {})
          segmentBytes.push(thisSegment)
          break outer
        }
      }
    }
    segmentBytes.push(thisSegment)
    completedSegments += 1
    if (firstSegmentDoneMs === null) firstSegmentDoneMs = performance.now() - startedAt
  }
  return {
    bytes,
    segmentBytes,
    completedSegments,
    elapsedMs: Math.max(1, performance.now() - downloadStart),
    firstSegmentDoneMs,
    completedAll,
  }
}

/** 用完整下完的分片估算码率：Σ字节 / Σ时长（纯函数，可测） */
export function estimateBitrateMbps(
  segments: HlsSegment[],
  segmentBytes: number[],
  completedSegments: number,
): number | undefined {
  let bytes = 0
  let duration = 0
  for (let i = 0; i < completedSegments && i < segments.length; i += 1) {
    const d = segments[i].duration
    if (d && d > 0 && segmentBytes[i] > 0) {
      bytes += segmentBytes[i]
      duration += d
    }
  }
  if (bytes === 0 || duration === 0) return undefined
  return Math.round(((bytes * 8) / duration / 1_000_000) * 10) / 10
}

/** 分辨率高度 → 清晰度标签（与播放页 playlistQuality.formatQualityLabel 同口径） */
export function qualityLabelFromHeight(height: number): string {
  if (height >= 2000) return '4K'
  if (height >= 1300) return '2K'
  return `${height}p`
}

function buildResult(
  startupMs: number,
  bytes: number,
  elapsedMs: number,
  bitrateMbps: number | undefined,
  qualityLabel?: string,
): PlaybackProbeResult {
  const throughputMbps = Math.round(((bytes * 8) / (elapsedMs / 1000) / 1_000_000) * 10) / 10
  return {
    startupMs,
    throughputMbps,
    ...(bitrateMbps !== undefined ? { bitrateMbps } : {}),
    ...(bitrateMbps !== undefined && bitrateMbps > 0
      ? { headroom: Math.round((throughputMbps / bitrateMbps) * 10) / 10 }
      : {}),
    ...(qualityLabel !== undefined ? { qualityLabel } : {}),
  }
}

/**
 * 对一个分集地址做真实吞吐测速。episodeUrl 一般是 m3u8；
 * 若是直连媒体文件（mp4 等），直接对文件本身采样下载（只下约 256KB 即停，不会整文件下载）。
 */
export async function probePlayback(
  episodeUrl: string,
  opts?: ProbeOptions,
): Promise<PlaybackProbeResult | null> {
  let parsed: URL
  try {
    parsed = new URL(episodeUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const targetBytes = opts?.targetBytes ?? TARGET_BYTES
  const timeBudgetMs = opts?.timeBudgetMs ?? TIME_BUDGET_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeBudgetMs + 2000)
  const startedAt = performance.now()
  try {
    const firstResponse = await fetch(episodeUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!firstResponse.ok) return null

    // 先窥一眼开头判断是不是播放列表，避免把直连大文件整个拉下来
    const reader = firstResponse.body?.getReader()
    if (!reader) return null
    const firstChunk = await reader.read()
    const firstBytes = firstChunk.value ?? new Uint8Array()
    const headText = new TextDecoder().decode(firstBytes.slice(0, 512))
    if (!headText.includes('#EXTM3U')) {
      // 直连媒体文件：沿用当前连接继续采样下载
      let bytes = firstBytes.byteLength
      const downloadStart = startedAt
      let completedAll = firstChunk.done === true
      while (!completedAll && bytes < targetBytes && performance.now() - startedAt <= timeBudgetMs) {
        const { done, value } = await reader.read()
        if (done) {
          completedAll = true
          break
        }
        if (value) bytes += value.byteLength
      }
      if (!completedAll) {
        void reader.cancel().catch(() => {})
      }
      if (bytes === 0) return null
      if (!completedAll && bytes < MIN_PARTIAL_BYTES) return null
      return buildResult(
        Math.round(performance.now() - startedAt),
        bytes,
        Math.max(1, performance.now() - downloadStart),
        undefined,
      )
    }

    // 播放列表：把剩余正文读完再解析（列表本身很小）
    const chunks: Uint8Array[] = [firstBytes]
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.byteLength
    }
    const text = new TextDecoder().decode(merged)

    let info = parseHlsPlaylist(text, episodeUrl)
    let bitrateMbps: number | undefined
    let qualityLabel: string | undefined
    if (info.variants.length > 0) {
      // 清晰度标签取所有档位中的最高分辨率（与换源列表既有口径一致）
      const maxHeight = Math.max(0, ...info.variants.map(v => v.height ?? 0))
      if (maxHeight > 0) qualityLabel = qualityLabelFromHeight(maxHeight)
      // 主列表：选码率最高的档位测（观众在自适应下最终会升到这一档）
      const variant = [...info.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
      if (variant.bandwidth && variant.bandwidth > 0) {
        bitrateMbps = Math.round((variant.bandwidth / 1_000_000) * 10) / 10
      }
      const variantResponse = await fetch(variant.url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!variantResponse.ok) return null
      const variantText = await variantResponse.text()
      info = parseHlsPlaylist(variantText, variant.url)
    }
    if (info.segments.length === 0) return null

    const targetSegments = info.segments.slice(0, MAX_SEGMENTS)
    const sample = await downloadSegments(
      targetSegments.map(s => s.url),
      controller.signal,
      startedAt,
      targetBytes,
      timeBudgetMs,
    )
    if (sample.bytes === 0) return null
    if (!sample.completedAll && sample.bytes < MIN_PARTIAL_BYTES) return null

    if (bitrateMbps === undefined) {
      bitrateMbps = estimateBitrateMbps(
        targetSegments,
        sample.segmentBytes,
        sample.completedSegments,
      )
    }
    return buildResult(
      Math.round(sample.firstSegmentDoneMs ?? performance.now() - startedAt),
      sample.bytes,
      sample.elapsedMs,
      bitrateMbps,
      qualityLabel,
    )
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 测速结果排序（升序，越小越靠前）：已测速优先；先比吞吐余量（大者靠前）、
 * 再比吞吐（大者靠前）、最后比起播耗时（小者靠前）；未测速排最后。
 * 搜索结果页与直达播放选源共用同一套口径。
 */
export function compareProbeResults(
  a: PlaybackProbeResult | null | undefined,
  b: PlaybackProbeResult | null | undefined,
): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const headroomDiff = (b.headroom ?? -1) - (a.headroom ?? -1)
  if (headroomDiff !== 0) return headroomDiff
  const throughputDiff = b.throughputMbps - a.throughputMbps
  if (throughputDiff !== 0) return throughputDiff
  return a.startupMs - b.startupMs
}
