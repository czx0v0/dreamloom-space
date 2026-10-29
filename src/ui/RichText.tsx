/**
 * 正文渲染组件。
 *
 * 只接收 domain 层解析好的结构化片段，自身不做任何字符串处理，
 * 也永不使用 dangerouslySetInnerHTML —— 模型输出的一律当数据，不当 HTML。
 */

import { useMemo } from 'react'
import { segmentText, type MentionContext, type Segment } from '../domain/markup'
import type { CanonState } from '../domain/types'

export type MentionHandler = (
  kind: 'cast' | 'place',
  id: string,
  rect: { top: number; bottom: number; left: number; right: number },
) => void

/** 从 canon 里取出可点击的实体。软删与已合并的不参与。 */
export function mentionContextOf(canon: CanonState | null): MentionContext {
  if (!canon) return { cast: [], places: [] }
  return {
    cast: canon.cast
      .filter((c) => c.removedAt === null && c.supersededBy === null)
      .map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    places: canon.places
      .filter((p) => p.removedAt === null && p.supersededBy === null)
      .map((p) => ({ id: p.id, name: p.name })),
  }
}

function renderSegment(seg: Segment, key: number, onMention?: MentionHandler) {
  if (seg.kind === 'plain') {
    return seg.emph ? <strong key={key}>{seg.text}</strong> : <span key={key}>{seg.text}</span>
  }

  const label = seg.kind === 'cast' ? '人物' : '地点'
  const button = (
    <button
      key={key}
      type="button"
      className={seg.kind === 'cast' ? 'mention' : 'mention place'}
      title={`查看${label}：${seg.text}`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        onMention?.(seg.kind as 'cast' | 'place', seg.id as string, {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
        })
      }}
    >
      {seg.text}
    </button>
  )
  return seg.emph ? <strong key={key}>{button}</strong> : button
}

export function RichText({
  text,
  canon,
  onMention,
  className,
}: {
  text: string
  canon: CanonState | null
  onMention?: MentionHandler
  className?: string
}) {
  const ctx = useMemo(() => mentionContextOf(canon), [canon])
  const blocks = useMemo(() => segmentText(text, ctx), [text, ctx])

  return (
    <div className={className ? `rich ${className}` : 'rich'}>
      {blocks.map((block, i) => (
        <p key={i} className={block.dialog ? 'line dialog' : 'line'}>
          {block.segments.map((seg, j) => renderSegment(seg, j, onMention))}
        </p>
      ))}
    </div>
  )
}
