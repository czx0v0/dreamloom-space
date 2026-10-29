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

const FORMATS: Array<{ key: ExportFormat; label: string; hint: string }> = [
  { key: 'story', label: '故事正文', hint: '按幕排列的纯正文，不含未揭示的秘密' },
  { key: 'outline', label: '大纲', hint: '每幕一句话 + 伏笔开收计数' },
  { key: 'codex', label: '创作档案', hint: '世界 / 人物（含故事线）/ 地点 / 关系 / 事实 / 伏笔' },
  { key: 'full', label: '整合稿', hint: '档案 + 大纲 + 正文，一份文档' },
]

export function Export({ spaceId }: { spaceId: string }) {
  const { repo } = useApp()
  const [ds, setDs] = useState<ExportDataSet | null>(null)
  const [format, setFormat] = useState<ExportFormat>('story')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const data = await repo.exportDataSet(spaceId)
        if (alive) setDs(data)
      } catch (e) {
        if (alive) setError(toUserMessage(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [repo, spaceId])

  // 唯一的渲染点：预览与下载共用这一个结果
  const content = useMemo(() => (ds ? buildExport(ds, format) : ''), [ds, format])
  const fileName = useMemo(
    () => (ds ? exportFileName(ds.space.title, format) : ''),
    [ds, format],
  )

  const download = () => {
    if (!content) return
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
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
          <button className="btn ghost" onClick={() => void copy()} disabled={!content}>
            {copied ? '已复制' : '复制全文'}
          </button>
          <button className="btn primary" onClick={download} disabled={!content}>
            下载 .md
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
