import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { createPortal } from 'react-dom'
import Artplayer from 'artplayer'

// artplayer 5.4.0 起 FULLSCREEN_WEB_IN_BODY 默认改为 true（网页全屏时把播放器节点挪到 body 下），
// 本站播放器嵌在布局容器内、尺寸与迷你播放器逻辑都依赖原位置，钉回旧行为避免全屏时节点迁移出问题
Artplayer.FULLSCREEN_WEB_IN_BODY = false
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku'
import type Hls from 'hls.js'
import type { HlsConfig } from 'hls.js'
import { ArrowLeft, ChevronDown, X } from 'lucide-react'
import { type DetailResult } from '@tgys/cms-core'
import { createM3u8Processor, createHlsLoaderClass } from '@tgys/cms-core/m3u8'
import { Button } from '@/shared/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Spinner } from '@/shared/components/ui/spinner'
import { useApiStore } from '@/shared/store/apiStore'
import { useViewingHistoryStore } from '@/shared/store/viewingHistoryStore'
import { useSettingStore } from '@/shared/store/settingStore'
import { useDocumentTitle, useCmsClient } from '@/shared/hooks'
import { useTmdbEnabled } from '@/shared/hooks/useTmdbMode'
import { buildCmsPlayPath, buildTmdbDetailPath, buildTmdbPlayPath } from '@/shared/lib/routes'
import {
  danmakuDurationFromMultiplier,
  danmakuMultiplierFromDuration,
  loadDanmakuForEpisode,
  resolveDanmakuApiUrl,
} from '@/shared/lib/danmaku'
import { isTmdbHistoryItem } from '@/shared/lib/viewingHistory'
import { getBackdropUrl, getPosterUrl } from '@/shared/lib/tmdb'
import { useFavoritesStore } from '@/features/favorites/store/favoritesStore'
import type { TmdbMediaItem, TmdbMediaType } from '@/shared/types/tmdb'
import type { ViewingHistoryItem } from '@/shared/types'
import type { VideoItem } from '@/shared/types/video'
import { useTmdbRecommendations } from '@/shared/hooks/useTmdb'
import { toast } from 'sonner'
import _ from 'lodash'
import {
  PlayerEpisodeInfoPanel,
  PlayerErrorState,
  PlayerHeroSection,
  PlayerInfoAndRecommendations,
  PlayerLoadingSkeleton,
  PlayerSourceSpeedStrip,
  splitPersonNames,
  type PlayerInfoData,
} from '@/features/player/components'
import {
  useEpisodePagination,
  useMobilePlayerGestures,
  useSourceSpeedOptions,
  useTmdbPlayback,
} from '@/features/player/hooks'
import {
  buildTmdbSelectionScopeKey,
  computeMiniPlayerRect,
  derivePlayerViewState,
  getNextTmdbSelectionLock,
  pickFailoverOption,
  resolvePlayerSelection,
  shouldFallbackEpisodeToFirst,
  type TmdbSelectionLock,
  validatePlayerRoute,
} from '@/features/player/lib'
import { readResolveCandidates } from '@/shared/lib/playbackProbe'

interface ArtplayerWithHls extends Artplayer {
  hls?: Hls
}

interface PlayerRouteParams {
  [key: string]: string | undefined
  type?: string
  tmdbId?: string
  sourceCode?: string
  vodId?: string
}

interface PlayerTransientNotice {
  id: string
  message: string
  duration: number
  progress: number
}

const m3u8Processor = createM3u8Processor({ filterAds: true })
type HlsConstructor = typeof import('hls.js')['default']
const BETTER_SOURCE_NOTICE_DURATION = 8000

let hlsConstructorPromise: Promise<HlsConstructor> | null = null
let customHlsLoaderClass: ReturnType<typeof createHlsLoaderClass> | null = null

const getHlsConstructor = async (): Promise<HlsConstructor> => {
  if (!hlsConstructorPromise) {
    hlsConstructorPromise = import('hls.js/dist/hls.light.mjs')
      .then(module => module.default as HlsConstructor)
      .catch(error => {
        hlsConstructorPromise = null
        throw error
      })
  }

  return hlsConstructorPromise
}

const getCustomHlsLoaderClass = (HlsClass: HlsConstructor) => {
  if (!customHlsLoaderClass) {
    customHlsLoaderClass = createHlsLoaderClass({
      m3u8Processor,
      Hls: HlsClass,
    })
  }

  return customHlsLoaderClass
}

const parseEpisodeIndex = (value: string | null): number => {
  const parsed = Number.parseInt(value || '0', 10)
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed
}

