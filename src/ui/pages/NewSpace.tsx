/** 新建空间：一句话生成 / 选模板 / 随机 / 手写。 */

import { useState } from 'react'
import { createSpaceFromTemplate, createSpaceManual, createSpaceRandom } from '../../app/createSpace'
import { generateSpace, type SeedDraft } from '../../app/seed'
import type { SpaceMeta } from '../../domain/types'
import { loadPrefs } from '../prefs'
import { toUserMessage } from '../../domain/errors'
import { TEMPLATES } from '../../store/seed'
import { navigate } from '../router'
import { useApp } from '../store'

type Mode = 'oneLine' | 'template' | 'random' | 'manual'

const GENRES = ['悬疑', '仙侠', '都市', '科幻', '历史', '奇幻']
const TONES = ['冷峻', '克制', '温情', '荒诞', '热血']

const MODE_LABEL: Record<Mode, string> = {
  oneLine: '一句话',
  template: '选模板',
  random: '随机',
  manual: '手写',
}

export function NewSpace() {
  const { repo, seeder } = useApp()
  // 新建时套用「设置」里的默认值：篇幅、温度、选项数
  const [prefs] = useState(loadPrefs)
  const preset = prefs.preset
  const defaults = { temperature: prefs.temperature, choiceCount: prefs.choiceCount }
  const [mode, setMode] = useState<Mode>('oneLine')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [oneLine, setOneLine] = useState('')
  const [genre, setGenre] = useState(GENRES[0])
  const [tone, setTone] = useState(TONES[0])
  /** 生成结果先给用户看一眼，不满意可以重来 */
  const [preview, setPreview] = useState<{ meta: SpaceMeta; draft: SeedDraft } | null>(null)
  const [manual, setManual] = useState({
    title: '',
    worldName: '',
    era: '',
    premise: '',
    mainGoal: '',
    protagonistName: '',
    protagonistOneLine: '',
    protagonistVoice: '',
    placeName: '',
    placeKind: '场所',
    placeOneLine: '',
  })

  const go = async (fn: () => Promise<{ id: string }>) => {
    setBusy(true)
    setError('')
    try {
      const meta = await fn()
      navigate(`s/${meta.id}`)
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page narrow">
      <button className="link" onClick={() => navigate('')}>
        ← 书架
      </button>
      <h1>新建空间</h1>

      <div className="tabs">
        {(['oneLine', 'template', 'random', 'manual'] as Mode[]).map((m) => (
          <button
            key={m}
            className={mode === m ? 'tab active' : 'tab'}
            onClick={() => {
              setMode(m)
              setPreview(null)
            }}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {error && <div className="notice error">{error}</div>}

      {mode === 'oneLine' && (
        <div className="panel form">
          {preview ? (
            <>
              <h3>{preview.draft.world.name}</h3>
              <p className="muted small">
                {preview.draft.world.era || '未标时代'}
                {preview.draft.world.premise ? ` · ${preview.draft.world.premise}` : ''}
              </p>

              <ul className="plain seed-cast">
                {preview.draft.cast.map((c) => (
                  <li key={c.name}>
                    <strong>{c.name}</strong>
                    <span className="muted small">
                      {c.role === 'protagonist' ? ' · 主角' : ''}
                      {c.oneLine ? ` · ${c.oneLine}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted small">
                地点：{preview.draft.places.map((p) => p.name).join('、')}
              </p>
              {preview.draft.notes.length > 0 && (
                <div className="notice info">
                  已自动调整：{preview.draft.notes.join('；')}
                </div>
              )}

              <div className="row">
                <button className="btn ghost" onClick={() => setPreview(null)}>
                  换个说法再来
                </button>
                <button
                  className="btn primary"
                  onClick={() => navigate(`s/${preview.meta.id}`)}
                >
                  就这样，开始写
                </button>
              </div>
            </>
          ) : (
            <>
              <label>
                用一句话说说想写什么
                <textarea
                  rows={3}
                  value={oneLine}
                  maxLength={200}
                  placeholder="民国雾港，一个回来查父亲死因的记者"
                  onChange={(e) => setOneLine(e.target.value)}
                />
              </label>
              <div className="grid2">
                <label>
                  类型
                  <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                    {GENRES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  基调
                  <select value={tone} onChange={(e) => setTone(e.target.value)}>
                    {TONES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="btn primary"
                disabled={busy || !oneLine.trim()}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  void generateSpace({ repo, seeder, now: () => Date.now() }, { oneLine, genre, tone })
                    .then(setPreview)
                    .catch((e) => setError(toUserMessage(e)))
                    .finally(() => setBusy(false))
                }}
              >
                {busy ? '正在构想…' : '生成设定'}
              </button>
              <p className="muted small">
                只会调用一次模型；生成的人物与地点进空间后都能直接改。
              </p>
            </>
          )}
        </div>
      )}

      {mode === 'template' && (
        <ul className="cards">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                className="card"
                disabled={busy}
                onClick={() =>
                  void go(() => createSpaceFromTemplate(repo, t, { preset, defaults }))
                }
              >
                <span className="card-cover">{t.cover}</span>
                <span className="card-body">
                  <strong>{t.name}</strong>
                  <span className="muted small">{t.tagline}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {mode === 'random' && (
        <div className="panel">
          <p className="muted">从内置模板里随机取一个世界，标题加后缀避免重名。</p>
          <button className="btn primary" disabled={busy} onClick={() => void go(() => createSpaceRandom(repo, undefined, defaults))}>
            掷一次
          </button>
        </div>
      )}

      {mode === 'manual' && (
        <form
          className="panel form"
          onSubmit={(e) => {
            e.preventDefault()
            void go(() =>
              createSpaceManual(
                repo,
                {
                  title: manual.title,
                  worldName: manual.worldName,
                  era: manual.era,
                  premise: manual.premise,
                  mainGoal: manual.mainGoal,
                  rules: [],
                  protagonist: {
                    name: manual.protagonistName,
                    oneLine: manual.protagonistOneLine,
                    voice: manual.protagonistVoice,
                  },
                  place: {
                    name: manual.placeName,
                    kind: manual.placeKind,
                    oneLine: manual.placeOneLine,
                  },
                },
                preset,
                defaults,
              ),
            )
          }}
        >
          <label>
            空间标题
            <input
              value={manual.title}
              onChange={(e) => setManual({ ...manual, title: e.target.value })}
              placeholder="雾港旧案"
            />
          </label>
          <div className="grid2">
            <label>
              世界名
              <input
                value={manual.worldName}
                onChange={(e) => setManual({ ...manual, worldName: e.target.value })}
                placeholder="雾港"
              />
            </label>
            <label>
              时代
              <input
                value={manual.era}
                onChange={(e) => setManual({ ...manual, era: e.target.value })}
                placeholder="民国十七年"
              />
            </label>
          </div>
          <label>
            一句话前提
            <textarea
              rows={2}
              value={manual.premise}
              onChange={(e) => setManual({ ...manual, premise: e.target.value })}
              placeholder="港口终年多雾，雾里有人撒谎"
            />
          </label>
          <label>
            主线目标（可空）
            <input
              value={manual.mainGoal}
              onChange={(e) => setManual({ ...manual, mainGoal: e.target.value })}
              placeholder="查清十年前的旧案"
            />
          </label>
          <div className="grid2">
            <label>
              主角名
              <input
                value={manual.protagonistName}
                onChange={(e) => setManual({ ...manual, protagonistName: e.target.value })}
                placeholder="林昭"
              />
            </label>
            <label>
              主角一句话
              <input
                value={manual.protagonistOneLine}
                onChange={(e) => setManual({ ...manual, protagonistOneLine: e.target.value })}
                placeholder="从北方回来的记者"
              />
            </label>
          </div>
          <div className="grid2">
            <label>
              起点地点
              <input
                value={manual.placeName}
                onChange={(e) => setManual({ ...manual, placeName: e.target.value })}
                placeholder="同福客栈"
              />
            </label>
            <label>
              地点类型
              <input
                value={manual.placeKind}
                onChange={(e) => setManual({ ...manual, placeKind: e.target.value })}
                placeholder="客栈"
              />
            </label>
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            创建并进入
          </button>
        </form>
      )}
    </div>
  )
}
