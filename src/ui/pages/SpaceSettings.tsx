/** 空间设置：只改这个空间自己的东西，全局默认值在 `#/settings`。 */

import { useEffect, useState } from 'react'
import { toUserMessage } from '../../domain/errors'
import { coverPrompt } from '../../domain/artPrompt'
import type { CanonState, CharPreset, SpaceMeta, SpaceMode } from '../../domain/types'
import { ArtBlock } from '../ArtBlock'
import { navigate } from '../router'
import { useApp } from '../store'

const PRESETS: Array<{ value: CharPreset; label: string; hint: string }> = [
  { value: 'short', label: '短', hint: '200–320 字，节奏快' },
  { value: 'medium', label: '中', hint: '320–500 字' },
  { value: 'long', label: '长', hint: '500–800 字，适合高潮' },
]

export function SpaceSettings({ spaceId }: { spaceId: string }) {
  const { repo } = useApp()
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [canon, setCanon] = useState<CanonState | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [confirmTitle, setConfirmTitle] = useState('')
  const [draft, setDraft] = useState({
    title: '',
    mode: 'goal' as SpaceMode,
    preset: 'short' as CharPreset,
    temperature: 0.9,
    mainGoal: '',
    hardRules: '',
  })

  // 封面的提示词要用到人物与地点，所以档案也一起读
  useEffect(() => {
    void repo.loadCanon(spaceId).then(setCanon).catch(() => setCanon(null))
  }, [repo, spaceId])

  useEffect(() => {
    void repo
      .loadMeta(spaceId)
      .then((m) => {
        setMeta(m)
        setDraft({
          title: m.title,
          mode: m.mode,
          preset: m.settings.charPreset,
          temperature: m.settings.temperature,
          mainGoal: m.mainGoal,
          hardRules: m.hardRules.join('\n'),
        })
      })
      .catch((e) => setError(toUserMessage(e)))
  }, [repo, spaceId])

  const flash = (text: string) => {
    setSaved(text)
    window.setTimeout(() => setSaved(''), 1800)
  }

  const save = async () => {
    if (!meta) return
    setError('')
    try {
      const next: SpaceMeta = {
        ...meta,
        title: draft.title.trim() || meta.title,
        mode: draft.mode,
        mainGoal: draft.mainGoal.trim(),
        hardRules: draft.hardRules
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6),
        settings: {
          ...meta.settings,
          charPreset: draft.preset,
          temperature: Math.min(1.2, Math.max(0.2, draft.temperature)),
        },
      }
      await repo.saveMeta(spaceId, next)
      setMeta(next)
      flash('已保存')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const remove = async () => {
    if (!meta) return
    if (confirmTitle.trim() !== meta.title) {
      setError('输入的标题和空间标题不一致，没有删除。')
      return
    }
    try {
      await repo.deleteSpace(spaceId)
      navigate('')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  if (!meta) {
    return (
      <div className="page narrow">
        {error ? <div className="notice error">{error}</div> : <p className="muted">正在打开设置…</p>}
      </div>
    )
  }

  return (
    <div className="page narrow">
      <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
        ← 回到故事
      </button>
      <h1>空间设置</h1>
      {error && <div className="notice error">{error}</div>}

      {canon && (
        <section className="panel">
          <h3>封面</h3>
          <p className="muted small">
            按世界、主线与主角生成一张竖图，书架和导出都会用到。同一提示词不会重复扣费，想换一张点「重画」。
          </p>
          <ArtBlock
            spaceId={spaceId}
            kind="cover"
            id={spaceId}
            prompt={coverPrompt(meta, canon)}
            size="768x1024"
            label="封面"
            defaultOpen
            className="cover-block"
          />
        </section>
      )}
      {saved && <div className="notice info">{saved}</div>}

      <div className="panel form">
        <label>
          标题
          <input value={draft.title} maxLength={40} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>

        <label>
          模式
          <select
            className="select"
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as SpaceMode })}
          >
            <option value="goal">有终点：按阶段推进，会催收线索、能写结局</option>
            <option value="free">沙盒：不催进度，随便写</option>
          </select>
        </label>

        <label>
          每段字数
          <select
            className="select"
            value={draft.preset}
            onChange={(e) => setDraft({ ...draft, preset: e.target.value as CharPreset })}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} · {p.hint}
              </option>
            ))}
          </select>
        </label>

        <label>
          温度 {draft.temperature.toFixed(2)}
          <input
            type="range"
            min={0.2}
            max={1.2}
            step={0.05}
            value={draft.temperature}
            onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
          />
          <span className="muted small">低更稳、更贴设定；高更野、更容易出意外。</span>
        </label>

        <label>
          主线目标
          <textarea
            rows={2}
            maxLength={120}
            value={draft.mainGoal}
            onChange={(e) => setDraft({ ...draft, mainGoal: e.target.value })}
            placeholder="例：查清父亲十年前在雾港的死因"
          />
          <span className="muted small">改这里不会改已写好的正文，只影响之后的推进。</span>
        </label>

        <label>
          铁律（一行一条，最多 6 条）
          <textarea
            rows={4}
            value={draft.hardRules}
            onChange={(e) => setDraft({ ...draft, hardRules: e.target.value })}
            placeholder={'雾一起，船上的人说什么都不作数\n书院里不能提「外面」两个字'}
          />
        </label>

        <div className="row">
          <button className="btn primary" onClick={() => void save()}>
            保存
          </button>
          <button className="btn ghost" onClick={() => navigate(`s/${spaceId}`)}>
            取消
          </button>
        </div>
      </div>

      <div className="panel danger-zone">
        <h3>删除这个空间</h3>
        <p className="muted small">
          会删掉全部幕、档案与补丁，不能撤销。想留底稿先去导出页存一份。
        </p>
        <label>
          输入标题「{meta.title}」确认
          <input value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} />
        </label>
        <button
          className="btn danger"
          disabled={confirmTitle.trim() !== meta.title}
          onClick={() => void remove()}
        >
          永久删除
        </button>
      </div>
    </div>
  )
}
