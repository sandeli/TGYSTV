import { beforeEach, describe, expect, it } from 'vitest'
import { useApiStore } from './apiStore'
import { useAuthStore } from './authStore'

const SRC_A = '[{"id":"a","name":"源A","url":"https://a.example/api.php/provide/vod"}]'
const SRC_AB =
  '[{"id":"a","name":"源A","url":"https://a.example/api.php/provide/vod"},' +
  '{"id":"b","name":"源B","url":"https://b.example/api.php/provide/vod"}]'

function setAdminSources(value: string, managedSourceEnabled: Record<string, boolean> = {}) {
  useAuthStore.setState({
    authConfig: { initialVideoSources: value, managedSourceEnabled } as never,
  })
}

describe('apiStore 管理员托管源标记', () => {
  beforeEach(() => {
    useApiStore.setState({
      videoAPIs: [],
      managedSourceIds: [],
      managedTrackingVersion: 1,
      adFilteringEnabled: true,
    })
    setAdminSources('')
  })

  it('初始化后记录托管源 id', async () => {
    setAdminSources(SRC_AB)
    await useApiStore.getState().initializeEnvSources()
    const state = useApiStore.getState()
    expect(state.videoAPIs.map(s => s.id).sort()).toEqual(['a', 'b'])
    expect([...state.managedSourceIds].sort()).toEqual(['a', 'b'])
  })

  it('替换源文件后，同 id 的源按新文件内容更新', async () => {
    setAdminSources(SRC_AB)
    await useApiStore.getState().initializeEnvSources()
    const updated =
      '[{"id":"a","name":"源A改","url":"https://a2.example/api.php/provide/vod"}]'
    setAdminSources(updated)
    await useApiStore.getState().initializeEnvSources()
    const state = useApiStore.getState()
    expect(state.videoAPIs).toHaveLength(1)
    expect(state.videoAPIs[0].name).toBe('源A改')
    expect(state.videoAPIs[0].url).toBe('https://a2.example/api.php/provide/vod')
  })

  it('存量补标记：旧版本导入的残留源被清掉，手动添加的 uuid 源保留', async () => {
    // 模拟托管标记功能上线前就已存在的本地数据（无任何标记记录）
    useApiStore.setState({
      videoAPIs: [
        {
          id: 'stale1',
          name: '残留源',
          url: 'https://stale.example/api.php/provide/vod',
          detailUrl: 'https://stale.example/api.php/provide/vod',
          isEnabled: true,
          updatedAt: new Date(),
          timeout: 3000,
          retry: 3,
        } as never,
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          name: '手动源',
          url: 'https://manual.example/api.php/provide/vod',
          detailUrl: 'https://manual.example/api.php/provide/vod',
          isEnabled: true,
          updatedAt: new Date(),
          timeout: 3000,
          retry: 3,
        } as never,
      ],
      managedSourceIds: [],
      managedTrackingVersion: 0,
    })
    setAdminSources(SRC_A)
    await useApiStore.getState().initializeEnvSources()
    const ids = useApiStore.getState().videoAPIs.map(s => s.id)
    expect(ids).not.toContain('stale1')
    expect(ids).toContain('123e4567-e89b-42d3-a456-426614174000')
    expect(ids).toContain('a')
    expect(useApiStore.getState().managedSourceIds).toEqual(['a'])
  })

  it('管理员换源后，旧托管源被移除，用户自加源保留', async () => {
    setAdminSources(SRC_AB)
    await useApiStore.getState().initializeEnvSources()
    useApiStore.getState().importVideoAPIs([
      {
        id: 'mine',
        name: '我的源',
        url: 'https://mine.example/api.php/provide/vod',
        detailUrl: 'https://mine.example/api.php/provide/vod',
        isEnabled: true,
        updatedAt: new Date(),
        timeout: 3000,
        retry: 3,
      } as never,
    ])
    setAdminSources(SRC_A)
    await useApiStore.getState().initializeEnvSources()
    const state = useApiStore.getState()
    expect(state.videoAPIs.map(s => s.id).sort()).toEqual(['a', 'mine'])
    expect(state.managedSourceIds).toEqual(['a'])
  })

  it('管理员全站关掉的托管源对任何用户都不可用（本地开着也剔除）', async () => {
    setAdminSources(SRC_AB, { b: false })
    await useApiStore.getState().initializeEnvSources()
    // b 在源文件里默认开启、本地也是开启，但全站开关表关了它
    expect(useApiStore.getState().videoAPIs.find(s => s.id === 'b')?.isEnabled).toBe(true)
    expect(useApiStore.getState().getSelectedAPIs().map(s => s.id)).toEqual(['a'])
  })

  it('管理员全站打开文件里默认关闭的托管源后可用', async () => {
    const mixed =
      '[{"id":"a","name":"源A","url":"https://a.example/api.php/provide/vod"},' +
      '{"id":"b","name":"源B","url":"https://b.example/api.php/provide/vod","enabled":false}]'
    setAdminSources(mixed, { b: true })
    await useApiStore.getState().initializeEnvSources()
    expect(useApiStore.getState().getSelectedAPIs().map(s => s.id).sort()).toEqual(['a', 'b'])
  })

  it('批量启停只作用于指定 id', async () => {
    setAdminSources(SRC_AB)
    await useApiStore.getState().initializeEnvSources()
    useApiStore.getState().setVideoSourcesEnabled(['a'], false)
    const state = useApiStore.getState()
    expect(state.videoAPIs.find(s => s.id === 'a')?.isEnabled).toBe(false)
    expect(state.videoAPIs.find(s => s.id === 'b')?.isEnabled).toBe(true)
  })
})

