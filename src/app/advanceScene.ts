/**
 * 推进一幕：整个产品的核心编排。
 *
 * 顺序不可调换：
 *   装配上下文 → 流式叙事 → 审计（纯函数）→ 必要时重写一次 → 提交场景
 *   → 立刻发起抽取（不挡 UI）→ 幕间最多等 8 秒 → 解禁下一幕
 *
 * 两个必须守住的点：
 *  1. `aborted` 的场景永不落正文、永不抽取
 *  2. 抽取失败不阻塞下一幕，但水位（archiveWatermark）不前进
 */

import { makeId } from '../domain/ids'
import { DomainError, ERR } from '../domain/errors'
import {
  countChars,
  fallbackChoices,
  isLikelyRepeat,
  parseChoiceLabel,
  parseNarration,
} from '../domain/scene'
import { auditScene, hasBlockingIssue, type AuditIssue } from '../domain/audit'
import { parseTriage } from '../domain/triage'
import { checkDirective, rollCheck } from '../domain/check'
import { applyPatch } from '../domain/patch'
import { mentionCast, proposeMerges } from '../domain/entity'
import type { ArchiveRequest } from '../agents/contracts'
import type { ArchivistPort, NarratorPort, TriagePort } from '../agents/ports'
import type {
  CanonState,
  CastMember,
  Clue,
  Objective,
  PatchRecord,
  Scene,
  SceneAction,
  SpaceMeta,
} from '../domain/types'
import type { SpaceRepo } from '../store/repo'
import type { ClientConfig } from './config'
import { resolvePov } from '../domain/pov'
import { createSceneStream } from '../domain/stream'
import { buildPack } from './pack'
import { snapshotCanon } from './rollback'

export type Stage = 'narrating' | 'auditing' | 'committing' | 'archiving' | 'idle'

export interface AdvanceDeps {
  repo: SpaceRepo
  narrator: NarratorPort
  archivist: ArchivistPort
  /** 可选：收线判定。不传就退化为「只开不收」，测试与旧调用方不受影响 */
  triage?: TriagePort
  config: ClientConfig
  now: () => number
  rand: () => number
}

export interface AdvanceOptions {
  spaceId: string
  action: SceneAction
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onStage?: (stage: Stage) => void
  /** 非致命提示（如上游重试），用于让用户知道「在动，只是不稳」 */
  onNotice?: (notice: { code: string; attempt?: number; maxAttempts?: number }) => void
  /** 写结局：不给选项、篇幅更长、写完后锁盘 */
  finale?: boolean
}

export interface AdvanceResult {
  scene: Scene
  text: string
  issues: AuditIssue[]
  dropped: string[]
  archiveStatus: 'applied' | 'failed' | 'skipped'
  /** 与上一段几乎一样（重写一次后仍然如此） */
  repeated: boolean
}

const ARCHIVE_WAIT_MS = 8000

