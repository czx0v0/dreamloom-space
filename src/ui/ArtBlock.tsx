/**
 * 生成图区块：一张图 + 「生成 / 重画 / 删除」。
 *
 * 收起时不读库也不渲染图片——一屏 25 幕全展开会一次性把几十张
 * 几百 KB 的 data URL 塞进 DOM，手机上直接卡死。
 */

import { useEffect, useState } from 'react'
import { drawArt } from '../app/art'
import { toUserMessage } from '../domain/errors'
import type { Art, ArtKind } from '../domain/types'
import { useApp } from './store'

interface Props {
  spaceId: string
  kind: ArtKind
  id: string
  /** 画面描述；为空时只显示占位，不提供生成 */
  prompt: string
  size?: string
  label?: string
  /** 封面、立绘这类一屏只有一个的，默认展开 */
  defaultOpen?: boolean
  className?: string
}

export function ArtBlock({
  spaceId,
  kind,
  id,
  prompt,
  size = '1024x1024',
  label = '配图',
  defaultOpen = false,
  className = '',
}: Props) {
  const { repo, media, config, provider } = useApp()
  const [open, setOpen] = useState(defaultOpen)
  const [art, setArt] = useState<Art | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 身份 = kind:id。切换人物/地点时必须重新读图：
  // 早前只在首次挂载时读一次，结果换一个人还显示上一个人的立绘（"所有人都是主角"）。
  const identity = `${kind}:${id}`
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoaded(false)
    setArt(null)
    setError('')
    void repo
      .loadArt(spaceId, kind, id)
      .then((a) => {
        if (!alive) return
        setArt(a ?? null)
        setLoaded(true)
      })
      .catch(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo, spaceId, identity])

  // 站点自带图能力，或用户自己配了多模态接口，才显示入口；
  // 否则按钮点下去只会收到「这个接口不支持生图」。
  const enabled = config.features.image && (config.media.image || Boolean(provider.mediaBase))

  if (!enabled) return null

  if (!open) {
    return (
      <button className={`link tiny ${className}`} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }

  const generate = async (force: boolean) => {
    setBusy(true)
    setError('')
    try {
      const res = await drawArt(
        { repo, media, now: () => Date.now() },
        { spaceId, kind, id, prompt, size, force },
      )
      setArt(res.art)
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await repo.deleteArt(spaceId, kind, id)
      setArt(null)
    } catch (e) {
      setError(toUserMessage(e))
    }
  }

  return (
    <figure className={`art-block ${className}`}>
      {art ? (
        <img src={art.dataUrl} alt={label} loading="lazy" />
      ) : (
        <div className="art-empty">
          {loaded ? '还没有图' : '读取中…'}
          {prompt && <span className="art-prompt">{prompt.slice(0, 90)}…</span>}
        </div>
      )}

      {error && <div className="notice error small">{error}</div>}

      <figcaption className="art-ops">
        <button
          className="btn ghost small-btn"
          disabled={busy || !prompt}
          onClick={() => void generate(Boolean(art))}
        >
          {busy ? '画中…' : art ? '重画' : '生成这张图'}
        </button>
        {art && (
          <button className="link tiny" onClick={() => void remove()} disabled={busy}>
            删除
          </button>
        )}
        {!defaultOpen && (
          <button className="link tiny" onClick={() => setOpen(false)} disabled={busy}>
            收起
          </button>
        )}
      </figcaption>
    </figure>
  )
}