describe('apiStore 手动添加与已有源同名同址', () => {
  beforeEach(() => {
    useApiStore.setState({
      videoAPIs: [],
      managedSourceIds: [],
      managedTrackingVersion: 1,
      adFilteringEnabled: true,
    })
    setAdminSources('')
  })

  const manual = (id: string, name: string, url: string, isEnabled = true) =>
    ({
      id,
      name,
      url,
      detailUrl: url,
      timeout: 3000,
      retry: 3,
      isEnabled,
      updatedAt: new Date(),
    }) as never

  it('撞托管源：建一份用户自己的副本，托管源不动，副本参与搜索选择', async () => {
    setAdminSources(SRC_A)
    await useApiStore.getState().initializeEnvSources()
    useApiStore
      .getState()
      .addAndUpdateVideoAPI(manual('user-uuid-1', '源A', 'https://a.example/api.php/provide/vod'))
    const state = useApiStore.getState()
    expect(state.videoAPIs).toHaveLength(2)
    const copy = state.videoAPIs.find(s => s.id === 'user-uuid-1')
    expect(copy?.isEnabled).toBe(true)
    expect(state.videoAPIs.find(s => s.id === 'a')?.name).toBe('源A')
    expect(state.getSelectedAPIs().map(s => s.id)).toContain('user-uuid-1')
  })

  it('撞本地源：原地更新那一份，不新增重复条目', () => {
    useApiStore.setState({
      videoAPIs: [manual('local-1', '我的源', 'https://x.example/api.php/provide/vod', false)],
    })
    useApiStore
      .getState()
      .addAndUpdateVideoAPI(manual('another-uuid', '我的源', 'https://x.example/api.php/provide/vod'))
    const state = useApiStore.getState()
    expect(state.videoAPIs).toHaveLength(1)
    expect(state.videoAPIs[0].id).toBe('local-1')
    expect(state.videoAPIs[0].isEnabled).toBe(true)
  })

  it('全新源：照常添加并置顶', () => {
    useApiStore.setState({
      videoAPIs: [manual('local-1', '旧源', 'https://old.example/api.php/provide/vod')],
    })
    useApiStore
      .getState()
      .addAndUpdateVideoAPI(manual('new-1', '新源', 'https://new.example/api.php/provide/vod'))
    const state = useApiStore.getState()
    expect(state.videoAPIs.map(s => s.id)).toEqual(['new-1', 'local-1'])
  })
})