export async function advanceScene(
  deps: AdvanceDeps,
  opts: AdvanceOptions,
): Promise<AdvanceResult> {
  const { repo, config, now } = deps
  const idGen = (prefix: string) => makeId(prefix, now(), deps.rand)

  opts.onStage?.('narrating')
  let allScenes = await repo.listScenes(opts.spaceId)
  // 旧版回退会留下 orphan 幕，它们占着 index 会让新幕编号跳号：进入推进时顺手清掉，
  // 并把 sceneCount 校正成"真正写了几幕"（旧存档的 sceneCount 可能停在更大的数上）。
  if (allScenes.some((s) => s.status === 'orphan')) {
    const lastCommitted = allScenes.filter((s) => s.status === 'committed').pop()
    const kept = (lastCommitted?.index ?? -1) + 1
    await repo.deleteScenesAfter(opts.spaceId, lastCommitted?.index ?? -1)
    const stale = await repo.loadMeta(opts.spaceId)
    if (stale.sceneCount !== kept) await repo.saveMeta(opts.spaceId, { ...stale, sceneCount: kept })
    allScenes = await repo.listScenes(opts.spaceId)
  }
  const meta = await repo.loadMeta(opts.spaceId)
  const canon = await repo.loadCanon(opts.spaceId)
  const scenes = allScenes.filter((s) => s.status === 'committed')

  const texts: Record<string, string> = {}
  for (const scene of scenes.slice(-Math.max(3, config.budget.recentSummaries))) {
    texts[scene.id] = await repo.loadText(opts.spaceId, scene.id)
  }

  // 结局比普通幕长：它要把所有线索收掉，200 字写不完
  const finale = opts.finale === true
  if (meta.endedAt && !finale) {
    throw new DomainError(ERR.BAD_REQUEST, '这个故事已经写完了。可以看档案、导出，或者回到某一幕重写。')
  }

  const target = finale
    ? { min: 400, max: 700 }
    : (config.presets[meta.settings.charPreset] ?? config.presets.medium)

  // 判定必须在装配上下文之前定下来：模型拿到的不是"你试着做"，而是"结果是这样"
  const action: SceneAction = { ...opts.action }
  if (action.attempt && !action.check) {
    const protag = canon.cast.find((c) => c.id === meta.protagId)
    const lastCommitted = scenes[scenes.length - 1]
    const support = (lastCommitted?.participants ?? []).filter((id) => id !== meta.protagId).length
    action.check = rollCheck({
      attempt: action.attempt,
      abilities: protag?.abilities ?? [],
      support,
      rand: deps.rand,
    })
  }
  /**
   * 玩家点「追这条」时，行动文本是 `追查：<问题>`。
   *
   * 只靠校对判定收线太被动——实测经常"追了半天没下文"，玩家会以为这个按钮没用。
   * 所以这里加一条硬要求：这一幕必须正面回答它（或明确证伪），不许只写"更接近了"。
   * 收没收仍然由正文与校对决定，不是"点了就算收"。
   */
  const pursueTarget = /^追查[：:]\s*(.+)$/.exec(action.text.trim())?.[1]
  const pursueClue = pursueTarget
    ? scenes
        .flatMap((sc) => sc.clues)
        .filter((c) => c.status === 'open')
        .find((c) => {
          const q = c.unknown || c.text
          return q.includes(pursueTarget.slice(0, 10)) || pursueTarget.includes(q.slice(0, 10))
        })
    : undefined
  const pursueDirective = pursueClue
    ? `【本幕要求】玩家明确在追这条未收问题：「${pursueClue.unknown || pursueClue.text}」。\n` +
      '这一幕必须给出明确答案（是谁 / 为什么 / 在哪），或者明确证伪这条猜测；' +
      '不要只写成"又近了一步""似乎有眉目"。'
    : ''

  const actionText = [
    action.text,
    action.check ? checkDirective(action.check) : '',
    pursueDirective,
  ]
    .filter(Boolean)
    .join('\n\n')

  const pack = buildPack({ meta, canon, scenes, texts, action: actionText }, config)

  // 视角决定「玩家的行动算谁的动作」，两处调用（首发与重写）必须一致
  const { pov, protagName } = resolvePov(meta.pov, meta.protagId, canon.cast)

  const first = await runNarration(deps, {
    sections: pack.sections,
    target,
    choiceCount: finale ? 0 : meta.settings.choiceCount,
    temperature: meta.settings.temperature,
    pov,
    protagName,
    finale,
    signal: opts.signal,
    onDelta: opts.onDelta,
    onNotice: opts.onNotice,
  })

  opts.onStage?.('auditing')
  const target2 = target
  const auditCtx = {
    deadNames: canon.cast.filter((c) => c.status === 'dead').map((c) => c.name),
    knownNames: canon.cast.filter((c) => c.removedAt === null).map((c) => c.name),
    actionVerbs: configVerbs(config),
    target: target2,
  }
  let issues = auditScene(first.text, auditCtx)
  let finalText = first.text
  let choices = first.choices

  // 下一幕的编号 = 已提交幕里最大的 index + 1，而不是"幕数"。
  // 两者在正常数据上等价；但旧存档/异常回退可能留下空洞或重复索引，
  // 用长度会撞号或跳号（玩家看到的就是"回退到第 1 幕，下一幕成了第 3 幕"）。
  const nextIndex = scenes.length ? Math.max(...scenes.map((s) => s.index)) + 1 : 0

  const previousText = scenes.length ? texts[scenes[scenes.length - 1].id] ?? '' : ''
  const repeatedFirst = isLikelyRepeat(previousText, first.text)

  // 只在「已死亡角色行动」或「与上一段几乎相同」时重写一次，其余只提示
  if ((hasBlockingIssue(issues) || repeatedFirst) && !opts.signal?.aborted) {
    const notes: string[] = []
    if (hasBlockingIssue(issues)) {
      const blocking = issues
        .filter((i) => i.severity === 'block')
        .map((i) => i.message)
        .join('；')
      notes.push(`${blocking}。不要让已死亡角色出场或说话`)
    }
    if (repeatedFirst) {
      notes.push('这一版与上一段几乎完全相同，必须换一个写法，从新的细节或新的动作切入，不要复述上文')
    }
    const second = await runNarration(deps, {
      sections: {
        ...pack.sections,
        action: `${opts.action.text}\n\n（上一版有问题，请重写：${notes.join('；')}。）`,
      },
      target,
      choiceCount: meta.settings.choiceCount,
      // 因「重复」而重写时必须**升温**：降温只会让它更确定地再复读一遍。
      // 因审计硬错误而重写才略降温，让措辞更保守。
      temperature: repeatedFirst
        ? Math.min(1.2, meta.settings.temperature + 0.15)
        : Math.max(0, meta.settings.temperature - 0.1),
      pov,
      protagName,
      finale,
      signal: opts.signal,
      onDelta: opts.onDelta,
      onNotice: opts.onNotice,
    })
    finalText = second.text
    choices = second.choices
    issues = auditScene(finalText, auditCtx)
  }

  const repeated = isLikelyRepeat(previousText, finalText)

  /**
   * 空正文必须拦住。
   *
   * 之前这里直接提交，于是模型返回空内容（内容过滤 / 上游截断 / 流中断）时，
   * 会存下一条 committed 但正文为空的幕；而 fallbackChoices 还会补上两条通用选项，
   * 让失败看起来像成功。用户看到的就是「有选择、没正文」。
   *
   * 30 字是保守门槛：模型偶尔会返回「（继续）」这种占位文本，长度非零但内容为零。
   */
  const stripped = finalText.replace(/\s/g, '')
  if (!opts.signal?.aborted && stripped.length < 30) {
    opts.onStage?.('idle')
    throw new DomainError(
      ERR.EMPTY_NARRATION,
      stripped.length
        ? `这次只写出来「${stripped.slice(0, 20)}」，太短了。再点一次通常就好了。`
        : undefined,
    )
  }

  // 这一幕发生在哪：先沿用上一幕，抽取拿到 move-to 后再纠正。
  // 人不会凭空移动，所以"沿用"永远比"清空"安全。
  // 第一幕没有上一幕：落在第一个地点，否则右栏整个开场都写着「位置不明」。
  const previousPlaceId = scenes.length
    ? (scenes[scenes.length - 1].placeId ?? null)
    : (canon.places.find((p) => p.removedAt === null)?.id ?? null)

  if (opts.signal?.aborted) {
    const aborted = buildScene({
      id: idGen('sc'),
      spaceId: opts.spaceId,
      index: nextIndex,
      action,
      text: finalText,
      choices,
      placeId: previousPlaceId,
      participants: [],
      model: config.model,
      status: 'aborted',
      now: now(),
    })
    await repo.saveScene(opts.spaceId, aborted, finalText)
    opts.onStage?.('idle')
    return {
      scene: aborted,
      text: finalText,
      issues,
      dropped: pack.dropped,
      archiveStatus: 'skipped',
      repeated,
    }
  }

  opts.onStage?.('committing')
  const participants = mentionCast(canon.cast, finalText)
  const scene = buildScene({
    id: idGen('sc'),
    spaceId: opts.spaceId,
    index: nextIndex,
    action,
    text: finalText,
    placeId: previousPlaceId,
    choices,
    participants,
    model: config.model,
    status: 'committed',
    now: now(),
  })
  await repo.saveScene(opts.spaceId, scene, finalText)

  // 抽取不挡 UI，但幕间最多等 8 秒
  opts.onStage?.('archiving')
  let archiveStatus: AdvanceResult['archiveStatus'] = 'skipped'
  try {
    // 全局未收线索：用于上限与跨幕去重，不能只看本幕
    const openClues = scenes
      .flatMap((sc) => sc.clues)
      .filter((c) => c.status === 'open')
      .concat(scene.clues.filter((c) => c.status === 'open'))

    // 收线判定与抽取并行：它只读正文与旧问题，不依赖抽取结果。
    // 超时/失败都只是「这次没收线」，不影响正文与档案。
    const livePlaces = canon.places.filter((p) => p.removedAt === null)
    const placeNames = livePlaces.map((p) => p.name)
    let triagedPlaceId: string | null = null

    const triageTask =
      deps.triage && openClues.length >= 1
        ? (() => {
            const pool = openClues.slice(-12)
            return withTimeout(
              deps.triage
                .triage({
                  sceneText: finalText,
                  clues: pool.map((c, i) => ({ n: i + 1, text: c.text })),
                  places: placeNames,
                })
                .then(async (res) => {
                  const outcome = parseTriage(res.text, pool, finalText, placeNames)
                  if (outcome.ids.length) {
                    await repo.resolveClues(opts.spaceId, outcome.ids, scene.id)
                  }
                  if (outcome.place) {
                    triagedPlaceId = livePlaces.find((p) => p.name === outcome.place)?.id ?? null
                  }
                }),
              6000,
            ).catch(() => null)
          })()
        : null

    const archived = await withTimeout(
      archiveScene(deps, meta, canon, scene, finalText, openClues),
      ARCHIVE_WAIT_MS,
    )
    await triageTask
    if (archived) {
      scene.summary = archived.summary
      scene.clues = archived.clues
      scene.patchId = archived.patchId
      scene.archivedAt = now()
      // 玩家选了「去三号仓库」就必须真的到那儿：位置由 move-to 决定。
      // move-to 漏抽时用校对结果兜底——否则正文写着"回客栈"，右栏还停在仓库。
      if (archived.placeId) scene.placeId = archived.placeId
      else if (triagedPlaceId) scene.placeId = triagedPlaceId
      archiveStatus = 'applied'
    }
  } catch {
    archiveStatus = 'failed'
  }
  await repo.saveScene(opts.spaceId, scene, finalText)
  // 久悬的线索自动放下：账本不能永远封顶（12 条待答问题读起来像没人在推进）
  await repo.expireClues(opts.spaceId, scene.index, 12).catch(() => 0)

  // 结局写完即锁盘：锁的是"继续推进"，数据仍然可看可导出可回退
  if (finale) {
    const latest = await repo.loadMeta(opts.spaceId)
    if (!latest.endedAt) {
      await repo.saveMeta(opts.spaceId, {
        ...latest,
        endedAt: now(),
      })
    }
  }

  opts.onStage?.('idle')

  // 每 10 幕留一份档案快照：回退靠它 + 补丁重放，才能精确还原到任意一幕
  if ((scene.index + 1) % 10 === 0) {
    const latestMeta = await repo.loadMeta(opts.spaceId)
    const latestCanon = await repo.loadCanon(opts.spaceId)
    await snapshotCanon(repo, opts.spaceId, latestMeta, latestCanon, scene.index)
  }

  return { scene, text: finalText, issues, dropped: pack.dropped, archiveStatus, repeated }
}

