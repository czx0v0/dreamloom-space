/**
 * 实体浮窗：点正文里的人名/地名，就地出卡片。
 *
 * 为什么不是直接跳档案页：阅读被打断的代价远高于"少看两个字段"。
 * 想知道更多时卡片里有「看完整档案」，那时才值得跳页。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { CanonState } from '../domain/types'

export interface MentionTarget {
  kind: 'cast' | 'place'
  id: string
  /** 触发元素的屏幕位置，用于把卡片摆在它下面 */
  rect: { top: number; bottom: number; left: number; right: number }
}

const CARD_WIDTH = 260
const GAP = 8

function positionFor(rect: MentionTarget['rect']) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 水平：优先左对齐触发元素，靠近右边时改为右对齐
  const left = Math.min(Math.max(GAP, rect.left), vw - CARD_WIDTH - GAP)
  // 垂直：优先放在下方，空间不够则翻到上方
  const below = rect.bottom + GAP
  const above = rect.top - GAP
  const flip = below > vh - 220 && above > 220
  return { left, top: flip ? undefined : below, bottom: flip ? vh - above : undefined } as const
}

export function MentionPopover({
  target,
  canon,
  onClose,
  onOpenCodex,
}: {
  target: MentionTarget
  canon: CanonState | null
  onClose: () => void
  onOpenCodex: (kind: 'cast' | 'place', id: string) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // 滚动时卡片会和文字错位，直接关掉比跟着跑更省事
    const onScroll = () => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const pos = positionFor(target.rect)

  const body = (() => {
    if (!canon) return null
    if (target.kind === 'cast') {
      const c = canon.cast.find((x) => x.id === target.id)
      if (!c) return null
      const recent = c.arc[c.arc.length - 1]
      const relations = canon.relations
        .filter((r) => r.aId === c.id || r.bId === c.id)
        .slice(0, 3)
        .map((r) => {
          const other = canon.cast.find((x) => x.id === (r.aId === c.id ? r.bId : r.aId))?.name
          return other ? `${other}（${r.kind}）` : null
        })
        .filter(Boolean)
      return (
        <>
          <div className="pop-head">
            <strong>{c.name}</strong>
            {c.status === 'dead' && <span className="tag dead">已死亡</span>}
            {c.role === 'protagonist' && <span className="tag main">主角</span>}
          </div>
          {c.oneLine && <p className="pop-line">{c.oneLine}</p>}
          {c.voice && <p className="pop-meta">语气：{c.voice}</p>}
          {c.goal && <p className="pop-meta">想要：{c.goal}</p>}
          {recent && (
            <p className="pop-meta">
              近况：{recent.text}
            </p>
          )}
          {relations.length > 0 && <p className="pop-meta">关系：{relations.join('、')}</p>}
        </>
      )
    }

    const p = canon.places.find((x) => x.id === target.id)
    if (!p) return null
    return (
      <>
        <div className="pop-head">
          <strong>{p.name}</strong>
          <span className="muted small">{p.kind}</span>
        </div>
        {p.oneLine && <p className="pop-line">{p.oneLine}</p>}
        {p.features.length > 0 && <p className="pop-meta">特征：{p.features.slice(0, 4).join('、')}</p>}
        {p.events.length > 0 && (
          <p className="pop-meta">这里发生过：{p.events.slice(-2).map((e) => e.text).join('；')}</p>
        )}
      </>
    )
  })()

  if (!body) return null

  return createPortal(
    <>
      <div className="pop-backdrop" onClick={onClose} />
      <div className="popover" style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}>
        {body}
        <button className="link pop-more" onClick={() => onOpenCodex(target.kind, target.id)}>
          看完整档案 →
        </button>
      </div>
    </>,
    document.body,
  )
}
