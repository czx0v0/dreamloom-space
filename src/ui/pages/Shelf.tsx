/** 书架：全部空间、新建、导入存档。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseBundle } from '../../domain/archive'
import { DomainError, toUserMessage } from '../../domain/errors'
import type { SpaceIndexEntry } from '../../domain/types'
import { FLAGS } from '../../app/flags'
import { navigate } from '../router'
import { useApp } from '../store'

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function Shelf() {
  const { repo, config } = useApp()
  const [spaces, setSpaces] = useState<SpaceIndexEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  /** 封面图：只有生成过的空间才有，没有就退回原来的表情图标 */
  const [covers, setCovers] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const list = await repo.listSpaces()
      setSpaces(list)
      const found = await Promise.all(
        list.map(async (sp) => [sp.id, (await repo.loadArt(sp.id, 'cover', sp.id))?.dataUrl] as const),
      )
      setCovers(Object.fromEntries(found.filter(([, url]) => Boolean(url)) as Array<[string, string]>))
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setLoading(false)
    }
  }, [repo])

  useEffect(() => {
    void load()
  }, [load])

  const onImport = async (file: File) => {
    try {
      const text = await file.text()
      const meta = await repo.importBundle(parseBundle(text))
      await load()
      navigate(`s/${meta.id}`)
    } catch (e) {
      setError(e instanceof DomainError ? e.message : '导入失败，文件可能不是筑梦之境存档')
    }
  }

  const remove = async (id: string, title: string) => {
    const ok = window.confirm(
      `删除《${title}》？\n\n全部幕、档案与补丁都会被删掉，不能撤销。想留底稿先导出存档。`,
    )
    if (!ok) return
    try {
      await repo.deleteSpace(id)
      await load()
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const totalScenes = spaces.reduce((n, s) => n + s.sceneCount, 0)

  return (
    <div className="page shelf">
      <header className="shelf-head">
        <div>
          <h1>筑梦之境</h1>
          <p className="muted">
            {spaces.length} 个空间 · {totalScenes} 幕
          </p>
        </div>
        <div className="row">
          {FLAGS.personaCrossSpace && (
            <button className="btn ghost" onClick={() => navigate('library')}>
              人物库
            </button>
          )}
          <button className="btn ghost" onClick={() => navigate('search')}>
            搜索
          </button>
          <button className="btn ghost" onClick={() => navigate('settings')}>
            设置
          </button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>
            导入存档
          </button>
          <button className="btn primary" onClick={() => navigate('new')}>
            新建空间
          </button>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onImport(file)
          e.target.value = ''
        }}
      />

      {error && <div className="notice error">{error}</div>}

      {loading ? (
        <div className="muted">正在打开…</div>
      ) : spaces.length === 0 ? (
        <div className="empty">
          <p className="empty-title">先造一个世界</p>
          <p className="muted">给一个起点，它一段一段往下写；写的同时有人在旁边记笔记。</p>
          <button className="btn primary" onClick={() => navigate('new')}>
            开始
          </button>
        </div>
      ) : (
        <ul className="cards">
          {spaces.map((s) => (
            <li key={s.id} className="card-wrap">
              <button className="card" onClick={() => navigate(`s/${s.id}`)}>
                {covers[s.id] ? (
                  <img className="card-cover-img" src={covers[s.id]} alt="" loading="lazy" />
                ) : (
                  <span className="card-cover">{s.cover}</span>
                )}
                <span className="card-body">
                  <strong>{s.title}</strong>
                  <span className="muted small">
                    {s.genre} · {s.sceneCount} 幕 · {formatDate(s.updatedAt)}
                  </span>
                </span>
              </button>
              {/* 书架是根目录：继续 / 入梦 / 删除都该在这里，不必先进去再找 */}
              <div className="card-actions">
                <button className="link" onClick={() => navigate(`s/${s.id}`)}>
                  继续
                </button>
                {config.features.dream && (
                  <button className="link" onClick={() => navigate(`s/${s.id}/dream`)}>
                    入梦
                  </button>
                )}
                <button className="link danger-text" onClick={() => void remove(s.id, s.title)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small shelf-privacy">
        所有内容只存在这台浏览器里：不上传、不云同步、没有账号。
        换设备请在空间里「导出 → 存档 JSON」，再到新设备「导入存档」。
      </p>
    </div>
  )
}
