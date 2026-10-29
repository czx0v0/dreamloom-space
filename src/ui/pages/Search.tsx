/** 跨空间检索：人名、摘要、正文。结果按空间分组，点一下回到那个故事。 */

import { useState } from 'react'
import { toUserMessage } from '../../domain/errors'
import type { SpaceIndexEntry } from '../../domain/types'
import { navigate } from '../router'
import { useApp } from '../store'

interface Hit {
  spaceId: string
  spaceTitle: string
  kind: '人物' | '摘要' | '正文'
  sceneIndex: number | null
  text: string
}

const MAX_HITS = 80

export function Search() {
  const { repo } = useApp()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState('')
  const [error, setError] = useState('')

  const run = async () => {
    const needle = q.trim()
    if (!needle) return
    setBusy(true)
    setError('')
    try {
      const spaces: SpaceIndexEntry[] = await repo.listSpaces()
      const out: Hit[] = []
      for (const space of spaces) {
        const canon = await repo.loadCanon(space.id)
        for (const c of canon.cast) {
          if (c.removedAt !== null) continue
          if (c.name.includes(needle) || c.oneLine.includes(needle)) {
            out.push({
              spaceId: space.id,
              spaceTitle: space.title,
              kind: '人物',
              sceneIndex: null,
              text: `${c.name} · ${c.oneLine || '（没有一句话）'}`,
            })
          }
        }
        const scenes = await repo.listScenes(space.id)
        for (const scene of scenes) {
          if (out.length >= MAX_HITS) break
          if (scene.status === 'orphan') continue
          if (scene.summary?.includes(needle)) {
            out.push({
              spaceId: space.id,
              spaceTitle: space.title,
              kind: '摘要',
              sceneIndex: scene.index,
              text: scene.summary,
            })
            continue
          }
          // 正文按需读取：书架列表刻意不加载 text/ 行，检索是唯一需要全量读的入口
          const text = await repo.loadText(space.id, scene.id)
          const at = text.indexOf(needle)
          if (at >= 0) {
            const from = Math.max(0, at - 24)
            const snippet = text.slice(from, Math.min(text.length, at + needle.length + 36))
            out.push({
              spaceId: space.id,
              spaceTitle: space.title,
              kind: '正文',
              sceneIndex: scene.index,
              text: `${from > 0 ? '…' : ''}${snippet}${at + needle.length + 36 < text.length ? '…' : ''}`,
            })
          }
        }
        if (out.length >= MAX_HITS) break
      }
      setHits(out)
      setSearched(needle)
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const groups = new Map<string, Hit[]>()
  for (const hit of hits) {
    const bucket = groups.get(hit.spaceId)
    if (bucket) bucket.push(hit)
    else groups.set(hit.spaceId, [hit])
  }

  return (
    <div className="page narrow">
      <button className="link" onClick={() => navigate('')}>
        ← 书架
      </button>
      <h1>全库搜索</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="人名、地名、某句对白…"
          maxLength={40}
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={busy || !q.trim()}>
          {busy ? '搜索中…' : '搜索'}
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}

      {searched && !busy && (
        <p className="muted small">
          「{searched}」命中 {hits.length} 处{hits.length >= MAX_HITS ? '（只显示前 80 条）' : ''}
        </p>
      )}

      {[...groups.entries()].map(([spaceId, list]) => (
        <section key={spaceId} className="panel">
          <h3>{list[0].spaceTitle}</h3>
          <ul className="plain">
            {list.map((hit, i) => (
              <li key={`${hit.kind}-${hit.sceneIndex}-${i}`}>
                <button
                  className="link"
                  onClick={() => navigate(hit.sceneIndex === null ? `s/${spaceId}/codex/cast` : `s/${spaceId}/timeline`)}
                >
                  <span className="choice-tag">{hit.kind}</span>
                  {hit.sceneIndex === null ? '' : `第 ${hit.sceneIndex + 1} 幕 · `}
                  {hit.text}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {searched && !hits.length && !busy && <p className="muted">没有找到。换个更短的词试试。</p>}
    </div>
  )
}
