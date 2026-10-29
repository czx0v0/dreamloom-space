/**
 * PatchOp 校验：结构、长度、枚举，以及最关键的一条 —— evidence 必须是正文的真子串。
 *
 * 这条把「幻觉入库」从概率问题变成可检测的布尔问题：
 * 模型的抽取错误不会被自我纠正，反而会被当成 canon 在下一幕强化，
 * 所以宁可漏记，不可错记。
 */

import type {
  ArcKind,
  FactKind,
  CastPatchValue,
  ClueKind,
  EntityKind,
  PatchOp,
  PlacePatchValue,
  RelKind,
  Strength,
} from './types'

export const REL_KINDS: RelKind[] = ['kin', 'ally', 'rival', 'enemy', 'mentor', 'lover', 'employ', 'other']
export const CLUE_KINDS: ClueKind[] = ['open-thread', 'loss']
export const ENTITY_KINDS: EntityKind[] = ['cast', 'place']
export const CAST_STATUSES = ['alive', 'dead', 'missing', 'unknown'] as const
export const ARC_KINDS: ArcKind[] = ['turn', 'loss', 'gain', 'reveal', 'meeting']
export const FACT_KINDS: FactKind[] = ['object', 'state', 'number', 'promise', 'place', 'other']
export const CAST_ROLES = ['protagonist', 'antagonist', 'support', 'extra'] as const

const STRIP = /[\s\u3000"'“”‘’《》「」『』【】\[\]()（）〈〉、，。！？；：·…⋯—\-~～]/g

export function normalizeForEvidence(s: string): string {
  return (s ?? '').replace(STRIP, '').toLowerCase()
}

/**
 * evidence 是否真的出自正文。
 * 允许模型用省略号拼接两段原文（它常见这么干），因此按省略号切分后逐段校验。
 */
export function evidenceIn(evidence: string, sceneText: string): boolean {
  if (!evidence || !sceneText) return false
  const hay = normalizeForEvidence(sceneText)
  const parts = evidence
    .split(/…|\.{3,}|⋯/)
    .map((p) => normalizeForEvidence(p))
    .filter((p) => p.length >= 2)
  if (parts.length === 0) return false
  return parts.every((p) => hay.includes(p))
}

function asString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max) : s
}

function asStringArray(v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const item of v) {
    const s = asString(item, maxLen)
    if (s) out.push(s)
    if (out.length >= maxItems) break
  }
  return out.length ? out : undefined
}

function asStrength(v: unknown): Strength | undefined {
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined
  const clamped = Math.min(5, Math.max(1, Math.round(n)))
  return clamped as Strength
}

export interface ValidateOptions {
  maxOps: number
}

export interface ValidateResult {
  ops: PatchOp[]
  warnings: string[]
}

