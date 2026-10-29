/**
 * 领域类型：全项目唯一真源。
 * 此文件不得 import 任何东西（含 IO / React / 浏览器 API）。
 */

export type CharPreset = 'short' | 'medium' | 'long'
/**
 * 叙述视角。
 *  first   —— 我是故事里的一个人（第一人称）
 *  third   —— 第三人称，镜头跟随主角
 *  watcher —— 旁观/导演：镜头自由移动，玩家不扮演具体人物
 */
export type Pov = 'first' | 'third' | 'watcher'

export type CastRole = 'protagonist' | 'antagonist' | 'support' | 'extra'

/**
 * 还没被揭开的东西。
 *
 * 带 `revealedAt` 而不是简单布尔：`secrets` 原来只能"永不上桌"，
 * 角色一揭示秘密，档案和 prompt 就对不上。带幕号之后，
 * 「第 12 幕揭开的秘密」从第 12 幕起自动进入上下文，无需人工同步。
 */
export interface HiddenTrait {
  text: string
  /** 被哪一幕揭开；null = 还没揭开 */
  revealedAt: string | null
}
export type CastStatus = 'alive' | 'dead' | 'missing' | 'unknown'
export type ArcKind = 'turn' | 'loss' | 'gain' | 'reveal' | 'meeting'
export type FactKind = 'object' | 'state' | 'number' | 'promise' | 'place' | 'other'

export type RelKind =
  | 'kin'
  | 'ally'
  | 'rival'
  | 'enemy'
  | 'mentor'
  | 'lover'
  | 'employ'
  | 'other'

export type Strength = 1 | 2 | 3 | 4 | 5

export type SceneStatus = 'streaming' | 'committed' | 'aborted' | 'orphan'
export type ActionKind = 'option' | 'random' | 'free' | 'continue'
/**
 * 线索只有两类：悬着的问题，和不可挽回的失去。
 *
 * `fact` 与 `promise` 被移除——它们有确定答案或确定的待办，属于 `Fact` 账。
 * 两者并存会导致同一件事有两条记录，而且"事实"永远收不掉，数量只增不减。
 */
export type ClueKind = 'open-thread' | 'loss'
export type EntityKind = 'cast' | 'place'

// ── 配置 ────────────────────────────────────────────────

export interface CharRange {
  min: number
  max: number
}

export interface EconomySettings {
  enabled: boolean
  points: number
}

export interface SpaceSettings {
  charPreset: CharPreset
  temperature: number
  choiceCount: number
  recentSummaries: number
  /** 预留：点数系统，首版 enabled=false */
  economy?: EconomySettings
}

// ── 空间 ────────────────────────────────────────────────

export interface SpaceMeta {
  id: string
  v: 1
  title: string
  cover: string
  createdAt: number
  updatedAt: number
  genre: string
  tone: string
  pov: Pov
  protagId: string | null
  settings: SpaceSettings
  /** 世界铁律，进 prompt 且永不被裁剪 */
  hardRules: string[]
  /** 当前主线目标，进 outline 分区，玩家可随时改 */
  mainGoal: string
  /** 可勾选的具体目标；第一条 main 与 mainGoal 同步 */
  objectives: Objective[]
  /** 节奏约束：goal = 有终点，free = 沙盒 */
  mode: SpaceMode
  /** 固定事件，按幕序触发 */
  scheduled: ScheduledEvent[]
  /** 结局写完的时间；有值即 `closed` */
  endedAt: number | null
  sceneCount: number
  /** 每次 patch 应用后 +1 */
  canonRev: number
  activeSceneId: string | null
  /** 已成功抽取到哪一幕；抽取队列的真相 */
  archiveWatermark: string | null
  stats: SpaceStats
}

export interface SpaceStats {
  calls: number
  inTok: number
  outTok: number
  chars: number
}

/** 书架列表用的轻量条目，不读正文 */
export interface SpaceIndexEntry {
  id: string
  title: string
  cover: string
  updatedAt: number
  sceneCount: number
  genre: string
}

// ── 世界 ────────────────────────────────────────────────

