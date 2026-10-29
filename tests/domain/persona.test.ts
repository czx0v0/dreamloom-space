import { describe, expect, it } from 'vitest'
import {
  diffPersona,
  hasPersonaInSpace,
  instantiatePersona,
  personaFromCast,
  refreshFromPersona,
} from '../../src/domain/persona'
import type { Persona } from '../../src/domain/types'
import { idGenFactory, makeCast } from '../helpers'

function makePersona(over: Partial<Persona> = {}): Persona {
  return {
    id: 'pe_1',
    v: 1,
    name: '林昭',
    aliases: ['林老板'],
    appearance: '总穿灰色长衫',
    oneLine: '查旧案的记者',
    personality: ['冷静', '固执'],
    abilities: [],
    voice: '语速很慢',
    backstory: '从北方来',
    secrets: ['他烧过一份档案'],
    tags: ['悬疑'],
    origin: 'user',
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('instantiatePersona', () => {
  it('导入时深拷贝，并记住原型版本', () => {
    const cast = instantiatePersona({
      persona: makePersona(),
      spaceId: 'sp_1',
      sceneId: null,
      idGen: idGenFactory(),
    })
    expect(cast.personaId).toBe('pe_1')
    expect(cast.personaRev).toBe(1)
    expect(cast.status).toBe('alive')
    expect(cast.arc).toEqual([])
    expect(cast.traits).toEqual(['冷静', '固执'])
  })

  it('修改原型不影响已导入的实例', () => {
    const persona = makePersona()
    const cast = instantiatePersona({
      persona,
      spaceId: 'sp_1',
      sceneId: null,
      idGen: idGenFactory(),
    })
    persona.name = '另一个人'
    persona.oneLine = '改过了'
    expect(cast.name).toBe('林昭')
    expect(cast.oneLine).toBe('查旧案的记者')
  })
})

describe('personaFromCast', () => {
  it('把空间角色反向导出为原型', () => {
    const cast = makeCast({ name: '掌柜', oneLine: '客栈掌柜', traits: ['谨慎'], secrets: ['账本'] })
    const persona = personaFromCast(cast, idGenFactory(), 100)
    expect(persona.name).toBe('掌柜')
    expect(persona.oneLine).toBe('客栈掌柜')
    expect(persona.personality).toEqual(['谨慎'])
    expect(persona.secrets).toEqual(['账本'])
    expect(persona.rev).toBe(1)
  })
})

describe('refreshFromPersona', () => {
  it('只刷描述性字段，保留状态与故事线', () => {
    const cast = makeCast({
      name: '林昭',
      oneLine: '旧描述',
      status: 'dead',
      arc: [{ sceneId: 'sc_3', text: '得知真相', kind: 'reveal', at: 1 }],
    })
    const persona = makePersona({ rev: 2, oneLine: '新描述', voice: '语速很快' })
    const { cast: next, applied } = refreshFromPersona(cast, persona)

    expect(next.oneLine).toBe('新描述')
    expect(next.voice).toBe('语速很快')
    expect(next.status).toBe('dead')
    expect(next.arc).toHaveLength(1)
    expect(next.personaRev).toBe(2)
    expect(applied.map((a) => a.field)).toContain('oneLine')
  })

  it('身份设定（role）跟着原型刷新', () => {
    const cast = makeCast({ name: '林昭', role: 'support' })
    const persona = makePersona({ rev: 2, tags: ['role:antagonist'] })
    const { cast: next, applied } = refreshFromPersona(cast, persona)
    expect(next.role).toBe('antagonist')
    expect(applied.some((a) => a.field === 'role')).toBe(true)
  })

  it('故事线永远不随原型刷新', () => {
    const cast = makeCast({
      arc: [{ sceneId: 'sc_3', text: '得知真相', kind: 'reveal', at: 1 }],
      status: 'dead',
    })
    const persona = makePersona({ rev: 5, tags: ['role:protagonist'] })
    const { cast: next } = refreshFromPersona(cast, persona)
    expect(next.arc).toHaveLength(1)
    expect(next.status).toBe('dead')
  })

  it('玩家锁定过的字段不被刷新', () => {
    const cast = makeCast({ oneLine: '我写的', locked: { oneLine: true } })
    const persona = makePersona({ oneLine: '原型写的', rev: 3 })
    const { cast: next } = refreshFromPersona(cast, persona)
    expect(next.oneLine).toBe('我写的')
  })

  it('diff 能列出将要变化的字段', () => {
    const persona = makePersona({ oneLine: '新' })
    const cast = makeCast({
      oneLine: '旧',
      voice: persona.voice,
      traits: [...persona.personality],
      secrets: [...persona.secrets],
    })
    const diffs = diffPersona(cast, persona)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ field: 'oneLine', before: '旧', after: '新' })
  })

  it('完全一致时不产生变化', () => {
    const persona = makePersona()
    const cast = makeCast({
      oneLine: persona.oneLine,
      voice: persona.voice,
      traits: [...persona.personality],
      secrets: [...persona.secrets],
    })
    expect(diffPersona(cast, persona)).toHaveLength(0)
  })
})

describe('hasPersonaInSpace', () => {
  it('同一原型在空间内只允许一个实例', () => {
    const cast = [makeCast({ personaId: 'pe_1' })]
    expect(hasPersonaInSpace(cast, 'pe_1')).toBe(true)
    expect(hasPersonaInSpace(cast, 'pe_2')).toBe(false)
  })

  it('已软删的实例不占用名额', () => {
    const cast = [makeCast({ personaId: 'pe_1', removedAt: 100 })]
    expect(hasPersonaInSpace(cast, 'pe_1')).toBe(false)
  })
})