describe('apiStore 用户导入视频源', () => {
  beforeEach(() => {
    useApiStore.setState({
      videoAPIs: [],
      managedSourceIds: [],
      managedTrackingVersion: 1,
      adFilteringEnabled: true,
    })
    setAdminSources('')
  })

  it('兼容 KVideo 格式：baseUrl 映射为 url，enabled 映射为开关', () => {
    const result = useApiStore.getState().importVideoAPIs([
      {
        name: 'KVideo源',
        baseUrl: 'https://k.example/api.php/provide/vod',
        enabled: false,
      } as never,
    ])
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    const state = useApiStore.getState()
    expect(state.videoAPIs).toHaveLength(1)
    expect(state.videoAPIs[0].url).toBe('https://k.example/api.php/provide/vod')
    expect(state.videoAPIs[0].isEnabled).toBe(false)
    // 禁用的源不参与搜索选择
    expect(state.getSelectedAPIs()).toHaveLength(0)
  })

  it('兼容 MoonTV 格式：api_site 字典展开导入，缺 api 的条目跳过', () => {
    const result = useApiStore.getState().importVideoAPIs({
      api_site: {
        'iqiyizyapi.com': { name: '🎬-爱奇艺-', api: 'https://iqiyizyapi.com/api.php/provide/vod' },
        'dbzy.tv': { name: '🎬豆瓣资源', api: 'https://caiji.dbzy5.com/api.php/provide/vod' },
        broken: { name: '坏条目' },
      },
    } as never)
    expect(result.imported).toBe(2)
    const state = useApiStore.getState()
    expect(state.videoAPIs).toHaveLength(2)
    expect(state.videoAPIs.map(s => s.name)).toEqual(['🎬-爱奇艺-', '🎬豆瓣资源'])
    expect(state.videoAPIs[0].url).toBe('https://iqiyizyapi.com/api.php/provide/vod')
    expect(state.videoAPIs[0].isEnabled).toBe(true)
    // 展开后可正常参与搜索选择
    expect(state.getSelectedAPIs()).toHaveLength(2)
  })

  it('兼容 TVBox 配置：只提取 type=1 的 CMS 源，爬虫/XML 站点计入跳过并说明', () => {
    const result = useApiStore.getState().importVideoAPIs({
      spider: 'https://example.com/spider.jar',
      sites: [
        { key: 'csp_LiteApple', name: '小苹果', type: 3, api: 'csp_LiteApple' },
        {
          key: 'liangzi',
          name: '量子',
          type: 1,
          api: 'https://lzizy.com/api.php/provide/vod',
        },
        { key: 'xmlone', name: 'XML源', type: 0, api: 'https://xml.example/api.php/provide/vod' },
        {
          key: 'ffzy',
          name: '非凡',
          type: 1,
          api: 'https://ffzy.tv/api.php/provide/vod',
        },
      ],
    } as never)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(2)
    expect(result.errors.some(e => e.includes('TVBox'))).toBe(true)
    const state = useApiStore.getState()
    expect(state.videoAPIs.map(s => s.name)).toEqual(['量子', '非凡'])
    expect(state.getSelectedAPIs()).toHaveLength(2)
  })

  it('无效条目被跳过并如实上报数量', () => {
    const result = useApiStore.getState().importVideoAPIs([
      { name: '好源', url: 'https://ok.example/api.php/provide/vod' },
      { name: '缺地址的源' },
      { url: 'https://noname.example/api.php/provide/vod' },
    ] as never)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(useApiStore.getState().videoAPIs).toHaveLength(1)
    expect(useApiStore.getState().videoAPIs[0].name).toBe('好源')
  })

  it('重复条目计入跳过，不产生重复', () => {
    const entry = { name: '源', url: 'https://dup.example/api.php/provide/vod' } as never
    const first = useApiStore.getState().importVideoAPIs([entry])
    const second = useApiStore.getState().importVideoAPIs([entry])
    expect(first.imported).toBe(1)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(1)
    expect(useApiStore.getState().videoAPIs).toHaveLength(1)
  })
})

describe('apiStore removeSourcesByIds 按 id 摘除', () => {
  it('摘除指定 id 的源，其余保留；空名单不动', () => {
    const mk = (id: string) => ({
      id,
      name: id,
      url: `https://${id}.example/api`,
      detailUrl: `https://${id}.example/api`,
      isEnabled: true,
      updatedAt: new Date(),
    })
    useApiStore.setState({ videoAPIs: [mk('a'), mk('b'), mk('c')] })
    useApiStore.getState().removeSourcesByIds(['b'])
    expect(useApiStore.getState().videoAPIs.map(s => s.id)).toEqual(['a', 'c'])
    useApiStore.getState().removeSourcesByIds([])
    expect(useApiStore.getState().videoAPIs).toHaveLength(2)
  })
})
