import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VideoSource } from '@tgys/cms-core'
import { useCmsClient } from '@/shared/hooks'
import { useApiStore } from '@/shared/store/apiStore'
import { getTitleMatchTier } from '@/features/search/hooks/directSearch.utils'
import type { PlayerSourceOption } from './useTmdbPlayback'
import {
  compareProbeResults,
  probePlayback,
  readResolveProbe,
  type PlaybackProbeResult,
} from '@/shared/lib/playbackProbe'

interface UseSourceSpeedOptionsArgs {
  /** TMDB 路由：候选源由 useTmdbPlayback 提供，不再另行搜索 */
  isTmdbRoute: boolean
  tmdbOptions: PlayerSourceOption[]
  /** 直连/CMS 路由：按片名在其他源中搜索同名资源作为候选 */
  discoverTitle: string | null
  currentOption: PlayerSourceOption | null
}

interface SourceSpeedState {
  /** 已按真实吞吐测速排列的候选源（余量优先，未测出的排后面） */
  options: PlayerSourceOption[]
  /** 源 code -> 真实分片吞吐测速结果（起播耗时/吞吐/余量/清晰度） */
  probes: Map<string, PlaybackProbeResult>
  /** 源 code -> 清晰度标签（如 1080p / 2K / 4K）；清单里读不到分辨率的源没有 */
  qualities: Map<string, string>
  /** 已完成探测（成功或失败）的源 code */
  probedCodes: Set<string>
  /** 是否仍在发现/测速 */
  isWorking: boolean
  /** 是否仍在跨源匹配候选 */
  discovering: boolean
}

const MAX_CONCURRENT = 3

/**
 * 播放页换源候选 + 真实吞吐测速：
 * - TMDB 路由直接使用已匹配的源；直连路由按片名跨源搜索同名资源（标题匹配档位 ≤2 才入选）
 * - 对每个候选源实测第一集真实分片吞吐（浏览器直连，与搜索结果卡片同一套测速口径）
 * - 直达播放解析页已测过的源直接复用其结果（readResolveProbe），只补测没测过的
 * - 返回按吞吐余量排列的候选列表，测速结果到达后自动重排
 *
 * 注意副作用顺序：重置必须最先声明（标题/路由变化时先清状态），
 * 之后发现与探速才不会被随后的重置误伤。
 */
