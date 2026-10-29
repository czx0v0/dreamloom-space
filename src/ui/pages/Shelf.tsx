/** 书架：全部空间、新建、导入存档。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseBundle } from '../../domain/archive'
import { DomainError, toUserMessage } from '../../domain/errors'
import type { SpaceIndexEntry } from '../../domain/types'
import { navigate } from '../router'
import { useApp } from '../store'

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function Shelf() {
  const { repo } = useApp()
  const [spaces, setSpaces] = useState<SpaceIndexEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setSpaces(await repo.listSpaces())
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
            <li key={s.id}>
              <button className="card" onClick={() => navigate(`s/${s.id}`)}>
                <span className="card-cover">{s.cover}</span>
                <span className="card-body">
                  <strong>{s.title}</strong>
                  <span className="muted small">
                    {s.genre} · {s.sceneCount} 幕 · {formatDate(s.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
