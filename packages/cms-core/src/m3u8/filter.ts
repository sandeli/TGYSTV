/**
 * M3U8过滤器类型
 */
export type M3u8Filter = (content: string) => string

/** 广告组判定：被标记分隔的短组总时长不超过该阈值（秒）视为广告（片头/片尾/插播） */
const SHORT_AD_GROUP_MAX_SECONDS = 60
/** 广告组判定：短组还须不超过全片总时长的该比例，避免把正片短段落误删（短片尤其重要） */
const SHORT_AD_GROUP_MAX_RATIO = 0.1
/** 保底：候选广告总时长超过全片该比例时整体放弃移除（判定不可靠，宁可不删） */
const BAIL_REMOVED_RATIO = 0.4
/** SCTE-35 广告窗组判定：整组分片都落在 CUE-OUT..CUE-IN 窗内且总时长不超过该上限（秒）视为广告 */
const CUE_AD_GROUP_MAX_SECONDS = 300
/** 广告地址特征：关键词须落在路径/文件名分隔边界上，避免 shadow、adventure 之类误判（借鉴 MoonTV 的 ad-filter） */
const AD_URL_PATTERN =
  /(^|[/_.-])(ad|ads|adv|advert|advertisement|advertising|guanggao|preroll|pre-roll|midroll|mid-roll|commercial|cueout|cue-out)([/_.-]|$)/i
/** 广告地址判定：组内只有部分分片命中特征词时，组总时长不超过该阈值（秒）才按广告处理 */
const AD_URL_PARTIAL_MAX_SECONDS = 90

interface SegmentBlock {
  /** EXTINF 之前附着的标签行（如 #EXT-X-KEY / #EXT-X-MAP），不含 discontinuity */
  preTags: string[]
  extinf: string
  /** EXTINF 与 URI 之间的标签行（如 #EXT-X-BYTERANGE） */
  midTags: string[]
  uri: string
  duration: number
  /** 该分片前有 discontinuity 分隔，即它开启一个新组 */
  startsGroup: boolean
  /** 该分片是否落在 SCTE-35 广告窗内（#EXT-X-CUE-OUT 之后、#EXT-X-CUE-IN 之前） */
  inCueWindow: boolean
}

interface SegmentGroup {
  segments: SegmentBlock[]
  duration: number
  /** 组内出现最多的绝对域名；全是相对地址时为空串 */
  dominantHost: string
}

/** 是否是 discontinuity 分隔行（精确匹配整行，避免误伤 #EXT-X-DISCONTINUITY-SEQUENCE 头） */
function isDiscontinuityLine(line: string): boolean {
  return line.trim() === '#EXT-X-DISCONTINUITY'
}

/** SCTE-35 广告窗开启行（前缀匹配同时覆盖 #EXT-X-CUE-OUT 与 #EXT-X-CUE-OUT-CONT） */
function isCueOutLine(line: string): boolean {
  return line.startsWith('#EXT-X-CUE-OUT')
}

/** SCTE-35 广告窗关闭行 */
function isCueInLine(line: string): boolean {
  return line.startsWith('#EXT-X-CUE-IN')
}

/** CUE 标记行（开启/关闭/续接都算）：移除广告后残留在保留分片上的标记应一并清掉 */
function isCueLine(line: string): boolean {
  return isCueOutLine(line) || isCueInLine(line)
}

function segmentHost(uri: string): string {
  try {
    return new URL(uri).hostname
  } catch {
    return ''
  }
}

/**
 * 把媒体清单解析成「头部行 + 分片块 + 尾部行」。
 * 解析不出任何分片（如主清单）时返回 null，调用方回退旧逻辑。
 */