export function useSourceSpeedOptions({
  isTmdbRoute,
  tmdbOptions,
  discoverTitle,
  currentOption,
}: UseSourceSpeedOptionsArgs): SourceSpeedState {
  const cmsClient = useCmsClient()
  const cmsClientRef = useRef(cmsClient)
  cmsClientRef.current = cmsClient
  const { videoAPIs } = useApiStore()
  const videoApisRef = useRef(videoAPIs)
  videoApisRef.current = videoAPIs

  const [discovered, setDiscovered] = useState<PlayerSourceOption[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [probes, setProbes] = useState<Map<string, PlaybackProbeResult>>(new Map())
  const [qualities, setQualities] = useState<Map<string, string>>(new Map())
  const [probedCodes, setProbedCodes] = useState<Set<string>>(new Set())
  const probeRef = useRef<Map<string, PlaybackProbeResult>>(new Map())
  const qualityRef = useRef<Map<string, string>>(new Map())
  const doneRef = useRef<Set<string>>(new Set())
  const enqueuedRef = useRef<Set<string>>(new Set())
  const queueRef = useRef<PlayerSourceOption[]>([])
  const activeRef = useRef(0)
  const discoverRunRef = useRef(0)

  // ① 重置：标题或路由类型变化时清空上一部影片的候选与测速（必须最先声明）
  useEffect(() => {
    probeRef.current = new Map()
    qualityRef.current = new Map()
    doneRef.current = new Set()
    enqueuedRef.current = new Set()
    queueRef.current = []
    setProbes(new Map())
    setQualities(new Map())
    setProbedCodes(new Set())
    setDiscovered([])
    setDiscovering(false)
  }, [isTmdbRoute, discoverTitle])

  // ② 直连路由：跨源搜索同名资源（标题变化时重做）
  useEffect(() => {
    if (isTmdbRoute || !discoverTitle || !currentOption) return
    let cancelled = false
    const runId = ++discoverRunRef.current
    setDiscovering(true)

    const candidates = videoApisRef.current.filter(
      api => api.isEnabled && api.id !== currentOption.sourceCode,
    )
    let index = 0
    const worker = async () => {
      while (!cancelled && index < candidates.length) {
        const source = candidates[index]
        index += 1
        try {
          const result = await cmsClientRef.current.search(discoverTitle, source)
          if (cancelled || runId !== discoverRunRef.current || !result.success) continue
          let best: { vodId: string; tier: number } | null = null
          for (const item of result.items ?? []) {
            const tier = getTitleMatchTier(item.vod_name ?? '', discoverTitle)
            if (tier > 2) continue
            if (!best || tier < best.tier) best = { vodId: String(item.vod_id), tier }
            if (tier === 0) break
          }
          if (best && !cancelled) {
            const found = best
            setDiscovered(prev =>
              prev.some(o => o.sourceCode === source.id)
                ? prev
                : [
                    ...prev,
                    {
                      sourceCode: source.id,
                      sourceName: source.name,
                      bestVodId: found.vodId,
                      bestScore: 0,
                    },
                  ],
            )
          }
        } catch {
          // 单个源搜索失败静默跳过
        }
      }
    }
    const workers = Array.from({ length: Math.min(4, candidates.length) }, () => worker())
    void Promise.all(workers).then(() => {
      if (!cancelled && runId === discoverRunRef.current) setDiscovering(false)
    })
    return () => {
      cancelled = true
    }
    // videoAPIs 引用变化不重跑（配置中途变更不刷新候选），只随标题/当前源变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTmdbRoute, discoverTitle, currentOption?.sourceCode])

  // 候选集合：TMDB 用传入的；直连用 当前源 + 搜索发现的源
  const baseOptions = useMemo(() => {
    if (isTmdbRoute) return tmdbOptions
    const list: PlayerSourceOption[] = []
    if (currentOption) list.push(currentOption)
    for (const option of discovered) {
      if (!list.some(o => o.sourceCode === option.sourceCode)) list.push(option)
    }
    return list
  }, [isTmdbRoute, tmdbOptions, currentOption, discovered])

  // 真实吞吐探测：取详情第一集地址，实下约 256KB 分片量吞吐（结果按源 code 记录，幂等）
  const runProbe = useCallback(async (option: PlayerSourceOption) => {
    const finish = (result: PlaybackProbeResult | null) => {
      doneRef.current.add(option.sourceCode)
      setProbedCodes(new Set(doneRef.current))
      if (result !== null) {
        probeRef.current.set(option.sourceCode, result)
        setProbes(new Map(probeRef.current))
        if (result.qualityLabel) {
          qualityRef.current.set(option.sourceCode, result.qualityLabel)
          setQualities(new Map(qualityRef.current))
        }
      }
    }
    const source: VideoSource | undefined = videoApisRef.current.find(
      api => api.id === option.sourceCode,
    )
    if (!source || !option.bestVodId) {
      finish(null)
      return
    }
    try {
      const detail = await cmsClientRef.current.getDetail(option.bestVodId, source)
      const episodeUrl = detail.episodes?.[0]
      if (!detail.success || !episodeUrl) {
        finish(null)
        return
      }
      finish(await probePlayback(episodeUrl))
    } catch {
      finish(null)
    }
  }, [])

  const pumpQueue = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const option = queueRef.current.shift()
      if (!option) break
      activeRef.current += 1
      void runProbe(option).finally(() => {
        activeRef.current -= 1
        pumpQueue()
      })
    }
  }, [runProbe])

  // 直达播放解析页已测过的源直接灌入结果：进页即有现成测速，不必从零重测
  const seedFromResolveCache = useCallback((option: PlayerSourceOption): boolean => {
    if (!option.bestVodId) return false
    const cached = readResolveProbe(option.sourceCode, option.bestVodId)
    if (!cached) return false
    doneRef.current.add(option.sourceCode)
    probeRef.current.set(option.sourceCode, cached.probe)
    setProbedCodes(new Set(doneRef.current))
    setProbes(new Map(probeRef.current))
    if (cached.probe.qualityLabel) {
      qualityRef.current.set(option.sourceCode, cached.probe.qualityLabel)
      setQualities(new Map(qualityRef.current))
    }
    return true
  }, [])

  // ③ 候选出现后排队探测（每个源只测一次；解析页测过的直接用缓存）
  useEffect(() => {
    for (const option of baseOptions) {
      if (enqueuedRef.current.has(option.sourceCode)) continue
      enqueuedRef.current.add(option.sourceCode)
      if (seedFromResolveCache(option)) continue
      queueRef.current.push(option)
    }
    pumpQueue()
  }, [baseOptions, pumpQueue, seedFromResolveCache])

  const options = useMemo(() => {
    const sorted = [...baseOptions]
    sorted.sort((a, b) =>
      compareProbeResults(probes.get(a.sourceCode), probes.get(b.sourceCode)),
    )
    return sorted
  }, [baseOptions, probes])

  const isWorking = discovering || probedCodes.size < baseOptions.length

  return { options, probes, qualities, probedCodes, isWorking, discovering }
}