export interface World {
  name: string
  era: string
  /** 这个故事要问的问题 */
  theme: string
  /** 一句话前提，进 prompt */
  premise: string
  oneLine: string
  rules: string[]
  factions: string[]
  updatedAt: number
}

// ── 人物 ────────────────────────────────────────────────

/**
 * 角色原型：跨空间复用的「这个人本来是谁」。
 * 导入到空间时是深拷贝（快照），原型后续修改不影响已有实例。
 */
export interface Persona {
  id: string
  v: 1
  name: string
  aliases: string[]
  appearance: string
  /** 一句话身份，人物库卡片与实例 oneLine 的来源 */
  oneLine: string
  personality: string[]
  /** 会什么（初始设定，导入实例时带过去） */
  abilities: string[]
  voice: string
  backstory: string
  secrets: string[]
  tags: string[]
  origin: 'user' | 'extract'
  /** 每次编辑 +1，「从原型刷新」据此比对 */
  rev: number
  createdAt: number
  updatedAt: number
}

/**
 * 状态事实：确定信息（谁持有什么、信上几个字、后厨有没有井）。
 * 这类东西不该靠检索碰运气，应该被结构化记住并每幕带上。
 */
export interface Fact {
  id: string
  subject: string
  predicate: string
  object: string
  kind: FactKind
  sceneId: string
  status: 'active' | 'retracted'
  /** 同一 (subject, predicate) 被改写时，旧记录置 retracted 而不是删除 */
  updatedAt: number
}

export type MergeStatus = 'pending' | 'accepted' | 'rejected'
export type MergeReason = 'similar-name' | 'shared-alias' | 'agent'

/**
 * 合并建议：机器只提议，玩家确认后才执行。
 * 自动合并两个人的代价是不可逆的——玩家会看到「这个人怎么突然多了一段记忆」。
 */
export interface MergeProposal {
  id: string
  spaceId: string
  aId: string
  bId: string
  reason: MergeReason
  evidence: string
  confidence: number
  status: MergeStatus
  createdAt: number
}

export interface PersonaIndexEntry {
  id: string
  name: string
  oneLine: string
  tags: string[]
  updatedAt: number
}

/** 角色在某个空间里的一段经历 */
export interface ArcBeat {
  sceneId: string
  /** ≤40 字 */
  text: string
  kind: ArcKind
  at: number
}

/** 地点上发生过的一件事 */
export interface PlaceEvent {
  sceneId: string
  /** ≤40 字 */
  text: string
  at: number
}

export interface CastMember {
  id: string
  spaceId: string
  /** 来自哪个原型（快照语义：原型改动不影响实例） */
  personaId: string | null
  personaRev: number | null
  /** 权威名，空间内归一化后唯一 */
  name: string
  aliases: string[]
  role: CastRole
  status: CastStatus
  statusChangedSceneId: string | null
  /** ≤40 字，一句话身份 */
  oneLine: string
  /** ≤30 字，说话风格 */
  voice: string
  traits: string[]
  /** 作者可见，绝不进叙事 prompt */
  secrets: string[]
  goal: string
  /** 会什么（≤6 条，每条 ≤10 字）。建空间时可有初始设定，抽取中只增不减 */
  abilities: string[]
  /** 喜欢什么（≤4 条） */
  hobbies: string[]
  /** 还没被揭开的东西：秘密、隐藏能力、真实身份 */
  hidden: HiddenTrait[]
  /** 角色自己的故事线，最多 maxArc 条 */
  arc: ArcBeat[]
  /** 可交互能力（自由文本，入梦模式用），≤6 条 */
  interactions: string[]
  firstSeenSceneId: string | null
  lastSeenSceneId: string | null
  /** 这个人最后出现在哪；用于「此刻谁在」与离场判断 */
  lastSeenPlaceId: string | null
  /** 玩家锁定后 patch 不可改 */
  locked: Partial<Record<'name' | 'status' | 'oneLine', true>>
  origin: 'user' | 'extract'
  confidence: number
  /** 合并痕迹，永不物理删 */
  supersededBy: string | null
  /** 软删时间戳（tombstone），null 表示在场 */
  removedAt: number | null
}

// ── 地点 ────────────────────────────────────────────────