function parseMediaPlaylist(content: string): {
  header: string[]
  segments: SegmentBlock[]
  trailer: string[]
} | null {
  const lines = content.split('\n')
  const firstExtinf = lines.findIndex(line => line.startsWith('#EXTINF'))
  if (firstExtinf === -1) return null

  // SCTE-35 广告窗状态：CUE-OUT（含 CUE-OUT-CONT）开启、CUE-IN 关闭；
  // 头部行里也可能出现 CUE-OUT（片头广告从首个分片起就在窗内），一并扫描
  let cueWindow = false
  const trackCueLine = (line: string): void => {
    if (isCueOutLine(line)) cueWindow = true
    else if (isCueInLine(line)) cueWindow = false
  }

  const header: string[] = []
  for (let i = 0; i < firstExtinf; i += 1) {
    trackCueLine(lines[i])
    if (!isDiscontinuityLine(lines[i])) header.push(lines[i])
  }

  const segments: SegmentBlock[] = []
  const trailer: string[] = []
  let pendingPreTags: string[] = []
  let current: Omit<SegmentBlock, 'uri'> | null = null
  let nextStartsGroup = true

  for (let i = firstExtinf; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('#EXTINF')) {
      current = {
        preTags: pendingPreTags,
        extinf: line,
        midTags: [],
        duration: Number.parseFloat(line.slice(line.indexOf(':') + 1)) || 0,
        startsGroup: nextStartsGroup,
        inCueWindow: cueWindow,
      }
      pendingPreTags = []
      nextStartsGroup = false
    } else if (isDiscontinuityLine(line)) {
      // 分隔标记本身不保留（与旧行为一致），只记录分组边界
      nextStartsGroup = true
    } else if (line.startsWith('#')) {
      trackCueLine(line)
      if (current) current.midTags.push(line)
      else pendingPreTags.push(line)
    } else if (line.trim() === '') {
      // 空行忽略
    } else if (current) {
      segments.push({ ...current, uri: line })
      current = null
    } else {
      trailer.push(line)
    }
  }
  // 最后一个分片之后留下的标签行（典型是 #EXT-X-ENDLIST）属于尾部，原样保留
  trailer.push(...pendingPreTags)

  if (segments.length === 0) return null
  return { header, segments, trailer }
}

function groupSegments(segments: SegmentBlock[]): SegmentGroup[] {
  const groups: SegmentGroup[] = []
  for (const segment of segments) {
    if (segment.startsGroup || groups.length === 0) {
      groups.push({ segments: [], duration: 0, dominantHost: '' })
    }
    const group = groups[groups.length - 1]
    group.segments.push(segment)
    group.duration += segment.duration
  }
  for (const group of groups) {
    const counts = new Map<string, number>()
    for (const segment of group.segments) {
      const host = segmentHost(segment.uri)
      if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
    }
    let best = ''
    let bestCount = 0
    for (const [host, count] of counts) {
      if (count > bestCount) {
        best = host
        bestCount = count
      }
    }
    group.dominantHost = best
  }
  return groups
}

/** 旧行为：只移除 discontinuity 标记行（新逻辑不适用或判定不可靠时的回退） */
function stripDiscontinuityMarkers(content: string): string {
  return content
    .split('\n')
    .filter(line => !isDiscontinuityLine(line))
    .join('\n')
}

/**
 * 创建默认广告过滤器（段级移除）
 *
 * 采集源的插播广告在清单里呈「正片 → #EXT-X-DISCONTINUITY → 广告组 → 标记 → 正片」
 * 结构。本过滤器按标记分组后整组移除广告分片，而非旧版只删标记行（广告照播）：
 * - 异域名组：组内分片主域名与正片（总时长最长的组）主域名不同 → 广告（片头/片尾/插播均可）
 * - SCTE-35 广告窗组：整组分片都落在 #EXT-X-CUE-OUT..#EXT-X-CUE-IN 窗内且 ≤300 秒 → 广告
 * - 广告地址组：整组分片地址都带广告特征词，或组 ≤90 秒且部分命中 → 广告
 * - 短分隔组：位于片头/片尾/中间、被标记分隔、总时长 ≤60 秒且 ≤全片 10% 的组 → 广告
 *   （片头是 QQ 群口播等招商段最常见的出现位置，旧规则只删中间组、会把它漏掉）
 *
 * 保底：仅处理带 #EXT-X-ENDLIST 的点播清单（直播清单回退旧行为）；候选总时长
 * 超过全片 40%、或会把分片删空时放弃移除、回退旧行为，绝不因过滤破坏播放。
 */
