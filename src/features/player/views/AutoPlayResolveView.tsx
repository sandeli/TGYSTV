import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { VideoSource } from '@tgys/cms-core'
import { Play } from 'lucide-react'
import { useCmsClient } from '@/shared/hooks'
import { useApiStore } from '@/shared/store/apiStore'
import { getTitleMatchTier } from '@/features/search/hooks/directSearch.utils'
import { buildDoubanSearchPath } from '@/shared/lib/douban'
import { buildCmsPlayPath } from '@/shared/lib/routes'
import {
  cacheResolveCandidates,
  cacheResolveProbes,
  compareProbeResults,
  probePlayback,
  type CachedSourceProbe,
  type PlaybackProbeResult,
} from '@/shared/lib/playbackProbe'

/**
 * 豆瓣墙点击直达播放的解析页（/play/auto?q=片名）：
 * 跨源搜索同名资源 → 按标题匹配档位筛候选 → 逐个实测第一集真实分片吞吐 →
 * 选出最稳的源后 replace 跳转到标准播放地址 /play/cms/:source/:vodId（播放页本体不感知此流程）。
 * 规则与搜索结果页一致：先比匹配档位，再比测速（吞吐余量优先、再比吞吐、再比起播），测不出的排后面。
 * 等待时长三段收口（v2.33.0 起，之前是等全场扫完、最长 30 秒，体感太慢）：
 * ① 好源即开播——至少测完 3 个候选后，其中最佳的精确匹配候选起播 ≤1.2 秒且吞吐余量
 *    ≥3 倍（无余量数据时吞吐 ≥12Mbps）就结束等待（只测一个就开播太草率、门槛松了会
 *    选到「秒开但播不动」的源，用户反馈后两轮收紧）；
 *    ② 15 秒软上限——已有测完的候选就用当前最佳；③ 30 秒硬上限兜底
 *    （v2.1.43 由 10 秒放宽的教训保留：软/硬上限都只在「已有可用候选」时才触发早选）。
 * 一个候选都没有则等搜索扫完后回退搜索结果页。
 */

export interface AutoPlayCandidate {
  sourceId: string
  sourceName: string
  vodId: string
  tier: number
  probe: PlaybackProbeResult | null
  /** 探测时取到的第一集地址，随测速结果一起缓存给播放页换源面板复用 */
  episodeUrl?: string
}

/** 候选排序：档位优先，其次按真实吞吐测速口径（纯函数，可测） */
/** 候选按优劣排名（档位优先、再测速口径）：选源取第一名，播放页自动换源名单也用这个顺序 */
export function rankAutoPlayCandidates(candidates: AutoPlayCandidate[]): AutoPlayCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return compareProbeResults(a.probe, b.probe)
  })
}

export function pickBestCandidate(candidates: AutoPlayCandidate[]): AutoPlayCandidate | null {
  if (candidates.length === 0) return null
  return rankAutoPlayCandidates(candidates)[0]
}

const SEARCH_WORKERS = 4
const PROBE_WORKERS = 3
const RESOLVE_DEADLINE_MS = 30000
/** 软上限：到时已有测完的候选就用当前最佳开播，不再等慢源（硬上限仍为 RESOLVE_DEADLINE_MS） */
const SOFT_DEADLINE_MS = 15000
/** 提前开播门槛：精确匹配候选起播不超过该耗时（毫秒） */
const EARLY_START_MAX_STARTUP_MS = 1200
/** 提前开播门槛：吞吐余量（有码率估算时）至少该倍数（测速只是短样本，余量留厚些防「秒开但播不动」） */
const EARLY_START_MIN_HEADROOM = 3
/** 提前开播门槛：无码率估算时以绝对吞吐兜底（Mbps） */
const EARLY_START_MIN_THROUGHPUT_MBPS = 12
/** 提前开播前至少测完的候选数：只测一个就开播太草率，攒够约三个再在其中挑最好的 */
const EARLY_START_MIN_PROBES = 3

/**
 * 该候选是否「足够好、可以不等全场直接开播」：必须是片名精确匹配（档位 0），
 * 且实测起播快、吞吐余量足。等待的长尾主要是慢源在逐个测速，一旦手里有这样的
 * 源，继续等下去几乎不会换出更好的选择，先开播省下的时间最可观。
 */
export function qualifiesForEarlyStart(candidate: AutoPlayCandidate): boolean {
  if (candidate.tier !== 0 || !candidate.probe) return false
  if (candidate.probe.startupMs > EARLY_START_MAX_STARTUP_MS) return false
  if (typeof candidate.probe.headroom === 'number') {
    return candidate.probe.headroom >= EARLY_START_MIN_HEADROOM
  }
  return candidate.probe.throughputMbps >= EARLY_START_MIN_THROUGHPUT_MBPS
}

/**
 * 是否现在就提前开播：至少测完 EARLY_START_MIN_PROBES 个候选，且当前最佳候选
 * 达到好源门槛。候选总数不足三个的片子不受此限——那种情况走「搜完+测完」的
 * 常规收口，不会因为凑不齐三个而干等。
 */
