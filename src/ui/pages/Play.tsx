/** 编织台：正文流 + 行动栏 + 右侧档案。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { advanceScene, type Stage } from '../../app/advanceScene'
import { toUserMessage } from '../../domain/errors'
import { sanitizeUserText } from '../../domain/text'
import { PHASE_LABEL, objectiveProgress, resolvePhase } from '../../domain/objective'
import type { CanonState, Choice, Scene, SceneAction, SpaceMeta } from '../../domain/types'
import { activeCast, openClues } from '../../store/selectors'
import { navigate } from '../router'
import { useApp } from '../store'
import { RichText } from '../RichText'
import { MentionPopover, type MentionTarget } from '../MentionPopover'

interface LoadedScene {
  scene: Scene
  text: string
}

const STAGE_TEXT: Record<Stage, string> = {
  narrating: '正在写…',
  auditing: '校对中…',
  committing: '落笔…',
  archiving: '档案员整理中…',
  idle: '',
}

const ACTION_LABEL: Record<SceneAction['kind'], string> = {
  option: '选择',
  random: '随机',
  free: '自述',
  continue: '续写',
}

export function Play({ spaceId }: { spaceId: string }) {
  const { repo, config, narrator, archivist, triage, apiKey } = useApp()
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [canon, setCanon] = useState<CanonState | null>(null)
  const [scenes, setScenes] = useState<LoadedScene[]>([])
  const [live, setLive] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [free, setFree] = useState('')

  /** 点正文里的人名 / 地名 → 就地浮窗（不跳页，阅读不中断） */
  const [mention, setMention] = useState<MentionTarget | null>(null)
  const openMention = useCallback(
    (
      kind: 'cast' | 'place',
      id: string,
      rect: { top: number; bottom: number; left: number; right: number },
    ) => setMention({ kind, id, rect }),
    [],
  )

  const lastPlaceId = scenes.length ? scenes[scenes.length - 1].scene.placeId : null
  const currentPlace = lastPlaceId && canon ? canon.places.find((p) => p.id === lastPlaceId) : null

  const phase = meta ? resolvePhase(meta, scenes.length) : 'opening'
  const progress = meta ? objectiveProgress(meta) : null
  const finished = phase === 'closed'
  const canWriteFinale = phase === 'ending'

  const bufferRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const [nextMeta, nextCanon, list] = await Promise.all([
      repo.loadMeta(spaceId),
      repo.loadCanon(spaceId),
      repo.listScenes(spaceId),
    ])
    const withText = await Promise.all(
      list
        .filter((s) => s.status === 'committed' || s.status === 'orphan')
        .map(async (scene) => ({ scene, text: await repo.loadText(spaceId, scene.id) })),
    )
    setMeta(nextMeta)
    setCanon(nextCanon)
    setScenes(withText)
  }, [repo, spaceId])

  useEffect(() => {
    void load().catch((e) => setError(toUserMessage(e)))
  }, [load])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      abortRef.current?.abort()
    }
  }, [])

  const onDelta = (text: string) => {
    bufferRef.current += text
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setLive(bufferRef.current)
      })
    }
  }

  const run = async (action: SceneAction, options: { finale?: boolean } = {}) => {
    if (stage !== 'idle') return
    setError('')
    setWarning('')
    bufferRef.current = ''
    setLive('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await advanceScene(
        { repo, narrator, archivist, triage, config, now: () => Date.now(), rand: Math.random },
        {
          spaceId,
          action,
          signal: controller.signal,
          onDelta,
          onStage: setStage,
          finale: options.finale,
          onNotice: (notice) => {
            // 重试必须让用户看见：静默重试会被当成「卡住了」
            if (notice.code === 'E_RETRY') {
              setWarning(
                `连接不太稳，正在重试（第 ${notice.attempt ?? 1}/${notice.maxAttempts ?? 3} 次）…`,
              )
            }
          },
        },
      )
      if (result.repeated) {
        setWarning('这一段和上一段几乎一样：换个选项，或者自己写一个不同的行动再试试。')
      }
      if (result.archiveStatus === 'failed') {
        setWarning((w) => `${w ? `${w} ` : ''}档案员这次没整理出东西，正文已保存，不影响继续写。`)
      }
      await load()
      setLive('')
      setFree('')
    } catch (e) {
      const message = toUserMessage(e)
      setError(message.includes('E_RATE_LIMITED') ? '请求太密了，等几秒再继续' : message)
    } finally {
      setStage('idle')
      abortRef.current = null
      bufferRef.current = ''
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setStage('idle')
  }

  if (!meta || !canon) return <div className="boot">正在翻开这一页…</div>

  const last = scenes[scenes.length - 1]
  const choices: Choice[] = last?.scene.choices ?? []
  const present = last ? activeCast(canon).filter((c) => last.scene.participants.includes(c.id)) : []
  const clues = openClues(scenes.map((s) => s.scene))
  const busy = stage !== 'idle'

  return (
    <div className="page play">
      <header className="play-head">
        <button className="link" onClick={() => navigate('')}>
          ← 书架
        </button>
        <div className="play-title">
          <strong>{meta.title}</strong>
          <span className="muted small">
            {scenes.length} 幕 · {config.model}
          </span>
        </div>
        <button className="link" onClick={() => navigate(`s/${spaceId}/timeline`)}>
          时间线
        </button>
        <button className="link" onClick={() => navigate(`s/${spaceId}/codex`)}>
          档案
        </button>
        <button className="link" onClick={() => navigate(`s/${spaceId}/export`)}>
          导出
        </button>
        <span className={busy ? 'lamp busy' : 'lamp'}>{STAGE_TEXT[stage] || '就绪'}</span>
      </header>

      {meta && meta.mode !== 'free' && meta.objectives.length > 0 && (
        <div className="story-progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round(progress!.ratio * 100)}%` }} />
          </div>
          <span className="progress-label">
            {PHASE_LABEL[phase]} · 目标 {progress!.done}/{progress!.total}
          </span>
        </div>
      )}

      {config.mock && (
        <div className="notice info">
          演示模式：文案由内置样例回放，<strong>不消耗额度也不需要 Key</strong>。配好
          <code>.env.local</code>（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）并去掉 LLM_MOCK 重启，就是真实模型。
        </div>
      )}
      {!config.mock && !config.hasServerKey && !apiKey && (
        <div className="notice info">
          还没有配置 API Key：在 <code>.env.local</code> 里填，或在浏览器本地保存自己的 Key（只存在这台设备）。
        </div>
      )}

      <div className="play-body">
        <main className="story">
          {scenes.map(({ scene, text }) => (
            <article key={scene.id} className={scene.status === 'orphan' ? 'scene orphan' : 'scene'}>
              <div className="scene-index">
                第 {scene.index + 1} 幕
                {scene.action && (
                  <span className="action-chip">
                    {ACTION_LABEL[scene.action.kind]}：{scene.action.text}
                  </span>
                )}
              </div>
              {text.replace(/\s/g, '') ? (
                <RichText text={text} canon={canon} onMention={openMention} />
              ) : (
                <div className="empty-scene">
                  这一幕没写出内容（模型返回了空）。
                  <button className="link" onClick={() => navigate(`s/${spaceId}/timeline`)}>
                    去时间线从这一幕重写
                  </button>
                </div>
              )}
            </article>
          ))}

          {live && (
            <article className="scene live">
              <div className="scene-index">第 {scenes.length + 1} 幕</div>
              <RichText text={live} canon={canon} onMention={openMention} />
            </article>
          )}

          {!scenes.length && !live && (
            <div className="empty">
              <p className="empty-title">{meta.title}</p>
              <p className="muted">{canon.world.premise || '一切都还没开始。'}</p>
              <button className="btn primary" onClick={() => void run({ kind: 'free', text: '开场' })}>
                开始第一段
              </button>
            </div>
          )}

          {warning && <div className="notice warn">{warning}</div>}
          {error && <div className="notice error">{error}</div>}
        </main>

        <aside className="side">
          <section>
            <h3>此刻在场</h3>
            <p className="place-now">
              {currentPlace ? currentPlace.name : <span className="muted">位置不明</span>}
            </p>
            {present.length ? (
              <ul className="plain">
                {present.map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong>
                    {c.status === 'dead' && <span className="tag dead">已死亡</span>}
                    <span className="muted small">{c.oneLine}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                还没有人登场{config.mock ? '（演示文案里没有具体人名，接真实模型后就会出现）' : ''}
              </p>
            )}
          </section>

          <section>
            <h3>目标</h3>
            {meta && meta.objectives.length ? (
              <ul className="plain objective-list">
                {meta.objectives.map((o) => (
                  <li key={o.id} className={o.status === 'done' ? 'objective done' : 'objective'}>
                    <span className="objective-mark">{o.status === 'done' ? '✓' : '○'}</span>
                    <span>
                      {o.kind === 'main' && <span className="tag main">主线</span>}
                      {o.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">还没有目标。主线目标在空间设定里。</p>
            )}
          </section>

          <section>
            <h3>未收伏笔</h3>
            {clues.length ? (
              <ul className="plain">
                {clues.slice(-5).map((c) => (
                  <li key={c.id} className="small">
                    {c.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">还没有</p>
            )}
          </section>

          <section className="stats">
            <button className="stat" onClick={() => navigate(`s/${spaceId}/codex/cast`)}>
              人物 {activeCast(canon).length} →
            </button>
            <button className="stat" onClick={() => navigate(`s/${spaceId}/codex/places`)}>
              地点 {canon.places.filter((p) => p.removedAt === null).length} →
            </button>
            <button className="stat" onClick={() => navigate(`s/${spaceId}/codex/facts`)}>
              事实 {canon.facts.filter((f) => f.status === 'active').length} →
            </button>
          </section>
        </aside>
      </div>

      {mention && (
        <MentionPopover
          target={mention}
          canon={canon}
          onClose={() => setMention(null)}
          onOpenCodex={(kind, id) => {
            setMention(null)
            navigate(`s/${spaceId}/codex/${kind === 'cast' ? 'cast' : 'places'}/${id}`)
          }}
        />
      )}

      <footer className="actions">
        {finished ? (
          <div className="finished-card">
            <p>
              这个故事已经写完了。
              <span className="muted small"> 可以导出，或者回到某一幕重写。</span>
            </p>
            <div className="row">
              <button className="btn ghost" onClick={() => navigate(`s/${spaceId}/export`)}>
                导出
              </button>
              <button className="btn ghost" onClick={() => navigate(`s/${spaceId}/timeline`)}>
                回看时间线
              </button>
            </div>
          </div>
        ) : busy ? (
          <button className="btn ghost" onClick={stop}>
            停止
          </button>
        ) : (
          <>
            {canWriteFinale && (
              <button
                className="btn primary finale"
                onClick={() => void run({ kind: 'free', text: '给出结局' }, { finale: true })}
              >
                写结局
              </button>
            )}
            {choices.map((c, i) => (
              <button key={i} className="btn choice" onClick={() => void run({ kind: 'option', text: c.label })}>
                {c.intent && <span className="choice-tag">{c.intent}</span>}
                {c.label}
              </button>
            ))}
            {choices.length > 0 && (
              <button
                className="btn ghost"
                title="随机选一个"
                onClick={() => {
                  const pick = choices[Math.floor(Math.random() * choices.length)]
                  void run({ kind: 'random', text: pick.label })
                }}
              >
                随机选择
              </button>
            )}
            <form
              className="free"
              onSubmit={(e) => {
                e.preventDefault()
                const text = sanitizeUserText(free, 200)
                if (!text) return
                void run({ kind: 'free', text })
                setFree('')
              }}
            >
              <input
                value={free}
                onChange={(e) => setFree(e.target.value)}
                placeholder={scenes.length ? '或者自己写一个行动…' : '直接开始'}
              />
              <button className="btn primary" type="submit">
                推进
              </button>
            </form>
          </>
        )}
      </footer>
    </div>
  )
}
