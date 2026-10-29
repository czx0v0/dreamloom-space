/**
 * Agent 契约：客户端与 `/api` 之间的唯一协议。
 * 服务端 `server/prompts.js` 按这里的字段渲染最终 prompt。
 */

import type { Choice, ClueKind, PatchOp } from '../domain/types'

// ── 叙事 ────────────────────────────────────────────────

/** 分区顺序与标题由服务端决定；客户端只负责按预算渲染内容。 */
export type NarrateSectionKey =
  | 'world'
  | 'rules'
  | 'outline'
  | 'cast'
  | 'places'
  | 'relations'
  | 'clues'
  | 'summaries'
  | 'lastTail'
  | 'action'

export type NarrateSections = Partial<Record<NarrateSectionKey, string>>

export interface NarrateRequest {
  runId: string
  sections: NarrateSections
  target: { min: number; max: number }
  choiceCount: number
  temperature: number
  /** 视角。缺省时服务端按第三人称处理。 */
  pov?: 'first' | 'third' | 'watcher'
  /** 第一人称/跟随视角下的主角名，写进 prompt。 */
  protagName?: string | null
  /** 写结局：不给选项、要求收束 */
  finale?: boolean
}

export interface NarrateMeta {
  runId: string
  model: string
}

export interface NarrateNotice {
  code: string
  dropped?: string[]
  detail?: string
}

export interface NarrateUsage {
  inTok: number
  outTok: number
}

export interface NarrateDone {
  finishReason: string | null
  chars: number
  ms: number
  /** 服务端从 <choices> 中抽出的选项；抽不出则为空数组 */
  choices: string[]
}

// ── 抽取 ────────────────────────────────────────────────

export interface ArchiveCanonCast {
  name: string
  aliases: string[]
  status: string
  oneLine: string
}

export interface ArchiveCanonPlace {
  name: string
  oneLine: string
}

export interface ArchiveCanonRelation {
  a: string
  b: string
  kind: string
}

/**
 * 给档案员看的未收线索。
 *
 * 早前这一项是缺的：档案员看不到"还有哪些问题没答"，于是只能一路开新线，
 * 而 `resolve-clue` 从来没有被调用过——不是被拒，是它根本不知道要收什么。
 * 编号 `#n` 让模型不必抄整句，回填一个数字即可，匹配失败率也随之下降。
 */
export interface ArchiveCanonClue {
  id: string
  text: string
  thread: string
}

export interface ArchiveRequest {
  runId: string
  sceneId: string
  sceneText: string
  canon: {
    cast: ArchiveCanonCast[]
    places: ArchiveCanonPlace[]
    relations: ArchiveCanonRelation[]
    clues?: ArchiveCanonClue[]
  }
}

export interface ArchiveResponse {
  summary: string
  ops: PatchOp[]
  warnings: string[]
  usage: NarrateUsage
  /** 首次解析是否失败过（用于统计 schema 有效率） */
  repaired: boolean
}

// ── 消歧（同名 / 近似名判定） ────────────────────────────

export interface DisambiguateCandidate {
  id: string
  name: string
  aliases: string[]
  oneLine: string
}

export interface DisambiguateRequest {
  runId: string
  /** 正文里出现的称呼 */
  ref: string
  /** 该称呼所在的句子，供模型判断 */
  context: string
  candidates: DisambiguateCandidate[]
}

export interface DisambiguateResponse {
  decision: 'same' | 'different' | 'unsure'
  /** decision=same 时给出匹配到的 id */
  matchedId: string | null
  reason: string
  confidence: number
}

// ── 通用 ────────────────────────────────────────────────

export interface ApiError {
  code: string
  message: string
  detail?: string
  retryAfterMs?: number
}

export interface ServerConfig {
  appName: string
  model: string
  presets: Record<string, { min: number; max: number }>
  defaultPreset: string
  choiceCount: number
  temperature: number
  features: { tts: boolean; image: boolean; dream: boolean; economy: boolean }
  limits: {
    narrateRpm: number
    structuredRpm: number
    maxConcurrency: number
    maxOutputChars: number
  }
  /** 服务端是否已配置 Key（前端据此决定要不要提示 BYOK） */
  hasServerKey: boolean
}

// ── 预留能力的签名（未实现，路由返回 501） ──────────────

export interface TtsRequest {
  text: string
  /** 由 CastMember.voice 推导 */
  voiceProfile: string
}

export interface ImageRequest {
  prompt: string
  size?: '512x512' | '1024x1024'
}

/**
 * 入梦（最小版）：文字 MUD。
 *
 * 不做坐标与地图：一句话说明"在哪、有谁、做了什么"，模型只写这一动作的直接后果。
 * 位置与人物来自主线档案，入梦不写回 canon——它是旁支，不能污染正在写的故事。
 */
export interface DreamRequest {
  placeName: string
  present: string[]
  command: string
  /** 最近几条旁白，给模型一点语感，不当作 canon */
  recent: string[]
}

// 便于跨层复用的别名
export type { Choice, ClueKind, PatchOp }
