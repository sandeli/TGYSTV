interface DerivePlayerViewStateParams {
  hasDetail: boolean
  loading: boolean
  error: string | null
  routeError: string | null
  isTmdbRoute: boolean
  tmdbLoading: boolean
  tmdbPlaylistLoading: boolean
  tmdbError: string | null
  tmdbPlaylistSearched: boolean
}

interface PlayerViewStateResult {
  shouldShowLoading: boolean
  primaryError: string | null
}

export function shouldFallbackEpisodeToFirst(episodesLength: number, selectedEpisode: number): boolean {
  if (episodesLength === 0) return false
  return selectedEpisode >= episodesLength
}

export interface FailoverOptionLike {
  sourceCode: string
  bestVodId?: string
}

/**
 * 起播失败自动换源：在已按优劣排名的候选列表里，挑第一个可换的源——
 * 跳过当前源、已试过的源与没有资源 id 的候选。没有可换的返回 null。
 */
export function pickFailoverOption<T extends FailoverOptionLike>(
  options: T[],
  currentSourceCode: string | null,
  triedSourceCodes: string[],
): T | null {
  const tried = new Set(triedSourceCodes)
  for (const option of options) {
    if (!option.bestVodId) continue
    if (option.sourceCode === currentSourceCode) continue
    if (tried.has(option.sourceCode)) continue
    return option
  }
  return null
}

export function derivePlayerViewState(params: DerivePlayerViewStateParams): PlayerViewStateResult {
  const hasPendingLoad =
    params.loading ||
    (params.isTmdbRoute &&
      (params.tmdbLoading || params.tmdbPlaylistLoading || !params.tmdbPlaylistSearched))

  // 路由级错误必须立即展示；其余错误在新一轮加载开始时应让位于骨架屏，避免闪屏。
  if (params.routeError) {
    return {
      shouldShowLoading: false,
      primaryError: params.routeError,
    }
  }

  if (hasPendingLoad && !params.hasDetail) {
    return {
      shouldShowLoading: true,
      primaryError: null,
    }
  }

  const primaryError = params.tmdbError || params.error || null
  const shouldShowLoading = !params.hasDetail && !primaryError && hasPendingLoad

  return {
    shouldShowLoading,
    primaryError,
  }
}
