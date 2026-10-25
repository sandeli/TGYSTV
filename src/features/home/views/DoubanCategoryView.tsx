import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { MediaPosterCard } from '@/shared/components/common'
import { AspectRatio } from '@/shared/components/ui/aspect-ratio'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  buildDoubanPlayPath,
  doubanPosterUrl,
  fetchDoubanCategoryFull,
  findDoubanCategory,
  type DoubanSubject,
} from '@/shared/lib/douban'

/**
 * DoubanCategoryView - 豆瓣分类整页
 * 从首页点栏目名进入：一次拉满 100 条，网格上下排列；点海报仍是直达播放
 */
export default function DoubanCategoryView() {
  const params = useParams()
  const category = findDoubanCategory(params.type ?? '', params.tag ?? '')

  const [items, setItems] = useState<DoubanSubject[]>([])
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!category) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    // 边拉边显示：每合并一页就先上屏，不等 100 部全部拉完
    fetchDoubanCategoryFull(category, partial => {
      if (cancelled) return
      setItems(partial)
      setLoading(false)
    }).then(result => {
      if (cancelled) return
      setItems(result)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // category 由路由参数现算，type/tag 变化即换分类，用原始参数作依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.type, params.tag, reloadKey])

  if (!category) {
    return (
      <div className="px-2 py-10 text-center">
        <p className="text-lg font-semibold">没有这个分类</p>
        <Link to="/" className="text-primary mt-3 inline-block text-sm underline underline-offset-4">
          返回首页
        </Link>
      </div>
    )
  }

  return (
    <div className="px-1">
      <div className="flex flex-wrap items-baseline gap-2 px-1">
        <h1 className="text-primary text-xl font-semibold">{category.label}</h1>
        {!loading && items.length > 0 && (
          <span className="text-muted-foreground text-sm">共 {items.length} 部</span>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-x-4 gap-y-5 pt-3 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index}>
              <AspectRatio ratio={2 / 3}>
                <Skeleton className="size-full rounded-lg" />
              </AspectRatio>
              <Skeleton className="mt-2 h-4 w-3/4" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          className="text-muted-foreground hover:text-primary mt-4 px-1 text-sm underline underline-offset-4"
        >
          加载失败，点击重试
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-x-4 gap-y-5 pt-3 sm:grid-cols-4 lg:grid-cols-6">
          {items.map(item => {
            const rating = Number.parseFloat(item.rate)
            return (
              <MediaPosterCard
                key={item.id}
                to={buildDoubanPlayPath(item.title)}
                posterUrl={item.cover ? doubanPosterUrl(item.cover) : null}
                title={item.title}
                rating={Number.isFinite(rating) && rating > 0 ? rating : undefined}
                hoverEffect="tilt3d"
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
