/**
 * 车机浏览器识别（供「车机自动免登录」使用）。
 *
 * 两条识别路径：
 * 1. 海外固件：UA 末尾带 `Tesla/<固件分支>` 标记（如 Tesla/feature-2022.20.9-31-abc），多年稳定。
 * 2. 国内固件（2026-10-25 用户实测样本）：UA 里**没有任何特斯拉标记**，只有一串通用
 *    Linux Chrome 签名——`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML,
 *    like Gecko) Chrome/148.0.0.0 Safari/537.36`。只能按这个签名放行；代价是桌面
 *    Linux 版 Chrome 的 UA 与它完全一致、也会被认成车机（免登录且无登录入口）。
 *    该功能是站长在后台自愿开启的便利开关，可随时关闭；且 UA 本就可伪造，这层识别
 *    只图方便、不是安全防线——设置/后台等接口仍由服务端会话校验把守。
 *
 * 老款 MCU1 的 QtCarBrowser 签名不同（(X11; Linux) 无 x86_64），仍不在识别范围，
 * 会退回正常登录页，不会把用户锁在外面。
 */
export const CAR_BROWSER_UA_MARKERS: readonly string[] = ['Tesla/']

/** 国内固件特斯拉车机的通用签名：X11 Linux x86_64 + Chrome，且不是安卓 */
function isGenericCarBrowserUA(userAgent: string): boolean {
  return (
    userAgent.includes('(X11; Linux x86_64)') &&
    /Chrome\/\d+/.test(userAgent) &&
    !userAgent.includes('Android')
  )
}

/** 纯函数：判断给定 UA 是否为车机浏览器 */
export function isCarBrowserUA(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return (
    CAR_BROWSER_UA_MARKERS.some(marker => userAgent.includes(marker)) ||
    isGenericCarBrowserUA(userAgent)
  )
}

/** 读取当前浏览器的 UA 并判断是否为车机 */
export function detectCarBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return isCarBrowserUA(navigator.userAgent)
}