export interface Place {
  id: string
  spaceId: string
  name: string
  kind: string
  oneLine: string
  features: string[]
  /** 商店货架等 */
  inventory: string[]
  /** 地点事件账本，最多 maxPlaceEvents 条 */
  events: PlaceEvent[]
  /** 相邻地点 id（入梦地图用） */
  exits: string[]
  /** 上级地点（房间属于建筑）；null = 顶层 */
  parentId: string | null
  /** 可交互能力（自由文本），≤6 条 */
  interactions: string[]
  /** 预留：入梦地图坐标 */
  coords: { x: number; y: number } | null
  firstSeenSceneId: string | null
  locked: Partial<Record<'name' | 'oneLine', true>>
  supersededBy: string | null
  /** 软删时间戳（tombstone），null 表示在场 */
  removedAt: number | null
}

// ── 关系 ────────────────────────────────────────────────

export interface Relation {
  id: string
  spaceId: string
  /** 恒 aId < bId，保证一条边唯一 */
  aId: string
  bId: string
  kind: RelKind
  strength: Strength
  note: string
  /** `${aId}|${bId}|${kind}` 幂等键 */
  edgeKey: string
  firstSeenSceneId: string | null
}

// ── 正文 ────────────────────────────────────────────────

export interface Choice {
  label: string
  intent?: string
}

/**
 * 线索归属：这条伏笔是为谁埋的。
 *
 * 不归属的伏笔会变成一串并列的坑——模型看不出它服务于谁，
 * 也就没有任何理由去收它。归属之后「收这条」才有动机。
 */
export type ClueThreadKind = 'main' | 'cast' | 'place'

export type ObjectiveKind = 'main' | 'side'
export type ObjectiveStatus = 'active' | 'done' | 'failed'

/**
 * 目标：故事里"要做什么"，可勾选、可计数。
 *
 * `mainGoal` 是"为什么"（一句话，进 prompt），Objective 是"要做什么"（可勾选）。
 * 两者是同一件事的两种粒度，不是两套真相：第一条 main 的文本与 mainGoal 保持同步。
 */
export interface Objective {
  id: string
  /** ≤60 字 */
  text: string
  kind: ObjectiveKind
  status: ObjectiveStatus
  /** 达成/失败在哪一幕 */
  atSceneId: string | null
  origin: 'user' | 'extract'
}

/** 阶段由 `resolvePhase()` 推导，不落库。 */
export type StoryPhase = 'opening' | 'investigation' | 'climax' | 'ending' | 'closed' | 'free'

/**
 * 空间模式：决定是否施加节奏约束，不影响其他任何能力。
 *  goal —— 有目标、有阶段、有终点（默认）
 *  free —— 纯沙盒：不催收、不推进度、不推结局
 */
export type SpaceMode = 'goal' | 'free'

/**
 * 固定事件：到了第 N 幕，某件事必须发生。
 *
 * 沙盒叙事最缺的是节拍。把「作者知道要发生什么」变成结构，
 * 而不是塞进 prompt 里祈祷模型记住。
 */
export interface ScheduledEvent {
  id: string
  /** 在第几幕（index）生成时触发；0 = 第一幕 */
  atSceneIndex: number
  /** 必须发生什么 */
  text: string
  fired: boolean
  origin: 'user' | 'extract'
}

export interface ClueThread {
  kind: ClueThreadKind
  /** kind 为 cast / place 时的实体 id；main 为 null */
  id: string | null
  /** 原始称呼（主线 / 人名 / 地名），用于展示 */
  label: string
}

export interface Clue {
  id: string
  kind: ClueKind
  text: string
  /** 这条线索引向谁 */
  thread: ClueThread
  /** 开在哪一幕 */
  sceneId: string
  /** open = 还悬着；resolved = 已收 */
  status: 'open' | 'resolved'
  resolvedAtSceneId: string | null
}

export interface SceneAction {
  kind: ActionKind
  text: string
}

