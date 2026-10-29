/** 编织台：正文流 + 行动栏 + 右侧档案。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { advanceScene, type Stage } from '../../app/advanceScene'
import { toUserMessage } from '../../domain/errors'
import { sanitizeUserText } from '../../domain/text'
import { PHASE_LABEL, objectiveProgress, resolvePhase } from '../../domain/objective'
import type { CheckAttempt, CanonState, Choice, Scene, SceneAction, SpaceMeta } from '../../domain/types'
import { activeCast, openClues } from '../../store/selectors'
import { navigate } from '../router'
import { useApp } from '../store'
import { RichText } from '../RichText'
import { MentionPopover, type MentionTarget } from '../MentionPopover'
import { ArtBlock } from '../ArtBlock'
import { scenePrompt } from '../../domain/artPrompt'

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
  const { repo, config, narrator, archivist, triage, apiKey, media, provider } = useApp()
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [canon, setCanon] = useState<CanonState | null>(null)
  const [scenes, setScenes] = useState<LoadedScene[]>([])
  const [live, setLive] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [free, setFree] = useState('')
  /** 一次性提示：追哪条、收掉哪条。自行消失，不打断写作 */
  const [flash, setFlash] = useState('')
  /**
   * 行动姿态。默认稳妥：每一次行动都该有"成不成"的不确定性，
   * 但不该逼玩家每次都做选择——想赌的人切到冒险即可。
   */
  const [attempt, setAttempt] = useState<CheckAttempt>('safe')

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

  /** 下一幕必须发生的固定事件（已经过去的会标错过，不在这里补） */
  const dueEvent =
    meta?.mode === 'goal'
      ? meta.scheduled.find((e) => !e.fired && e.atSceneIndex === scenes.length) ?? null
      : null

  const phase = meta ? resolvePhase(meta, scenes.length) : 'opening'
  const progress = meta ? objectiveProgress(meta) : null
  const finished = phase === 'closed'
  const canWriteFinale = phase === 'ending'

  const bufferRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /**
   * 行动栏是 fixed 的，高度却随选项条数变化（4 条选项 + 姿态条 + 输入框）。
   * 用固定 padding 兜不住：手机上一换行就压住正文最后两段。
   */
  const actionsRef = useRef<HTMLElement | null>(null)
  const [actionsH, setActionsH] = useState(0)
  /** 朗读：一次只放一条，避免两段声音叠在一起 */
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null)
  const [speakingId, setSpeakingId] = useState('')

  const speak = async (sceneId: string, text: string) => {
    if (speakingId) return
    setSpeakingId(sceneId)
    setError('')
    try {
      // 优先用主角自己的音色；没设就用全局默认
      const protag = canon?.cast.find((c) => c.id === meta?.protagId)
      const res = await media.speak({
        text: text.slice(0, 900),
        voice:
          protag?.voiceId ||
          (protag?.gender === 'male' ? provider.ttsVoiceMale : '') ||
          provider.ttsVoice ||
          undefined,
      })
      if (!res.audio) {
        setError('演示模式没有真实音频；填上自己的 Key 后即可朗读。')
      } else {
        setAudio({ id: sceneId, url: res.audio })
      }
    } catch (e) {
      setError(explain(e))
    } finally {
      setSpeakingId('')
    }
  }

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
    return withText
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

  const run = async (
    action: SceneAction,
    options: { finale?: boolean; attempt?: CheckAttempt } = {},
  ) => {
    if (stage !== 'idle') return
    setError('')
    setWarning('')
    bufferRef.current = ''
    setLive('')
    const controller = new AbortController()
    abortRef.current = controller
    const beforeOpen = openClues(scenes.map((x) => x.scene))
    try {
      const result = await advanceScene(
        { repo, narrator, archivist, triage, config, now: () => Date.now(), rand: Math.random },
        {
          spaceId,
          // 开场与结局不掷骰：开场是既定引子，结局本来就要收束
          action:
            options.finale || action.text === '开场'
              ? action
              : { ...action, attempt: options.attempt ?? attempt },
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
      const fresh = await load()
      const afterOpen = openClues(fresh.map((x) => x.scene))
      const closed = beforeOpen.filter((b) => !afterOpen.some((a) => a.id === b.id))
      if (closed.length) {
        setFlash(`收掉一条：${closed[0].unknown || closed[0].text}`)
      } else if (beforeOpen.some((c) => c.pursuedAt)) {
        setFlash('这条还没被正面回答，可以再追一步，或换个问法。')
      }
      setLive('')
      setFree('')
    } catch (e) {
      setError(explain(e))
    } finally {
      setStage('idle')
      abortRef.current = null
      bufferRef.current = ''
    }
  }

  useEffect(() => {
    const el = actionsRef.current
    if (!el) return
    const sync = () => setActionsH(el.getBoundingClientRect().height)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    // 键盘弹出/收起会改变可视高度，fixed 栏的高度也可能跟着变
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
    // 内容变了 ResizeObserver 自己会回调，这里不必跟着依赖重挂
  }, [])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(''), 3600)
    return () => window.clearTimeout(timer)
  }, [flash])

  const pursue = async (clueId: string, text: string) => {
    setFree(`追查：${text}`)
    try {
      await repo.markCluePursued(spaceId, clueId)
      await load()
      setFlash('已标记为正在追，下一步直接提交即可。')
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  /**
   * 额度用完和限流不是"坏了"，是"没牌了"。
   * 这时候只说一句错误没有用，得告诉人往哪走：填自己的 Key 就能继续。
   */
  const explain = (e: unknown): string => {
    const code = (e as { code?: string } | null)?.code ?? ''
    const base = toUserMessage(e)
    if (code === 'E_QUOTA_EXHAUSTED') {
      return `${base}　站点的今日体验额度用完了，在「设置」里填自己的 Key 可以接着写（只存本机）。`
    }
    if (code === 'E_RATE_LIMITED') return '请求太密了，等几秒再继续。'
    if (code === 'E_NO_KEY') return `${base}　在「设置」里填一个 Key（只存本机），或点这里去填。`
    return base
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
    <div
      className="page play"
      style={
        actionsH ? ({ '--actions-h': `${actionsH}px` } as React.CSSProperties) : undefined
      }
    >
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
        {config.features.dream && (
          <button className="link" onClick={() => navigate(`s/${spaceId}/dream`)}>
            入梦
          </button>
        )}
        <button className="link" onClick={() => navigate(`s/${spaceId}/settings`)}>
          设置
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
          演示模式：文案由内置样例回放，<strong>不消耗额度也不需要 Key</strong>。想用真实模型，
          <button className="link inline-cta" onClick={() => navigate('settings')}>
            去设置填一个 Key
          </button>
          （只存在这台设备）。
        </div>
      )}
      {!config.mock && !config.hasServerKey && !apiKey && (
        <div className="notice info">
          还没有 API Key。
          <button className="link inline-cta" onClick={() => navigate('settings')}>
            去设置填一个
          </button>
          只存本机，不会上传；填完在世界里写一句就能验通。
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
                    {scene.action.check && (
                      <em className={scene.action.check.success ? 'check ok' : 'check bad'}>
                        {scene.action.check.attempt === 'bold' ? '冒险' : '稳妥'}·
                        {scene.action.check.success ? '成' : '败'}
                      </em>
                    )}
                  </span>
                )}
              </div>
              {(() => {
                const closed = scene.clues.filter(
                  (c) => c.status === 'resolved' && c.resolvedAtSceneId === scene.id,
                )
                const opened = scene.clues
                const pursued = /^追查[：:]/.test((scene.action?.text ?? '').trim())
                if (!closed.length && !opened.length && !pursued) return null
                /* 玩家要看得见"这一步改变了什么"：收了哪条、又开了哪条、追问有没有下文 */
                return (
                  <div className="scene-clues">
                    {pursued && (
                      <span
                        className={closed.length ? 'clue-chip done' : 'clue-chip pending'}
                        title="这一步是在追一条旧问题"
                      >
                        {closed.length ? '追问有下文' : '追问 · 本幕仍未答'}
                      </span>
                    )}
                    {closed.map((c) => (
                      <span key={c.id} className="clue-chip done" title="这一幕回答了它">
                        收线 · {c.unknown || c.text}
                      </span>
                    ))}
                    {opened.map((c) => (
                      <span key={c.id} className="clue-chip new" title="这一幕新埋的疑问">
                        新疑问 · {c.unknown || c.text}
                      </span>
                    ))}
                  </div>
                )
              })()}

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

              {scene.status === 'committed' && (
                <div className="scene-ops">
                  <ArtBlock
                    spaceId={spaceId}
                    kind="scene"
                    id={scene.id}
                    prompt={scenePrompt(
                      scene,
                      text,
                      canon.places.find((p) => p.id === scene.placeId) ?? null,
                      scene.participants
                        .map((id) => canon.cast.find((c) => c.id === id)?.name ?? '')
                        .filter(Boolean),
                    )}
                    size="1024x768"
                    label="配图"
                  />
                  {config.features.tts && (config.media.tts || Boolean(provider.mediaBase)) && (
                    <button
                      className="link tiny"
                      disabled={Boolean(speakingId)}
                      onClick={() => void speak(scene.id, text)}
                    >
                      {speakingId === scene.id ? '合成中…' : '朗读'}
                    </button>
                  )}
                </div>
              )}
              {audio?.id === scene.id && (
                <audio className="scene-audio" controls autoPlay src={audio.url} />
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
      {flash && <div className="notice info flash">{flash}</div>}
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
                  <li key={c.id} className={c.pursuedAt ? 'small clue-row pursued' : 'small clue-row'}>
                    <span>
                      {c.unknown || c.text}
                      {c.pursuedAt && <em className="clue-pursuing">正在追</em>}
                    </span>
                    {/* 追问是玩法：点了会记下"正在追"并填进行动，收没收到由正文决定 */}
                    <button
                      className="link tiny"
                      title="把这条填进行动，直接去问"
                      onClick={() => void pursue(c.id, c.unknown || c.text)}
                    >
                      追这条
                    </button>
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

      <footer className="actions" ref={actionsRef}>
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
            {dueEvent && (
              <div className="event-card">
                <div className="event-head">
                  <span className="event-title">本幕必然发生</span>
                  <span className="muted small">第 {dueEvent.atSceneIndex + 1} 幕</span>
                </div>
                <p>{dueEvent.text}</p>
                <div className="row">
                  <button
                    className="btn choice"
                    onClick={() => {
                      setAttempt('safe')
                      void run(
                        { kind: 'free', text: `面对「${dueEvent.text}」，先稳住，按规矩来` },
                        { attempt: 'safe' },
                      )
                    }}
                  >
                    <span className="choice-tag">稳妥</span>先稳住，按规矩来
                  </button>
                  <button
                    className="btn choice"
                    onClick={() => {
                      setAttempt('bold')
                      void run(
                        { kind: 'free', text: `面对「${dueEvent.text}」，直接迎上去` },
                        { attempt: 'bold' },
                      )
                    }}
                  >
                    <span className="choice-tag">冒险</span>直接迎上去
                  </button>
                  <button
                    className="btn choice"
                    onClick={() => {
                      setAttempt('safe')
                      void run(
                        { kind: 'free', text: `面对「${dueEvent.text}」，先看看别人怎么应对` },
                        { attempt: 'safe' },
                      )
                    }}
                  >
                    <span className="choice-tag">观察</span>先看别人怎么应对
                  </button>
                </div>
              </div>
            )}
            <div className="attempt-bar">
              <span className="muted small">这一步：</span>
              <button
                className={attempt === 'safe' ? 'seg-item active' : 'seg-item'}
                onClick={() => setAttempt('safe')}
              >
                稳妥
              </button>
              <button
                className={attempt === 'bold' ? 'seg-item active' : 'seg-item'}
                onClick={() => setAttempt('bold')}
              >
                冒险
              </button>
              <span className="muted small">
                {attempt === 'safe' ? '按部就班，容易办成' : '更容易推进，但失败会有代价'}
              </span>
            </div>
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
