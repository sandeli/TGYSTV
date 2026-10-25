import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { useEffect, useState } from 'react'
import { MediaPosterCard } from '@/shared/components/common'
import {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
} from '@/shared/components/ui/carousel'
import { AspectRatio } from '@/shared/components/ui/aspect-ratio'
import { Button } from '@/shared/components/ui/button'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useIsMobile } from '@/shared/hooks/use-mobile'
import {
  DOUBAN_CATEGORIES,
  buildDoubanCategoryPath,
  buildDoubanPlayPath,
  doubanPosterUrl,
  fetchDoubanCategory,
  type DoubanCategory,
  type DoubanSubject,
} from '@/shared/lib/douban'

/**
 * DoubanSectionSkeleton - 板块骨架屏
 */
function DoubanSectionSkeleton({ title }: { title: string }) {
  const isMobile = useIsMobile()
  const skeletonCount = isMobile
    ? 3
    : typeof window !== 'undefined' && window.innerWidth < 1024
      ? 4
      : 6

  return (
    <div>
      <div className="px-1">
        <h2 className="text-primary text-xl font-semibold">{title}</h2>
      </div>
      <div className="flex gap-4 pt-2">
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <div key={index} className="flex-1">
            <AspectRatio ratio={2 / 3}>
              <Skeleton className="size-full rounded-lg" />
            </AspectRatio>
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * DoubanSection - 单个豆瓣分类板块（海报横滑墙）
 * 点击海报按片名跳转站内聚合搜索
 */
function DoubanSection({ category }: { category: DoubanCategory }) {
  const isMobile = useIsMobile()
  const isTablet = !isMobile && typeof window !== 'undefined' && window.innerWidth < 1024
  const visibleCount = isMobile ? 3 : isTablet ? 4 : 6
  const slidesToScroll = visibleCount

  const [items, setItems] = useState<DoubanSubject[]>([])
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [carouselApi, setCarouselApi] = useState<CarouselApi>()
  const [canScrollPrev, setCanScrollPrev] = useState(false)
  const [canScrollNext, setCanScrollNext] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchDoubanCategory(category).then(result => {
      if (cancelled) return
      setItems(result)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // category 为模块级常量配置，引用稳定；reloadKey 变化时重新拉取（失败占位的点击重试）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

  useEffect(() => {
    if (!carouselApi) return
    const onSelect = () => {
      setCanScrollPrev(carouselApi.canScrollPrev())
      setCanScrollNext(carouselApi.canScrollNext())
    }
    onSelect()
    carouselApi.on('select', onSelect)
    carouselApi.on('reInit', onSelect)
    return () => {
      carouselApi.off('select', onSelect)
      carouselApi.off('reInit', onSelect)
    }
  }, [carouselApi])

  if (loading) {
    return <DoubanSectionSkeleton title={category.label} />
  }

  // 拉取失败或无数据：显示带标题的失败占位，可点击重试（不再整块消失）
  if (items.length === 0) {
    return (
      <div className="px-1">
        <h2 className="text-primary text-xl font-semibold">
          <Link
            to={buildDoubanCategoryPath(category)}
            className="hover:underline underline-offset-4"
          >
            {category.label}
          </Link>
        </h2>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          className="text-muted-foreground hover:text-primary mt-2 text-sm underline underline-offset-4"
        >
          加载失败，点击重试
        </button>
      </div>
    )
  }

  const canDrag = items.length > visibleCount

  return (
    <div className="group/carousel">
      <div className="px-1">
        <h2 className="text-primary text-xl font-semibold">
          <Link
            to={buildDoubanCategoryPath(category)}
            className="inline-flex items-center gap-0.5 hover:underline underline-offset-4"
          >
            {category.label}
            <ChevronRight className="size-5" />
          </Link>
        </h2>
      </div>
      <div className="pt-2">
        <Carousel opts={{ watchDrag: canDrag, slidesToScroll }} setApi={setCarouselApi}>
          {/* py 给 hover 立体浮起留出不被轮播视口裁掉的余量 */}
          <CarouselContent className="py-2.5">
            {items.map(item => {
              const rating = Number.parseFloat(item.rate)
              return (
                <CarouselItem key={item.id} className="h-fit basis-1/3 md:basis-1/4 lg:basis-1/6">
                  <MediaPosterCard
                    to={buildDoubanPlayPath(item.title)}
                    posterUrl={item.cover ? doubanPosterUrl(item.cover) : null}
                    title={item.title}
                    rating={Number.isFinite(rating) && rating > 0 ? rating : undefined}
                    hoverEffect="tilt3d"
                  />
                </CarouselItem>
              )
            })}
          </CarouselContent>
          {canDrag && canScrollPrev && (
            <Button
              variant="outline"
              size="icon"
              className="absolute top-1/2 -left-5 size-10 -translate-y-1/2 rounded-full transition-opacity duration-300 md:size-12 lg:opacity-0 lg:group-hover/carousel:opacity-100 dark:bg-zinc-800"
              onClick={() => carouselApi?.scrollPrev()}
            >
              <ChevronLeft className="size-4 translate-x-1.5 md:size-6 md:translate-x-0.5" />
            </Button>
          )}
          {canDrag && canScrollNext && (
            <Button
              variant="outline"
              size="icon"
              className="absolute top-1/2 -right-5 size-10 -translate-y-1/2 rounded-full transition-opacity duration-300 md:size-12 lg:opacity-0 lg:group-hover/carousel:opacity-100 dark:bg-zinc-800"
              onClick={() => carouselApi?.scrollNext()}
            >
              <ChevronRight className="size-4 -translate-x-1.5 md:size-6 md:-translate-x-0.5" />
            </Button>
          )}
        </Carousel>
      </div>
    </div>
  )
}

/**
 * DoubanHomeContent - 首页豆瓣分类墙
 * 热门电影 / 国产剧 / 热门综艺 / 热门动漫 / 豆瓣高分 / 经典电影
 */
export function DoubanHomeContent() {
  return (
    <>
      {DOUBAN_CATEGORIES.map(category => (
        <DoubanSection key={`${category.type}-${category.tag}`} category={category} />
      ))}
    </>
  )
}