/** 逐条校验；不合格的 op 丢弃并记 warning，绝不抛错（保证向前兼容）。 */
export function validateOps(
  rawOps: unknown,
  sceneText: string,
  opts: ValidateOptions,
): ValidateResult {
  const warnings: string[] = []
  if (!Array.isArray(rawOps)) {
    return { ops: [], warnings: ['ops 不是数组，本次不更新档案'] }
  }

  const ops: PatchOp[] = []
  let dropped = 0

  for (const raw of rawOps) {
    if (ops.length >= opts.maxOps) {
      warnings.push(`op 数量超过上限 ${opts.maxOps}，多余部分已忽略`)
      break
    }
    if (!raw || typeof raw !== 'object') {
      dropped++
      continue
    }
    const o = raw as Record<string, unknown>
    const kind = typeof o.op === 'string' ? o.op : ''
    const evidence = asString(o.evidence, 200)
    const ref = asString(o.ref, 12)

    if (!evidence) {
      warnings.push(`丢弃 ${kind || '未知 op'}：缺少 evidence`)
      dropped++
      continue
    }
    if (!evidenceIn(evidence, sceneText)) {
      warnings.push(`丢弃 ${kind}/${ref ?? '?'}：evidence 不在正文中`)
      dropped++
      continue
    }

    if (kind === 'assert-fact') {
      const subject = asString(o.subject, 12)
      const predicate = asString(o.predicate, 12)
      const object = asString(o.object, 40)
      const factKind = asString(o.kind, 10) ?? 'other'
      if (!subject || !predicate || !object) {
        warnings.push('丢弃 assert-fact：字段不完整')
        dropped++
        continue
      }
      ops.push({
        op: 'assert-fact',
        subject,
        predicate,
        object,
        kind: FACT_KINDS.includes(factKind as FactKind) ? (factKind as FactKind) : 'other',
        evidence,
      })
      continue
    }

    if (kind === 'retract-fact') {
      const factRef = asString(o.ref, 40)
      if (!factRef) {
        dropped++
        continue
      }
      ops.push({ op: 'retract-fact', ref: factRef, evidence })
      continue
    }

    if (kind === 'add-objective') {
      const text = asString(o.text, 60)
      if (!text) {
        warnings.push('丢弃 add-objective：缺少描述')
        dropped++
        continue
      }
      const objKind = asString(o.kind, 8)
      ops.push({
        op: 'add-objective',
        text,
        kind: objKind === 'main' ? 'main' : 'side',
        evidence,
      })
      continue
    }

    if (kind === 'achieve-objective') {
      const objRef = asString(o.ref, 40)
      if (!objRef) {
        dropped++
        continue
      }
      ops.push({ op: 'achieve-objective', ref: objRef, evidence })
      continue
    }

    if (kind === 'reveal-hidden') {
      const who = asString(o.ref, 12)
      const what = asString(o.what, 40)
      if (!who || !what) {
        dropped++
        continue
      }
      ops.push({ op: 'reveal-hidden', ref: who, what, evidence })
      continue
    }

    if (kind === 'move-to') {
      const placeRef = asString(o.ref, 12)
      if (!placeRef) {
        warnings.push('丢弃 move-to：缺少地点名')
        dropped++
        continue
      }
      ops.push({
        op: 'move-to',
        ref: placeRef,
        who: asString(o.who, 12) ?? undefined,
        evidence,
      })
      continue
    }

    if (kind === 'resolve-clue') {
      const clueRef = asString(o.ref, 40)
      if (!clueRef) {
        dropped++
        continue
      }
      ops.push({ op: 'resolve-clue', ref: clueRef, evidence })
      continue
    }

    if (kind === 'append-arc') {
      const arcKind = asString(o.kind, 12)
      const text = asString(o.text, 40)
      if (!ref || !text || !arcKind || !ARC_KINDS.includes(arcKind as ArcKind)) {
        warnings.push('丢弃 append-arc：字段不完整或 kind 非法')
        dropped++
        continue
      }
      ops.push({ op: 'append-arc', ref, kind: arcKind as ArcKind, text, evidence })
      continue
    }

    if (kind === 'append-place-event') {
      const text = asString(o.text, 40)
      if (!ref || !text) {
        dropped++
        continue
      }
      ops.push({ op: 'append-place-event', ref, text, evidence })
      continue
    }

    if (kind === 'upsert-cast') {
      if (!ref) {
        dropped++
        continue
      }
      const v = (o.value ?? {}) as Record<string, unknown>
      const value: CastPatchValue = {}
      const name = asString(v.name, 12)
      const oneLine = asString(v.oneLine, 40)
      const voice = asString(v.voice, 30)
      const role = asString(v.role, 20)
      const status = asString(v.status, 12)
      const goal = asString(v.goal, 80)
      const traits = asStringArray(v.traits, 8, 6)
      if (name) value.name = name
      if (oneLine) value.oneLine = oneLine
      if (voice) value.voice = voice
      if (traits) value.traits = traits
      if (role && (CAST_ROLES as readonly string[]).includes(role)) {
        value.role = role as CastPatchValue['role']
      }
      if (status && (CAST_STATUSES as readonly string[]).includes(status)) {
        value.status = status as CastPatchValue['status']
      } else if (status) {
        warnings.push(`忽略非法状态 ${status}（${ref}）`)
      }
      if (goal) value.goal = goal
      if (Object.keys(value).length === 0) {
        dropped++
        continue
      }
      const confidence = Number(o.confidence)
      ops.push({
        op: 'upsert-cast',
        ref,
        evidence,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
        value,
      })
      continue
    }

    if (kind === 'upsert-place') {
      if (!ref) {
        dropped++
        continue
      }
      const v = (o.value ?? {}) as Record<string, unknown>
      const value: PlacePatchValue = {}
      const name = asString(v.name, 12)
      const placeKind = asString(v.kind, 10)
      const oneLine = asString(v.oneLine, 40)
      const features = asStringArray(v.features, 6, 10)
      const inventory = asStringArray(v.inventory, 12, 16)
      if (name) value.name = name
      if (placeKind) value.kind = placeKind
      if (oneLine) value.oneLine = oneLine
      if (features) value.features = features
      if (inventory) value.inventory = inventory
      if (Object.keys(value).length === 0) {
        dropped++
        continue
      }
      ops.push({ op: 'upsert-place', ref, evidence, value })
      continue
    }

    if (kind === 'upsert-relation') {
      const a = asString(o.a, 12)
      const b = asString(o.b, 12)
      const relKind = asString(o.kind, 12)
      if (!a || !b || !relKind || !REL_KINDS.includes(relKind as RelKind)) {
        warnings.push(`丢弃 upsert-relation：字段不完整或关系类型非法`)
        dropped++
        continue
      }
      if (normalizeForEvidence(a) === normalizeForEvidence(b)) {
        dropped++
        continue
      }
      ops.push({
        op: 'upsert-relation',
        a,
        b,
        kind: relKind as RelKind,
        strength: asStrength(o.strength),
        evidence,
        note: asString(o.note, 40),
      })
      continue
    }

    if (kind === 'append-clue') {
      const clueKind = asString(o.kind, 12)
      const text = asString(o.text, 120)
      if (!text || !clueKind || !CLUE_KINDS.includes(clueKind as ClueKind)) {
        warnings.push('丢弃 append-clue：字段不完整或类型非法')
        dropped++
        continue
      }
      const thread = asString(o.thread, 12) ?? undefined
      ops.push({ op: 'append-clue', kind: clueKind as ClueKind, text, thread, evidence })
      continue
    }

    if (kind === 'tombstone') {
      const entity = asString(o.entity, 8)
      const reason = asString(o.reason, 40)
      if (!ref || !entity || !ENTITY_KINDS.includes(entity as EntityKind)) {
        dropped++
        continue
      }
      ops.push({
        op: 'tombstone',
        entity: entity as EntityKind,
        ref,
        reason: reason ?? '正文表明其已离场',
        evidence,
      })
      continue
    }

    warnings.push(`忽略未知 op：${kind || '(空)'}`)
    dropped++
  }

  if (dropped > 0) warnings.push(`共丢弃 ${dropped} 条不可信条目`)

  return {
    ops,
    warnings: Array.from(new Set(warnings)).slice(0, 12),
  }
}