export interface Scene {
  id: string
  spaceId: string
  index: number
  status: SceneStatus
  action: SceneAction | null
  choices: Choice[]
  /** 这一幕发生在哪个地点；null = 尚未确定 */
  placeId: string | null
  /** 在场人物 id，用于角色线与「此刻谁在」面板 */
  participants: string[]
  /** 一句话大纲 */
  summary: string | null
  /** 本幕留下的未解线索 / 承诺 / 失去 */
  clues: Clue[]
  textChars: number
  model: string
  inTok: number
  outTok: number
  committedAt: number | null
  archivedAt: number | null
  patchId: string | null
}

// ── 补丁 ────────────────────────────────────────────────

export type CastPatchValue = Partial<
  Pick<
    CastMember,
    'name' | 'status' | 'oneLine' | 'voice' | 'traits' | 'role' | 'goal' | 'abilities' | 'hobbies'
  >
>

export type PlacePatchValue = Partial<
  Pick<Place, 'name' | 'kind' | 'oneLine' | 'features' | 'inventory'>
>

export type PatchOp =
  | {
      op: 'upsert-cast'
      ref: string
      evidence: string
      confidence?: number
      value: CastPatchValue
    }
  | {
      op: 'upsert-place'
      ref: string
      evidence: string
      /** 上级地点名（可选）：模型只在明确写出从属关系时给 */
      parent?: string
      value: PlacePatchValue
    }
  | {
      op: 'upsert-relation'
      a: string
      b: string
      kind: RelKind
      strength?: Strength
      evidence: string
      note?: string
    }
  | {
      op: 'append-clue'
      kind: ClueKind
      text: string
      /** 服务于谁：人名 / 地名 / 「主线」。缺省视为主线。 */
      thread?: string
      evidence: string
    }
  | {
      op: 'append-arc'
      ref: string
      kind: ArcKind
      text: string
      evidence: string
    }
  | {
      op: 'append-place-event'
      ref: string
      text: string
      evidence: string
    }
  | {
      op: 'resolve-clue'
      ref: string
      evidence: string
    }
  | {
      op: 'assert-fact'
      subject: string
      predicate: string
      object: string
      kind: FactKind
      evidence: string
    }
  | {
      op: 'retract-fact'
      ref: string
      evidence: string
    }
  | {
      op: 'add-objective'
      text: string
      kind?: ObjectiveKind
      evidence: string
    }
  | {
      op: 'achieve-objective'
      /** 目标文本片段 */
      ref: string
      evidence: string
    }
  | {
      op: 'reveal-hidden'
      /** 角色名 */
      ref: string
      /** 被揭开的秘密/能力，文本片段即可 */
      what: string
      evidence: string
    }
  | {
      op: 'move-to'
      ref: string
      /** 谁在移动；缺省为视角人物（meta.protagId） */
      who?: string
      evidence: string
    }
  | {
      op: 'tombstone'
      entity: EntityKind
      ref: string
      reason: string
      evidence: string
    }

export type OpResultKind = 'applied' | 'skipped' | 'rejected'

export interface OpResult {
  op: string
  ref: string
  result: OpResultKind
  reason?: string
}

export interface PatchRecord {
  id: string
  spaceId: string
  sceneId: string
  canonRevBefore: number
  canonRevAfter: number
  ops: PatchOp[]
  report: OpResult[]
  warnings: string[]
  /** 原始模型输出，截断 8KB，调 prompt 的唯一依据 */
  raw: string
  createdAt: number
}

// ── 档案快照（回退用） ──────────────────────────────────

export interface CanonSnapshot {
  rev: number
  sceneId: string
  /** 快照对应的幕序（-1 = 建空间时的初始状态） */
  sceneIndex: number
  cast: CastMember[]
  places: Place[]
  relations: Relation[]
  facts: Fact[]
  world: World
}

/** 内存中的 canon 视图，patch 的输入输出 */
export interface CanonState {
  world: World
  cast: CastMember[]
  places: Place[]
  relations: Relation[]
  facts: Fact[]
}

// ── 存档信封 ────────────────────────────────────────────

export interface SpaceBundle {
  format: 'dreamloom'
  v: 1
  exportedAt: number
  space: SpaceMeta
  world: World
  cast: CastMember[]
  places: Place[]
  relations: Relation[]
  facts: Fact[]
  scenes: Scene[]
  texts: Record<string, string>
  patches: PatchRecord[]
  snapshots: CanonSnapshot[]
}