/**
 * `mainGoal` 与第一条 main objective 是同一件事的两种粒度，必须同步。
 * 不同步就会出现「大纲说查父亲死因，目标列表说找到船老大」这种两套真相。
 */
function syncMainGoal(current: string, objectives?: Objective[]): string {
  if (!objectives) return current
  return objectives.find((o) => o.kind === 'main')?.text ?? current
}

function configVerbs(config: ClientConfig): string[] {
  // 动词表放在服务端 YAML，前端通过 config 拿到；拿不到时用保守默认值
  const maybe = (config as unknown as { actionVerbs?: string[] }).actionVerbs
  return maybe?.length ? maybe : ['说', '道', '走', '笑', '转身', '回答']
}

function buildScene(input: {
  id: string
  spaceId: string
  index: number
  action: SceneAction
  text: string
  choices: Scene['choices']
  /** 这一幕发生在哪：本条 move-to 的目标 → 上一幕的地点 → null */
  placeId: string | null
  participants: string[]
  model: string
  status: Scene['status']
  now: number
}): Scene {
  return {
    id: input.id,
    spaceId: input.spaceId,
    index: input.index,
    status: input.status,
    action: input.action,
    choices: input.choices,
    placeId: input.placeId,
    participants: input.participants,
    summary: null,
    clues: [],
    textChars: countChars(input.text),
    model: input.model,
    inTok: 0,
    outTok: 0,
    committedAt: input.status === 'committed' ? input.now : null,
    archivedAt: null,
    patchId: null,
  }
}

