/**
 * 人物库：跨空间的原型。
 *
 * 心智模型只有一句：这里是"演员表"，每个空间是"一部戏"。
 * 同一原型在不同空间里各演各的，一个死了另一个还活着——导入是深拷贝，不是引用。
 */

import { useCallback, useEffect, useState } from 'react'
import { importPersonaIntoSpace, saveCastAsPersona } from '../../app/persona'
import { toUserMessage } from '../../domain/errors'
import { makeId } from '../../domain/ids'
import type { CastMember, Persona, SpaceIndexEntry } from '../../domain/types'
import { FLAGS } from '../../app/flags'
import { navigate } from '../router'
import { useApp } from '../store'

function blankPersona(now: number): Persona {
  return {
    id: makeId('pe', now),
    v: 1,
    name: '新角色',
    aliases: [],
    appearance: '',
    oneLine: '',
    personality: [],
    abilities: [],
    voice: '',
    backstory: '',
    secrets: [],
    tags: [],
    origin: 'user',
    rev: 1,
    createdAt: now,
    updatedAt: now,
  }
}

const lines = (v: string) =>
  v
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)

export function PersonaLibrary() {
  const { repo } = useApp()
  const [list, setList] = useState<Array<{ id: string; name: string; oneLine: string; tags: string[] }>>([])
  const [editing, setEditing] = useState<Persona | null>(null)
  const [spaces, setSpaces] = useState<SpaceIndexEntry[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [cast, setCast] = useState<CastMember[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [personas, spaceList] = await Promise.all([repo.listPersonas(), repo.listSpaces()])
      setList(personas)
      setSpaces(spaceList)
      setSpaceId((prev) => prev || spaceList[0]?.id || '')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }, [repo])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!spaceId) {
      setCast([])
      return
    }
    void repo
      .loadCanon(spaceId)
      .then((canon) => setCast(canon.cast.filter((c) => c.removedAt === null)))
      .catch(() => setCast([]))
  }, [repo, spaceId])

  const flash = (text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice(''), 2000)
  }

  const open = async (id: string) => {
    const persona = await repo.loadPersona(id)
    if (persona) setEditing(persona)
  }

  const save = async () => {
    if (!editing) return
    try {
      const next = await repo.savePersona({ ...editing, updatedAt: 0 })
      setEditing(next)
      await load()
      flash('已保存')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const remove = async (id: string) => {
    try {
      await repo.deletePersona(id)
      if (editing?.id === id) setEditing(null)
      await load()
      flash('已删除（空间里已有的实例不受影响）')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const exportFromCast = async (castId: string) => {
    if (!spaceId) return
    try {
      const persona = await saveCastAsPersona(repo, spaceId, castId)
      await load()
      setEditing(persona)
      flash('已另存为原型')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const importInto = async (personaId: string) => {
    if (!spaceId) return
    try {
      const member = await importPersonaIntoSpace(repo, spaceId, personaId)
      flash(`已把「${member.name}」导入当前空间`)
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const sel = (v: string[]) => v.join('、')

  // 功能暂停：整页只留一句说明与回程，避免"半残"的入口继续制造困惑。
  // 代码与数据结构都保留，`FLAGS.personaCrossSpace = true` 即恢复。
  if (!FLAGS.personaCrossSpace) {
    return (
      <div className="page narrow">
        <button className="link" onClick={() => navigate('')}>
          ← 书架
        </button>
        <h1>人物素材库</h1>
        <div className="notice info">
          这个功能暂停了。跨空间搬角色在实际写作里用得很少，而"同名不同人""导入后不跟随原型更新"
          反而更容易让人困惑；角色本来也会从正文里长出来，不必先建库。
        </div>
        <p className="muted small">
          已经建过的原型不会丢，导出存档时也会带上；需要恢复入口时把
          <code>src/app/flags.ts</code> 里的 <code>personaCrossSpace</code> 打开即可。
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <button className="link" onClick={() => navigate('')}>
        ← 书架
      </button>
      <h1>人物库</h1>
      <p className="muted small">
        原型是"演员"，空间是"这一部戏"。同一原型导入不同空间后各演各的，互不影响。
      </p>
      {!FLAGS.personaCrossSpace && (
        <div className="notice info">
          跨空间导入暂时关闭：实际用下来价值不大，而且同名与"不跟随原型更新"容易让人困惑。
          这里保留为角色卡的草稿本，可以新建、编辑、从空间角色另存。
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice info">{notice}</div>}

      <div className="library-grid">
        <section className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>原型（{list.length}）</h3>
            <button className="btn ghost" onClick={() => setEditing(blankPersona(Date.now()))}>
              ＋ 新建
            </button>
          </div>
          {list.length ? (
            <ul className="list persona-list">
              {list.map((p) => (
                <li key={p.id}>
                  {/* 整行可点：之前只有名字那几个字能点，看着像死链接 */}
                  <button
                    className={editing?.id === p.id ? 'list-item active' : 'list-item'}
                    onClick={() => void open(p.id)}
                  >
                    <strong>{p.name}</strong>
                    <span className="muted small">{p.oneLine || '（还没写一句话身份）'}</span>
                    {(p.tags ?? []).length > 0 && (
                      <span className="chips">
                        {(p.tags ?? []).slice(0, 4).map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                  {FLAGS.personaCrossSpace && (
                    <div className="persona-ops">
                      <button
                        className="link tiny"
                        onClick={() => void importInto(p.id)}
                        disabled={!spaceId}
                        title={spaceId ? '把这个原型复制一份进当前空间' : '先选一个空间'}
                      >
                        导入当前空间
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">还没有原型。可以从下面「某空间里的角色」另存一个。</p>
          )}

          <h3>从空间角色另存</h3>
          <label className="select-wrap">
            <span className="muted small">从哪个空间里拿</span>
            <select
              className="select"
              value={spaceId}
              onChange={(e) => setSpaceId(e.target.value)}
              disabled={!spaces.length}
            >
              {spaces.length ? (
                spaces.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.title}（{sp.sceneCount} 幕）
                  </option>
                ))
              ) : (
                <option value="">还没有空间</option>
              )}
            </select>
          </label>
          {cast.length ? (
            <ul className="plain">
              {cast.map((c) => (
                <li key={c.id} className="persona-row">
                  <span>{c.name}</span>
                  <span className="muted small">{c.oneLine}</span>
                  <button className="link" onClick={() => void exportFromCast(c.id)}>
                    另存为原型
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">这个空间还没有人物。</p>
          )}
        </section>

        <section className="panel form">
          {editing ? (
            <>
              <div className="persona-head">
                <span className="persona-avatar" aria-hidden>
                  {editing.name.slice(0, 1) || '？'}
                </span>
                <div>
                  <h3 className="persona-head-name">{editing.name || '新角色'}</h3>
                  <p className="muted small">
                    {editing.oneLine || '（还没写一句话身份）'} · 第 {editing.rev} 版
                    {editing.createdAt ? '' : ' · 未保存'}
                  </p>
                </div>
              </div>
              <label>
                名字
                <input
                  value={editing.name}
                  maxLength={20}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label>
                一句话身份
                <input
                  value={editing.oneLine}
                  maxLength={60}
                  onChange={(e) => setEditing({ ...editing, oneLine: e.target.value })}
                />
              </label>
              <label>
                说话风格
                <input
                  value={editing.voice}
                  maxLength={40}
                  onChange={(e) => setEditing({ ...editing, voice: e.target.value })}
                />
              </label>
              <label>
                性格（顿号或逗号分隔）
                <input
                  value={sel(editing.personality)}
                  onChange={(e) => setEditing({ ...editing, personality: lines(e.target.value) })}
                />
              </label>
              <label>
                会什么
                <input
                  value={sel(editing.abilities)}
                  onChange={(e) => setEditing({ ...editing, abilities: lines(e.target.value) })}
                />
              </label>
              <label>
                秘密（导入后是"没揭开的"）
                <textarea
                  rows={3}
                  value={(editing.secrets ?? []).join('\n')}
                  onChange={(e) =>
                    setEditing({ ...editing, secrets: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
                  }
                />
              </label>
              <label>
                外形
                <textarea
                  rows={2}
                  value={editing.appearance}
                  onChange={(e) => setEditing({ ...editing, appearance: e.target.value })}
                />
              </label>
              <div className="row">
                <button className="btn primary" onClick={() => void save()}>
                  保存（版本 +1）
                </button>
                <button className="btn ghost" onClick={() => setEditing(null)}>
                  关闭
                </button>
                <button className="btn danger" onClick={() => void remove(editing.id)}>
                  删除
                </button>
              </div>
              <p className="muted small">
                保存只改原型；已经导入各空间的人物<strong>不会</strong>跟着变，需要各自「从原型刷新」。
              </p>
            </>
          ) : (
            <p className="muted">左边选一个原型，或新建一个。</p>
          )}
        </section>
      </div>
    </div>
  )
}