const parsePositiveNumber = (value: string | null): number | null => {
  const parsed = Number.parseInt(value || '', 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

const formatDurationLabel = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const buildDetailRequestKey = (sourceCode: string, vodId: string) => `${sourceCode}::${vodId}`

const isTouchDevice = () =>
  window.matchMedia('(hover: none) and (pointer: coarse)').matches || navigator.maxTouchPoints > 0

const stripHtmlTags = (value: string) => {
  const stripped = value
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()

  return stripped
}

const matchesTmdbHistory = (
  item: ViewingHistoryItem,
  mediaType: TmdbMediaType,
  tmdbId: number,
  seasonNumber: number | null,
) => {
  if (!isTmdbHistoryItem(item)) return false
  if (item.tmdbMediaType !== mediaType || item.tmdbId !== tmdbId) return false
  if (mediaType === 'tv') {
    return (item.tmdbSeasonNumber ?? null) === seasonNumber
  }
  return true
}

export default function UnifiedPlayer() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { type = '', tmdbId = '', sourceCode: routeSourceCode = '', vodId: routeVodId = '' } =
    useParams<PlayerRouteParams>()

  const cmsClient = useCmsClient()
  const tmdbEnabled = useTmdbEnabled()
  const { videoAPIs, adFilteringEnabled } = useApiStore()
  const { addViewingHistory, viewingHistory } = useViewingHistoryStore()
  const { playback } = useSettingStore()

  const viewingHistoryRef = useRef(viewingHistory)
  const playbackRef = useRef(playback)
  const detailRef = useRef<DetailResult | null>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const detailRequestSeqRef = useRef(0)
  const loadedDetailKeyRef = useRef('')
  const tmdbSelectionLockRef = useRef<TmdbSelectionLock | null>(null)

  useEffect(() => {
    viewingHistoryRef.current = viewingHistory
    playbackRef.current = playback
  }, [playback, viewingHistory])

  const querySourceCode = searchParams.get('source') || ''
  const queryVodId = searchParams.get('id') || ''
  const querySeasonNumber = parsePositiveNumber(searchParams.get('season'))
  const episodeIndexParam = searchParams.get('ep')

  const routeValidation = useMemo(
    () =>
      validatePlayerRoute({
        type,
        tmdbId,
        sourceCode: routeSourceCode,
        vodId: routeVodId,
      }),
    [routeSourceCode, routeVodId, tmdbId, type],
  )
  const isTmdbRoute = routeValidation.isValid && routeValidation.mode === 'tmdb'
  const isCmsRoute = routeValidation.isValid && routeValidation.mode === 'cms'
  const routeError = routeValidation.isValid ? null : routeValidation.message
  const tmdbMediaType: TmdbMediaType | null =
    routeValidation.isValid && routeValidation.mode === 'tmdb' ? routeValidation.tmdbMediaType : null
  const parsedTmdbId =
    routeValidation.isValid && routeValidation.mode === 'tmdb' ? routeValidation.tmdbId : 0

  const tmdbPlayback = useTmdbPlayback({
    enabled: isTmdbRoute,
    mediaType: tmdbMediaType,
    tmdbId: parsedTmdbId,
    querySourceCode,
    querySeasonNumber,
  })

  const { recommendations: fallbackRecommendations } = useTmdbRecommendations()
  const toggleCmsFavorite = useFavoritesStore(state => state.toggleCmsFavorite)
  const toggleTmdbFavorite = useFavoritesStore(state => state.toggleTmdbFavorite)

  const [detail, setDetail] = useState<DetailResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 起播失败（详情被源站 503 / HLS 清单致命错误等）：先不展示错误页，由自动换源逻辑接管，
  // 有备选源就自动换、换不动才把失败消息交还给错误页/提示
  const [startFailure, setStartFailure] = useState<{ sourceCode: string; message: string } | null>(
    null,
  )
  const startFailureRef = useRef<{ sourceCode: string; message: string } | null>(null)
  // 本源是否已经真正开始播放：起播后的中途错误不触发自动换源（有分片重试兜底）
  const hasPlayedRef = useRef(false)
  const resolvedSourceRef = useRef<string | null>(null)
  const [isDetailRefreshing, setIsDetailRefreshing] = useState(false)
  const [transientNotices, setTransientNotices] = useState<PlayerTransientNotice[]>([])
  const [dismissedBetterNoticeKeys, setDismissedBetterNoticeKeys] = useState<string[]>([])
  const [betterNoticeProgress, setBetterNoticeProgress] = useState(100)
  const [activeRightPanel, setActiveRightPanel] = useState<'episode' | 'source' | 'season' | null>('episode')
  const [gestureVolumeLevel, setGestureVolumeLevel] = useState<number | null>(null)
  const [gestureSeekPreviewTime, setGestureSeekPreviewTime] = useState<number | null>(null)
  const [activeArt, setActiveArt] = useState<Artplayer | null>(null)
  const selectedEpisode = parseEpisodeIndex(episodeIndexParam)
  const noticeTimersRef = useRef<Map<string, number>>(new Map())
  const noticeAnimationFramesRef = useRef<Map<string, number>>(new Map())
  const betterNoticeTimerRef = useRef<number | null>(null)
  const betterNoticeAnimationFrameRef = useRef<number | null>(null)
  const gestureVolumeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    detailRef.current = detail
  }, [detail])

  const showPlayerNotice = useCallback((message: string, duration = 2200) => {
    const noticeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    setTransientNotices(prev => [...prev, { id: noticeId, message, duration, progress: 100 }])

    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        setTransientNotices(prev =>
          prev.map(notice => (notice.id === noticeId ? { ...notice, progress: 0 } : notice)),
        )
        noticeAnimationFramesRef.current.delete(noticeId)
      })
      noticeAnimationFramesRef.current.set(noticeId, secondFrame)
    })
    noticeAnimationFramesRef.current.set(noticeId, firstFrame)

    const timerId = window.setTimeout(() => {
      setTransientNotices(prev => prev.filter(notice => notice.id !== noticeId))
      noticeTimersRef.current.delete(noticeId)
      const frameId = noticeAnimationFramesRef.current.get(noticeId)
      if (frameId) {
        window.cancelAnimationFrame(frameId)
        noticeAnimationFramesRef.current.delete(noticeId)
      }
    }, duration)
    noticeTimersRef.current.set(noticeId, timerId)
  }, [])

  useEffect(() => {
    const noticeTimers = noticeTimersRef.current
    const noticeAnimationFrames = noticeAnimationFramesRef.current

    return () => {
      noticeTimers.forEach(timerId => window.clearTimeout(timerId))
      noticeTimers.clear()
      noticeAnimationFrames.forEach(frameId => window.cancelAnimationFrame(frameId))
      noticeAnimationFrames.clear()
      if (betterNoticeTimerRef.current) {
        window.clearTimeout(betterNoticeTimerRef.current)
        betterNoticeTimerRef.current = null
      }
      if (betterNoticeAnimationFrameRef.current) {
        window.cancelAnimationFrame(betterNoticeAnimationFrameRef.current)
        betterNoticeAnimationFrameRef.current = null
      }
      if (gestureVolumeTimerRef.current) {
        window.clearTimeout(gestureVolumeTimerRef.current)
      }
    }
  }, [])

  const playerOverlayContainer = activeArt?.template?.$player ?? null
  const seekPreviewOverlay =
    gestureSeekPreviewTime !== null ? (
      <div className="pointer-events-none absolute top-3 left-3 z-[160]">
        <div className="rounded-md border border-white/15 bg-black/65 px-2.5 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm">
          预览 {formatDurationLabel(gestureSeekPreviewTime)}
        </div>
      </div>
    ) : null
  const volumeOverlay =
    gestureVolumeLevel !== null ? (
      <div className="pointer-events-none absolute top-3 left-1/2 z-[160] w-[min(52vw,300px)] -translate-x-1/2">
        <div className="rounded-full border border-white/15 bg-black/70 px-2.5 py-2 shadow-lg backdrop-blur-sm">
          <div className="mb-1 text-center text-xs text-white">{Math.round(gestureVolumeLevel * 100)}%</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-75"
              style={{ width: `${Math.round(gestureVolumeLevel * 100)}%` }}
            />
          </div>
        </div>
      </div>
    ) : null

  const currentTmdbSelectionScopeKey = buildTmdbSelectionScopeKey(tmdbMediaType, parsedTmdbId, querySeasonNumber)
  const { resolvedSourceCode, resolvedVodId, hasExplicitTmdbSelection } = resolvePlayerSelection({
    isCmsRoute,
    isTmdbRoute,
    routeSourceCode,
    routeVodId,
    querySourceCode,
    queryVodId,
    tmdbResolvedSourceCode: tmdbPlayback.resolvedSourceCode,
    tmdbResolvedVodId: tmdbPlayback.resolvedVodId,
    currentScopeKey: currentTmdbSelectionScopeKey,
    lock: tmdbSelectionLockRef.current,
  })
  const canUseTmdbHistory = Boolean(
    isTmdbRoute && tmdbMediaType && Number.isInteger(parsedTmdbId) && parsedTmdbId > 0,
  )
  const tmdbSeasonNumberForHistory =
    tmdbMediaType === 'tv' ? (tmdbPlayback.selectedSeasonNumber ?? querySeasonNumber ?? null) : null
  const cmsFavoriteActive = useFavoritesStore(state =>
    isCmsRoute && resolvedVodId && resolvedSourceCode
      ? state.isCmsFavorited(resolvedVodId, resolvedSourceCode)
      : false,
  )
  const tmdbFavoriteActive = useFavoritesStore(state =>
    isTmdbRoute && tmdbMediaType && parsedTmdbId > 0
      ? state.isTmdbFavorited(parsedTmdbId, tmdbMediaType)
      : false,
  )

  const sourceConfig = useMemo(
    () => videoAPIs.find(api => api.id === resolvedSourceCode),
    [resolvedSourceCode, videoAPIs],
  )

  useEffect(() => {
    startFailureRef.current = startFailure
  }, [startFailure])

  // 换源后重置起播失败状态：新源重新获得自动换源机会，也不再算「已播过」
  useEffect(() => {
    resolvedSourceRef.current = resolvedSourceCode
    hasPlayedRef.current = false
    setStartFailure(null)
  }, [resolvedSourceCode, resolvedVodId])

  useEffect(() => {
    if (!isTmdbRoute) {
      tmdbSelectionLockRef.current = null
      return
    }

    tmdbSelectionLockRef.current = getNextTmdbSelectionLock({
      isTmdbRoute,
      currentScopeKey: currentTmdbSelectionScopeKey,
      querySourceCode,
      queryVodId,
      tmdbResolvedSourceCode: tmdbPlayback.resolvedSourceCode,
      tmdbResolvedVodId: tmdbPlayback.resolvedVodId,
      lock: tmdbSelectionLockRef.current,
    })
  }, [
    currentTmdbSelectionScopeKey,
    isTmdbRoute,
    querySourceCode,
    queryVodId,
    tmdbPlayback.resolvedSourceCode,
    tmdbPlayback.resolvedVodId,
  ])

  const buildCurrentPlayPath = useCallback(
    (
      episodeIndex: number,
      options?: {
        sourceCode?: string
        vodId?: string
        seasonNumber?: number
      },
    ) => {
      if (isCmsRoute) {
        return buildCmsPlayPath(routeSourceCode, routeVodId, episodeIndex)
      }

      if (isTmdbRoute && tmdbMediaType) {
        return buildTmdbPlayPath(tmdbMediaType, parsedTmdbId, {
          sourceCode: options?.sourceCode || resolvedSourceCode,
          vodId: options?.vodId || resolvedVodId,
          episodeIndex,
          seasonNumber: options?.seasonNumber ?? tmdbPlayback.selectedSeasonNumber ?? undefined,
        })
      }

      return buildCmsPlayPath(resolvedSourceCode, resolvedVodId, episodeIndex)
    },
    [
      isCmsRoute,
      isTmdbRoute,
      resolvedSourceCode,
      resolvedVodId,
      routeSourceCode,
      routeVodId,
      parsedTmdbId,
      tmdbMediaType,
      tmdbPlayback.selectedSeasonNumber,
    ],
  )

  useEffect(() => {
    if (!location.pathname.startsWith('/play/')) return
    if (!isTmdbRoute || !tmdbMediaType) return
    if (tmdbPlayback.tmdbLoading) return
    if (!tmdbPlayback.playlist.searched) return

    if (!resolvedSourceCode || !resolvedVodId) return

    const currentSeason = parsePositiveNumber(searchParams.get('season'))
    const targetSeason = tmdbPlayback.selectedSeasonNumber || null
    const episodeFromUrl = parseEpisodeIndex(episodeIndexParam)

    const sourceUnchanged = querySourceCode === resolvedSourceCode
    const vodUnchanged = queryVodId === resolvedVodId
    const seasonUnchanged = currentSeason === targetSeason

    if (sourceUnchanged && vodUnchanged && seasonUnchanged) return

    navigate(
      buildTmdbPlayPath(tmdbMediaType, parsedTmdbId, {
        sourceCode: resolvedSourceCode,
        vodId: resolvedVodId,
        episodeIndex: episodeFromUrl,
        seasonNumber: targetSeason || undefined,
      }),
      { replace: true },
    )
  }, [
    isTmdbRoute,
    querySourceCode,
    queryVodId,
    episodeIndexParam,
    location.pathname,
    navigate,
    searchParams,
    parsedTmdbId,
    tmdbMediaType,
    tmdbPlayback.playlist.searched,
    resolvedSourceCode,
    resolvedVodId,
    tmdbPlayback.selectedSeasonNumber,
    tmdbPlayback.tmdbLoading,
  ])

  useEffect(() => {
    const requestSeq = detailRequestSeqRef.current + 1
    detailRequestSeqRef.current = requestSeq
    let disposed = false
    const canCommit = () => !disposed && detailRequestSeqRef.current === requestSeq

    const fetchVideoDetail = async () => {
      if (routeError) {
        if (!canCommit()) return
        setDetail(null)
        setLoading(false)
        setIsDetailRefreshing(false)
        setError(routeError)
        return
      }

      const hasResolvedTmdbSelection = Boolean(resolvedSourceCode && resolvedVodId)
      const shouldWaitForTmdbSelection =
        isTmdbRoute &&
        !hasExplicitTmdbSelection &&
        !hasResolvedTmdbSelection &&
        (tmdbPlayback.tmdbLoading || tmdbPlayback.playlist.loading || !tmdbPlayback.playlist.searched)

      if (shouldWaitForTmdbSelection) {
        if (!canCommit()) return
        if (detailRef.current) {
          setIsDetailRefreshing(true)
        } else {
          setLoading(true)
        }
        setError(null)
        return
      }

      if (!resolvedSourceCode || !resolvedVodId) {
        if (isTmdbRoute && tmdbPlayback.playlist.searched) {
          if (!canCommit()) return
          setDetail(null)
          setLoading(false)
          setIsDetailRefreshing(false)
          setError('没有匹配到可播放资源，请返回详情页重新匹配')
          return
        }

        if (!canCommit()) return
        setDetail(null)
        setLoading(false)
        setIsDetailRefreshing(false)
        setError('缺少必要的播放参数')
        return
      }

      const detailRequestKey = buildDetailRequestKey(resolvedSourceCode, resolvedVodId)
      const hasLoadedCurrentDetail = Boolean(
        detailRef.current && loadedDetailKeyRef.current === detailRequestKey,
      )
      if (hasLoadedCurrentDetail) {
        return
      }

      if (!canCommit()) return
      if (detailRef.current) setIsDetailRefreshing(true)
      else setLoading(true)
      setError(null)

      let failoverArmed = false
      try {
        if (!sourceConfig) {
          throw new Error('未找到对应视频源配置，请检查源设置')
        }

        const response = await cmsClient.getDetail(resolvedVodId, sourceConfig)
        if (!canCommit()) return
        if (response.success && response.episodes && response.episodes.length > 0) {
          loadedDetailKeyRef.current = detailRequestKey
          setDetail(response)
          setError(null)
          return
        }

        throw new Error(response.error || '获取视频详情失败')
      } catch (fetchError) {
        if (!canCommit()) return
        console.error('获取视频详情失败:', fetchError)
        setDetail(null)
        const message = fetchError instanceof Error ? fetchError.message : '获取视频详情失败'
        if (isCmsRoute && resolvedSourceCode && !hasPlayedRef.current) {
          // CMS 直达路线：失败先交给自动换源（备选多半在解析排名里），错误页暂不展示、
          // 骨架屏保持；换不动时再由自动换源逻辑把这条消息交还错误页
          failoverArmed = true
          setStartFailure({ sourceCode: resolvedSourceCode, message })
        } else {
          setError(message)
        }
      } finally {
        if (canCommit()) {
          if (!failoverArmed) setLoading(false)
          setIsDetailRefreshing(false)
        }
      }
    }

    void fetchVideoDetail()

    return () => {
      disposed = true
    }
  }, [
    cmsClient,
    hasExplicitTmdbSelection,
    isCmsRoute,
    isTmdbRoute,
    routeError,
    resolvedSourceCode,
    resolvedVodId,
    sourceConfig,
    tmdbPlayback.playlist.loading,
    tmdbPlayback.playlist.searched,
    tmdbPlayback.tmdbLoading,
  ])

  const episodes = useMemo(() => {
    if (!detail) return []

    if (detail.videoInfo?.episodes_names && detail.videoInfo.episodes_names.length > 0) {
      return detail.videoInfo.episodes_names
    }

    return detail.episodes.map((_, index) => `第 ${index + 1} 集`)
  }, [detail])

  useEffect(() => {
    if (!shouldFallbackEpisodeToFirst(episodes.length, selectedEpisode)) return

    pendingSeekRef.current = null
    const nextEpisode = 0
    navigate(buildCurrentPlayPath(nextEpisode), { replace: true })
  }, [buildCurrentPlayPath, episodes.length, navigate, selectedEpisode])

  const episodePagination = useEpisodePagination({
    episodes,
    selectedEpisode,
    defaultDescOrder: playback.defaultEpisodeOrder === 'desc',
  })

  const episodeProgressMap = useMemo(() => {
    if (!playback.isViewingHistoryVisible || !resolvedSourceCode || !resolvedVodId) return null

    const appendProgress = (
      targetMap: Map<number, { progress: number; timestamp: number }>,
      item: ViewingHistoryItem,
    ) => {
      const progress =
        item.duration > 0 ? Math.min(100, Math.max(0, (item.playbackPosition / item.duration) * 100)) : 0
      const previous = targetMap.get(item.episodeIndex)

      if (!previous || item.timestamp > previous.timestamp) {
        targetMap.set(item.episodeIndex, { progress, timestamp: item.timestamp })
      }
    }

    if (canUseTmdbHistory && tmdbMediaType) {
      const tmdbMap = new Map<number, { progress: number; timestamp: number }>()
      const cmsFallbackMap = new Map<number, { progress: number; timestamp: number }>()

      for (const item of viewingHistory) {
        if (matchesTmdbHistory(item, tmdbMediaType, parsedTmdbId, tmdbSeasonNumberForHistory)) {
          appendProgress(tmdbMap, item)
          continue
        }

        if (
          item.recordType === 'cms' &&
          item.sourceCode === resolvedSourceCode &&
          item.vodId === resolvedVodId
        ) {
          appendProgress(cmsFallbackMap, item)
        }
      }

      const merged = new Map<number, number>()
      tmdbMap.forEach((value, episodeIndex) => {
        merged.set(episodeIndex, value.progress)
      })
      cmsFallbackMap.forEach((value, episodeIndex) => {
        if (!merged.has(episodeIndex)) {
          merged.set(episodeIndex, value.progress)
        }
      })

      return merged
    }

    const map = new Map<number, { progress: number; timestamp: number }>()
    for (const item of viewingHistory) {
      if (item.sourceCode === resolvedSourceCode && item.vodId === resolvedVodId) {
        appendProgress(map, item)
      }
    }

    const normalized = new Map<number, number>()
    map.forEach((value, episodeIndex) => {
      normalized.set(episodeIndex, value.progress)
    })
    return normalized
  }, [
    canUseTmdbHistory,
    parsedTmdbId,
    playback.isViewingHistoryVisible,
    resolvedSourceCode,
    resolvedVodId,
    tmdbMediaType,
    tmdbSeasonNumberForHistory,
    viewingHistory,
  ])

  const playerRef = useRef<Artplayer | null>(null)
  // 播放器控制栏显隐（artplayer 'control' 事件驱动），返回键与底部控制栏同步淡入淡出
  const [controlsVisible, setControlsVisible] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const handleVolumeGestureChange = useCallback((volume: number) => {
    if (gestureVolumeTimerRef.current) {
      window.clearTimeout(gestureVolumeTimerRef.current)
      gestureVolumeTimerRef.current = null
    }
    setGestureVolumeLevel(volume)
  }, [])
  const handleVolumeGestureEnd = useCallback(() => {
    if (gestureVolumeTimerRef.current) {
      window.clearTimeout(gestureVolumeTimerRef.current)
    }
    gestureVolumeTimerRef.current = window.setTimeout(() => {
      setGestureVolumeLevel(null)
      gestureVolumeTimerRef.current = null
    }, 360)
  }, [])
  const handleSeekGesturePreviewChange = useCallback((previewTime: number) => {
    setGestureSeekPreviewTime(previewTime)
  }, [])
  const handleSeekGesturePreviewEnd = useCallback(() => {
    setGestureSeekPreviewTime(null)
  }, [])

  const mobileGestureConfig = useMemo(
    () => ({
      longPressPlaybackRate: Math.max(1, Math.min(5, playback.longPressPlaybackRate)),
    }),
    [playback.longPressPlaybackRate],
  )

  useMobilePlayerGestures({
    art: activeArt,
    enabled: playback.isMobileGestureEnabled,
    config: mobileGestureConfig,
    onVolumeGestureChange: handleVolumeGestureChange,
    onVolumeGestureEnd: handleVolumeGestureEnd,
    onSeekGesturePreviewChange: handleSeekGesturePreviewChange,
    onSeekGesturePreviewEnd: handleSeekGesturePreviewEnd,
  })

  useEffect(() => {
    if (!detail?.episodes || !detail.episodes[selectedEpisode] || !containerRef.current) return

    if (playerRef.current && playerRef.current.destroy) {
      playerRef.current.destroy(false)
    }

    const isMobileDevice = isTouchDevice()

    // 弹幕：开关开启且能解析出接口地址（用户自有地址 > 部署变量）时才挂载插件
    const danmakuApiUrl = resolveDanmakuApiUrl(playbackRef.current.danmakuApiUrl)
    const danmakuActive = playbackRef.current.isDanmakuEnabled && danmakuApiUrl.length > 0
    const danmakuTitle = detail.videoInfo?.title ?? ''
    const danmakuEpisodeName = episodes[selectedEpisode] ?? ''
    const danmakuDuration = danmakuDurationFromMultiplier(playbackRef.current.danmakuSpeed)

    const nextEpisode = () => {
      if (!playbackRef.current.isAutoPlayEnabled) return

      if (selectedEpisode < episodes.length - 1) {
        const nextIndex = selectedEpisode + 1
        navigate(buildCurrentPlayPath(nextIndex), { replace: true })
        showPlayerNotice(`即将播放下一集: ${episodes[nextIndex]}`)
      }
    }

    const art = new Artplayer({
      container: containerRef.current,
      url: detail.episodes[selectedEpisode],
      volume: playbackRef.current.defaultVolume,
      isLive: false,
      muted: false,
      autoplay: false,
      pip: playbackRef.current.isPipEnabled,
      autoSize: false,
      autoMini: false, // 内置 autoMini 监听 window.scroll，在 ScrollArea 布局下失效，改用手动实现
      screenshot: playbackRef.current.isScreenshotEnabled,
      setting: true,
      loop: playbackRef.current.isLoopEnabled,
      flip: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: !isMobileDevice,
      lock: isMobileDevice,
      gesture: false,
      fastForward: false,
      subtitleOffset: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: !isMobileDevice,
      theme: playbackRef.current.playerThemeColor,
      lang: 'zh-cn',
      moreVideoAttr: {
        crossOrigin: 'anonymous',
      },
      plugins: danmakuActive
        ? [
            artplayerPluginDanmuku({
              danmuku: () =>
                loadDanmakuForEpisode(
                  danmakuApiUrl,
                  danmakuTitle,
                  danmakuEpisodeName,
                  selectedEpisode,
                  playbackRef.current.danmakuFontFamily,
                ),
              // 插件 speed 为弹幕停留时长（越大越慢），插件自身钳制在 1~10；超过 10 的目标时长在创建后绕过钳制写入
              speed: Math.min(10, Math.max(1, danmakuDuration)),
              opacity: playbackRef.current.danmakuOpacity,
              fontSize: playbackRef.current.danmakuFontSize,
              margin: playbackRef.current.danmakuMargin as [
                number | `${number}%`,
                number | `${number}%`,
              ],
              // 显示区域档位：插件默认最小 1/4，按需求扩到最低 1/5（下边距 80%）
              MARGIN: {
                min: 0,
                max: 4,
                steps: [
                  { name: '1/5', value: [10, '80%'] },
                  { name: '1/4', value: [10, '75%'] },
                  { name: '半屏', value: [10, '50%'] },
                  { name: '3/4', value: [10, '25%'] },
                  { name: '满屏', value: [10, 10] },
                ],
              } as unknown as { min: number; max: number; steps: { name: string; value: number | string }[] },
              emitter: false,
              antiOverlap: true,
              synchronousPlayback: true,
            }),
          ]
        : [],
      customType: {
        m3u8: function (video: HTMLMediaElement, url: string, art: Artplayer) {
          const artWithHls = art as ArtplayerWithHls
          void (async () => {
            try {
              const HlsClass = await getHlsConstructor()
              if (playerRef.current !== art) return

              if (HlsClass.isSupported()) {
                if (artWithHls.hls) artWithHls.hls.destroy()
                // 播放缓冲调优：起播带宽估算调高（不再从最低档慢慢爬）、预缓冲加大抗源站抖动、
                // 首片段预取与分片重试加强，减少起播等待与中途转圈
                const hlsConfig: Partial<HlsConfig> = {
                  maxBufferLength: 60,
                  maxBufferSize: 100 * 1000 * 1000,
                  backBufferLength: 30,
                  abrEwmaDefaultEstimate: 5_000_000,
                  startFragPrefetch: true,
                  fragLoadingMaxRetry: 6,
                  ...(adFilteringEnabled
                    ? {
                        loader: getCustomHlsLoaderClass(
                          HlsClass,
                        ) as unknown as typeof HlsClass.DefaultConfig.loader,
                      }
                    : {}),
                }
                const hls = new HlsClass(hlsConfig)
                hls.on(HlsClass.Events.ERROR, (_event, data) => {
                  // 起播前的致命错误（清单 503 等）：交给自动换源处理；已开播的中途错误不掺和
                  if (!data?.fatal || hasPlayedRef.current || startFailureRef.current) return
                  const code = resolvedSourceRef.current
                  if (code) setStartFailure({ sourceCode: code, message: '视频加载失败' })
                })
                hls.loadSource(url)
                hls.attachMedia(video)
                artWithHls.hls = hls
                art.on('destroy', () => hls.destroy())
              } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url
              } else {
                art.notice.show = 'Unsupported playback format: m3u8'
              }
            } catch (loadError) {
              console.error('加载 HLS 播放内核失败:', loadError)
              if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url
              } else {
                art.notice.show = '播放内核加载失败，请稍后重试'
              }
            }
          })()
        },
      },
    })

    playerRef.current = art
    setActiveArt(art)

    if (danmakuActive) {
      const danmukuPlugin = art.plugins.artplayerPluginDanmuku as unknown as
        | { option: { speed: number } }
        | undefined
      // 目标时长超过插件上限 10 时，直接改插件内部值绕过它的钳制
      if (danmukuPlugin && danmakuDuration > 10) {
        danmukuPlugin.option.speed = danmakuDuration
      }
      // 播放器内调整的弹幕参数实时写回设置存储，退出再进入播放页不丢失
      const onPluginEvent = (
        art as unknown as {
          on: (name: string, handler: (option: Record<string, unknown>) => void) => void
        }
      ).on.bind(art)
      onPluginEvent('artplayerPluginDanmuku:config', option => {
        const patch: {
          danmakuOpacity?: number
          danmakuSpeed?: number
          danmakuFontSize?: number
          danmakuMargin?: [number | string, number | string]
        } = {}
        if (typeof option.opacity === 'number' && Number.isFinite(option.opacity)) {
          patch.danmakuOpacity = Math.min(1, Math.max(0, option.opacity))
        }
        if (typeof option.speed === 'number' && option.speed > 0) {
          const storedDuration = danmakuDurationFromMultiplier(
            useSettingStore.getState().playback.danmakuSpeed,
          )
          if (option.speed === 10 && storedDuration > 10) {
            // 事件中的 10 是插件把超限时长钳制后的假值：不回写倍率，并把插件内部值补回目标时长
            if (danmukuPlugin) danmukuPlugin.option.speed = storedDuration
          } else {
            patch.danmakuSpeed = danmakuMultiplierFromDuration(option.speed)
          }
        }
        if (typeof option.fontSize === 'number' && Number.isFinite(option.fontSize)) {
          patch.danmakuFontSize = Math.min(32, Math.max(14, Math.round(option.fontSize)))
        }
        if (Array.isArray(option.margin) && option.margin.length === 2) {
          const [marginTop, marginBottom] = option.margin as Array<number | string>
          if (
            (typeof marginTop === 'number' || typeof marginTop === 'string') &&
            (typeof marginBottom === 'number' || typeof marginBottom === 'string')
          ) {
            patch.danmakuMargin = [marginTop, marginBottom]
          }
        }
        if (Object.keys(patch).length > 0) {
          useSettingStore.getState().setPlaybackSettings(patch)
        }
      })
      onPluginEvent('artplayerPluginDanmuku:hide', () => {
        useSettingStore.getState().setPlaybackSettings({ isDanmakuEnabled: false })
      })
      onPluginEvent('artplayerPluginDanmuku:show', () => {
        useSettingStore.getState().setPlaybackSettings({ isDanmakuEnabled: true })
      })
    }

    const syncFullscreenMiniProgressBar = () => {
      const isFullscreenActive = art.fullscreen || art.fullscreenWeb
      const shouldHideMiniProgress =
        playbackRef.current.isFullscreenProgressHidden && isFullscreenActive
      art.template.$player.classList.toggle('tgys-hide-mini-progress', shouldHideMiniProgress)
    }

    const syncMobileControlBar = () => {
      const isFullscreenActive = art.fullscreen || art.fullscreenWeb
      const isMobileNow = isTouchDevice()

      const fullscreenControl = art.controls['fullscreen'] as HTMLElement | undefined
      const fullscreenWebControl = art.controls['fullscreenWeb'] as HTMLElement | undefined
      const preferredFullscreenControl = isMobileNow
        ? (fullscreenControl ?? fullscreenWebControl)
        : (fullscreenControl ?? fullscreenWebControl)
      const rightControls = Array.from(
        art.template.$controlsRight.querySelectorAll<HTMLElement>('.art-control'),
      )

      if (isMobileNow && !isFullscreenActive) {
        rightControls.forEach(control => {
          control.style.display = control === preferredFullscreenControl ? '' : 'none'
        })
      } else {
        rightControls.forEach(control => {
          control.style.display = ''
        })
      }
      if (preferredFullscreenControl) {
        preferredFullscreenControl.style.display = ''
      }

      syncFullscreenMiniProgressBar()
    }

    const handleControlViewportChange = _.throttle(() => {
      syncMobileControlBar()
    }, 120)

    art.on('fullscreen', syncMobileControlBar)
    art.on('fullscreenWeb', syncMobileControlBar)
    art.on('control', (visible: boolean) => setControlsVisible(visible))
    window.addEventListener('resize', handleControlViewportChange, { passive: true })
    window.addEventListener('orientationchange', handleControlViewportChange)

    art.on('ready', () => {
      syncMobileControlBar()

      if (art.video) {
        art.video.style.objectFit = 'contain'
        art.video.style.objectPosition = 'center center'
        art.video.style.background = '#000'
      }

      let existingHistory: ViewingHistoryItem | undefined

      if (canUseTmdbHistory && tmdbMediaType) {
        existingHistory = viewingHistoryRef.current.find(
          item =>
            item.episodeIndex === selectedEpisode &&
            matchesTmdbHistory(item, tmdbMediaType, parsedTmdbId, tmdbSeasonNumberForHistory),
        )

        if (!existingHistory) {
          existingHistory = viewingHistoryRef.current.find(
            item =>
              item.recordType === 'cms' &&
              item.sourceCode === resolvedSourceCode &&
              item.vodId === resolvedVodId &&
              item.episodeIndex === selectedEpisode,
          )
        }
      } else {
        existingHistory = viewingHistoryRef.current.find(
          item =>
            item.sourceCode === resolvedSourceCode &&
            item.vodId === resolvedVodId &&
            item.episodeIndex === selectedEpisode,
        )
      }

      if (pendingSeekRef.current && pendingSeekRef.current > 0) {
        art.seek = pendingSeekRef.current
        pendingSeekRef.current = null
        showPlayerNotice('已继承上一个源的播放进度')
      } else if (existingHistory && existingHistory.playbackPosition > 0) {
        art.seek = existingHistory.playbackPosition
        showPlayerNotice('已自动跳转到上次观看位置')
      }
    })

    const addHistorySnapshot = () => {
      if (!resolvedSourceCode || !resolvedVodId || !detail.videoInfo) return
      const historyImageUrl =
        (canUseTmdbHistory
          ? getBackdropUrl(tmdbPlayback.tmdbDetail?.backdropPath || null, 'w1280')
          : '') ||
        detail.videoInfo.cover ||
        ''
      addViewingHistory({
        recordType: canUseTmdbHistory ? 'tmdb' : 'cms',
        title: detail.videoInfo.title || '未知视频',
        imageUrl: historyImageUrl,
        sourceCode: resolvedSourceCode,
        sourceName: detail.videoInfo.source_name || '',
        vodId: resolvedVodId,
        tmdbMediaType: canUseTmdbHistory ? tmdbMediaType || undefined : undefined,
        tmdbId: canUseTmdbHistory ? parsedTmdbId : undefined,
        tmdbSeasonNumber:
          canUseTmdbHistory && tmdbMediaType === 'tv' ? tmdbSeasonNumberForHistory : undefined,
        episodeIndex: selectedEpisode,
        episodeName: episodes[selectedEpisode],
        playbackPosition: art.currentTime || 0,
        duration: art.duration || 0,
        timestamp: Date.now(),
      })
    }

    art.on('video:play', addHistorySnapshot)
    art.on('video:playing', () => {
      // 真正开始播放后，中途错误不再触发自动换源
      hasPlayedRef.current = true
    })
    art.on('video:pause', addHistorySnapshot)
    art.on('video:ended', () => {
      addHistorySnapshot()
      nextEpisode()
    })
    art.on('video:error', addHistorySnapshot)

    let lastTimeUpdate = 0
    const TIME_UPDATE_INTERVAL = 3000

    const timeUpdateHandler = () => {
      if (!resolvedSourceCode || !resolvedVodId || !detail.videoInfo) return
      const currentTime = art.currentTime || 0
      const duration = art.duration || 0
      const timeSinceLastUpdate = Date.now() - lastTimeUpdate

      if (timeSinceLastUpdate >= TIME_UPDATE_INTERVAL && currentTime > 0 && duration > 0) {
        lastTimeUpdate = Date.now()
        const historyImageUrl =
          (canUseTmdbHistory
            ? getBackdropUrl(tmdbPlayback.tmdbDetail?.backdropPath || null, 'w1280')
            : '') ||
          detail.videoInfo.cover ||
          ''
        addViewingHistory({
          recordType: canUseTmdbHistory ? 'tmdb' : 'cms',
          title: detail.videoInfo.title || '未知视频',
          imageUrl: historyImageUrl,
          sourceCode: resolvedSourceCode,
          sourceName: detail.videoInfo.source_name || '',
          vodId: resolvedVodId,
          tmdbMediaType: canUseTmdbHistory ? tmdbMediaType || undefined : undefined,
          tmdbId: canUseTmdbHistory ? parsedTmdbId : undefined,
          tmdbSeasonNumber:
            canUseTmdbHistory && tmdbMediaType === 'tv' ? tmdbSeasonNumberForHistory : undefined,
          episodeIndex: selectedEpisode,
          episodeName: episodes[selectedEpisode],
          playbackPosition: currentTime,
          duration,
          timestamp: Date.now(),
        })
      }
    }

    const throttledTimeUpdate = _.throttle(timeUpdateHandler, TIME_UPDATE_INTERVAL)
    art.on('video:timeupdate', throttledTimeUpdate)

    // 自动迷你（小窗）：Artplayer 内置 autoMini 监听 window.scroll，
    // 但应用使用 Radix ScrollArea 管理滚动，window.scroll 永远不触发。
    // 这里监听 ScrollArea viewport 的 scroll 事件，手动切换 art.mini 并校正小窗位置。
    let miniCleanup: (() => void) | undefined
    if (containerRef.current) {
      const playerSection = containerRef.current.closest('section')
      let isMini = false
      const VISIBILITY_GAP = 50
      const applyMiniPosition = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const miniEl = (playerRef.current as any)?.template?.$mini as HTMLElement | undefined
        if (!miniEl) return

        const isMobile = window.matchMedia('(max-width: 639px)').matches
        const isTablet = window.matchMedia('(min-width: 640px) and (max-width: 1023px)').matches
        const currentRect = miniEl.getBoundingClientRect()
        const rect = computeMiniPlayerRect({
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          currentWidth: currentRect.width,
          currentHeight: currentRect.height,
          isMobile,
          isTablet,
        })

        miniEl.style.width = `${rect.width}px`
        miniEl.style.height = `${rect.height}px`
        miniEl.style.top = `${rect.top}px`
        miniEl.style.left = `${rect.left}px`
      }
      const enterMini = () => {
        if (isMini || !playerRef.current) return
        // 进入迷你模式前固定 section 高度，防止 fixed 定位导致布局塌陷
        if (playerSection) {
          playerSection.style.minHeight = `${playerSection.getBoundingClientRect().height}px`
        }
        isMini = true
        playerRef.current.mini = true
        requestAnimationFrame(applyMiniPosition)
      }
      const exitMini = () => {
        if (!isMini) return
        isMini = false
        if (playerRef.current) playerRef.current.mini = false
        if (playerSection) playerSection.style.minHeight = ''
      }
      // 用户点小窗自带的关闭按钮时 artplayer 直接退出 mini，这里同步本地状态与占位高度
      const syncMiniState = (state: boolean) => {
        if (!state && isMini) {
          isMini = false
          if (playerSection) playerSection.style.minHeight = ''
        } else if (state && !isMini) {
          isMini = true
        }
      }
      art.on('mini', syncMiniState)
      const handleViewportChange = _.throttle(() => {
        if (!isMini) return
        requestAnimationFrame(applyMiniPosition)
      }, 120)
      window.addEventListener('resize', handleViewportChange, { passive: true })
      window.addEventListener('orientationchange', handleViewportChange)

      miniCleanup = () => {
        handleViewportChange.cancel()
        window.removeEventListener('resize', handleViewportChange)
        window.removeEventListener('orientationchange', handleViewportChange)
        art.off('mini', syncMiniState)
        if (playerRef.current) {
          playerRef.current.mini = false
        }
        if (playerSection) playerSection.style.minHeight = ''
      }

      // 自动迷你：开关开启时，播放器滚出可视区域自动进小窗、滚回来自动退出
      if (playbackRef.current.isAutoMiniEnabled) {
        const scrollViewport = document.querySelector(
          '[data-main-scroll-area] [data-slot="scroll-area-viewport"]',
        ) as HTMLElement | null
        if (scrollViewport && playerSection) {
          const checkVisibility = _.throttle(() => {
            if (!playerRef.current) return

            const scrollRect = scrollViewport.getBoundingClientRect()
            const sectionRect = playerSection.getBoundingClientRect()

            // section 底部在滚动区域顶部以下且 section 顶部在滚动区域底部以上，则可见
            const isVisible =
              sectionRect.bottom > scrollRect.top + VISIBILITY_GAP &&
              sectionRect.top < scrollRect.bottom - VISIBILITY_GAP

            if (!isVisible) enterMini()
            else exitMini()
          }, 200)

          scrollViewport.addEventListener('scroll', checkVisibility, { passive: true })
          const baseCleanup = miniCleanup
          miniCleanup = () => {
            checkVisibility.cancel()
            scrollViewport.removeEventListener('scroll', checkVisibility)
            baseCleanup()
          }
        }
      }
    }

    return () => {
      miniCleanup?.()
      throttledTimeUpdate.cancel()
      handleControlViewportChange.cancel()
      window.removeEventListener('resize', handleControlViewportChange)
      window.removeEventListener('orientationchange', handleControlViewportChange)
      art.off('fullscreen', syncMobileControlBar)
      art.off('fullscreenWeb', syncMobileControlBar)
      if (playerRef.current && playerRef.current.destroy) {
        addHistorySnapshot()
        setActiveArt(current => (current === art ? null : current))
        playerRef.current.destroy(false)
        playerRef.current = null
      }
    }
  }, [
    addViewingHistory,
    adFilteringEnabled,
    buildCurrentPlayPath,
    canUseTmdbHistory,
    detail,
    episodes,
    navigate,
    parsedTmdbId,
    resolvedSourceCode,
    resolvedVodId,
    selectedEpisode,
    showPlayerNotice,
    tmdbPlayback.tmdbDetail?.backdropPath,
    tmdbMediaType,
    tmdbSeasonNumberForHistory,
  ])

  const handleEpisodeChange = (displayIndex: number) => {
    pendingSeekRef.current = null
    const actualIndex = episodePagination.toActualIndex(displayIndex)
    if (actualIndex === selectedEpisode) return
    navigate(buildCurrentPlayPath(actualIndex), { replace: true })
  }

  const handleSourceChange = useCallback(
    (sourceCode: string) => {
      if (!isTmdbRoute || !tmdbMediaType) return

      const nextOption = tmdbPlayback.sourceOptions.find(option => option.sourceCode === sourceCode)
      if (!nextOption || !nextOption.bestVodId) return

      pendingSeekRef.current = playerRef.current?.currentTime || null

      const nextPath = buildTmdbPlayPath(tmdbMediaType, parsedTmdbId, {
        sourceCode: nextOption.sourceCode,
        vodId: nextOption.bestVodId,
        episodeIndex: selectedEpisode,
        seasonNumber: tmdbPlayback.selectedSeasonNumber || undefined,
      })

      navigate(nextPath, { replace: true })
      showPlayerNotice(`已切换到 ${nextOption.sourceName}`)
    },
    [
      isTmdbRoute,
      navigate,
      parsedTmdbId,
      selectedEpisode,
      showPlayerNotice,
      tmdbMediaType,
      tmdbPlayback.selectedSeasonNumber,
      tmdbPlayback.sourceOptions,
    ],
  )

  const handleSeasonChange = (seasonNumber: number) => {
    if (!isTmdbRoute || tmdbMediaType !== 'tv') return

    pendingSeekRef.current = null

    const seasonSourceOptions = tmdbPlayback.getSourceOptionsForSeason(seasonNumber)
    if (seasonSourceOptions.length === 0) {
      showPlayerNotice('该季暂无可用源')
      return
    }

    const preferredSource =
      seasonSourceOptions.find(option => option.sourceCode === resolvedSourceCode) || seasonSourceOptions[0]

    const nextPath = buildTmdbPlayPath('tv', parsedTmdbId, {
      sourceCode: preferredSource.sourceCode,
      vodId: preferredSource.bestVodId,
      episodeIndex: 0,
      seasonNumber,
    })

    navigate(nextPath, { replace: true })
  }

  const handleToggleCmsFavorite = useCallback(() => {
    if (!isCmsRoute || !resolvedVodId || !resolvedSourceCode) return

    const video: VideoItem = {
      vod_id: resolvedVodId,
      vod_name: detail?.videoInfo?.title || '未知视频',
      vod_pic: detail?.videoInfo?.cover,
      vod_year: detail?.videoInfo?.year,
      vod_area: detail?.videoInfo?.area,
      vod_remarks: detail?.videoInfo?.remarks,
      vod_content: detail?.videoInfo?.desc,
      type_name: detail?.videoInfo?.type,
      source_code: resolvedSourceCode,
      source_name: detail?.videoInfo?.source_name || '',
    }

    toggleCmsFavorite(video)
    toast.success(cmsFavoriteActive ? '已取消收藏' : '已加入收藏')
  }, [
    cmsFavoriteActive,
    detail?.videoInfo?.area,
    detail?.videoInfo?.cover,
    detail?.videoInfo?.desc,
    detail?.videoInfo?.remarks,
    detail?.videoInfo?.source_name,
    detail?.videoInfo?.title,
    detail?.videoInfo?.type,
    detail?.videoInfo?.year,
    isCmsRoute,
    resolvedSourceCode,
    resolvedVodId,
    toggleCmsFavorite,
  ])

  const handleToggleTmdbFavorite = useCallback(() => {
    if (!isTmdbRoute || !tmdbMediaType || parsedTmdbId <= 0) return

    const tmdbMedia: TmdbMediaItem = {
      id: parsedTmdbId,
      mediaType: tmdbMediaType,
      title: tmdbPlayback.tmdbDetail?.title || '未知视频',
      originalTitle: tmdbPlayback.tmdbDetail?.originalTitle || tmdbPlayback.tmdbDetail?.title || '未知视频',
      overview: tmdbPlayback.tmdbDetail?.overview || '',
      posterPath: tmdbPlayback.tmdbDetail?.posterPath || null,
      backdropPath: tmdbPlayback.tmdbDetail?.backdropPath || null,
      logoPath: tmdbPlayback.tmdbDetail?.logoPath || null,
      releaseDate: tmdbPlayback.tmdbDetail?.releaseDate || '',
      voteAverage: tmdbPlayback.tmdbDetail?.voteAverage || 0,
      voteCount: tmdbPlayback.tmdbDetail?.voteCount || 0,
      popularity: tmdbPlayback.tmdbDetail?.popularity || 0,
      genreIds: tmdbPlayback.tmdbDetail?.genreIds || [],
      originalLanguage: tmdbPlayback.tmdbDetail?.originalLanguage || '',
      originCountry: tmdbPlayback.tmdbDetail?.originCountry || [],
    }

    toggleTmdbFavorite(tmdbMedia)
    toast.success(tmdbFavoriteActive ? '已取消收藏' : '已加入收藏')
  }, [
    isTmdbRoute,
    parsedTmdbId,
    tmdbFavoriteActive,
    tmdbMediaType,
    tmdbPlayback.tmdbDetail?.backdropPath,
    tmdbPlayback.tmdbDetail?.genreIds,
    tmdbPlayback.tmdbDetail?.logoPath,
    tmdbPlayback.tmdbDetail?.originalLanguage,
    tmdbPlayback.tmdbDetail?.originalTitle,
    tmdbPlayback.tmdbDetail?.originCountry,
    tmdbPlayback.tmdbDetail?.overview,
    tmdbPlayback.tmdbDetail?.popularity,
    tmdbPlayback.tmdbDetail?.posterPath,
    tmdbPlayback.tmdbDetail?.releaseDate,
    tmdbPlayback.tmdbDetail?.title,
    tmdbPlayback.tmdbDetail?.voteAverage,
    tmdbPlayback.tmdbDetail?.voteCount,
    toggleTmdbFavorite,
  ])

  const sourceOptions = useMemo(() => {
    if (isTmdbRoute) {
      return tmdbPlayback.sourceOptions
    }

    const sourceName =
      detail?.videoInfo?.source_name || sourceConfig?.name || routeSourceCode || resolvedSourceCode || '直连源'

    return [
      {
        sourceCode: resolvedSourceCode,
        sourceName,
        bestVodId: resolvedVodId,
        bestScore: 0,
      },
    ]
  }, [
    detail?.videoInfo?.source_name,
    isTmdbRoute,
    resolvedSourceCode,
    resolvedVodId,
    routeSourceCode,
    sourceConfig?.name,
    tmdbPlayback.sourceOptions,
  ])

  useEffect(() => {
    setDismissedBetterNoticeKeys([])
  }, [isTmdbRoute, parsedTmdbId, querySeasonNumber, tmdbMediaType])

  const currentSourceOption = useMemo(() => {
    if (!isTmdbRoute || !resolvedSourceCode) return null
    return sourceOptions.find(option => option.sourceCode === resolvedSourceCode) || null
  }, [isTmdbRoute, resolvedSourceCode, sourceOptions])

  const bestSourceOption = useMemo(() => {
    if (!isTmdbRoute || sourceOptions.length === 0) return null
    return sourceOptions.reduce((best, option) => (option.bestScore > best.bestScore ? option : best), sourceOptions[0])
  }, [isTmdbRoute, sourceOptions])

  // 选集上方换源条：候选源 + 播放线路测速（按速度排序）
  const sourceSpeed = useSourceSpeedOptions({
    isTmdbRoute,
    tmdbOptions: tmdbPlayback.sourceOptions,
    discoverTitle: isCmsRoute ? (detail?.videoInfo?.title ?? null) : null,
    currentOption: isTmdbRoute ? null : (sourceOptions[0] ?? null),
  })

  const handleAnySourceChange = useCallback(
    (sourceCode: string) => {
      if (isTmdbRoute) {
        handleSourceChange(sourceCode)
        return
      }
      const nextOption = sourceSpeed.options.find(option => option.sourceCode === sourceCode)
      if (!nextOption || !nextOption.bestVodId) return
      pendingSeekRef.current = playerRef.current?.currentTime || null
      navigate(buildCmsPlayPath(nextOption.sourceCode, nextOption.bestVodId, selectedEpisode), {
        replace: true,
      })
      showPlayerNotice(`已切换到 ${nextOption.sourceName}`)
    },
    [handleSourceChange, isTmdbRoute, navigate, selectedEpisode, showPlayerNotice, sourceSpeed.options],
  )

  // 起播失败自动换源：已选定的源在真正开播前失败（详情被源站 503、清单致命错误等）时，
  // 按排名自动换到下一个没试过的源，最多自动换 2 次（算上最初的源共试 3 个）；
  // 换源链经路由 state 传递，手动换源不带 state、链条自动清零
  const MAX_AUTO_FAILOVER = 2
  const failoverChain = useMemo(() => {
    const raw = (
      location.state as { autoFailover?: { tried?: unknown; count?: unknown } } | null
    )?.autoFailover
    return {
      tried: Array.isArray(raw?.tried)
        ? raw.tried.filter((t): t is string => typeof t === 'string')
        : [],
      count: typeof raw?.count === 'number' && raw.count > 0 ? Math.floor(raw.count) : 0,
    }
  }, [location.state])

  useEffect(() => {
    if (!isCmsRoute || !startFailure) return
    if (startFailure.sourceCode !== resolvedSourceCode || !resolvedVodId) return

    const giveUp = () => {
      // 有详情（信息已加载、只是流打不开）：只弹提示，播放器与换源条都在，用户可手动换；
      // 没详情：把原始失败消息交还错误页，并结束骨架屏
      if (detailRef.current) {
        showPlayerNotice('当前源加载失败，请手动换个源试试')
      } else {
        setError(startFailure.message)
        setLoading(false)
      }
      setStartFailure(null)
    }

    if (hasPlayedRef.current || failoverChain.count >= MAX_AUTO_FAILOVER) {
      giveUp()
      return
    }

    // 候选池：播放页已发现并测速排名的优先，其次解析页缓存的候选排名
    // （详情被 503 打死时跨源发现跑不起来，只能靠解析排名兜底）
    const pool = [...sourceSpeed.options]
    const cached = readResolveCandidates(resolvedSourceCode, resolvedVodId)
    if (cached) {
      for (const entry of cached) {
        if (!pool.some(o => o.sourceCode === entry.sourceCode)) {
          pool.push({
            sourceCode: entry.sourceCode,
            sourceName: entry.sourceName,
            bestVodId: entry.vodId,
            bestScore: 0,
          })
        }
      }
    }
    const next = pickFailoverOption(pool, resolvedSourceCode, failoverChain.tried)
    if (next) {
      navigate(buildCmsPlayPath(next.sourceCode, next.bestVodId, selectedEpisode), {
        replace: true,
        state: {
          autoFailover: {
            tried: [...failoverChain.tried, resolvedSourceCode],
            count: failoverChain.count + 1,
          },
        },
      })
      showPlayerNotice(
        `「${sourceConfig?.name ?? '当前源'}」加载失败，已自动换到「${next.sourceName}」`,
      )
      setStartFailure(null)
      return
    }
    // 还没有候选：跨源发现还在跑就继续等（options/isWorking 变化会重跑本 effect）；跑完仍无候选则放弃
    if (!sourceSpeed.isWorking) giveUp()
  }, [
    isCmsRoute,
    startFailure,
    resolvedSourceCode,
    resolvedVodId,
    failoverChain,
    sourceSpeed.options,
    sourceSpeed.isWorking,
    navigate,
    selectedEpisode,
    sourceConfig,
    showPlayerNotice,
  ])

  const betterSourceNoticeKey = useMemo(() => {
    if (!isTmdbRoute || !bestSourceOption) return ''

    const currentScore = currentSourceOption?.bestScore ?? -1
    const hasDifferentTarget =
      bestSourceOption.sourceCode !== resolvedSourceCode || bestSourceOption.bestVodId !== resolvedVodId
    if (!hasDifferentTarget || bestSourceOption.bestScore <= currentScore) return ''

    const seasonScope =
      tmdbMediaType === 'tv' ? (tmdbPlayback.selectedSeasonNumber ?? querySeasonNumber ?? 0) : 0

    return [
      tmdbMediaType || 'movie',
      parsedTmdbId,
      seasonScope,
      `${resolvedSourceCode}:${resolvedVodId}`,
      `${bestSourceOption.sourceCode}:${bestSourceOption.bestVodId}:${bestSourceOption.bestScore}`,
    ].join('|')
  }, [
    currentSourceOption?.bestScore,
    isTmdbRoute,
    bestSourceOption,
    parsedTmdbId,
    querySeasonNumber,
    resolvedSourceCode,
    resolvedVodId,
    tmdbMediaType,
    tmdbPlayback.selectedSeasonNumber,
  ])

  const shouldShowBetterSourceNotice =
    Boolean(betterSourceNoticeKey) && !dismissedBetterNoticeKeys.includes(betterSourceNoticeKey)

  const clearBetterNoticeRuntime = useCallback(() => {
    if (betterNoticeTimerRef.current) {
      window.clearTimeout(betterNoticeTimerRef.current)
      betterNoticeTimerRef.current = null
    }
    if (betterNoticeAnimationFrameRef.current) {
      window.cancelAnimationFrame(betterNoticeAnimationFrameRef.current)
      betterNoticeAnimationFrameRef.current = null
    }
  }, [])

  const dismissBetterSourceNotice = useCallback(() => {
    if (!betterSourceNoticeKey) return
    setDismissedBetterNoticeKeys(prev =>
      prev.includes(betterSourceNoticeKey) ? prev : [...prev.slice(-29), betterSourceNoticeKey],
    )
  }, [betterSourceNoticeKey])

  useEffect(() => {
    clearBetterNoticeRuntime()

    if (!shouldShowBetterSourceNotice || !betterSourceNoticeKey) {
      setBetterNoticeProgress(100)
      return
    }

    setBetterNoticeProgress(100)

    betterNoticeAnimationFrameRef.current = window.requestAnimationFrame(() => {
      betterNoticeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setBetterNoticeProgress(0)
        betterNoticeAnimationFrameRef.current = null
      })
    })

    betterNoticeTimerRef.current = window.setTimeout(() => {
      dismissBetterSourceNotice()
    }, BETTER_SOURCE_NOTICE_DURATION)

    return () => {
      clearBetterNoticeRuntime()
    }
  }, [betterSourceNoticeKey, clearBetterNoticeRuntime, dismissBetterSourceNotice, shouldShowBetterSourceNotice])

  const handleSwitchToBetterSource = useCallback(() => {
    if (!bestSourceOption) return
    if (betterSourceNoticeKey) {
      setDismissedBetterNoticeKeys(prev =>
        prev.includes(betterSourceNoticeKey) ? prev : [...prev.slice(-29), betterSourceNoticeKey],
      )
    }
    handleSourceChange(bestSourceOption.sourceCode)
  }, [bestSourceOption, betterSourceNoticeKey, handleSourceChange])

  const shouldShowMatchingNotice = Boolean(
    isTmdbRoute && tmdbPlayback.playlist.loading && tmdbPlayback.playlist.searched,
  )

  const matchingNoticeText = useMemo(() => {
    const { completed, total, currentSourceName, lastResultSourceName } = tmdbPlayback.playlist.progress
    const progressText = total > 0 ? `${Math.min(completed, total)}/${total}` : '--/--'
    const sourceText = currentSourceName || lastResultSourceName
    return sourceText ? `持续匹配中 ${progressText} · ${sourceText}` : `持续匹配中 ${progressText}`
  }, [tmdbPlayback.playlist.progress])

  const shouldShowOverlayNotices =
    shouldShowMatchingNotice || shouldShowBetterSourceNotice || transientNotices.length > 0

  const title = detail?.videoInfo?.title || tmdbPlayback.tmdbDetail?.title || '未知视频'
  const sourceName =
    detail?.videoInfo?.source_name ||
    sourceOptions.find(option => option.sourceCode === resolvedSourceCode)?.sourceName ||
    '未知来源'

  const rawOverview = tmdbPlayback.tmdbDetail?.overview || detail?.videoInfo?.desc || ''
  const overview = isCmsRoute ? stripHtmlTags(rawOverview) : rawOverview
  const pageTitle = title || '视频播放'
  useDocumentTitle(pageTitle)

  const recommendationItems = isTmdbRoute
    ? tmdbPlayback.recommendations.length > 0
      ? tmdbPlayback.recommendations
      : fallbackRecommendations
    : []
  const detailLink =
    isTmdbRoute && tmdbMediaType ? buildTmdbDetailPath(tmdbMediaType, parsedTmdbId) : undefined
  const seasonCount =
    tmdbMediaType === 'tv'
      ? tmdbPlayback.tmdbRichDetail?.number_of_seasons || tmdbPlayback.seasonOptions.length
      : undefined
  const episodeCount =
    tmdbMediaType === 'tv'
      ? tmdbPlayback.tmdbRichDetail?.number_of_episodes || detail?.episodes.length
      : undefined
  const hasSeasonPanel = !isCmsRoute && tmdbPlayback.seasonOptions.length > 0

  const modeLabel = isTmdbRoute ? 'TMDB 播放模式' : 'CMS 直连模式'

  // 「简介」胶囊页的数据：原底部「影视介绍」整体搬入右侧合并框
  const playerInfo: PlayerInfoData = {
    title,
    originalTitle: tmdbPlayback.tmdbDetail?.originalTitle,
    poster: tmdbPlayback.tmdbDetail?.posterPath
      ? getPosterUrl(tmdbPlayback.tmdbDetail.posterPath, 'w342')
      : detail?.videoInfo?.cover || undefined,
    overview,
    sourceName,
    modeLabel,
    mediaTypeText: tmdbMediaType === 'tv' ? '剧集' : tmdbMediaType === 'movie' ? '电影' : undefined,
    releaseDate: tmdbPlayback.tmdbDetail?.releaseDate,
    rating: tmdbPlayback.tmdbDetail?.voteAverage,
    seasonEpisodeText:
      tmdbMediaType === 'tv' && seasonCount && episodeCount
        ? `共 ${seasonCount} 季 / ${episodeCount} 集`
        : undefined,
    extraBadges: [detail?.videoInfo?.type, detail?.videoInfo?.year, detail?.videoInfo?.area].filter(
      (value): value is string => Boolean(value),
    ),
    actors: isTmdbRoute
      ? (tmdbPlayback.tmdbRichDetail?.credits?.cast ?? []).slice(0, 12).map(cast => cast.name)
      : splitPersonNames(detail?.videoInfo?.actor),
    directors: isTmdbRoute
      ? (tmdbPlayback.tmdbRichDetail?.created_by ?? []).map(person => person.name)
      : splitPersonNames(detail?.videoInfo?.director),
    favoriteAction: isCmsRoute
      ? { active: cmsFavoriteActive, onToggle: handleToggleCmsFavorite }
      : isTmdbRoute && tmdbMediaType
        ? { active: tmdbFavoriteActive, onToggle: handleToggleTmdbFavorite }
        : undefined,
    detailLink,
  }
  const collapsibleContentClassName =
    'overflow-hidden border-t border-border/45 p-3 md:p-4 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-top-1 data-[state=closed]:slide-out-to-top-1 data-[state=open]:duration-300 data-[state=closed]:duration-200'

  const getPanelClassName = (_panel: 'source' | 'season' | 'episode') =>
    'overflow-hidden rounded-lg border border-border/60 bg-card/55 transition-all'

  useEffect(() => {
    if (isCmsRoute && activeRightPanel !== 'episode') {
      setActiveRightPanel('episode')
      return
    }

    if (!hasSeasonPanel && activeRightPanel === 'season') {
      setActiveRightPanel('episode')
    }
  }, [activeRightPanel, hasSeasonPanel, isCmsRoute])

  const { shouldShowLoading, primaryError } = derivePlayerViewState({
    hasDetail: Boolean(detail),
    loading,
    error,
    routeError,
    isTmdbRoute,
    tmdbLoading: tmdbPlayback.tmdbLoading,
    tmdbPlaylistLoading: tmdbPlayback.playlist.loading,
    tmdbError: tmdbPlayback.tmdbError,
    tmdbPlaylistSearched: tmdbPlayback.playlist.searched,
  })
  const loadingMode = isCmsRoute ? 'cms' : 'tmdb'
  const renderErrorState = (message: string) => {
    const isNoMatch = message.includes('没有匹配到可播放资源')
    const isRouteInvalid = message.includes('无效的播放地址')
    const isSourceConfigIssue = message.includes('未找到对应视频源配置')

    const title = isRouteInvalid
      ? '这个播放地址不可用'
      : isNoMatch
        ? '找不到匹配播放源'
        : '视频暂时无法播放'
    const tag = isRouteInvalid ? '路由校验失败' : isNoMatch ? '匹配结果为空' : '播放链路异常'
    const primaryAction = {
      label: '返回上一页',
      onClick: () => navigate(-1),
    }

    const secondaryAction = isNoMatch
      ? detailLink
        ? {
            label: '返回详情页重试',
            to: detailLink,
            variant: 'outline' as const,
          }
        : {
            label: '视频源设置',
            to: '/settings/source',
            variant: 'outline' as const,
          }
      : isSourceConfigIssue
        ? {
            label: '视频源设置',
            to: '/settings/source',
            variant: 'outline' as const,
          }
        : detailLink
          ? {
              label: '查看影视详情',
              to: detailLink,
              variant: 'outline' as const,
            }
          : undefined

    return (
      <PlayerErrorState
        title={title}
        description={message}
        tag={tag}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
      />
    )
  }

  if (isTmdbRoute && !tmdbEnabled) {
    return (
      <PlayerErrorState
        title="TMDB 模式未启用"
        description="当前未开启 TMDB 智能模式，无法使用 TMDB 播放功能。请在设置中开启或返回首页。"
        tag="模式不可用"
        primaryAction={{
          label: '返回首页',
          onClick: () => navigate('/'),
        }}
        secondaryAction={{
          label: '前往设置',
          to: '/settings/system',
          variant: 'outline' as const,
        }}
      />
    )
  }

  if (shouldShowLoading) {
    return <PlayerLoadingSkeleton mode={loadingMode} />
  }

  if (primaryError) {
    return renderErrorState(primaryError)
  }

  if (!detail || detail.episodes.length === 0) {
    return renderErrorState(error || '无法获取播放信息')
  }

  return (
    <div className="space-y-4 md:space-y-5">
      {isTmdbRoute && (
        <PlayerHeroSection
          modeLabel={modeLabel}
          sourceName={sourceName}
          title={title}
          overview={overview}
          posterPath={tmdbPlayback.tmdbDetail?.posterPath}
          backdropPath={tmdbPlayback.tmdbDetail?.backdropPath}
          tmdbMediaType={tmdbMediaType}
          currentEpisodeText={episodes[selectedEpisode] || `第 ${selectedEpisode + 1} 集`}
          totalEpisodeText={`${detail.episodes.length} 集`}
          onBack={() => navigate(-1)}
        />
      )}

      <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          {error && (
            <div className="rounded-lg border border-red-400/35 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {error}
            </div>
          )}

          <section className="relative overflow-hidden rounded-lg border border-border/60 bg-black/95 shadow-lg">
            <div
              className={`absolute top-3 left-3 z-40 flex max-w-[min(72%,600px)] items-center gap-2.5 transition-opacity duration-300 ${
                controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <button
                type="button"
                aria-label="返回上一页"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
                className="flex shrink-0 items-center gap-1 rounded-full border border-white/20 bg-black/20 py-1.5 pr-3.5 pl-2.5 text-sm text-white backdrop-blur-sm transition-colors duration-300 hover:bg-black/35"
              >
                <ArrowLeft className="size-4" />
                返回
              </button>
              {title.trim() && (
                <span className="min-w-0 truncate text-sm font-medium text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.85)]">
                  {title.trim()}
                  {detail.episodes.length > 1 && (
                    <span className="text-white/75"> · 第{selectedEpisode + 1}集</span>
                  )}
                </span>
              )}
            </div>
            <div
              id="player"
              ref={containerRef}
              className="aspect-video min-h-[180px] w-full [touch-action:none] bg-black sm:h-[clamp(240px,56vw,74vh)] sm:min-h-[220px] sm:aspect-auto [&_.art-video-player]:!h-full [&_.art-video-player]:!w-full [&_.artplayer-app]:!h-full [&_.artplayer-app]:!w-full [&_video]:!h-full [&_video]:!w-full"
            />
            {seekPreviewOverlay &&
              (playerOverlayContainer
                ? createPortal(seekPreviewOverlay, playerOverlayContainer)
                : seekPreviewOverlay)}
            {volumeOverlay &&
              (playerOverlayContainer ? createPortal(volumeOverlay, playerOverlayContainer) : volumeOverlay)}
            {shouldShowOverlayNotices && (
              <div className="pointer-events-none absolute top-3 right-3 z-30 flex max-w-[min(92vw,420px)] flex-col items-end gap-2">
                {shouldShowMatchingNotice && (
                  <div className="pointer-events-auto w-[min(86vw,320px)] overflow-hidden rounded-md border border-amber-300/35 bg-black/68 shadow-lg backdrop-blur-sm">
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-white">
                      <span className="inline-flex size-3.5 animate-spin rounded-full border border-amber-200 border-t-transparent" />
                      <span className="truncate">{matchingNoticeText}</span>
                    </div>
                  </div>
                )}

                {shouldShowBetterSourceNotice && bestSourceOption && (
                  <div className="pointer-events-auto w-[min(90vw,360px)] overflow-hidden rounded-md border border-emerald-300/35 bg-black/72 shadow-lg backdrop-blur-sm">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-white">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold">匹配到更优结果</p>
                        <p className="mt-0.5 truncate text-[11px] text-white/80">
                          {bestSourceOption.sourceName}（{bestSourceOption.bestScore} 分）
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7 rounded-full px-3 text-[11px]"
                          onClick={handleSwitchToBetterSource}
                        >
                          切换
                        </Button>
                        <button
                          type="button"
                          className="text-white/70 transition-colors hover:text-white"
                          aria-label="关闭更优匹配提示"
                          onClick={dismissBetterSourceNotice}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="h-0.5 border-t border-white/12 bg-white/20">
                      <div
                        className="h-full bg-emerald-400 transition-[width] ease-linear"
                        style={{
                          width: `${betterNoticeProgress}%`,
                          transitionDuration: `${BETTER_SOURCE_NOTICE_DURATION}ms`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {transientNotices.map(notice => (
                  <div
                    key={notice.id}
                    className="pointer-events-auto w-[min(78vw,340px)] overflow-hidden rounded-md border border-white/15 bg-black/65 shadow-lg backdrop-blur-sm"
                  >
                    <div className="px-3 py-1.5 text-xs text-white">{notice.message}</div>
                    <div className="h-0.5 bg-white/20">
                      <div
                        className="h-full bg-red-500 transition-[width] ease-linear"
                        style={{
                          width: `${notice.progress}%`,
                          transitionDuration: `${notice.duration}ms`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {isDetailRefreshing && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
                <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-sm text-white">
                  <Spinner size="sm" />
                  正在切换资源...
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className="min-w-0 xl:sticky xl:top-20 xl:h-[clamp(240px,56vw,74vh)] xl:min-h-[220px] xl:pr-1">
          {isCmsRoute ? (
            <div className="flex flex-col gap-3 xl:h-full">
              <PlayerSourceSpeedStrip
                options={sourceSpeed.options}
                probes={sourceSpeed.probes}
                qualities={sourceSpeed.qualities}
                probedCodes={sourceSpeed.probedCodes}
                selectedSourceCode={resolvedSourceCode}
                onSourceChange={handleAnySourceChange}
                onRetest={sourceSpeed.retest}
                isWorking={sourceSpeed.isWorking}
                matching={sourceSpeed.discovering}
              />
              <PlayerEpisodeInfoPanel
                info={playerInfo}
                totalEpisodes={detail.episodes.length}
                selectedEpisode={selectedEpisode}
                isReversed={episodePagination.isReversed}
                onToggleOrder={() => episodePagination.setIsReversed(prev => !prev)}
                pageRanges={episodePagination.pageRanges}
                currentPageRange={episodePagination.currentPageRange}
                onPageRangeChange={episodePagination.setCurrentPageRange}
                episodes={episodePagination.currentPageEpisodes}
                onEpisodeSelect={handleEpisodeChange}
                episodeProgressMap={episodeProgressMap}
                className="xl:min-h-0 xl:flex-1"
              />
            </div>
          ) : (
            <div className="space-y-3 xl:flex xl:h-full xl:flex-col xl:gap-3 xl:space-y-0">
              <Collapsible
                open={activeRightPanel === 'source'}
                onOpenChange={open => setActiveRightPanel(open ? 'source' : null)}
                className={getPanelClassName('source')}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    aria-label="展开或收起换源面板"
                    className="flex min-w-0 w-full items-center justify-between gap-2 px-3 py-3 text-sm font-semibold md:px-4"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">换源</span>
                      <span className="text-muted-foreground truncate text-xs">{sourceOptions.length} 源</span>
                    </span>
                    <ChevronDown
                      className={`size-4 transition-transform ${activeRightPanel === 'source' ? 'rotate-180' : ''}`}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent
                  className={collapsibleContentClassName}
                >
                  <ScrollArea className="max-h-44 sm:max-h-56 xl:max-h-72">
                    <div className="grid grid-cols-2 gap-2 pr-2 sm:flex sm:flex-wrap">
                      {sourceOptions.map(option => {
                        const active = option.sourceCode === resolvedSourceCode
                        return (
                          <Button
                            key={option.sourceCode}
                            size="sm"
                            variant={active ? 'default' : 'secondary'}
                            className="min-w-0 max-w-full justify-between rounded-full sm:w-auto sm:max-w-[240px]"
                            aria-current={active ? 'true' : undefined}
                            aria-label={`切换到视频源 ${option.sourceName}`}
                            onClick={() => handleSourceChange(option.sourceCode)}
                          >
                            <span className="truncate">{option.sourceName}</span>
                            {isTmdbRoute && <span className="shrink-0 text-[11px] opacity-70">{option.bestScore}</span>}
                          </Button>
                        )
                      })}
                    </div>
                  </ScrollArea>
                </CollapsibleContent>
              </Collapsible>

            {hasSeasonPanel && (
              <Collapsible
                open={activeRightPanel === 'season'}
                onOpenChange={open => setActiveRightPanel(open ? 'season' : null)}
                className={getPanelClassName('season')}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    aria-label="展开或收起选季面板"
                    className="flex min-w-0 w-full items-center justify-between gap-2 px-3 py-3 text-sm font-semibold md:px-4"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">选季</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {tmdbPlayback.seasonOptions.length} 季
                      </span>
                    </span>
                    <ChevronDown
                      className={`size-4 transition-transform ${activeRightPanel === 'season' ? 'rotate-180' : ''}`}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent
                  className={collapsibleContentClassName}
                >
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    {tmdbPlayback.seasonOptions.map(option => {
                      const active = option.seasonNumber === tmdbPlayback.selectedSeasonNumber
                      return (
                        <Button
                          key={option.seasonNumber}
                          size="sm"
                          variant={active ? 'default' : 'secondary'}
                          className="min-w-0 max-w-full justify-between rounded-full sm:w-auto sm:max-w-[240px]"
                          aria-current={active ? 'true' : undefined}
                          aria-label={`切换到第 ${option.seasonNumber} 季`}
                          onClick={() => handleSeasonChange(option.seasonNumber)}
                        >
                          <span className="truncate">S{option.seasonNumber}</span>
                          <span className="shrink-0 text-[11px] opacity-70">{option.matchedSourceCount}</span>
                        </Button>
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            <PlayerSourceSpeedStrip
              options={sourceSpeed.options}
              probes={sourceSpeed.probes}
                qualities={sourceSpeed.qualities}
              probedCodes={sourceSpeed.probedCodes}
              selectedSourceCode={resolvedSourceCode}
              onSourceChange={handleAnySourceChange}
              onRetest={sourceSpeed.retest}
              isWorking={sourceSpeed.isWorking}
              className="shrink-0"
            />
            {episodes.length > 0 && (
              <PlayerEpisodeInfoPanel
                info={playerInfo}
                totalEpisodes={detail.episodes.length}
                selectedEpisode={selectedEpisode}
                isReversed={episodePagination.isReversed}
                onToggleOrder={() => episodePagination.setIsReversed(prev => !prev)}
                pageRanges={episodePagination.pageRanges}
                currentPageRange={episodePagination.currentPageRange}
                onPageRangeChange={episodePagination.setCurrentPageRange}
                episodes={episodePagination.currentPageEpisodes}
                onEpisodeSelect={handleEpisodeChange}
                episodeProgressMap={episodeProgressMap}
                className="xl:min-h-0 xl:flex-1"
              />
            )}
            </div>
          )}
        </aside>
      </section>

      <PlayerInfoAndRecommendations
        showRecommendations={isTmdbRoute}
        recommendations={recommendationItems}
      />
    </div>
  )
}
