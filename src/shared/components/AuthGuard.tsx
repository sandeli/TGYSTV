import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Lock,
  ShieldCheck,
  User,
  UserPlus,
  Wrench,
} from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { Spinner } from '@/shared/components/ui/spinner'
import { useAuthStore } from '@/shared/store/authStore'
import {
  fetchCaptcha,
  type CaptchaAnswer,
  type CaptchaChallenge,
} from '@/shared/lib/authApi'
import { TgysLogo } from '@/shared/components/icons'
import { toast } from 'sonner'
import { getPublicEnv } from '@/shared/config/runtimeEnv'
import { detectCarBrowser } from '@/shared/lib/carBrowser'

interface AuthGuardProps {
  children: React.ReactNode
}

const easeOutQuad = [0.25, 0.46, 0.45, 0.94] as const

type GateMode = 'server' | 'legacy' | 'open'
type FormMode = 'account' | 'master' | 'register'

/**
 * 数字验证码输入（本站自托管出题，替代 Cloudflare Turnstile）：
 * 挂载即拉一道题，输入框 + 可点击刷新的验证码图片；题目或输入变化时把作答报给父级。
 * 题目 5 分钟过期、校验一次即作废，父级在提交失败/切换表单时以 key 重挂本组件换新题。
 */
function CaptchaField({ onChange }: { onChange: (answer: CaptchaAnswer) => void }) {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null)
  const [code, setCode] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      setChallenge(await fetchCaptcha())
    } catch {
      setChallenge(null)
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    onChange({ id: challenge?.id ?? '', code })
  }, [challenge, code, onChange])

  const refresh = () => {
    setCode('')
    void load()
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="请输入图片验证码"
        aria-label="图片验证码"
        value={code}
        onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
        className="h-11 min-w-0 flex-1 rounded-full"
      />
      <button
        type="button"
        onClick={refresh}
        title="看不清？点击刷新验证码"
        aria-label="刷新验证码"
        className="border-border/60 h-11 w-[120px] shrink-0 overflow-hidden rounded-lg border bg-white"
      >
        {challenge ? (
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(challenge.image)}`}
            alt="数字验证码"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="text-muted-foreground flex h-full items-center justify-center px-1 text-xs">
            {loadFailed ? '加载失败，点击重试' : '加载中…'}
          </span>
        )}
      </button>
    </div>
  )
}

/** 注册定时开放时刻的登录页展示文案（北京时间）：同年省略年份，如「11月1日 20:00」 */
function formatRegistrationOpenLabel(openAtSec: number): string {
  const date = new Date(openAtSec * 1000)
  const yearOf = (d: Date) => d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const withYear = yearOf(date) !== yearOf(new Date())
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    ...(withYear ? { year: 'numeric' as const } : {}),
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

const FORM_HEADINGS: Record<FormMode, { title: string; desc: string }> = {
  account: { title: '欢迎回来', desc: '登录你的账号，继续观看' },
  master: { title: '站长验证', desc: '输入站长密码（即站点访问密码）进入' },
  register: { title: '创建账号', desc: '注册后即可登录观看' },
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { login, loginWithAccount, register, validateSession, probeConfig, revalidateSession } =
    useAuthStore()
  const serverToken = useAuthStore(state => state.token)
  const legacySessionToken = useAuthStore(state => state.sessionToken)
  const registrationMode = useAuthStore(
    state =>
      state.authConfig?.registrationMode ??
      (state.authConfig?.registrationOpen ? 'open' : 'closed'),
  )
  const registrationOpen = registrationMode !== 'closed'
  // 开放时段：未开始时注册入口换成开放日期通知、已结束时显示结束提示（服务端注册接口同样拦截，前端只是展示口径）
  const registrationOpenAt = useAuthStore(state => state.authConfig?.registrationOpenAt ?? 0)
  const registrationCloseAt = useAuthStore(state => state.authConfig?.registrationCloseAt ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)
  const registrationWindow: 'before' | 'in' | 'after' =
    registrationOpenAt > 0 && nowSec < registrationOpenAt
      ? 'before'
      : registrationCloseAt > 0 && nowSec >= registrationCloseAt
        ? 'after'
        : 'in'
  const registrationFull = useAuthStore(state => state.authConfig?.registrationFull ?? false)
  const siteClosed = useAuthStore(state => state.authConfig?.siteBehavior?.siteClosed ?? false)
  const siteClosedMessage = useAuthStore(
    state => state.authConfig?.siteBehavior?.siteClosedMessage ?? '',
  )
  // 无会员模式（免登录开放）：访客直接进站；顶栏「管理员登录」唤起登录墙时只给站长表单
  const openAccess = useAuthStore(state => state.authConfig?.siteBehavior?.openAccess ?? false)
  // 车机自动免登录：开关开启且当前是车机浏览器时，与无会员模式走同一条访客通道
  const carOpenAccess = useAuthStore(state => state.authConfig?.siteBehavior?.carOpenAccess ?? false)
  const visitorMode = openAccess || (carOpenAccess && detectCarBrowser())
  const loginWallRequested = useAuthStore(state => state.loginWallRequested)
  const setLoginWallRequested = useAuthStore(state => state.setLoginWallRequested)
  const [showClosedLogin, setShowClosedLogin] = useState(false)

  const [gateMode, setGateMode] = useState<GateMode | null>(null)
  const [formMode, setFormMode] = useState<FormMode>('account')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [captchaAnswer, setCaptchaAnswer] = useState<CaptchaAnswer>({ id: '', code: '' })
  // 验证码题目校验一次即作废：每次提交（无论成败）后都换新组件重新出题，
  // 否则第二次提交会拿着已作废的题目被服务端拒绝
  const [captchaNonce, setCaptchaNonce] = useState(0)
  const refreshCaptcha = useCallback(() => {
    setCaptchaAnswer({ id: '', code: '' })
    setCaptchaNonce(n => n + 1)
  }, [])
  // 稳定引用：CaptchaField 靠 onChange 身份不变避免重复上报
  const handleCaptchaChange = useCallback((answer: CaptchaAnswer) => {
    setCaptchaAnswer(answer)
  }, [])
  const [isLoading, setIsLoading] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [isDismissing, setIsDismissing] = useState(false)
  const revealRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const revealOriginRef = useRef('50% 50%')

  const accessPassword = getPublicEnv('TGYS_ACCESS_PASSWORD')
  const legacyProtectionEnabled = !!accessPassword && accessPassword.trim() !== ''

  useEffect(() => {
    const checkAuth = async () => {
      const config = await probeConfig()
      if (config.authEnabled) {
        setGateMode('server')
        const hasToken = !!useAuthStore.getState().token
        let authed = hasToken ? await validateSession() : false
        // 访客模式（无会员开放 / 车机自动免登录）下只有站长会话算数：
        // 普通会员会话一律按访客对待（不弹墙、不进设置）
        if (
          authed &&
          (config.siteBehavior?.openAccess ||
            (config.siteBehavior?.carOpenAccess && detectCarBrowser())) &&
          !useAuthStore.getState().user?.isMaster
        ) {
          authed = false
        }
        setIsAuthenticated(authed)
        return
      }
      if (!legacyProtectionEnabled) {
        setGateMode('open')
        setIsAuthenticated(true)
        return
      }
      setGateMode('legacy')
      setIsAuthenticated(await validateSession())
    }
    void checkAuth()
  }, [probeConfig, validateSession, legacyProtectionEnabled])

  // 应用内退出登录后，守卫重新上锁回到登录界面
  // 会话定时复查（账号模式）：被管理员踢下线/禁用/到期后，最多 60 秒内弹回登录页，看片中也一样（切回标签页会立即复查）
  useEffect(() => {
    if (!isAuthenticated || gateMode !== 'server') return
    let cancelled = false
    const revalidate = async () => {
      const result = await revalidateSession()
      if (!cancelled && result === 'invalid') {
        setIsAuthenticated(false)
        // 刷新公开配置：若是关站导致的失效，登录门要立刻换成维护页而不是普通登录框
        void probeConfig()
      }
    }
    const timer = window.setInterval(() => void revalidate(), 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void revalidate()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isAuthenticated, gateMode, revalidateSession, probeConfig])

  // 访客模式下登录墙被唤起时强制切到站长表单（该模式没有账号登录与注册）
  useEffect(() => {
    if (gateMode === 'server' && visitorMode && (loginWallRequested || showClosedLogin)) {
      setFormMode('master')
    }
  }, [gateMode, visitorMode, loginWallRequested, showClosedLogin])

  useEffect(() => {
    if (!isAuthenticated || isDismissing) return
    if (gateMode === 'server' && !serverToken) setIsAuthenticated(false)
    if (gateMode === 'legacy' && !legacySessionToken && legacyProtectionEnabled) {
      setIsAuthenticated(false)
    }
  }, [
    serverToken,
    legacySessionToken,
    gateMode,
    isAuthenticated,
    isDismissing,
    legacyProtectionEnabled,
  ])

  // 验证成功后，从按钮位置扩散圆形 clip-path 揭开页面内容
  useEffect(() => {
    if (!isDismissing) return

    const reveal = revealRef.current
    if (reveal) {
      const origin = revealOriginRef.current
      const animation = reveal.animate(
        [{ clipPath: `circle(0% at ${origin})` }, { clipPath: `circle(150% at ${origin})` }],
        {
          duration: 600,
          easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
          fill: 'forwards',
        },
      )
      animation.onfinish = () => {
        setIsAuthenticated(true)
        setIsDismissing(false)
      }

      return () => animation.cancel()
    }

    setIsAuthenticated(true)
    setIsDismissing(false)
  }, [isDismissing])

  const handleSuccess = useCallback(() => {
    toast.success('验证成功')
    setLoginWallRequested(false)
    // 成功后必须复位 loading：守卫组件本身不会卸载，退出登录重新上锁时
    // 若 isLoading 残留为 true，登录按钮会一直禁用变灰、需刷新才恢复
    setIsLoading(false)
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      revealOriginRef.current = `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2}px`
    }
    setIsDismissing(true)
  }, [])

  // 访客模式：未登录（或只有普通会员会话）一律按访客直接放行；
  // 关站维护优先于访客开放；顶栏点了「管理员登录」时改为展示登录墙（仅站长表单）
  const visitorAccess =
    gateMode === 'server' && visitorMode && !siteClosed && !loginWallRequested

  // 站长登录在所有模式下都需要数字验证码（防爆破站长密码，与服务端 login 的校验口径一致；
  // 本站自托管出题，不依赖第三方验证服务）。legacy 单密码模式无账号系统，不在此列。
  const masterCaptchaRequired = gateMode === 'server'

  if (
    gateMode === null ||
    (gateMode !== 'open' && isAuthenticated === null && !visitorAccess)
  ) {
    // 首屏探测期间显示品牌骨架而不是白屏（感知速度；探测结论出来后自然切换）
    return (
      <div className="bg-background fixed inset-0 z-50 flex flex-col items-center justify-center gap-4">
        <div className="border-muted-foreground/25 border-t-foreground size-11 animate-spin rounded-full border-[3px]" />
        <div className="animate-pulse text-center">
          <p className="text-xl font-bold tracking-wide">TGYS TV</p>
          <p className="text-muted-foreground mt-1 text-xs">你的私人流媒体影院</p>
        </div>
      </div>
    )
  }

  if (gateMode === 'open' || isAuthenticated || visitorAccess) {
    return <>{children}</>
  }

  const handleMasterLogin = async () => {
    if (masterCaptchaRequired && captchaAnswer.code.length !== 4) {
      toast.error('请输入 4 位数字验证码')
      return
    }
    setIsLoading(true)
    await new Promise(resolve => setTimeout(resolve, 300))
    const success = await login(
      password,
      masterCaptchaRequired ? captchaAnswer : undefined,
    )
    if (success) {
      handleSuccess()
    } else {
      toast.error(gateMode === 'server' ? '站长密码不正确' : '验证失败')
      setIsLoading(false)
      refreshCaptcha()
    }
  }

  const handleAccountLogin = async () => {
    if (!username.trim() || !password) {
      toast.error('请输入用户名和密码')
      return
    }
    // 会员登录不设验证码（服务端从不校验会员验证码；关站时服务端直接拒绝会员登录）
    setIsLoading(true)
    const result = await loginWithAccount(username.trim(), password)
    if (result.ok) {
      handleSuccess()
    } else {
      toast.error(result.error ?? '登录失败')
      setIsLoading(false)
    }
  }

  const handleRegister = async () => {
    if (!username.trim() || !password) {
      toast.error('请输入用户名和密码')
      return
    }
    if (password !== confirmPassword) {
      toast.error('两次输入的密码不一致')
      return
    }
    if (registrationMode === 'invite' && !inviteCode.trim()) {
      toast.error('请输入邀请码')
      return
    }
    if (captchaAnswer.code.length !== 4) {
      toast.error('请输入 4 位数字验证码')
      return
    }
    setIsLoading(true)
    const result = await register(
      username.trim(),
      password,
      captchaAnswer,
      registrationMode === 'invite' ? inviteCode.trim() : undefined,
    )
    if (result.ok) {
      toast.success('注册成功')
      handleSuccess()
    } else {
      toast.error(result.error ?? '注册失败')
      setIsLoading(false)
      refreshCaptcha()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || isLoading) return
    if (formMode === 'account') void handleAccountLogin()
    else if (formMode === 'register') void handleRegister()
    else void handleMasterLogin()
  }

  const switchForm = (mode: FormMode) => {
    setFormMode(mode)
    setConfirmPassword('')
    refreshCaptcha()
  }

  // 访客模式下登录墙只有站长表单：没有账号登录、没有注册
  // （含关站维护页里点「管理员登录」展开表单的情形；此判定在渲染分支处现算，
  // 强制站长表单的 effect 统一放在上方 hooks 区，避免条件 return 之后再调 hooks）
  const adminOnlyWall = gateMode === 'server' && visitorMode

  const heading =
    gateMode === 'legacy'
      ? { title: '访问受限', desc: '当前站点通过密码保护，请输入访问密码以继续' }
      : FORM_HEADINGS[formMode]

  return (
    <>
      {/* 验证成功后渲染页面内容，clip-path 从按钮位置向外扩散 */}
      {isDismissing && (
        <div
          ref={revealRef}
          className="fixed inset-0 z-[10000]"
          style={{ clipPath: `circle(0% at ${revealOriginRef.current})` }}
        >
          {children}
        </div>
      )}

      {/* 守卫层 */}
      <div className="bg-background fixed inset-0 z-[9999] flex flex-col md:flex-row">
        {/* 左侧品牌区 — 移动端顶部横栏，桌面端左侧半屏 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, ease: easeOutQuad }}
          className="bg-muted/40 relative flex shrink-0 flex-col items-center justify-center overflow-hidden px-8 py-12 md:w-1/2 md:py-0"
        >
          {/* 装饰性模糊光晕 */}
          <div className="bg-primary/10 pointer-events-none absolute -top-20 -left-20 size-72 rounded-full blur-3xl" />
          <div className="bg-primary/5 pointer-events-none absolute -right-16 -bottom-16 size-56 rounded-full blur-3xl" />

          <div className="relative flex flex-col items-center gap-4">
            <motion.div
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.5, delay: 0.1, ease: easeOutQuad }}
              className="flex flex-col items-center gap-3"
            >
              <TgysLogo size={80} />
              <div className="text-xl font-bold tracking-widest">TGYS TV</div>
            </motion.div>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.25, ease: easeOutQuad }}
              className="text-muted-foreground max-w-xs text-center text-sm"
            >
              你的私人流媒体影院
            </motion.p>
          </div>
        </motion.div>

        {/* 右侧表单区 — 移动端占满剩余空间，桌面端右侧半屏 */}
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-12 md:px-16">
          <div className="w-full max-w-sm space-y-8">
            {gateMode === 'server' && siteClosed && !showClosedLogin ? (
              <motion.div
                initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.5, delay: 0.15, ease: easeOutQuad }}
                className="space-y-4"
              >
                <div className="bg-muted/70 ring-border/60 flex size-12 items-center justify-center rounded-xl ring-1">
                  <Wrench className="text-muted-foreground size-5" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold">站点维护中</h1>
                  <p className="text-muted-foreground mt-1.5 text-sm whitespace-pre-line">
                    {siteClosedMessage.trim() || '本站正在维护升级，暂时无法访问，请稍后再来。'}
                  </p>
                </div>
                {!detectCarBrowser() && (
                  <>
                    <Button
                      className="h-11 w-full rounded-full"
                      onClick={() => setShowClosedLogin(true)}
                    >
                      管理员登录
                    </Button>
                    <p className="text-muted-foreground text-center text-xs">
                      维护期间仅管理员可登录
                    </p>
                  </>
                )}
              </motion.div>
            ) : (
              <>
            {/* 信息区域 */}
            <motion.div
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.5, delay: 0.15, ease: easeOutQuad }}
              className="space-y-4"
            >
              <div className="bg-muted/70 ring-border/60 flex size-12 items-center justify-center rounded-xl ring-1">
                {formMode === 'register' ? (
                  <UserPlus className="text-muted-foreground size-5" />
                ) : formMode === 'master' ? (
                  <ShieldCheck className="text-muted-foreground size-5" />
                ) : (
                  <Lock className="text-muted-foreground size-5" />
                )}
              </div>
              <div>
                <h1 className="text-2xl font-semibold">{heading.title}</h1>
                <p className="text-muted-foreground mt-1.5 text-sm">{heading.desc}</p>
              </div>
            </motion.div>

            {/* 表单区域 */}
            <motion.div
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.5, delay: 0.25, ease: easeOutQuad }}
              className="space-y-4"
              onKeyDown={handleKeyDown}
            >
              {gateMode === 'legacy' || formMode === 'master' ? (
                <>
                  {masterCaptchaRequired && (
                    <CaptchaField key={captchaNonce} onChange={handleCaptchaChange} />
                  )}
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder="请输入访问密码"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="h-11 rounded-full"
                    />
                    <Button
                      ref={buttonRef}
                      size="icon-lg"
                      className="shrink-0 rounded-full"
                      onClick={() => void handleMasterLogin()}
                      disabled={isLoading}
                    >
                      {isLoading ? <Spinner size="sm" /> : <ArrowRight className="size-5" />}
                    </Button>
                  </div>
                  {gateMode === 'server' && !adminOnlyWall && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
                      onClick={() => switchForm('account')}
                    >
                      <ArrowLeft className="size-4" />
                      返回账号登录
                    </button>
                  )}
                  {adminOnlyWall && !siteClosed && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
                      onClick={() => setLoginWallRequested(false)}
                    >
                      <ArrowLeft className="size-4" />
                      返回浏览
                    </button>
                  )}
                </>
              ) : formMode === 'account' ? (
                <>
                  <Input
                    type="text"
                    placeholder="用户名"
                    autoComplete="username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="h-11 rounded-full"
                  />
                  <Input
                    type="password"
                    placeholder="密码"
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="h-11 rounded-full"
                  />
                  <Button
                    ref={buttonRef}
                    className="h-11 w-full rounded-full"
                    onClick={() => void handleAccountLogin()}
                    disabled={isLoading}
                  >
                    {isLoading ? <Spinner size="sm" /> : '登录'}
                  </Button>
                  <div className="text-muted-foreground flex items-center justify-between text-sm">
                    <button
                      type="button"
                      className="hover:text-foreground flex items-center gap-1"
                      onClick={() => switchForm('master')}
                    >
                      <ShieldCheck className="size-4" />
                      站长登录
                    </button>
                    {!siteClosed &&
                      (registrationWindow === 'before' ? (
                        <span className="flex items-center gap-1">
                          <CalendarClock className="size-4" />
                          注册将于 {formatRegistrationOpenLabel(registrationOpenAt)} 开放
                          {registrationCloseAt > 0 &&
                            `，${formatRegistrationOpenLabel(registrationCloseAt)} 截止`}
                        </span>
                      ) : registrationWindow === 'after' ? (
                        <span>注册开放时段已结束</span>
                      ) : registrationFull ? (
                        <span>注册名额已满</span>
                      ) : registrationOpen ? (
                        <button
                          type="button"
                          className="hover:text-foreground flex items-center gap-1"
                          onClick={() => switchForm('register')}
                        >
                          <User className="size-4" />
                          {registrationMode === 'invite' ? '邀请码注册' : '注册账号'}
                        </button>
                      ) : (
                        <span>注册已关闭</span>
                      ))}
                  </div>
                </>
              ) : (
                <>
                  <Input
                    type="text"
                    placeholder="用户名（3-24 位，文字/数字/下划线）"
                    autoComplete="username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="h-11 rounded-full"
                  />
                  <Input
                    type="password"
                    placeholder="密码（至少 6 位）"
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="h-11 rounded-full"
                  />
                  <Input
                    type="password"
                    placeholder="确认密码"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="h-11 rounded-full"
                  />
                  {registrationMode === 'invite' && (
                    <Input
                      type="text"
                      placeholder="邀请码（向管理员索取）"
                      autoComplete="off"
                      value={inviteCode}
                      onChange={e => setInviteCode(e.target.value)}
                      className="h-11 rounded-full"
                    />
                  )}
                  <CaptchaField key={captchaNonce} onChange={handleCaptchaChange} />
                  <Button
                    ref={buttonRef}
                    className="h-11 w-full rounded-full"
                    onClick={() => void handleRegister()}
                    disabled={isLoading}
                  >
                    {isLoading ? <Spinner size="sm" /> : '注册并登录'}
                  </Button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
                    onClick={() => switchForm('account')}
                  >
                    <ArrowLeft className="size-4" />
                    已有账号，去登录
                  </button>
                </>
              )}
            </motion.div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