export function shouldEarlyStart(candidates: AutoPlayCandidate[], probesDone: number): boolean {
  if (probesDone < EARLY_START_MIN_PROBES) return false
  const best = pickBestCandidate(candidates)
  return best !== null && qualifiesForEarlyStart(best)
}

/**
 * 解析页所处阶段：不报计数，只报阶段——搜索进度条快到底（≥90%）时进入临开播阶段，
 * 其余时间都是优选进行中（纯函数，可测）。
 */
export function resolvePhase(progress: { searched: number; total: number }): 'ready' | 'searching' {
  return progress.total > 0 && progress.searched / progress.total >= 0.9 ? 'ready' : 'searching'
}

/** 阶段 → 状态文案 */
export function resolveStatusText(progress: { searched: number; total: number }): string {
  return resolvePhase(progress) === 'ready' ? '准备就绪，即将开始播放…' : '正在优选播放源…'
}

export default function AutoPlayResolveView() {
  const navigate = useNavigate()
  const cmsClient = useCmsClient()
  // 标题只在挂载时从地址读一次并冻结：跳去播放页后地址里的 ?q 会消失，若响应式重读，
  // 标题变空会触发下方空标题守卫，把刚跳的播放页又顶回首页（v2.1.44 实测踩中）
  const [title] = useState(
    () => (new URLSearchParams(window.location.search).get('q') ?? '').trim(),
  )

  const [progress, setProgress] = useState({ searched: 0, total: 0, found: 0, probed: 0 })
  const runRef = useRef(0)

  useEffect(() => {
    if (!title) {
      navigate('/', { replace: true })
      return
    }
    const runId = ++runRef.current
    let cancelled = false
    let finished = false
    let searchDone = false
    let probesActive = 0
    let probesDone = 0
    let searchedCount = 0
    const candidates: AutoPlayCandidate[] = []
    const probeQueue: AutoPlayCandidate[] = []
    const sources: VideoSource[] = useApiStore.getState().getSelectedAPIs()
    setProgress({ searched: 0, total: sources.length, found: 0, probed: 0 })

    const finish = () => {
      if (finished || cancelled || runId !== runRef.current) return
      finished = true
      const best = pickBestCandidate(candidates)
      if (best) {
        // 把已测候选的测速结果缓存给播放页换源面板：进页即有现成数据，不必从零重测
        const probedEntries = new Map<string, CachedSourceProbe>()
        for (const c of candidates) {
          if (c.probe && c.episodeUrl) {
            probedEntries.set(`${c.sourceId}:${c.vodId}`, { probe: c.probe, episodeUrl: c.episodeUrl })
          }
        }
        if (probedEntries.size > 0) cacheResolveProbes(probedEntries)
        // 完整候选排名也缓存：播放页起播失败（详情 503 等）时按这个顺序自动换源
        cacheResolveCandidates(
          best.sourceId,
          best.vodId,
          rankAutoPlayCandidates(candidates).map(c => ({
            sourceCode: c.sourceId,
            sourceName: c.sourceName,
            vodId: c.vodId,
          })),
        )
        // 选源交代：让用户（和排障）一眼看出解析页选出了哪个源、测速多少
        toast.success(
          `已为你选源：${best.sourceName}${best.probe ? ` · 起播 ${best.probe.startupMs} ms · 吞吐 ${best.probe.throughputMbps} Mbps` : ' · 未测得速度'}`,
        )
        navigate(buildCmsPlayPath(best.sourceId, best.vodId), { replace: true })
      } else {
        toast.error(`已搜索 ${searchedCount} 个源，未找到可直接播放的，已为你打开搜索结果`)
        navigate(buildDoubanSearchPath(title), { replace: true })
      }
    }

    const maybeFinish = () => {
      if (searchDone && probesActive === 0 && probeQueue.length === 0) finish()
    }

    const softDeadline = setTimeout(() => {
      // 软上限：已有测完的候选就用当前最佳开播，不再陪慢源耗着
      if (candidates.some(c => c.probe)) finish()
    }, SOFT_DEADLINE_MS)

    const deadline = setTimeout(() => {
      // 硬上限：已有候选就用当前最佳开播；还没有则等搜索扫完再兜底
      if (candidates.length > 0) finish()
    }, RESOLVE_DEADLINE_MS)

    const probeOne = async (candidate: AutoPlayCandidate) => {
      const source = sources.find(s => s.id === candidate.sourceId)
      if (!source) return
      try {
        const detail = await cmsClient.getDetail(candidate.vodId, source)
        const episodeUrl = detail.episodes?.[0]
        if (!detail.success || !episodeUrl) return
        candidate.episodeUrl = episodeUrl
        // 真实分片吞吐测速（自带 10 秒预算）；失败保持 probe=null，排序时排后面
        candidate.probe = await probePlayback(episodeUrl)
      } catch {
        // 详情拉取失败：候选保留但无测速数据
      }
    }

    // 固定测速池：轮询队列，搜索结束且队列清空后退出
    const probeWorker = async () => {
      for (;;) {
        if (cancelled) return
        const candidate = probeQueue.shift()
        if (candidate) {
          probesActive += 1
          await probeOne(candidate)
          probesActive -= 1
          probesDone += 1
          if (!cancelled) setProgress(p => ({ ...p, probed: probesDone }))
          // 好源即开播：至少测完三个候选、且最佳的那个足够稳，就结束等待，不陪长尾慢源
          if (shouldEarlyStart(candidates, probesDone)) {
            finish()
            return
          }
          maybeFinish()
          continue
        }
        if (searchDone) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    const searchWorker = async (queue: VideoSource[]) => {
      while (!cancelled && queue.length > 0) {
        const source = queue.shift()
        if (!source) break
        try {
          const result = await cmsClient.search(title, source)
          if (cancelled) return
          if (result.success) {
            let best: { vodId: string; tier: number } | null = null
            for (const item of result.items ?? []) {
              const tier = getTitleMatchTier(item.vod_name ?? '', title)
              if (tier > 2) continue
              if (!best || tier < best.tier) best = { vodId: String(item.vod_id), tier }
              if (tier === 0) break
            }
            if (best) {
              const candidate: AutoPlayCandidate = {
                sourceId: source.id,
                sourceName: source.name,
                vodId: best.vodId,
                tier: best.tier,
                probe: null,
              }
              candidates.push(candidate)
              // 按档位插入测速队列：精确匹配的候选先测，兜底超时早选时手里已有靠谱数据
              const insertAt = probeQueue.findIndex(q => q.tier > candidate.tier)
              if (insertAt === -1) probeQueue.push(candidate)
              else probeQueue.splice(insertAt, 0, candidate)
              setProgress(p => ({ ...p, found: candidates.length }))
            }
          }
        } catch {
          // 单个源搜索失败静默跳过
        }
        searchedCount += 1
        if (!cancelled) setProgress(p => ({ ...p, searched: searchedCount }))
      }
    }

    for (let i = 0; i < PROBE_WORKERS; i += 1) void probeWorker()
    const searchQueue = [...sources]
    const workers = Array.from({ length: Math.min(SEARCH_WORKERS, searchQueue.length) }, () =>
      searchWorker(searchQueue),
    )
    void Promise.all(workers).then(() => {
      searchDone = true
      maybeFinish()
    })
    if (sources.length === 0) {
      searchDone = true
      finish()
    }

    return () => {
      cancelled = true
      clearTimeout(softDeadline)
      clearTimeout(deadline)
    }
    // 只按标题跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      {/* 旋转光环 + 中央播放键的载入动画 */}
      <div className="relative flex size-28 items-center justify-center">
        <div className="border-primary/15 absolute inset-0 rounded-full border-4" />
        <div className="border-primary absolute inset-0 animate-spin rounded-full border-4 border-t-transparent [animation-duration:1.6s]" />
        <div className="border-primary/40 absolute inset-3 animate-[spin_3.2s_linear_infinite_reverse] rounded-full border-2 border-b-transparent" />
        <div className="bg-primary/10 flex size-14 animate-pulse items-center justify-center rounded-full">
          <Play className="text-primary size-6 fill-current pl-0.5" />
        </div>
      </div>
      <div>
        <p className="text-lg font-semibold">
          正在为你挑最快的源
          <span className="ml-1 inline-flex gap-0.5 align-baseline">
            <span className="animate-bounce [animation-delay:0ms]">.</span>
            <span className="animate-bounce [animation-delay:150ms]">.</span>
            <span className="animate-bounce [animation-delay:300ms]">.</span>
          </span>
        </p>
        <p className="text-muted-foreground mt-1 text-sm">《{title}》</p>
      </div>
      {/* 搜索进度条 + 阶段文案（不报计数；临开播时文案转主色强调，与进度条呼应） */}
      <div className="w-64">
        <div className="bg-primary/15 h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-all duration-500"
            style={{
              width: `${progress.total > 0 ? Math.round((progress.searched / progress.total) * 100) : 0}%`,
            }}
          />
        </div>
        <p
          aria-live="polite"
          className={
            resolvePhase(progress) === 'ready'
              ? 'text-primary mt-4 text-sm font-medium tracking-[0.2em]'
              : 'text-muted-foreground mt-4 text-sm tracking-[0.2em]'
          }
        >
          {resolveStatusText(progress).replace(/…$/, '')}
          {/* 省略号做成与标题一致的三点跳动动画（颜色随文案阶段继承） */}
          <span className="ml-0.5 inline-flex gap-0.5 align-baseline">
            <span className="animate-bounce [animation-delay:0ms]">.</span>
            <span className="animate-bounce [animation-delay:150ms]">.</span>
            <span className="animate-bounce [animation-delay:300ms]">.</span>
          </span>
        </p>
      </div>
    </div>
  )
}
