import { useState } from 'react'
import { ChevronDown, Clapperboard, RadioTower, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { cn } from '@/shared/lib/utils'
import type { PlayerSourceOption } from '@/features/player/hooks'
import type { PlaybackProbeResult } from '@/shared/lib/playbackProbe'

interface PlayerSourceSpeedStripProps {
  options: PlayerSourceOption[]
  probes: Map<string, PlaybackProbeResult>
  qualities: Map<string, string>
  probedCodes: Set<string>
  selectedSourceCode: string
  onSourceChange: (sourceCode: string) => void
  /** 再次测速（测速完毕后在面板底部显示按钮）；不传则不显示 */
  onRetest?: () => void
  isWorking: boolean
  /** 正在跨源匹配候选（尚无结果时显示同款占位条，避免换源条突然蹦出） */
  matching?: boolean
  className?: string
}

/** 源名展示清洗：去掉开头/结尾的表情、横线等装饰字符（行首统一由场记板图标占位） */
function displaySourceName(name: string): string {
  const cleaned = name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
  return cleaned || name
}

/** 状态点颜色：优先按吞吐余量（越大越稳），没有余量数据时按起播耗时 */
function speedDotClass(probe: PlaybackProbeResult): string {
  if (probe.headroom !== undefined) {
    if (probe.headroom >= 2) return 'bg-emerald-500'
    if (probe.headroom >= 1) return 'bg-amber-500'
    return 'bg-rose-500'
  }
  if (probe.startupMs <= 400) return 'bg-emerald-500'
  if (probe.startupMs <= 1000) return 'bg-amber-500'
  return 'bg-rose-500'
}

/**
 * 选集上方的换源入口，与相邻的选季/选集面板同款样式：
 * 默认收起为一条（显示源数量与当前源），点击展开按播放速度排好的候选；
 * 匹配阶段先以同尺寸占位条出现，避免布局突然跳动。
 */
export function PlayerSourceSpeedStrip({
  options,
  probes,
  qualities,
  probedCodes,
  selectedSourceCode,
  onSourceChange,
  onRetest,
  isWorking,
  matching = false,
  className,
}: PlayerSourceSpeedStripProps) {
  const [open, setOpen] = useState(false)

  if (options.length <= 1) {
    if (!matching) return null
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 overflow-hidden rounded-lg border border-border/60 bg-card/55 px-3 py-3 text-sm font-semibold md:px-4',
          className,
        )}
      >
        <RadioTower className="size-4 shrink-0" />
        <span className="shrink-0">换源</span>
        <span className="text-muted-foreground animate-pulse truncate text-xs font-normal">
          正在匹配其他源…
        </span>
      </div>
    )
  }

  const current = options.find(option => option.sourceCode === selectedSourceCode)
  const currentLabel = current ? displaySourceName(current.sourceName) : ''

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'overflow-hidden rounded-lg border border-border/60 bg-card/55 transition-all',
        className,
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label="展开或收起换源面板"
          className="flex w-full min-w-0 items-center justify-between gap-2 px-3 py-3 text-sm font-semibold md:px-4"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <RadioTower className="size-4 shrink-0" />
            <span className="shrink-0">换源</span>
            <span className="text-muted-foreground truncate text-xs font-normal">
              {options.length} 源{current ? ` · 当前 ${currentLabel}` : ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {isWorking && (
              <span className="text-muted-foreground animate-pulse text-xs font-normal">测速中</span>
            )}
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden border-t border-border/45 p-3 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 data-[state=closed]:duration-200 data-[state=open]:duration-300 md:p-4">
        <ScrollArea className="max-h-56 sm:max-h-72">
          <div className="flex flex-col gap-2 pr-2">
            {options.map(option => {
              const active = option.sourceCode === selectedSourceCode
              const probe = probes.get(option.sourceCode)
              const quality = qualities.get(option.sourceCode)
              const probed = probedCodes.has(option.sourceCode)
              const label = displaySourceName(option.sourceName)
              return (
                <Button
                  key={option.sourceCode}
                  size="sm"
                  variant={active ? 'default' : 'secondary'}
                  className="h-auto w-full min-w-0 justify-between gap-2 rounded-full px-3.5 py-2"
                  aria-current={active ? 'true' : undefined}
                  aria-label={`切换到视频源 ${label}`}
                  onClick={() => onSourceChange(option.sourceCode)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <Clapperboard className="size-4 shrink-0 opacity-75" />
                    <span className="leading-snug">{label}</span>
                    {quality && (
                      <span className="shrink-0 text-[11px] font-semibold opacity-90">
                        {quality}
                      </span>
                    )}
                  </span>
                  {probe !== undefined ? (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums opacity-80">
                      <span className={cn('size-1.5 rounded-full', speedDotClass(probe))} />
                      播放 {probe.startupMs} ms · {probe.throughputMbps} Mbps
                    </span>
                  ) : probed ? (
                    <span className="shrink-0 text-[11px] opacity-60">测不出</span>
                  ) : (
                    <span className="shrink-0 text-[11px] opacity-60">测速中</span>
                  )}
                </Button>
              )
            })}
          </div>
        </ScrollArea>
        {onRetest && !isWorking && (
          <div className="flex justify-end pt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 rounded-full"
              onClick={onRetest}
            >
              <RefreshCw className="size-3.5" />
              再次测速
            </Button>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
