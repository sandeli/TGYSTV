import { describe, expect, it } from 'vitest'
import { isCarBrowserUA } from './carBrowser'

describe('isCarBrowserUA 车机浏览器识别', () => {
  it('识别特斯拉现代车机（各固件分支/版本都命中 Tesla/ 标记）', () => {
    // 真实样本：Model 3/Y 时代固件
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36 Tesla/feature-2022.20.9-31-abc',
      ),
    ).toBe(true)
    // 开发分支固件
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36 Tesla/develop-2024.44-12345',
      ),
    ).toBe(true)
    // FSD 测试版固件
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.0 Safari/537.36 Tesla/fsd-beta-12.5-xyz',
      ),
    ).toBe(true)
  })

  it('识别国内固件特斯拉车机（UA 无 Tesla 标记，只有通用 Linux Chrome 签名）', () => {
    // 2026-10-25 用户在车机上打开 httpbin.org/user-agent 的实测样本，一字不差
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      ),
    ).toBe(true)
  })

  it('普通浏览器不误判', () => {
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe(false)
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false)
    // 仅出现 Tesla 字样（如新闻页标题拼凑的 UA）没有斜杠标记不算
    expect(isCarBrowserUA('Mozilla/5.0 TeslaBrowser/1.0')).toBe(false)
  })

  it('老款 MCU1 的 QtCarBrowser 不在识别范围（已知边界，退回普通登录页）', () => {
    expect(
      isCarBrowserUA(
        'Mozilla/5.0 (X11; Linux) AppleWebKit/534.34 (KHTML, like Gecko) QtCarBrowser Safari/534.34',
      ),
    ).toBe(false)
  })

  it('空 UA 安全返回 false', () => {
    expect(isCarBrowserUA('')).toBe(false)
    expect(isCarBrowserUA(null)).toBe(false)
    expect(isCarBrowserUA(undefined)).toBe(false)
  })
})