interface NarrationInput {
  sections: Record<string, string>
  target: { min: number; max: number }
  choiceCount: number
  temperature: number
  pov: 'first' | 'third' | 'watcher'
  protagName: string | null
  finale?: boolean
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onNotice?: (notice: { code: string; attempt?: number; maxAttempts?: number }) => void
}

async function runNarration(
  deps: AdvanceDeps,
  input: NarrationInput,
): Promise<{ text: string; choices: Scene['choices'] }> {
  const handle = deps.narrator.narrate(
    {
      runId: makeId('rn', deps.now()),
      sections: input.sections,
      target: input.target,
      choiceCount: input.choiceCount,
      temperature: input.temperature,
      pov: input.pov,
      protagName: input.protagName,
      finale: input.finale,
    },
    input.signal,
  )

  let raw = ''
  let serverChoices: string[] = []
  // 流里带着 <scene> / <choices> 结构标签，必须过滤后才给界面，
  // 否则用户会先看到 `<scene>` 四个字符，结尾再看到一串选项原文
  const stream = createSceneStream()
  for await (const event of handle.events) {
    if (event.type === 'delta') {
      raw += event.text
      const visible = stream.push(event.text)
      if (visible) input.onDelta?.(visible)
    } else if (event.type === 'done') {
      serverChoices = event.data.choices ?? []
    } else if (event.type === 'notice') {
      const code = event.data.code
      if (code === 'E_RATE_LIMITED' || code === 'E_QUOTA_EXHAUSTED') {
        throw new Error(code)
      }
      input.onNotice?.(event.data)
    }
  }

  const tail = stream.flush()
  if (tail) input.onDelta?.(tail)

  const parsed = parseNarration(raw, input.choiceCount)
  // 服务端给的是带 `[意图]` 的原始行：必须走同一个解析器，
  // 否则界面会显示成「[追问] 问阿棠…」，标签变成文案的一部分
  const fromServer = serverChoices
    .map((label) => parseChoiceLabel(label))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .slice(0, input.choiceCount)
  const choices = fromServer.length
    ? fromServer
    : parsed.choices.length
      ? parsed.choices
      : fallbackChoices(null, input.choiceCount)

  return { text: parsed.scene, choices }
}

