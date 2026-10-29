/** 时间线：每幕一句话，可回到任意一幕。 */

import { useCallback, useEffect, useState } from 'react'
import { rollbackTo } from '../../app/rollback'
import { revertScene, rewriteScene, type RewriteMode } from '../../app/rewriteScene'
import { toUserMessage } from '../../domain/errors'
import type { Scene, SceneAction, SpaceMeta } from '../../domain/types'
import { navigate } from '../router'
import { useApp } from '../store'

interface Row {
  scene: Scene
  text: string
  /** 有旧版 = 这一段被改写/编辑过，可以撤销一步 */
  hasOld: boolean
}

const ACTION_LABEL: Record<SceneAction['kind'], string> = {
  option: '选择',
  random: '随机',
  free: '自述',
  continue: '续写',
}

export function Timeline({ spaceId }: { spaceId: string }) {
  const { repo, rewriter, archivist, narrator, config } = useApp()
  const [meta, setMeta] = useState<SpaceMeta | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [m, scenes] = await Promise.all([repo.loadMeta(spaceId), repo.listScenes(spaceId)])
    setMeta(m)
    setRows(
      await Promise.all(
        scenes
          .filter((s) => s.status === 'committed' || s.status === 'orphan')
          .map(async (scene) => ({
          scene,
          text: await repo.loadText(spaceId, scene.id),
          hasOld: (await repo.loadTextOld(spaceId, scene.id)) !== null,
        })),
      ),
    )
  }, [repo, spaceId])

  useEffect(() => {
    void load().catch((e) => setError(toUserMessage(e)))
  }, [load])

  const deps = { repo, rewriter, archivist, narrator, config, now: () => Date.now(), rand: Math.random }

  const doRewrite = async (row: Row, mode: RewriteMode) => {
    setBusy(true)
    setError('')
    setFlash('')
    try {
      const result = await rewriteScene(deps, {
        spaceId,
        sceneId: row.scene.id,
        mode: mode === 'compress' ? 'compress' : 'rewrite',
      })
      await load()
      setFlash(
        `${mode === 'compress' ? '已压缩' : '已重写'}：${result.before} → ${result.after} 字` +
          (result.archived ? '，档案已重新整理' : '，档案稍后整理'),
      )
      window.setTimeout(() => setFlash(''), 3200)
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const doRevert = async (row: Row) => {
    setBusy(true)
    setError('')
    try {
      await revertScene(deps, { spaceId, sceneId: row.scene.id })
      await load()
      setFlash('已撤销上一次改写')
      window.setTimeout(() => setFlash(''), 2600)
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const rollback = async (row: Row) => {
    const ok = window.confirm(
      `回到第 ${row.scene.index + 1} 幕？\n\n后面的 ${rows.filter((r) => r.scene.index > row.scene.index).length} 幕会被**删除**（正文、档案改动一起清）。想留底稿先导出存档。`,
    )
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const result = await rollbackTo(repo, spaceId, row.scene.id, Date.now())
      if (!result.restored) {
        setError(result.warnings.join('；'))
      } else {
        setFlash(
          `已回到第 ${row.scene.index + 1} 幕：从「${result.fromSnapshot}」起算，重放 ${result.replayed} 份补丁，删除后移的 ${result.deleted} 幕`,
        )
        await load()
      }
    } catch (e) {
      setError(toUserMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!meta) return <div className="boot">正在铺开时间线…</div>

  const activeId = meta.activeSceneId

  return (
    <div className="page narrow timeline">
      <header className="play-head">
        <button className="link" onClick={() => navigate(`s/${spaceId}`)}>
          ← 编织台
        </button>
        <div className="play-title">
          <strong>{meta.title} · 时间线</strong>
          <span className="muted small">{rows.length} 幕</span>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}
      {flash && <div className="notice ok">{flash}</div>}

      {rows.length === 0 ? (
        <div className="empty">
          <p className="empty-title">还没有时间线</p>
          <p className="muted">推一幕之后，这里会出现一句话摘要。</p>
        </div>
      ) : (
        <ol className="beats">
          {rows.map((row) => {
            const isCurrent = row.scene.id === activeId
            const isOrphan = row.scene.status === 'orphan'
            return (
              <li key={row.scene.id} className={isOrphan ? 'beat orphan' : isCurrent ? 'beat current' : 'beat'}>
                <span className="beat-index">{row.scene.index + 1}</span>
                <div className="beat-body">
                  <p>{row.scene.summary || '（这一幕没有摘要）'}</p>
                  {row.scene.action && (
                    <p className="beat-action">
                      {ACTION_LABEL[row.scene.action.kind] ?? '行动'}：{row.scene.action.text}
                    </p>
                  )}
                  <span className="muted small">
                    {row.scene.textChars} 字
                    {row.scene.clues.length > 0 && ` · 伏笔 ${row.scene.clues.length}`}
                    {isOrphan && ' · 未采用分支'}
                    {isCurrent && ' · 当前'}
                  </span>
                </div>
                {!isOrphan && (
                  <span className="beat-ops">
                    <button
                      className="link"
                      disabled={busy}
                      title="压到大约一半字数，情节不变"
                      onClick={() => void doRewrite(row, 'compress')}
                    >
                      压缩
                    </button>
                    <button
                      className="link"
                      disabled={busy}
                      title="同一段换一种写法，情节不变"
                      onClick={() => void doRewrite(row, 'rewrite')}
                    >
                      重写
                    </button>
                    {row.hasOld && (
                      <button className="link" disabled={busy} onClick={() => void doRevert(row)}>
                        撤销
                      </button>
                    )}
                  </span>
                )}
                {!isOrphan && !isCurrent && (
                  <button className="btn ghost small-btn" disabled={busy} onClick={() => void rollback(row)}>
                    回到这里
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <p className="muted small">
        回退会把档案恢复到那一幕结束时的状态（每 10 幕留一份快照 + 重放补丁），
        后面写过的不删除，只标为未采用分支，导出时仍保留。
      </p>
    </div>
  )
}
