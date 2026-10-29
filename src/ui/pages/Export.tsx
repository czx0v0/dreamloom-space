/**
 * 导出页。
 *
 * 关键约束：**预览与下载必须调用同一个 `buildExport`**。
 * 「预览看着对、导出的不对」这类 bug 的唯一来源，就是渲染逻辑写了两遍。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  buildExport,
  exportFileName,
  type ExportDataSet,
  type ExportFormat,
} from '../../domain/export'
import { toUserMessage } from '../../domain/errors'
import { navigate } from '../router'
import { useApp } from '../store'

type ExportKind = ExportFormat | 'archive'

const FORMATS: Array<{ key: ExportKind; label: string; hint: string }> = [
  { key: 'story', label: '故事正文', hint: '按幕排列的纯正文，不含未揭示的秘密' },
  { key: 'outline', label: '大纲', hint: '每幕一句话 + 伏笔开收计数' },
  { key: 'codex', label: '创作档案', hint: '世界 / 人物（含故事线）/ 地点 / 关系 / 事实 / 伏笔' },
  { key: 'full', label: '整合稿', hint: '档案 + 大纲 + 正文，一份文档' },
  {
    key: 'archive',
    label: '存档 JSON',
    hint: '可被「导入存档」重新读进来的完整数据：档案、全部幕、补丁。换设备或备份用这份',
  },
]

export function Export({ spaceId }: { spaceId: string }) {
  const { repo } = useApp()
  const [ds, setDs] = useState<ExportDataSet | null>(null)
  const [format, setFormat] = useState<ExportKind>('story')
  /** 存档 JSON 与 md 的产物来源不同：前者是 bundle，后者是渲染文本 */
  const [bundleJson, setBundleJson] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  /** 下载/保存的回执：浏览器拦截下载时，这是唯一能看到的信号 */
  const [saved, setSaved] = useState('')
  /** 打包中：带图存档可能几十 MB，stringify 是同步的，不给提示就像卡死 */
  const [packing, setPacking] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const data = await repo.exportDataSet(spaceId)
        if (alive) setDs(data)
      } catch (e) {
        if (alive) setError(toUserMessage(e))
      } finally {
        if (alive) setPacking(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [repo, spaceId])

  useEffect(() => {
    if (format !== 'archive') return
    let alive = true
    setPacking(true)
    void (async () => {
      try {
        const bundle = await repo.exportBundle(spaceId)
        // 不缩进：带图的存档缩进后能大出 15%，而这是给机器读的文件
        if (alive) setBundleJson(JSON.stringify(bundle))
      } catch (e) {
        if (alive) setError(toUserMessage(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [format, repo, spaceId])

  // 唯一的渲染点：预览与下载共用这一个结果
  const content = useMemo(
    () => (format === 'archive' ? bundleJson : ds ? buildExport(ds, format as ExportFormat) : ''),
    [ds, format, bundleJson],
  )
  const fileName = useMemo(
    () =>
      format === 'archive'
        ? `${(ds?.space.title ?? '存档').replace(/[/\\:*?"<>|]/g, '_')}-存档.json`
        : ds
          ? exportFileName(ds.space.title, format as ExportFormat)
          : '',
    [ds, format],
  )

  /**
   * 保存文件。
   *
   * 之前"点了没反应"的三个原因，逐个堵掉：
   *  1. `a` 没插进文档就 click()——Firefox/Safari 会直接忽略；
   *  2. click() 之后立刻 revokeObjectURL——浏览器还没读完 blob，链接就失效了；
   *  3. 预览面板常跑在 iframe 里，`a[download]` 可能被 sandbox 拦掉，且**没有任何提示**。
   *
   * 所以：优先用文件选择器（能写盘、能拿到真实失败原因），否则退到锚点下载（延迟回收），
   * 最后无论走哪条路都给一句回执——"没反应"至少能变成"被拦了"。
   */
  const download = async () => {
    if (!content) return
    const type = format === 'archive' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
    const blob = new Blob([content], { type })
    setSaved('')

    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [
            {
              description: format === 'archive' ? '存档 JSON' : 'Markdown',
              accept: { [format === 'archive' ? 'application/json' : 'text/markdown']: [format === 'archive' ? '.json' : '.md'] },
            },
          ],
        })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        setSaved(`已保存：${fileName}`)
        return
      } catch (e) {
        // 用户主动取消就安静退出；其它错误（多见于 iframe 里没有权限）继续走锚点
        if ((e as { name?: string })?.name === 'AbortError') return
      }
    }

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // 立刻 revoke 会让下载中途断掉，这是"点了没反应"最常见的元凶
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setSaved(`已发起下载：${fileName}。若没有文件出现，说明浏览器拦了下载（地址栏右侧的图标），或者这里是不允许下载的内嵌框架——可以改用「复制全文」。`)
  }

  const copy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('这个浏览器不允许写入剪贴板，请用下载')
    }
  }

  const stats = ds
    ? {
        scenes: ds.scenes.filter((s) => s.scene.status === 'committed').length,
        chars: ds.scenes.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0),
        cast: ds.cast.filter((c) => c.removedAt === null).length,
        openClues: ds.scenes.flatMap((s) => s.scene.clues).filter((c) => c.status === 'open').length,
      }
    : null

  return (
    <div className="page export">
      <header className="shelf-head">
        <div>
          <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
            ← 回到故事
          </button>
          <h1>导出</h1>
          <p className="muted">
            {stats
              ? `${stats.scenes} 幕 · ${stats.chars} 字 · ${stats.cast} 人 · ${stats.openClues} 条未收线索`
              : '正在汇总…'}
          </p>
        </div>
        <div className="row">
          <button
            className="btn ghost"
            onClick={() => void copy()}
            disabled={!content}
          >
            {copied ? '已复制' : '复制全文'}
          </button>
          <button className="btn primary" onClick={() => void download()} disabled={!content || packing}>
            {packing ? '打包中…' : format === 'archive' ? '下载 .json' : '下载 .md'}
          </button>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}

      <div className="seg block">
        {FORMATS.map((f) => (
          <button
            key={f.key}
            className={format === f.key ? 'seg-item active' : 'seg-item'}
            onClick={() => setFormat(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="muted small">{FORMATS.find((f) => f.key === format)?.hint}</p>
      {packing && (
        <div className="notice info">
          正在打包存档…带图的存档可能几十 MB，打包时页面会短暂无响应；打包完成会自动开始下载。
        </div>
      )}
      {saved && <div className="notice info">{saved}</div>}
      {format === 'archive' && (
        <div className="notice warn">
          存档里有未揭开的秘密与隐藏设定，**不要当公开文件分享**；要给别人看故事，用「故事正文」。
        </div>
      )}

      <section className="panel doc-preview">
        {content ? (
          <pre>{content}</pre>
        ) : (
          <p className="muted">{ds ? '这个格式没有内容。' : '正在读取存档…'}</p>
        )}
      </section>

      <p className="muted small">
        导出是只读操作：不改存档、不触发抽取、不消耗额度。文件名{' '}
        <code>{fileName || '—'}</code>
      </p>
    </div>
  )
}