interface Archived {
  summary: string
  clues: Scene['clues']
  patchId: string
  /** 本次抽取里 move-to 的目标；没有移动为 null */
  placeId: string | null
}

/** 抽取 + 落库。失败时抛错，由调用方决定是否推进水位。 */
export async function archiveScene(
  deps: AdvanceDeps,
  meta: SpaceMeta,
  canon: CanonState,
  scene: Scene,
  text: string,
  openClues: Clue[],
): Promise<Archived | null> {
  const { repo, archivist, now } = deps
  const request: ArchiveRequest = {
    runId: makeId('rn', now()),
    sceneId: scene.id,
    sceneText: text,
    canon: {
      cast: canon.cast
        .filter((c) => c.removedAt === null)
        .map((c) => ({ name: c.name, aliases: c.aliases, status: c.status, oneLine: c.oneLine })),
      places: canon.places
        .filter((p) => p.removedAt === null)
        .map((p) => ({ name: p.name, oneLine: p.oneLine })),
      relations: canon.relations.slice(0, 20).map((r) => ({
        a: canon.cast.find((c) => c.id === r.aId)?.name ?? '?',
        b: canon.cast.find((c) => c.id === r.bId)?.name ?? '?',
        kind: r.kind,
      })),
      // 顺序即编号：#1 是最早开的那条。patch 按同一个数组解 #n，两边不能各自排序。
      clues: openClues.slice(0, 12).map((c) => ({
        id: c.id,
        text: c.text,
        thread: c.thread?.label ?? '主线',
      })),
    },
  }

  const response = await archivist.archive(request)
  if (!response.summary && response.ops.length === 0) return null

  const idGen = (prefix: string) => makeId(prefix, now(), deps.rand)
  const outcome = applyPatch(canon, response.ops, {
    spaceId: meta.id,
    sceneId: scene.id,
    now: now(),
    existingClues: scene.clues,
    idGen,
    maxArc: deps.config.budget.maxArc,
    maxPlaceEvents: deps.config.budget.maxPlaceEvents,
    maxFacts: deps.config.budget.maxFacts,
    protagId: meta.protagId,
    existingOpenClues: openClues,
    maxOpenClues: deps.config.budget.maxOpenClues,
    objectives: meta.objectives,
  })

  const patch: PatchRecord = {
    id: idGen('pt'),
    spaceId: meta.id,
    sceneId: scene.id,
    canonRevBefore: meta.canonRev,
    canonRevAfter: meta.canonRev + 1,
    ops: response.ops,
    report: outcome.report,
    warnings: [...response.warnings, ...outcome.warnings].slice(0, 20),
    raw: '',
    createdAt: now(),
  }

  await repo.saveCanon(meta.id, outcome.state)
  await repo.savePatch(meta.id, patch)
  // 收线要落到「线索当初所在的那一幕」，否则档案页永远显示未收
  if (outcome.resolvedClueIds.length) {
    await repo.resolveClues(meta.id, outcome.resolvedClueIds, scene.id)
  }
  await repo.saveMeta(meta.id, {
    ...meta,
    // 目标只在真的变了时才回写；没有目标类 op 时 outcome.objectives 为 undefined
    objectives: outcome.objectives ?? meta.objectives,
    mainGoal: syncMainGoal(meta.mainGoal, outcome.objectives),
    canonRev: meta.canonRev + 1,
    archiveWatermark: scene.id,
    stats: {
      ...meta.stats,
      calls: meta.stats.calls + 1,
      chars: meta.stats.chars + countChars(text),
    },
  })

  const proposals = proposeMerges(outcome.state.cast, meta.id, now(), idGen)
  if (proposals.length) {
    const existing = await repo.listMergeProposals(meta.id)
    const known = new Set(existing.map((p) => `${p.aId}|${p.bId}`))
    const fresh = proposals.filter((p) => !known.has(`${p.aId}|${p.bId}`))
    if (fresh.length) await repo.saveMergeProposals(meta.id, [...existing, ...fresh])
  }

  return {
    summary: response.summary || scene.summary || '',
    clues: outcome.clues,
    patchId: patch.id,
    placeId: outcome.placeId,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 从档案里取在场人物的便捷方法，UI 用。 */
export function presentCastOf(canon: CanonState, participants: string[]): CastMember[] {
  return canon.cast.filter((c) => participants.includes(c.id))
}
