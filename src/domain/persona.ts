/**
 * 原型（Persona）↔ 空间实例（CastMember）的转换。
 *
 * 核心语义：导入是**深拷贝**，不是引用。
 * 故事是 append-only 的，如果原型改名就全局改，已经写好的正文会和档案对不上。
 * 想要同步时走显式的 refreshFromPersona，并且只刷描述性字段。
 */

import type { CastMember, CastRole, Persona } from './types'

export interface InstantiateInput {
  persona: Persona
  spaceId: string
  /** 首次出场的幕；导入时通常为 null，等真正写到那一幕再补 */
  sceneId: string | null
  idGen: (prefix: string) => string
  role?: CastRole
}

export function instantiatePersona(input: InstantiateInput): CastMember {
  const { persona, spaceId, sceneId, idGen } = input
  return {
    id: idGen('ch'),
    spaceId,
    personaId: persona.id,
    personaRev: persona.rev,
    name: persona.name,
    aliases: [...persona.aliases],
    role: input.role ?? 'support',
    status: 'alive',
    statusChangedSceneId: null,
    oneLine: persona.oneLine,
    voice: persona.voice,
    traits: [...persona.personality].slice(0, 8),
    secrets: [...persona.secrets],
    goal: '',
    abilities: [...persona.abilities],
    hobbies: [],
    hidden: [...(persona.secrets ?? [])].map((text) => ({ text, revealedAt: null })),
    arc: [],
    interactions: [],
    firstSeenSceneId: sceneId,
    lastSeenSceneId: sceneId,
    lastSeenPlaceId: null,
    locked: {},
    origin: 'user',
    confidence: 1,
    supersededBy: null,
    removedAt: null,
  }
}

/** 从空间角色反向导出原型（复用闭环的另一半）。 */
export function personaFromCast(
  cast: CastMember,
  idGen: (prefix: string) => string,
  now: number,
): Persona {
  return {
    id: idGen('pe'),
    v: 1,
    name: cast.name,
    abilities: [...cast.abilities],
    aliases: [...cast.aliases],
    appearance: '',
    oneLine: cast.oneLine,
    personality: [...cast.traits],
    voice: cast.voice,
    backstory: '',
    secrets: [...cast.secrets],
    tags: [],
    origin: 'user',
    rev: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export interface FieldDiff {
  field: 'role' | 'oneLine' | 'voice' | 'traits' | 'secrets'
  before: string
  after: string
}

/**
 * 可刷新的字段：身份设定跟着原型走（职业改了就该改），
 * 但 status / goal / arc / relations / locked 永不刷新——那是"他在这个故事里的遭遇"。
 */
const REFRESHABLE = ['oneLine', 'voice', 'traits', 'secrets'] as const

function asText(v: string | string[]): string {
  return Array.isArray(v) ? v.join('、') : v
}

function personaRoleOf(persona: Persona): CastMember['role'] | null {
  const tag = persona.tags.find((t) => t.startsWith('role:'))
  if (!tag) return null
  const value = tag.slice(5)
  return value === 'protagonist' || value === 'antagonist' || value === 'support' || value === 'extra'
    ? value
    : null
}

export function diffPersona(cast: CastMember, persona: Persona): FieldDiff[] {
  const diffsRole: FieldDiff[] = []
  const personaRole = personaRoleOf(persona)
  if (personaRole && personaRole !== cast.role) {
    diffsRole.push({ field: 'role', before: cast.role, after: personaRole })
  }
  const next: Record<string, string | string[]> = {
    oneLine: persona.oneLine,
    voice: persona.voice,
    traits: persona.personality.slice(0, 8),
    secrets: persona.secrets,
  }
  const diffs: FieldDiff[] = [...diffsRole]
  for (const field of REFRESHABLE) {
    const before = cast[field]
    const after = next[field]
    const beforeText = asText(before as string | string[])
    const afterText = asText(after as string | string[])
    if (beforeText !== afterText) {
      diffs.push({ field, before: beforeText, after: afterText })
    }
  }
  return diffs
}

/**
 * 从原型刷新。
 * 绝不触碰：name（空间内可能被改过）、aliases、status、goal、arc、relations、locked。
 * 玩家锁定过的字段也不刷。
 */
export function refreshFromPersona(
  cast: CastMember,
  persona: Persona,
): { cast: CastMember; applied: FieldDiff[] } {
  const applied: FieldDiff[] = []
  const next: CastMember = {
    ...cast,
    traits: [...cast.traits],
    secrets: [...cast.secrets],
    arc: cast.arc.map((b) => ({ ...b })),
    interactions: [...cast.interactions],
    locked: { ...cast.locked },
  }

  // role：职业/身份属于原型的设定，允许跟着刷新
  const personaRole = personaRoleOf(persona)
  if (personaRole && personaRole !== next.role) {
    applied.push({ field: 'role', before: next.role, after: personaRole })
    next.role = personaRole
  }

  if (next.oneLine !== persona.oneLine && !next.locked.oneLine) {
    applied.push({ field: 'oneLine', before: next.oneLine, after: persona.oneLine })
    next.oneLine = persona.oneLine
  }
  if (next.voice !== persona.voice) {
    applied.push({ field: 'voice', before: next.voice, after: persona.voice })
    next.voice = persona.voice
  }
  const nextTraits = persona.personality.slice(0, 8)
  if (next.traits.join('|') !== nextTraits.join('|')) {
    applied.push({ field: 'traits', before: next.traits.join('、'), after: nextTraits.join('、') })
    next.traits = nextTraits
  }
  if (next.secrets.join('|') !== persona.secrets.join('|')) {
    applied.push({
      field: 'secrets',
      before: next.secrets.join('、'),
      after: persona.secrets.join('、'),
    })
    next.secrets = [...persona.secrets]
  }

  next.personaRev = persona.rev
  return { cast: next, applied }
}

/** 同一空间内同一原型只允许一个实例。 */
export function hasPersonaInSpace(cast: CastMember[], personaId: string): boolean {
  return cast.some((c) => c.personaId === personaId && c.removedAt === null)
}
