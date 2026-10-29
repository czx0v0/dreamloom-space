/** 档案库：世界 / 人物 / 地点 / 关系 / 事实 / 伏笔，以及合并确认。 */

import { useCallback, useEffect, useState } from 'react'
import { acceptMerge, applyCastEdit, dismissMerge, type EditableCastField } from '../../app/canonEdit'
import { importPersonaIntoSpace } from '../../app/persona'
import { PersonaPicker } from '../PersonaPicker'
import { FLAGS } from '../../app/flags'
import { ArtBlock } from '../ArtBlock'
import { castPrompt, coverPrompt, placePrompt } from '../../domain/artPrompt'
import { toUserMessage } from '../../domain/errors'
import { STRENGTH_LABEL } from '../../domain/export'
import { placePath } from '../../domain/place'
import { parseSuggestions } from '../../domain/suggest'
import type {
  CanonState,
  CastMember,
  Clue,
  ScheduledEvent,
  SpaceMode,
  MergeProposal,
  Objective,
  Place,
  Scene,
  SpaceMeta,
} from '../../domain/types'
import { activeFacts, relationsOf } from '../../store/selectors'
import { navigate } from '../router'
import { useApp } from '../store'

type Tab = 'cast' | 'places' | 'relations' | 'facts' | 'clues' | 'objectives' | 'world'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'world', label: '世界' },
  { key: 'cast', label: '人物' },
  { key: 'places', label: '地点' },
  { key: 'relations', label: '关系' },
  { key: 'facts', label: '事实' },
  { key: 'clues', label: '伏笔' },
  { key: 'objectives', label: '目标' },
]

const STATUS_LABEL: Record<CastMember['status'], string> = {
  alive: '在场',
  dead: '已死亡',
  missing: '失踪',
  unknown: '去向不明',
}

const ARC_LABEL: Record<string, string> = {
  turn: '转折',
  loss: '失去',
  gain: '获得',
  reveal: '揭示',
  meeting: '相遇',
}

const TAB_KEYS = TABS.map((t) => t.key)

