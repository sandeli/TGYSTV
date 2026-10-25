import { describe, expect, it } from 'vitest'
import {
  derivePlayerViewState,
  pickFailoverOption,
  shouldFallbackEpisodeToFirst,
} from './playerViewState'

describe('derivePlayerViewState', () => {
  it('错误存在时不应显示 loading', () => {
    const state = derivePlayerViewState({
      hasDetail: false,
      loading: false,
      error: '缺少参数',
      routeError: null,
      isTmdbRoute: true,
      tmdbLoading: false,
      tmdbPlaylistLoading: false,
      tmdbError: null,
      tmdbPlaylistSearched: true,
    })

    expect(state.primaryError).toBe('缺少参数')
    expect(state.shouldShowLoading).toBe(false)
  })

  it('新一轮加载开始时应优先显示 loading，避免旧错误闪屏', () => {
    const state = derivePlayerViewState({
      hasDetail: false,
      loading: true,
      error: '上一次请求失败',
      routeError: null,
      isTmdbRoute: true,
      tmdbLoading: false,
      tmdbPlaylistLoading: false,
      tmdbError: null,
      tmdbPlaylistSearched: true,
    })

    expect(state.primaryError).toBeNull()
    expect(state.shouldShowLoading).toBe(true)
  })

  it('路由级错误仍应直接展示，不被 loading 覆盖', () => {
    const state = derivePlayerViewState({
      hasDetail: false,
      loading: true,
      error: null,
      routeError: '无效的播放地址',
      isTmdbRoute: true,
      tmdbLoading: true,
      tmdbPlaylistLoading: true,
      tmdbError: null,
      tmdbPlaylistSearched: false,
    })

    expect(state.primaryError).toBe('无效的播放地址')
    expect(state.shouldShowLoading).toBe(false)
  })

  it('TMDB 首次匹配阶段应显示 loading', () => {
    const state = derivePlayerViewState({
      hasDetail: false,
      loading: false,
      error: null,
      routeError: null,
      isTmdbRoute: true,
      tmdbLoading: false,
      tmdbPlaylistLoading: false,
      tmdbError: null,
      tmdbPlaylistSearched: false,
    })

    expect(state.shouldShowLoading).toBe(true)
  })

  it('TMDB 匹配中（playlist loading）应持续显示 loading', () => {
    const state = derivePlayerViewState({
      hasDetail: false,
      loading: false,
      error: null,
      routeError: null,
      isTmdbRoute: true,
      tmdbLoading: false,
      tmdbPlaylistLoading: true,
      tmdbError: null,
      tmdbPlaylistSearched: true,
    })

    expect(state.shouldShowLoading).toBe(true)
  })
})

describe('shouldFallbackEpisodeToFirst', () => {
  it('分集越界时需要回落到第 1 集', () => {
    expect(shouldFallbackEpisodeToFirst(20, 50)).toBe(true)
  })

  it('分集未越界时不应回落', () => {
    expect(shouldFallbackEpisodeToFirst(20, 10)).toBe(false)
  })
})

describe('pickFailoverOption 起播失败自动换源挑选', () => {
  const options = [
    { sourceCode: 'cur', bestVodId: 'v0' },
    { sourceCode: 'a', bestVodId: 'v1' },
    { sourceCode: 'b', bestVodId: 'v2' },
  ]

  it('按排名挑第一个非当前、未试过的源', () => {
    expect(pickFailoverOption(options, 'cur', [])?.sourceCode).toBe('a')
    expect(pickFailoverOption(options, 'cur', ['a'])?.sourceCode).toBe('b')
  })

  it('全部试过或只剩当前源时返回 null', () => {
    expect(pickFailoverOption(options, 'cur', ['a', 'b'])).toBeNull()
    expect(pickFailoverOption([options[0]], 'cur', [])).toBeNull()
    expect(pickFailoverOption([], 'cur', [])).toBeNull()
  })

  it('没有资源 id 的候选跳过', () => {
    expect(
      pickFailoverOption(
        [
          { sourceCode: 'x', bestVodId: '' },
          { sourceCode: 'y', bestVodId: 'v9' },
        ],
        'cur',
        [],
      )?.sourceCode,
    ).toBe('y')
  })
})
