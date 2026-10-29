/**
 * 端口定义：UI 与 app 层只依赖端口，不依赖具体实现。
 * 预留能力（TTS / 图像 / 入梦）在这里先有形状，实现阶段返回 FEATURE_OFF。
 */

import type {
  ArchiveRequest,
  ArchiveResponse,
  DreamRequest,
  ImageRequest,
  NarrateDone,
  NarrateMeta,
  NarrateNotice,
  NarrateRequest,
  NarrateUsage,
  TtsRequest,
} from './contracts'

export type NarrateEvent =
  | { type: 'meta'; data: NarrateMeta }
  | { type: 'delta'; text: string }
  | { type: 'notice'; data: NarrateNotice }
  | { type: 'usage'; data: NarrateUsage }
  | { type: 'done'; data: NarrateDone }

export interface NarrateHandle {
  events: AsyncIterable<NarrateEvent>
  abort: () => void
}

export interface NarratorPort {
  narrate(req: NarrateRequest, signal?: AbortSignal): NarrateHandle
}

export interface SeedRequest {
  runId: string
  oneLine: string
  genre?: string
  tone?: string
  /**
   * 作者已经定了的事。空着就让模型自由发挥——随机性不是问题，
   * 问题是"全部随机"：主角叫什么、想干什么，玩家往往已经有想法。
   */
  hints?: { protagonist?: string; goal?: string; taboo?: string }
}

export interface SeedResponse {
  /** 模型返回的原始 JSON 文本；解析与校验在客户端 */
  text: string
  usage?: { inTok: number; outTok: number }
}

export interface RewriteRequest {
  mode: 'compress' | 'rewrite'
  text: string
  targetChars: number
}

export interface RewriteResponse {
  text: string
  usage?: { inTok: number; outTok: number }
}

export interface RewritePort {
  rewrite(req: RewriteRequest): Promise<RewriteResponse>
}

export interface SeedPort {
  generate(req: SeedRequest): Promise<SeedResponse>
}

export interface ArchivistPort {
  archive(req: ArchiveRequest): Promise<ArchiveResponse>
}

/**
 * 收线判定：这一幕回答了哪些旧问题。
 *
 * 独立于档案员——它不产出新档案，只做对账。失败/超时都只是"这次没收线"，
 * 不能影响正文提交。
 */
export interface TriageRequest {
  sceneText: string
  clues: Array<{ n: number; text: string }>
  /** 已知地点名：位置判定只认这个清单里的名字 */
  places?: string[]
}

export interface TriagePort {
  triage(req: TriageRequest): Promise<{ text: string }>
}

/** 辅助生成：给固定事件或某个角色的秘密出草稿 */
export interface SuggestPort {
  suggest(req: {
    kind: 'events' | 'hidden'
    context: { world: string; goal: string; cast: string[]; recent: string[] }
    target?: string
  }): Promise<{ text: string }>
}

/** v1 不启用（beat 由档案员顺带产出） */
export interface OutlinerPort {
  suggest(spaceId: string): Promise<{ ops: unknown[]; rationale: string }>
}

// ── 预留：媒体 ──────────────────────────────────────────

export interface VoiceProfile {
  /** 由 CastMember.voice 推导，例如「低沉/沙哑」 */
  descriptor: string
  pitch?: number
  speed?: number
}

export interface MediaPort {
  speak(req: TtsRequest): Promise<{ audioUrl: string }>
  illustrate(req: ImageRequest): Promise<{ imageUrl: string }>
}

// ── 预留：入梦（RPG 漫游） ──────────────────────────────

export interface DreamStepResult {
  narration: string
}

export interface DreamPort {
  step(req: DreamRequest): Promise<DreamStepResult>
}