export function Codex({
  spaceId,
  tab: initialTab,
  focus,
}: {
  spaceId: string
  tab?: string
  focus?: string
}) {
  const { repo, config, suggest, media, provider } = useApp()
  const [tab, setTab] = useState<Tab>(
    initialTab && TAB_KEYS.includes(initialTab as Tab) ? (initialTab as Tab) : 'cast',
  )
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [canon, setCanon] = useState<CanonState | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [proposals, setProposals] = useState<MergeProposal[]>([])
  // 从正文点名字进来时直达该人物；没有 focus 就让详情回落到第一个
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const load = useCallback(async () => {
    const [m, c, s, p] = await Promise.all([
      repo.loadMeta(spaceId),
      repo.loadCanon(spaceId),
      repo.listScenes(spaceId),
      repo.listMergeProposals(spaceId),
    ])
    setMeta(m)
    setCanon(c)
    setScenes(s)
    setProposals(p)
  }, [repo, spaceId])

  useEffect(() => {
    void load().catch((e) => setError(toUserMessage(e)))
  }, [load])

  const [suggesting, setSuggesting] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  /** 试听：哪个角色正在合成，以及生成好的音频 */
  const [voicing, setVoicing] = useState('')
  const [voiceClip, setVoiceClip] = useState('')

  // ⚠️ 这个早退之前必须放完所有 hook。
  // 曾经把 `suggesting / personaOpen` 写在它下面：首帧走早退只调 5 个 hook，
  // 数据到了再调 7 个，React 直接抛 #310（Rendered more hooks than during the previous render）。
  if (!meta || !canon) return <div className="boot">正在整理档案…</div>

  const cast = canon.cast.filter((c) => c.supersededBy === null && c.removedAt === null)
  const merged = canon.cast.filter((c) => c.supersededBy !== null)
  const places = canon.places.filter((p) => p.supersededBy === null)
  const clues = scenes.flatMap((s) => s.clues)
  const progress = `${scenes.filter((s) => s.summary).length}/${scenes.length}`

  const onEdit = async (member: CastMember, field: EditableCastField, value: string) => {
    const next = applyCastEdit(member, field, value)
    if (next === member) return
    await repo.saveCanon(spaceId, {
      ...canon,
      cast: canon.cast.map((c) => (c.id === member.id ? next : c)),
    })
    setCanon({
      ...canon,
      cast: canon.cast.map((c) => (c.id === member.id ? next : c)),
    })
    setFlash('已保存，该字段不再被模型覆盖')
    setTimeout(() => setFlash(''), 2400)
  }

  /** 列表类字段（能力 / 爱好 / 隐藏项）：直接改 canon，不走 applyCastEdit（那是给字符串的） */
  const onEditList = async (
    member: CastMember,
    field: 'abilities' | 'hobbies' | 'hidden',
    values: CastMember['abilities'] | CastMember['hidden'],
  ) => {
    const next = { ...member, [field]: values } as CastMember
    const canonNext = {
      ...canon,
      cast: canon.cast.map((c) => (c.id === member.id ? next : c)),
    }
    setCanon(canonNext)
    await repo.saveCanon(spaceId, canonNext)
    setFlash('已保存')
    setTimeout(() => setFlash(''), 2400)
  }

  /** 用角色自己的音色说一句，确认这个音色合适再定下来 */
  const audition = async (member: CastMember) => {
    setVoicing(member.id)
    setVoiceClip('')
    try {
      const res = await media.speak({
        text: `${member.name}：「雾散了，走吧。」`,
        voice: member.voiceId || (member.gender === 'male' ? provider.ttsVoiceMale : '') || provider.ttsVoice || undefined,
      })
      if (res.audio) setVoiceClip(res.audio)
      else setFlash('没有拿到音频（演示模式或未配置语音接口）')
    } catch (e) {
      setFlash(toUserMessage(e))
    } finally {
      setVoicing('')
      setTimeout(() => setFlash(''), 2600)
    }
  }

  const importPersona = async (personaId: string) => {
    const member = await importPersonaIntoSpace(repo, spaceId, personaId)
    await load()
    setSelected(member.id)
    setFlash(`已导入「${member.name}」，可在下方改身份`)
    setTimeout(() => setFlash(''), 2600)
  }

  /** 辅助生成：只出草稿，进列表后可逐条删改 */
  const askSuggestions = async (kind: 'events' | 'hidden', target?: string): Promise<string[]> => {
    setSuggesting(true)
    try {
      const res = await suggest.suggest({
        kind,
        target,
        context: {
          world: [canon.world.name, canon.world.era, canon.world.premise].filter(Boolean).join('／'),
          goal: meta.mainGoal,
          cast: cast.map((c) => c.name),
          recent: scenes.slice(-3).map((sc) => sc.summary ?? '').filter(Boolean),
        },
      })
      const items = parseSuggestions(res.text, kind === 'events' ? 3 : 2)
      if (!items.length) {
        setFlash('这次没想出合适的，再点一次或手写。')
        setTimeout(() => setFlash(''), 2400)
      }
      return items
    } catch (e) {
      setFlash(toUserMessage(e))
      setTimeout(() => setFlash(''), 3200)
      return []
    } finally {
      setSuggesting(false)
    }
  }

  const suggestEvents = async () => {
    const items = await askSuggestions('events')
    if (!items.length) return
    const base = meta.sceneCount + 1
    const next = [
      ...meta.scheduled,
      ...items.map((text, i) => ({
        id: `ev_${Date.now()}_${i}`,
        atSceneIndex: base + i,
        text,
        fired: false,
        origin: 'extract' as const,
      })),
    ]
    const metaNext = { ...meta, scheduled: next }
    setMeta(metaNext)
    await repo.saveMeta(spaceId, metaNext)
    setFlash(`已加 ${items.length} 个节点，可改期或删掉`)
    setTimeout(() => setFlash(''), 2600)
  }

  const suggestHidden = async (member: CastMember) => {
    const items = await askSuggestions('hidden', member.name)
    if (!items.length) return
    const merged = [
      ...member.hidden,
      ...items.map((text) => ({ text, revealedAt: null })),
    ].slice(0, 8)
    await onEditList(member, 'hidden', merged)
    setFlash(`给${member.name}加了 ${items.length} 条秘密`)
    setTimeout(() => setFlash(''), 2400)
  }

  const onAccept = async (proposal: MergeProposal) => {
    try {
      const result = await acceptMerge(repo, spaceId, proposal, Date.now())
      await load()
      setFlash(
        result.merged
          ? `已合并：搬走 ${result.aliasesMoved} 个别名，重指 ${result.scenesRepointed} 幕`
          : '没有合并：目标已被处理过',
      )
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  const onDismiss = async (proposal: MergeProposal) => {
    await dismissMerge(repo, spaceId, proposal.id)
    await load()
  }

  return (
    <div className="page codex">
      <header className="play-head">
        <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
          ← 回到编织台
        </button>
        <div className="play-title">
          <strong>{meta.title} · 档案</strong>
          <span className="muted small">
            摘要 {progress} · 人物 {cast.length} · 地点 {places.length} · 事实 {activeFacts(canon).length}
          </span>
        </div>
        <button className="link" onClick={() => navigate(`s/${spaceId}/export`)}>
          导出 →
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}
      {flash && <div className="notice ok">{flash}</div>}

      {/* 封面放在档案页顶部：书架缩略图太小，很多人找不到生成入口 */}
      <section className="panel cover-panel">
        <h3>封面</h3>
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

      {proposals.length > 0 && (
        <section className="panel merge-panel">
          <h3>可能有重复的人</h3>
          <ul className="plain">
            {proposals.map((p) => {
              const a = canon.cast.find((c) => c.id === p.aId)
              const b = canon.cast.find((c) => c.id === p.bId)
              if (!a || !b) return null
              return (
                <li key={p.id} className="merge-row">
                  <span>
                    <strong>{a.name}</strong> 与 <strong>{b.name}</strong>
                    <span className="muted small"> · {p.evidence} · 置信 {p.confidence.toFixed(1)}</span>
                  </span>
                  <span className="row">
                    <button className="btn" onClick={() => void onAccept(p)}>
                      合并
                    </button>
                    <button className="btn ghost" onClick={() => void onDismiss(p)}>
                      忽略
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="muted small">合并会搬走别名与故事线，并把关系、出场记录指到保留的那个人。原始记录不会删除。</p>
        </section>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'world' && (
        <section className="panel">
          <dl className="kv">
            <dt>世界</dt>
            <dd>{canon.world.name || '—'}</dd>
            <dt>时代</dt>
            <dd>{canon.world.era || '—'}</dd>
            <dt>主题</dt>
            <dd>{canon.world.theme || '—'}</dd>
            <dt>前提</dt>
            <dd>{canon.world.premise || '—'}</dd>
            <dt>主线目标</dt>
            <dd>{meta.mainGoal || '—'}</dd>
            <dt>势力</dt>
            <dd>{canon.world.factions.join('、') || '—'}</dd>
          </dl>
          <h3>铁律</h3>
          <ul className="plain">
            {[...canon.world.rules, ...meta.hardRules].map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {!canon.world.rules.length && !meta.hardRules.length && <li className="muted">还没有铁律</li>}
          </ul>
        </section>
      )}

      {tab === 'cast' && (
        <div className="split">
          <div className="cast-side">
            <div className="row cast-side-head">
              <span className="muted small">人物（{cast.length}）</span>
              {FLAGS.personaCrossSpace && (
                <button className="link tiny" onClick={() => setPersonaOpen(true)}>
                  从人物库导入
                </button>
              )}
            </div>
          <ul className="list">
            {cast.map((c) => (
              <li key={c.id}>
                <button
                  className={selected === c.id ? 'list-item active' : 'list-item'}
                  onClick={() => setSelected(c.id)}
                >
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {STATUS_LABEL[c.status]} · {c.arc.length} 条故事线
                  </span>
                </button>
              </li>
            ))}
          </ul>
          </div>
          <div className="panel detail">
            {(() => {
              const member = cast.find((c) => c.id === selected) ?? cast[0]
              if (!member) return <p className="muted">还没有人物，推进几幕后会自动出现。</p>
              return (
                <>
                  <h3>{member.name}</h3>
                  <ArtBlock
                    key={member.id}
                    spaceId={spaceId}
                    kind="cast"
                    id={member.id}
                    prompt={castPrompt(member.name, member.oneLine, '', member.traits, member.voice)}
                    size="768x1024"
                    label="立绘"
                    defaultOpen
                    className="detail-art"
                  />
                  <dl className="kv">
                    <dt>状态</dt>
                    <dd>{STATUS_LABEL[member.status]}</dd>
                    <dt>别名</dt>
                    <dd>{member.aliases.join('、') || '—'}</dd>
                  </dl>
                  <EditableField
                    label="一句话"
                    value={member.oneLine}
                    max={40}
                    locked={Boolean(member.locked.oneLine)}
                    onSave={(v) => void onEdit(member, 'oneLine', v)}
                  />
                  <EditableField
                    label="语气"
                    value={member.voice}
                    max={30}
                    onSave={(v) => void onEdit(member, 'voice', v)}
                  />
                  <div className="field">
                    <span className="field-label">性别</span>
                    <select
                      className="select"
                      value={member.gender ?? 'unknown'}
                      onChange={(e) =>
                        void onEdit(member, 'gender', e.target.value as 'male' | 'female' | 'unknown')
                      }
                    >
                      <option value="unknown">未标</option>
                      <option value="female">女</option>
                      <option value="male">男</option>
                    </select>
                    {member.gender === 'male' && !member.voiceId && !provider.ttsVoiceMale && (
                      <span className="muted small">默认音色是女声，建议在上方填一个男声音色</span>
                    )}
                  </div>
                  <EditableField
                    label="朗读音色"
                    value={member.voiceId ?? ''}
                    max={40}
                    locked={false}
                    onSave={(v) => void onEdit(member, 'voiceId', v)}
                  />
                  <div className="row voice-row">
                    <button
                      className="btn ghost small-btn"
                      disabled={Boolean(voicing) || !config.features.tts}
                      onClick={() => void audition(member)}
                      title="用这个角色的音色念一句（会消耗少量语音额度）"
                    >
                      {voicing === member.id ? '合成中…' : '试听这个角色'}
                    </button>
                    <span className="muted small">音色名以供应商控制台为准，留空用默认</span>
                  </div>
                  {voiceClip && <audio className="scene-audio" controls autoPlay src={voiceClip} />}
                  <EditableField
                    label="目标"
                    value={member.goal}
                    max={80}
                    onSave={(v) => void onEdit(member, 'goal', v)}
                  />
                  <ListField
                    label="会什么"
                    values={member.abilities}
                    hint="只写表现出来的能力"
                    onSave={(values) =>
                      void onEditList(member, 'abilities', values.slice(0, 6))
                    }
                  />
                  <ListField
                    label="喜欢什么"
                    values={member.hobbies}
                    hint="闲笔里提到的"
                    onSave={(values) => void onEditList(member, 'hobbies', values.slice(0, 4))}
                  />

                  <h3>
                    还没揭开的
                    <button
                      className="link tiny"
                      disabled={suggesting}
                      onClick={() => void suggestHidden(member)}
                      title="让模型补两条可以被剧情揭开的秘密"
                    >
                      AI 补两个
                    </button>
                  </h3>
                  {member.hidden.length ? (
                    <ul className="plain hidden-list">
                      {member.hidden.map((h, i) => (
                        <li key={i} className={h.revealedAt ? 'hidden-item revealed' : 'hidden-item'}>
                          <span className="objective-mark">{h.revealedAt ? '✓' : '·'}</span>
                          <span>{h.text}</span>
                          <button
                            className="link"
                            onClick={() =>
                              void onEditList(
                                member,
                                'hidden',
                                member.hidden.map((x, j) =>
                                  j === i
                                    ? { ...x, revealedAt: x.revealedAt ? null : 'manual' }
                                    : x,
                                ),
                              )
                            }
                          >
                            {h.revealedAt ? '收回' : '已揭开'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">没有登记的秘密。抽取时发现的会自动加进来。</p>
                  )}

                  <h3>故事线</h3>
                  {member.arc.length ? (
                    <ol className="arc">
                      {member.arc.map((beat, i) => (
                        <li key={i}>
                          <span className="tag">{ARC_LABEL[beat.kind] ?? beat.kind}</span>
                          {beat.text}
                          <span className="muted small"> · 第 {scenes.find((s) => s.id === beat.sceneId)?.index ?? '?'} 幕</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="muted small">还没有转折</p>
                  )}

                  <h3>关系</h3>
                  {relationsOf(canon, member.id).length ? (
                    <ul className="plain">
                      {relationsOf(canon, member.id).map((r, i) => (
                        <li key={i}>
                          {r.other} · {r.kind} · {STRENGTH_LABEL[r.strength] ?? `${r.strength}/5`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">还没有</p>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      {tab === 'places' && (
        <PlaceList
          places={places}
          scenes={scenes}
          spaceId={spaceId}
          onCreate={(name, kind) => {
            void (async () => {
              const place: Place = {
                id: repo.idGen('pl'),
                spaceId,
                name,
                kind: kind || '场所',
                oneLine: '',
                features: [],
                inventory: [],
                events: [],
                exits: [],
                parentId: null,
                interactions: [],
                coords: null,
                firstSeenSceneId: null,
                locked: {},
                supersededBy: null,
                removedAt: null,
              }
              const next = { ...canon, places: [...canon.places, place] }
              setCanon(next)
              await repo.saveCanon(spaceId, next)
              setFlash(`已加地点「${name}」`)
              setTimeout(() => setFlash(''), 2200)
            })()
          }}
          onSetParent={(id, parentId) => {
            void (async () => {
              const next = { ...canon, places: places.map((p) => (p.id === id ? { ...p, parentId } : p)) }
              setCanon(next)
              await repo.saveCanon(spaceId, next)
            })()
          }}
        />
      )}

      {tab === 'relations' && (
        <section className="panel">
          {canon.relations.length ? (
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>A</th>
                  <th>B</th>
                  <th>类型</th>
                  <th>强度</th>
                </tr>
              </thead>
              <tbody>
                {canon.relations.map((r) => (
                  <tr key={r.id}>
                    <td>{canon.cast.find((c) => c.id === r.aId)?.name ?? '（已合并）'}</td>
                    <td>{canon.cast.find((c) => c.id === r.bId)?.name ?? '（已合并）'}</td>
                    <td>{r.kind}</td>
                    <td>{STRENGTH_LABEL[r.strength] ?? `${r.strength}/5`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="muted">还没有关系</p>
          )}
        </section>
      )}

      {tab === 'facts' && (
        <section className="panel">
          <h3>已知事实（确定信息）</h3>
          {activeFacts(canon).length ? (
            <ul className="plain">
              {activeFacts(canon).map((f) => (
                <li key={f.id}>
                  <span className="tag">{f.kind}</span>
                  {f.subject} {f.predicate} {f.object}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">还没有结构化事实</p>
          )}
          {canon.facts.some((f) => f.status === 'retracted') && (
            <>
              <h3>已被改写</h3>
              <ul className="plain muted small">
                {canon.facts
                  .filter((f) => f.status === 'retracted')
                  .slice(-10)
                  .map((f) => (
                    <li key={f.id}>
                      {f.subject} {f.predicate} {f.object}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      )}

      {tab === 'objectives' && meta && (
        <>
          <ModeSwitch
            meta={meta}
            onChange={async (mode) => {
              const next = { ...meta, mode }
              setMeta(next)
              await repo.saveMeta(spaceId, next)
            }}
          />
          <ObjectiveList
            meta={meta}
            onChange={async (objectives) => {
              const next = { ...meta, objectives }
              setMeta(next)
              await repo.saveMeta(spaceId, next)
            }}
          />
          <ScheduledList
            meta={meta}
            busy={suggesting}
            onSuggest={() => void suggestEvents()}
            onChange={async (scheduled) => {
              const next = { ...meta, scheduled }
              setMeta(next)
              await repo.saveMeta(spaceId, next)
            }}
          />
        </>
      )}

      {tab === 'clues' && (
        <ClueList clues={clues} scenes={scenes} maxOpen={config.budget.maxOpenClues} />
      )}

      {merged.length > 0 && tab === 'cast' && (
        <p className="muted small">已合并 {merged.length} 个条目（原记录仍可导出）</p>
      )}

      <PersonaPicker
        open={personaOpen}
        existing={cast.map((c) => c.name)}
        onImport={importPersona}
        onClose={() => setPersonaOpen(false)}
      />
    </div>
  )
}

/** 逗号/顿号分隔的列表编辑：比"逐个加一行"省事，也够用。 */
function ListField({
  label,
  values,
  hint,
  onSave,
}: {
  label: string
  values: string[]
  hint?: string
  onSave: (values: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(values.join('、'))

  useEffect(() => {
    setDraft(values.join('、'))
  }, [values])

  if (!editing) {
    return (
      <p className="field">
        <span className="field-label">{label}</span>
        <span>{values.length ? values.join('、') : <span className="muted">—</span>}</span>
        <button className="link" onClick={() => setEditing(true)}>
          改
        </button>
      </p>
    )
  }

  const commit = () => {
    const next = draft
      .split(/[、,，]/)
      .map((v) => v.trim())
      .filter(Boolean)
    setEditing(false)
    onSave(next)
  }

  return (
    <div className="field editing">
      <span className="field-label">{label}</span>
      <input
        autoFocus
        value={draft}
        placeholder={hint}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    </div>
  )
}

function EditableField(props: {
  label: string
  value: string
  max: number
  locked?: boolean
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(props.value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setDraft(props.value)
  }, [props.value])

  if (!editing) {
    return (
      <p className="field">
        <span className="field-label">{props.label}</span>
        <span>{props.value || <span className="muted">—</span>}</span>
        {props.locked && <span className="tag">已锁定</span>}
        <button className="link" onClick={() => setEditing(true)}>
          改
        </button>
      </p>
    )
  }

  return (
    <form
      className="field editing"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSave(draft)
        setEditing(false)
      }}
    >
      <span className="field-label">{props.label}</span>
      <input value={draft} maxLength={props.max} onChange={(e) => setDraft(e.target.value)} autoFocus />
      <button className="btn" type="submit">
        保存
      </button>
      <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
        取消
      </button>
    </form>
  )
}

function PlaceList({
  places,
  scenes,
  spaceId,
  onSetParent,
  onCreate,
}: {
  places: Place[]
  scenes: Scene[]
  spaceId: string
  onSetParent: (id: string, parentId: string | null) => void
  onCreate: (name: string, kind: string) => void
}) {
  const [draft, setDraft] = useState({ name: '', kind: '场所' })
  const add = () => {
    const name = draft.name.trim()
    if (!name) return
    onCreate(name.slice(0, 20), draft.kind.trim().slice(0, 10))
    setDraft({ name: '', kind: draft.kind })
  }

  return (
    <div className="split">
      <div className="cast-side">
        <div className="row cast-side-head">
          <span className="muted small">地点（{places.length}）</span>
        </div>
        <div className="place-add">
          <input
            value={draft.name}
            maxLength={20}
            placeholder="新地点名"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <input
            value={draft.kind}
            maxLength={10}
            placeholder="类型"
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          />
          <button className="btn ghost" onClick={add} disabled={!draft.name.trim()}>
            添加
          </button>
        </div>
      {!places.length && <p className="muted small">还没有地点。上面加一个，之后写到的场景会自动挂上去。</p>}
      <ul className="list">
        {places.map((p) => (
          <li key={p.id}>
            <div className="list-item static">
              <strong>{p.name}</strong>
              <span className="muted small">
                {p.kind} · {p.events.length} 件事
              </span>
              {p.parentId && (
                <span className="muted small">{placePath(places, p.id)}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      </div>
      <div className="panel detail">
        {places.map((p) => (
          <div key={p.id} className="place-block">
            <h3>
              {placePath(places, p.id)}（{p.kind}）
            </h3>
            <p className="muted small">{p.oneLine || '—'}</p>
            <ArtBlock
              spaceId={spaceId}
              kind="place"
              id={p.id}
              prompt={placePrompt(p)}
              size="1024x768"
              label="场景图"
              defaultOpen
              className="detail-art"
            />
            <div className="field">
              <span className="field-label">属于</span>
              <select
                className="select"
                value={p.parentId ?? ''}
                onChange={(e) => onSetParent(p.id, e.target.value || null)}
              >
                <option value="">（顶层地点）</option>
                {places
                  .filter((x) => x.id !== p.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
              <span className="muted small">房间属于建筑时挂上，位置会显示成「建筑 / 房间」</span>
            </div>
            {p.features.length > 0 && <p className="small">特征：{p.features.join('、')}</p>}
            {p.inventory.length > 0 && <p className="small">陈设：{p.inventory.join('、')}</p>}
            {p.events.length > 0 && (
              <ol className="arc">
                {p.events.map((e, i) => (
                  <li key={i}>
                    {e.text}
                    <span className="muted small"> · 第 {scenes.find((s) => s.id === e.sceneId)?.index ?? '?'} 幕</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ModeSwitch({
  meta,
  onChange,
}: {
  meta: SpaceMeta
  onChange: (mode: SpaceMode) => Promise<void>
}) {
  const free = meta.mode === 'free'
  return (
    <section className="panel">
      <h3>节奏</h3>
      <div className="seg">
        <button
          className={free ? 'seg-item' : 'seg-item active'}
          onClick={() => void onChange('goal')}
        >
          有终点（解谜）
        </button>
        <button
          className={free ? 'seg-item active' : 'seg-item'}
          onClick={() => void onChange('free')}
        >
          自由写作
        </button>
      </div>
      <p className="muted small">
        {free
          ? '自由写作：不催收线索、不推进度、不出现「写结局」。已写的内容不受影响。'
          : '有终点：追踪目标，积压线索时会催收，主目标达成后可写结局。'}
      </p>
    </section>
  )
}

function ScheduledList({
  meta,
  onChange,
  busy,
  onSuggest,
}: {
  meta: SpaceMeta
  onChange: (scheduled: ScheduledEvent[]) => Promise<void>
  busy: boolean
  onSuggest: () => void
}) {
  const [draft, setDraft] = useState('')
  const [at, setAt] = useState('')
  const nextIndex = meta.sceneCount

  const add = () => {
    const text = draft.trim().slice(0, 80)
    const index = Number(at)
    if (!text || !Number.isFinite(index) || index < 0) return
    setDraft('')
    setAt('')
    void onChange([
      ...meta.scheduled,
      {
        id: `ev_${Date.now()}`,
        atSceneIndex: Math.round(index),
        text,
        fired: false,
        origin: 'user',
      },
    ])
  }

  return (
    <section className="panel">
      <h3>
        固定事件
        <button className="link tiny" disabled={busy} onClick={onSuggest} title="让模型按主线想三个节拍">
          {busy ? '想…' : 'AI 想三个'}
        </button>
      </h3>
      <p className="muted small">
        在第 N 幕强制发生某件事。过了那一幕不补——补会打乱已经写好的时间线。
        自动生成的是草稿，落地前可以改期或删掉。
      </p>

      {meta.scheduled.length ? (
        <ul className="plain objective-edit">
          {meta.scheduled
            .slice()
            .sort((a, b) => a.atSceneIndex - b.atSceneIndex)
            .map((e) => {
              const missed = !e.fired && e.atSceneIndex < nextIndex
              return (
                <li key={e.id} className={e.fired ? 'objective done' : 'objective'}>
                  <span className="objective-mark">{e.fired ? '✓' : missed ? '！' : '○'}</span>
                  <span className="objective-text">
                    <span className="muted small">第 {e.atSceneIndex + 1} 幕 · </span>
                    {e.text}
                    {missed && <span className="tag dead">错过</span>}
                  </span>
                  <span className="objective-ops">
                    <button
                      className="link"
                      onClick={() =>
                        void onChange(
                          meta.scheduled.map((x) =>
                            x.id === e.id ? { ...x, atSceneIndex: nextIndex, fired: false } : x,
                          ),
                        )
                      }
                      title="挪到下一幕"
                    >
                      改期
                    </button>
                    <button
                      className="link"
                      onClick={() => void onChange(meta.scheduled.filter((x) => x.id !== e.id))}
                    >
                      删
                    </button>
                  </span>
                </li>
              )
            })}
        </ul>
      ) : (
        <p className="muted">还没有固定事件。</p>
      )}

      <div className="row objective-add">
        <input
          className="event-at"
          type="number"
          min={1}
          value={at}
          placeholder="幕"
          onChange={(e) => setAt(e.target.value)}
        />
        <input
          value={draft}
          maxLength={80}
          placeholder="必须发生什么，例：凌晨四点码头的灯灭了"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn ghost small-btn" onClick={add} disabled={!draft.trim() || !at}>
          加一条
        </button>
      </div>
    </section>
  )
}

const OBJ_STATUS_LABEL = { active: '进行中', done: '已达成', failed: '已失败' } as const

function ObjectiveList({
  meta,
  onChange,
}: {
  meta: SpaceMeta
  onChange: (objectives: Objective[]) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const patch = (id: string, next: Partial<Objective>) =>
    onChange(meta.objectives.map((o) => (o.id === id ? { ...o, ...next } : o)))

  const add = () => {
    const text = draft.trim().slice(0, 60)
    if (!text) return
    setDraft('')
    void onChange([
      ...meta.objectives,
      {
        id: `ob_${Date.now()}`,
        text,
        kind: meta.objectives.some((o) => o.kind === 'main') ? 'side' : 'main',
        status: 'active',
        atSceneId: null,
        origin: 'user',
      },
    ])
  }

  const remove = (id: string) => onChange(meta.objectives.filter((o) => o.id !== id))

  return (
    <section className="panel">
      <h3>目标</h3>
      <p className="muted small">
        主目标达成后，编织台会出现「写结局」——故事不会无限推下去。
      </p>

      {meta.objectives.length ? (
        <ul className="plain objective-edit">
          {meta.objectives.map((o) => (
            <li key={o.id} className={o.status === 'done' ? 'objective done' : 'objective'}>
              <button
                className="objective-mark"
                title={o.status === 'done' ? '标记为未完成' : '标记为已达成'}
                onClick={() =>
                  void patch(o.id, {
                    status: o.status === 'done' ? 'active' : 'done',
                    atSceneId: o.status === 'done' ? null : o.atSceneId,
                  })
                }
              >
                {o.status === 'done' ? '✓' : '○'}
              </button>

              {editing === o.id ? (
                <input
                  autoFocus
                  value={editText}
                  maxLength={60}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => {
                    void patch(o.id, { text: editText.trim() || o.text })
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
              ) : (
                <span className="objective-text">
                  {o.kind === 'main' && <span className="tag main">主线</span>}
                  {o.text}
                  <span className="muted small"> · {OBJ_STATUS_LABEL[o.status]}</span>
                </span>
              )}

              <span className="objective-ops">
                <button
                  className="link"
                  onClick={() => {
                    setEditing(o.id)
                    setEditText(o.text)
                  }}
                >
                  改
                </button>
                <button className="link" onClick={() => void remove(o.id)}>
                  删
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">还没有目标。加一条，故事才有终点。</p>
      )}

      <div className="row objective-add">
        <input
          value={draft}
          maxLength={60}
          placeholder="要做什么，例：找到初七夜那条船的船老大"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button className="btn ghost small-btn" onClick={add} disabled={!draft.trim()}>
          加一条
        </button>
      </div>
    </section>
  )
}

function ClueList({
  clues,
  scenes,
  maxOpen,
}: {
  clues: Clue[]
  scenes: Scene[]
  maxOpen: number
}) {
  const open = clues.filter((c) => c.status === 'open')
  const resolved = clues.filter((c) => c.status === 'resolved')
  const dropped = clues.filter((c) => c.status === 'dropped')
  const sceneIndexOf = (id: string | null) => scenes.find((s) => s.id === id)?.index
  const latest = scenes.length ? scenes[scenes.length - 1].index : 0

  // 按归属分组：和 prompt 里给模型看到的是同一套结构，
  // 玩家翻档案时才能判断「这条到底服务于谁、是不是该收了」
  const groups = new Map<string, Clue[]>()
  for (const c of open) {
    const label = c.thread?.label || '主线'
    const bucket = groups.get(label)
    if (bucket) bucket.push(c)
    else groups.set(label, [c])
  }

  return (
    <section className="panel">
      <h3>
        未收（{open.length} / 上限 {maxOpen}）
      </h3>
      {open.length >= maxOpen ? (
        <div className="notice warn">
          已经满了，下一幕不会再记新线索——需要你在正文里解答其中一条，它才会被收掉。
        </div>
      ) : open.length >= 8 ? (
        <div className="notice warn">
          线索积压得有点多。故事里每解答一条，档案就会自动把它标成已收。
        </div>
      ) : null}
      {open.length ? (
        <div className="clue-groups">
          {[...groups.entries()].map(([label, list]) => (
            <div key={label} className="clue-group">
              <h4>{label}</h4>
              <ul className="plain">
                {list.map((c) => {
                  const at = sceneIndexOf(c.sceneId)
                  const age = at === undefined ? null : latest - at
                  return (
                    <li key={c.id} className="clue-item">
                      <span className="clue-unknown">
                        {c.unknown || c.text}
                        {c.migrated && <em className="clue-migrated">补一个问题</em>}
                      </span>
                      {c.known && <span className="clue-known">已知：{c.known}</span>}
                      <span className="muted small">
                        {' '}
                        · 第 {(at ?? 0) + 1} 幕开
                        {age !== null && age >= 12 ? ' · 悬了很久' : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">没有悬着的线索</p>
      )}
      <h3>已收（{resolved.length}）</h3>
      {resolved.length ? (
        <ul className="plain muted">
          {resolved.map((c) => (
            <li key={c.id}>
              {c.unknown || c.text}
              <span className="small">
                {' '}
                · 第 {(sceneIndexOf(c.resolvedAtSceneId) ?? 0) + 1} 幕收
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">还没有收过</p>
      )}
      {dropped.length > 0 && (
        <>
          <h3>已放下（{dropped.length}）</h3>
          <p className="muted small">悬了 12 幕以上、剧里没再提，也不是被解答——想捡回来可以手动改成未收。</p>
          <ul className="plain muted">
            {dropped.map((c) => (
              <li key={c.id}>
                {c.unknown || c.text}
                <span className="small"> · 第 {(sceneIndexOf(c.sceneId) ?? 0) + 1} 幕开</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
