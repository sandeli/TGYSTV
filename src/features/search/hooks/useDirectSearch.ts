import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { type VideoItem, type SearchResultEvent, type Pagination, type VideoSource } from '@tgys/cms-core'
import { useApiStore } from '@/shared/store/apiStore'
import { useCmsClient } from '@/shared/hooks'
import { PaginationConfig } from '@/shared/config/video.config'
import { getSourcesToFetch, type SourcePaginationInfo } from './directSearch.utils'
import { probePlayback, type PlaybackProbeResult } from '@/shared/lib/playbackProbe'

export function useDirectSearch() {
  const [directResults, setDirectResults] = useState<VideoItem[]>([])
  const [directLoading, setDirectLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [searchProgress, setSearchProgress] = useState({ completed: 0, total: 0 })
  const [cmsPagination, setCmsPagination] = useState<Pagination>({
    page: 1,
    totalPages: 0,
    totalResults: 0,
  })
  // 缓存每个源的分页信息，用于判断是否需要请求
  const sourcePaginationCacheRef = useRef<Map<string, SourcePaginationInfo>>(new Map())
  const abortCtrlRef = useRef<AbortController | null>(null)
  const timeOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentPageRef = useRef(1)
  // 新增：记录当前页需要请求的源列表
  const sourcesToFetchRef = useRef<VideoSource[]>([])
  // 新增：记录当前页已返回结果的源 ID 集合
  const [completedSourcesInCurrentPage, setCompletedSourcesInCurrentPage] = useState<Set<string>>(new Set())
  // 新增：记录当前页成功返回结果的源 ID 集合（有内容的源）
  const [successfulSourcesInCurrentPage, setSuccessfulSourcesInCurrentPage] = useState<Set<string>>(new Set())
  // 新增：请求版本号，用于处理竞态条件
  const requestVersionRef = useRef(0)
  // 各源测速：源 ID -> 本次搜索中该源的响应耗时（毫秒），用于结果按速度排序
  const [sourceLatencies, setSourceLatencies] = useState<Map<string, number>>(new Map())
  const sourceLatencyRef = useRef<Map<string, number>>(new Map())
  const searchStartRef = useRef(0)

  // 记录某源耗时（只记第一次，后续翻页不覆盖，保证排序稳定）
  const recordSourceLatency = useCallback((sourceId: string) => {
    if (!sourceId || sourceLatencyRef.current.has(sourceId)) return
    const latency = Math.round(performance.now() - searchStartRef.current)
    sourceLatencyRef.current.set(sourceId, latency)
    setSourceLatencies(new Map(sourceLatencyRef.current))
  }, [])

  // 把尚未记录耗时的源统一记为当前已耗时（超时/收尾时调用，这些源自然排最后）
  const fillMissingLatencies = useCallback(() => {
    let changed = false
    sourcesToFetchRef.current.forEach(source => {
      if (!sourceLatencyRef.current.has(source.id)) {
        sourceLatencyRef.current.set(
          source.id,
          Math.round(performance.now() - searchStartRef.current),
        )
        changed = true
      }
    })
    if (changed) setSourceLatencies(new Map(sourceLatencyRef.current))
  }, [])

  // 各源播放测速：源 ID -> 真实分片吞吐测速结果（起播耗时/吞吐/码率余量）
  const [playbackProbes, setPlaybackProbes] = useState<Map<string, PlaybackProbeResult>>(new Map())
  const playbackProbeRef = useRef<Map<string, PlaybackProbeResult>>(new Map())
  const probedSourcesRef = useRef<Set<string>>(new Set())
  const probeQueueRef = useRef<Array<{ source: VideoSource; vodId: string }>>([])
  const activeProbesRef = useRef(0)
  const probeVersionRef = useRef(0)

  const { videoAPIs } = useApiStore()
  const cmsClient = useCmsClient()
  const cmsClientRef = useRef(cmsClient)
  cmsClientRef.current = cmsClient

  // 对单个源做真实吞吐测速：取详情第一集地址，浏览器直连实下约 256KB 真实分片量吞吐
  const runProbe = useCallback(async (source: VideoSource, vodId: string, version: number) => {
    try {
      const detail = await cmsClientRef.current.getDetail(vodId, source)
      if (version !== probeVersionRef.current) return
      const episodeUrl = detail.episodes?.[0]
      if (!detail.success || !episodeUrl) return

      const result = await probePlayback(episodeUrl)
      if (!result) return
      if (version !== probeVersionRef.current) return
      playbackProbeRef.current.set(source.id, result)
      setPlaybackProbes(new Map(playbackProbeRef.current))
    } catch {
      // 探测失败（跨域限制/超时/无分集地址）静默处理，卡片不展示测速数据
    }
  }, [])

  const pumpProbeQueue = useCallback(() => {
    const MAX_CONCURRENT_PROBES = 3
    while (activeProbesRef.current < MAX_CONCURRENT_PROBES && probeQueueRef.current.length > 0) {
      const job = probeQueueRef.current.shift()
      if (!job) break
      activeProbesRef.current += 1
      void runProbe(job.source, job.vodId, probeVersionRef.current).finally(() => {
        activeProbesRef.current -= 1
        pumpProbeQueue()
      })
    }
  }, [runProbe])

  const selectedAPIs = useMemo(() => {
    return videoAPIs.filter(api => api.isEnabled)
  }, [videoAPIs])

  // 结果到达后，为每个有结果的源排队探测一次（每轮搜索每源只测一次）
  useEffect(() => {
    if (directResults.length === 0) return
    const seen = new Set<string>()
    for (const item of directResults) {
      const code = item.source_code
      if (!code || seen.has(code)) continue
      seen.add(code)
      if (probedSourcesRef.current.has(code)) continue
      const source = selectedAPIs.find(api => api.id === code)
      if (!source || !item.vod_id) continue
      probedSourcesRef.current.add(code)
      probeQueueRef.current.push({ source, vodId: String(item.vod_id) })
    }
    pumpProbeQueue()
  }, [directResults, selectedAPIs, pumpProbeQueue])

  const fetchDirectSearch = useCallback(async (keyword: string, page: number = 1) => {
    if (!keyword || selectedAPIs.length === 0) return

    // 增加版本号，用于处理竞态条件
    const currentVersion = ++requestVersionRef.current

    abortCtrlRef.current?.abort()
    const controller = new AbortController()
    abortCtrlRef.current = controller
    currentPageRef.current = page

    setDirectLoading(true)
    searchStartRef.current = performance.now()

    // 第1页时清空现有结果
    if (page === 1) {
      setDirectResults([])
      sourcePaginationCacheRef.current.clear()
      sourceLatencyRef.current.clear()
      setSourceLatencies(new Map())
      // 播放测速状态一并重置，并让上一轮未完成的探测失效
      probeVersionRef.current += 1
      probedSourcesRef.current.clear()
      probeQueueRef.current = []
      playbackProbeRef.current.clear()
      setPlaybackProbes(new Map())
      setCompletedSourcesInCurrentPage(new Set())
      setSuccessfulSourcesInCurrentPage(new Set())
    } else {
      // 翻页时清空当前页的已完成记录
      setCompletedSourcesInCurrentPage(new Set())
      setSuccessfulSourcesInCurrentPage(new Set())
    }

    // 根据缓存判断哪些源需要跳过
    const cachedSources = sourcePaginationCacheRef.current
    const sourcesToFetch = getSourcesToFetch(selectedAPIs, cachedSources, page)
    const totalRequestedSources = sourcesToFetch.length

    // 保存当前页需要请求的源列表
    sourcesToFetchRef.current = sourcesToFetch
    if (sourcesToFetch.length === 0) {
      setDirectLoading(false)
      setSearchProgress({ completed: selectedAPIs.length, total: selectedAPIs.length })
      setHasMore(false)
      if (timeOutTimer.current) {
        clearTimeout(timeOutTimer.current)
        timeOutTimer.current = null
      }
      return
    }
    setSearchProgress({ completed: 0, total: totalRequestedSources })

    if (timeOutTimer.current) {
      clearTimeout(timeOutTimer.current)
      timeOutTimer.current = null
    }
    timeOutTimer.current = setTimeout(() => {
      fillMissingLatencies()
      setDirectLoading(false)
      // 超时时，将所有需要请求的源标记为已完成
      // 这样可以避免因为某些源无响应而卡住
      if (sourcesToFetchRef.current.length > 0) {
        setCompletedSourcesInCurrentPage(prev => {
          const newSet = new Set(prev)
          sourcesToFetchRef.current.forEach(source => {
            newSet.add(source.id)
          })
          return newSet
        })
        setSearchProgress({
          completed: totalRequestedSources,
          total: totalRequestedSources,
        })
      }
      timeOutTimer.current = null
    }, PaginationConfig.maxRequestTimeout)

    // 用于累积分页信息
    const paginationMap = new Map<string, Pagination>()

    // Subscribe to search progress - 这是每个源完成（成功或失败）的可靠信号
    const unsubProgress = cmsClient.on('search:progress', (event) => {
      // Only process if this is the current request (handle race conditions)
      if (currentVersion !== requestVersionRef.current) return

      if (event.source?.id) {
        const sourceId = event.source.id
        const isInCurrentFetch = sourcesToFetchRef.current.some(s => s.id === sourceId)
        if (isInCurrentFetch) {
          // 源完成（成功或失败）即记下它的响应耗时
          recordSourceLatency(sourceId)
          setCompletedSourcesInCurrentPage(prev => {
            // 避免重复添加
            if (prev.has(sourceId)) return prev
            const newSet = new Set([...prev, sourceId])
            // 实时更新搜索进度
            setSearchProgress({
              completed: newSet.size,
              total: totalRequestedSources,
            })
            return newSet
          })
        }
      }
    })

    // Subscribe to incremental results
    const unsubResult = cmsClient.on('search:result', (event: SearchResultEvent) => {
      // If not the latest request, ignore results (handle race conditions)
      if (currentVersion !== requestVersionRef.current) return

      // 更新分页缓存
      if (event.pagination && event.source) {
        const cached = cachedSources.get(event.source.id)
        const paginationInfo: SourcePaginationInfo = {
          totalPages: event.pagination.totalPages,
          totalResults: event.pagination.totalResults,
        }
        // 只有当分页信息更新时才记录（处理空结果返回最后一页分页信息的情况）
        if (!cached || event.pagination.page <= event.pagination.totalPages) {
          cachedSources.set(event.source.id, paginationInfo)
        }
      }

      setDirectResults(prev => {
        // 累积所有源的结果
        return [...prev, ...event.items]
      })

      // 记录成功返回结果的源（有结果的源才算成功）
      if (event.source?.id && event.items.length > 0) {
        const sourceId = event.source.id
        const isInCurrentFetch = sourcesToFetchRef.current.some(s => s.id === sourceId)
        if (isInCurrentFetch) {
          setSuccessfulSourcesInCurrentPage(prev => {
            if (prev.has(sourceId)) return prev
            return new Set([...prev, sourceId])
          })
        }
      }

      // 注意：不在这里更新完成状态，由 search:progress 事件统一处理
      // 这样可以确保无论成功或失败（包括重试后），都只在一个地方标记完成

      // 收集分页信息
      if (event.pagination && event.source) {
        paginationMap.set(event.source.id, event.pagination)

        // 聚合分页信息：累加总数，取最大页数
        let totalResults = 0
        let maxTotalPages = 0
        // 合并缓存和新请求的分页信息
        const allSources = new Set([
          ...cachedSources.keys(),
          ...paginationMap.keys(),
        ])
        allSources.forEach(sourceId => {
          const pag =
            paginationMap.get(sourceId) ||
            (cachedSources.get(sourceId) as Pagination | undefined)
          if (pag) {
            totalResults += pag.totalResults
            if (pag.totalPages > maxTotalPages) {
              maxTotalPages = pag.totalPages
            }
          }
        })

        setCmsPagination({
          page: event.pagination.page,
          totalPages: maxTotalPages,
          totalResults,
        })

        // 判断是否还有更多页
        setHasMore(event.pagination.page < maxTotalPages)
      }
    })

    cmsClient
      .aggregatedSearch(keyword, sourcesToFetch, page, controller.signal)
      .then((allResults: VideoItem[]) => {
        // If no results returned and not on first page, there might be no more data
        // This handles the case where totalPages info is inconsistent with actual data
        if (allResults.length === 0 && page > 1) {
          setHasMore(false)
        }

        // Progress update
        setSearchProgress({
          completed: totalRequestedSources,
          total: totalRequestedSources,
        })

        if (allResults.length === 0 && page === 1) {
          setHasMore(false)
        }
      })
      .catch(error => {
        if ((error as Error).name !== 'AbortError') {
          console.error('直连搜索失败:', error)
        }
      })
      .finally(() => {
        fillMissingLatencies()
        // 强制将所有本次请求的源标记为完成，防止因某些源无响应或错误信息不完整而卡住
        setCompletedSourcesInCurrentPage(prev => {
          const newSet = new Set(prev)
          sourcesToFetchRef.current.forEach(source => {
            newSet.add(source.id)
          })
          return newSet
        })
        setSearchProgress({
          completed: totalRequestedSources,
          total: totalRequestedSources,
        })

        unsubResult()
        unsubProgress()
        setDirectLoading(false)

        if (timeOutTimer.current) {
          clearTimeout(timeOutTimer.current)
          timeOutTimer.current = null
        }
      })

    // 移除toast提示
  }, [selectedAPIs, cmsClient, recordSourceLatency, fillMissingLatencies])

  const abortDirectSearch = useCallback(() => {
    abortCtrlRef.current?.abort()
    abortCtrlRef.current = null
    if (timeOutTimer.current) {
      clearTimeout(timeOutTimer.current)
      timeOutTimer.current = null
    }
    setDirectLoading(false)
  }, [])

  const clearDirectSearchState = useCallback(() => {
    setDirectResults([])
    setSearchProgress({ completed: 0, total: 0 })
    setCmsPagination({
      page: 1,
      totalPages: 0,
      totalResults: 0,
    })
    setHasMore(true)
    sourceLatencyRef.current.clear()
    setSourceLatencies(new Map())
    probeVersionRef.current += 1
    probedSourcesRef.current.clear()
    probeQueueRef.current = []
    playbackProbeRef.current.clear()
    setPlaybackProbes(new Map())
    setCompletedSourcesInCurrentPage(new Set())
    setSuccessfulSourcesInCurrentPage(new Set())
    sourcesToFetchRef.current = []
    sourcePaginationCacheRef.current.clear()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortDirectSearch()
      clearDirectSearchState()
      requestVersionRef.current = 0
    }
  }, [abortDirectSearch, clearDirectSearchState])

  // 计算当前页是否已完成（所有源都已返回）
  const isCurrentPageComplete = useMemo(() => {
    return completedSourcesInCurrentPage.size >= sourcesToFetchRef.current.length
  }, [completedSourcesInCurrentPage])

  // 计算是否允许加载下一页
  const canLoadMore = useMemo(() => {
    return isCurrentPageComplete && cmsPagination.page < cmsPagination.totalPages
  }, [isCurrentPageComplete, cmsPagination])

  return {
    directResults,
    directLoading,
    hasMore,
    searchProgress,
    cmsPagination,
    isCurrentPageComplete,
    canLoadMore,
    successfulSourcesInCurrentPage,
    sourceLatencies,
    playbackProbes,
    startDirectSearch: fetchDirectSearch,
    abortDirectSearch,
    clearDirectSearchState,
    setDirectResults,
  }
}
