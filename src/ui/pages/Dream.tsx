/**
 * 入梦：文字 MUD 最小版。
 *
 * 单地点、四动词、不写回主线档案——它是"钻进这个世界走两步"的旁支，
 * 一旦写回 canon 就会和正在写的故事打架。
 */

import { useEffect, useRef, useState } from 'react'
import { toUserMessage } from '../../domain/errors'
import { MUD_HELP, describeCommand, parseMudCommand } from '../../domain/mud'
import { ArtBlock } from '../ArtBlock'
import { placePrompt } from '../../domain/artPrompt'
import type { CanonState, SpaceMeta } from '../../domain/types'
import { navigate } from '../router'
import { useApp } from '../store'

interface Line {
  who: '你' | '梦'
  text: string
}

const keyOf = (spaceId: string) => `dreamloom.mud.${spaceId}`

export function Dream({ spaceId }: { spaceId: string }) {
  const { repo, config, dream } = useApp()
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [canon, setCanon] = useState<CanonState | null>(null)
  const [placeId, setPlaceId] = useState<string | null>(null)
  /** 复用主线的图：地点场景与在场人物的立绘，入梦不另外画一份 */
  const [arts, setArts] = useState<Record<string, string>>({})
  const [lines, setLines] = useState<Line[]>(() => {
    try {
      const raw = localStorage.getItem(keyOf(spaceId))
      return raw ? (JSON.parse(raw) as Line[]) : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const [m, c, scenes] = await Promise.all([
        repo.loadMeta(spaceId),
        repo.loadCanon(spaceId),
        repo.listScenes(spaceId),
      ])
      setMeta(m)
      setCanon(c)
      const all = await repo.listArt(spaceId).catch(() => [])
      setArts(Object.fromEntries(all.map((a) => [`${a.kind}:${a.id}`, a.dataUrl])))
      const last = [...scenes].reverse().find((s) => s.status === 'committed')
      setPlaceId(last?.placeId ?? c.places.find((p) => p.removedAt === null)?.id ?? null)
    })().catch((e) => setError(toUserMessage(e)))
  }, [repo, spaceId])

  useEffect(() => {
    try {
      localStorage.setItem(keyOf(spaceId), JSON.stringify(lines.slice(-40)))
    } catch {
      // 存不下就算了：入梦是临时体验，不承担存档职责
    }
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines, spaceId])

  const place = canon?.places.find((p) => p.id === placeId) ?? null
  const presentCast = (canon?.cast ?? []).filter(
    (c) => c.removedAt === null && c.status === 'alive' && c.lastSeenPlaceId === placeId,
  )
  const present = presentCast.map((c) => c.name)

  if (!config.features.dream) {
    return (
      <div className="page narrow">
        <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
          ← 回到故事
        </button>
        <div className="notice info">
          入梦没有开启。它是一项可选能力，配置里把 <code>features.dream</code> 打开即可。
        </div>
      </div>
    )
  }

  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || busy) return
    setError('')
    setInput('')
    const cmd = parseMudCommand(text)
    if (cmd.verb === 'unknown') {
      setLines((prev) => [...prev, { who: '你', text }, { who: '梦', text: MUD_HELP }])
      return
    }

    setBusy(true)
    setLines((prev) => [...prev, { who: '你', text: describeCommand(cmd, place?.name ?? '') }])
    try {
      const res = await dream.step({
        placeName: place?.name ?? '',
        present,
        command: describeCommand(cmd, place?.name ?? ''),
        recent: lines.slice(-3).map((l) => l.text),
      })
      setLines((prev) => [...prev, { who: '梦', text: res.narration || '（这一步没有回应）' }])
      // 走：目标能对上已知地点就换位置（只改入梦里的位置，不写回 canon）。
      // 对不上就留在原地——凭空造一个新地点会让下次进来时位置漂移。
      if (cmd.verb === 'go' && cmd.target && canon) {
        const target = canon.places.find(
          (p) => p.removedAt === null && (cmd.target.includes(p.name) || p.name.includes(cmd.target)),
        )
        if (target) setPlaceId(target.id)
      }
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page narrow dream">
      <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
        ← 回到故事
      </button>
      <h1>入梦</h1>
      <p className="muted small">
        {meta?.title ?? '…'} · 你现在在「{place?.name ?? '不明'}」
        {present.length ? ` · 在场：${present.join('、')}` : ''}
      </p>

      {/* 入梦直接用主线已有的图：地点场景 + 在场人物的立绘，不重复生成 */}
      {place && (
        arts[`place:${place.id}`] ? (
          <img className="dream-stage" src={arts[`place:${place.id}`]} alt={place.name} />
        ) : (
          <ArtBlock
            spaceId={spaceId}
            kind="place"
            id={place.id}
            prompt={placePrompt(place)}
            size="1024x768"
            label="给这个地点配一张图"
            defaultOpen
            className="dream-stage-empty"
          />
        )
      )}
      {presentCast.length > 0 && (
        <div className="dream-cast">
          {presentCast.map((c) =>
            arts[`cast:${c.id}`] ? (
              <figure key={c.id} className="dream-cast-item">
                <img src={arts[`cast:${c.id}`]} alt={c.name} />
                <figcaption>{c.name}</figcaption>
              </figure>
            ) : (
              <figure key={c.id} className="dream-cast-item">
                {/* 没立绘也给一个像"头像"的占位，否则一排灰字挤在一起很难看 */}
                <span className="dream-cast-placeholder" aria-hidden>
                  {c.name.slice(0, 1) || '？'}
                </span>
                <figcaption>{c.name}</figcaption>
              </figure>
            ),
          )}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      <div className="dream-log">
        {lines.length === 0 && (
          <p className="muted">
            这里可以只用四个动词走两步：看、走、说、用。写「看看柜台」「问掌柜那封信」都行。
          </p>
        )}
        {lines.map((line, i) => (
          <p key={i} className={line.who === '你' ? 'dream-you' : 'dream-narration'}>
            {line.text}
          </p>
        ))}
        <div ref={endRef} />
      </div>

      <div className="row dream-quick">
        {['看看', '走', '说', '用'].map((w) => (
          <button key={w} className="btn ghost" onClick={() => setInput(w)}>
            {w}
          </button>
        ))}
        {lines.length > 0 && (
          <button
            className="link"
            onClick={() => {
              setLines([])
              localStorage.removeItem(keyOf(spaceId))
            }}
          >
            清空
          </button>
        )}
      </div>

      <form
        className="free"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={120}
          placeholder="看看柜台 / 问掌柜那封信是谁寄的 / 推门进去"
          disabled={busy}
        />
        <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? '…' : '做'}
        </button>
      </form>
    </div>
  )
}