export function createDefaultAdFilter(): M3u8Filter {
  return (content: string): string => {
    if (!content) return ''
    if (!content.includes('#EXT-X-ENDLIST')) return stripDiscontinuityMarkers(content)

    const parsed = parseMediaPlaylist(content)
    if (!parsed) return stripDiscontinuityMarkers(content)
    const { header, segments, trailer } = parsed

    const groups = groupSegments(segments)
    if (groups.length < 2) return stripDiscontinuityMarkers(content)

    const totalDuration = groups.reduce((sum, g) => sum + g.duration, 0)
    if (totalDuration <= 0) return stripDiscontinuityMarkers(content)

    // 正片组 = 总时长最长的组；其主域名作为正片域名基准
    const contentGroup = groups.reduce((a, b) => (b.duration > a.duration ? b : a))
    const contentHost = contentGroup.dominantHost

    const adGroups = new Set<SegmentGroup>()
    for (const group of groups) {
      if (group === contentGroup) continue
      if (contentHost && group.dominantHost && group.dominantHost !== contentHost) {
        adGroups.add(group)
        continue
      }
      // SCTE-35 广告窗：整组分片都落在 CUE-OUT..CUE-IN 内即广告（源站自带的显式标记，
      // 同域名、同长度也认）；300 秒上限防异常源把正片整段标进窗内
      if (
        group.segments.every(s => s.inCueWindow) &&
        group.duration <= CUE_AD_GROUP_MAX_SECONDS
      ) {
        adGroups.add(group)
        continue
      }
      // 广告地址特征：整组分片地址都带广告词，或组较短且有部分命中
      const adUrlHits = group.segments.filter(s => AD_URL_PATTERN.test(s.uri)).length
      if (
        adUrlHits > 0 &&
        (adUrlHits === group.segments.length || group.duration <= AD_URL_PARTIAL_MAX_SECONDS)
      ) {
        adGroups.add(group)
        continue
      }
      // 短组不论位置（片头/片尾/插播）都按广告处理：片头恰是口播招商段最常见的位置
      if (
        group.duration <= SHORT_AD_GROUP_MAX_SECONDS &&
        group.duration <= totalDuration * SHORT_AD_GROUP_MAX_RATIO
      ) {
        adGroups.add(group)
      }
    }
    if (adGroups.size === 0) return stripDiscontinuityMarkers(content)

    const removedDuration = [...adGroups].reduce((sum, g) => sum + g.duration, 0)
    const keptGroups = groups.filter(g => !adGroups.has(g))
    if (keptGroups.length === 0 || removedDuration > totalDuration * BAIL_REMOVED_RATIO) {
      return stripDiscontinuityMarkers(content)
    }

    const keptSegments = keptGroups.flatMap(g => g.segments)
    // 片头广告被移除时，MEDIA-SEQUENCE 按移除的分片数前移，保持序号语义
    const firstKeptIndex = segments.indexOf(keptSegments[0])
    const removedBefore = segments.slice(0, firstKeptIndex).length
    const outHeader = header.map(line => {
      const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line)
      if (match && removedBefore > 0) {
        return `#EXT-X-MEDIA-SEQUENCE:${Number.parseInt(match[1], 10) + removedBefore}`
      }
      return line
    })

    const out: string[] = [...outHeader]
    for (const segment of keptSegments) {
      // 保留分片上残留的 CUE 标记（多为广告窗的 CUE-IN）随广告一并清掉，KEY/MAP 等标签不动
      out.push(
        ...segment.preTags.filter(line => !isCueLine(line)),
        segment.extinf,
        ...segment.midTags.filter(line => !isCueLine(line)),
        segment.uri,
      )
    }
    out.push(...trailer.filter(line => !isCueLine(line)))
    return out.join('\n')
  }
}

/**
 * 创建基于模式的过滤器
 * @param patterns 要移除的行的正则模式
 */
export function createPatternFilter(patterns: RegExp[]): M3u8Filter {
  return (content: string): string => {
    if (!content) return ''

    const lines = content.split('\n')
    const filteredLines = lines.filter(line => {
      return !patterns.some(pattern => pattern.test(line))
    })

    return filteredLines.join('\n')
  }
}

/**
 * 组合多个过滤器
 * @param filters 过滤器列表
 */
export function composeFilters(...filters: M3u8Filter[]): M3u8Filter {
  return (content: string): string => {
    return filters.reduce((acc, filter) => filter(acc), content)
  }
}
