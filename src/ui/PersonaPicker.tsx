/**
 * 人物库选择器：卡片列表 + 详情 + 导入。
 *
 * 之前是挤在侧栏里的几行文字，点名字没反应、也没有地方看「这个人是谁」。
 * 导入一个角色等于把他整段设定搬进这个故事，应该先看得到再决定。
 */

import { useEffect, useState } from 'react'
import { toUserMessage } from '../domain/errors'
import type { Persona } from '../domain/types'
import { useApp } from './store'

interface Props {
  open: boolean
  /** 已在空间里的人物名，用来提示「同名会重复」 */
  existing?: string[]
  onImport: (personaId: string) => Promise<void> | void
  onClose: () => void
}

export function PersonaPicker({ open, existing = [], onImport, onClose }: Props) {
  const { repo } = useApp()
  const [list, setList] = useState<Persona[]>([])
  const [activeId, setActiveId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    void repo
      .listPersonas()
      .then(async (rows) => {
        // 列表只有摘要，详情要逐个取：数量不会多（原型是演员表，不是数据库）
        const full = await Promise.all(rows.map((r) => repo.loadPersona(r.id)))
        const valid = full.filter((p): p is Persona => Boolean(p))
        setList(valid)
        setActiveId((prev) => prev || valid[0]?.id || '')
      })
      .catch((e) => setError(toUserMessage(e)))
      .finally(() => setLoading(false))
  }, [open, repo])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const active = list.find((p) => p.id === activeId) ?? null
  const dup = active ? existing.includes(active.name) : false

  const submit = async () => {
    if (!active) return
    setBusy(true)
    try {
      await onImport(active.id)
      onClose()
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal persona-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="从人物库导入"
      >
        <header className="modal-head">
          <h2>从人物库导入</h2>
          <button className="modal-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {error && <div className="notice error">{error}</div>}

        {loading ? (
          <p className="muted small">读取中…</p>
        ) : list.length === 0 ? (
          <div className="modal-empty">
            <p>人物库还是空的。</p>
            <p className="muted small">
              可以去<a href="#/library">人物库</a>新建一个，或在别的空间里把角色「另存为原型」。
            </p>
          </div>
        ) : (
          <div className="persona-modal-body">
            <ul className="persona-cards">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    className={p.id === activeId ? 'persona-card active' : 'persona-card'}
                    onClick={() => setActiveId(p.id)}
                  >
                    <span className="persona-avatar" aria-hidden>
                      {p.name.slice(0, 1) || '？'}
                    </span>
                    <span className="persona-card-text">
                      <strong>{p.name}</strong>
                      <span className="muted small">{p.oneLine || '（还没写一句话身份）'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="persona-detail">
              {active ? (
                <>
                  <h3 className="persona-detail-name">{active.name}</h3>
                  <p className="muted small">{active.oneLine || '（还没写一句话身份）'}</p>

                  <dl className="kv">
                    {active.voice && (
                      <>
                        <dt>说话风格</dt>
                        <dd>{active.voice}</dd>
                      </>
                    )}
                    {(active.personality ?? []).length > 0 && (
                      <>
                        <dt>性格</dt>
                        <dd className="chips">
                          {(active.personality ?? []).map((t) => (
                            <span key={t} className="chip">
                              {t}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    {(active.abilities ?? []).length > 0 && (
                      <>
                        <dt>会什么</dt>
                        <dd className="chips">
                          {(active.abilities ?? []).map((t) => (
                            <span key={t} className="chip">
                              {t}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    {active.appearance && (
                      <>
                        <dt>外形</dt>
                        <dd>{active.appearance}</dd>
                      </>
                    )}
                    {active.backstory && (
                      <>
                        <dt>来历</dt>
                        <dd>{active.backstory}</dd>
                      </>
                    )}
                  </dl>

                  {(active.secrets ?? []).length > 0 && (
                    <p className="muted small">
                      带有 {active.secrets?.length} 条秘密，导入后会成为「还没揭开的」。
                    </p>
                  )}
                  {dup && (
                    <div className="notice warn">
                      这个故事里已经有一个叫「{active.name}」的人了。再导入会出现两个同名角色。
                    </div>
                  )}

                  <div className="modal-actions">
                    <button className="btn primary" onClick={() => void submit()} disabled={busy}>
                      {busy ? '导入中…' : `导入「${active.name}」`}
                    </button>
                    <button className="btn ghost" onClick={onClose} disabled={busy}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted small">左边选一个角色。</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
