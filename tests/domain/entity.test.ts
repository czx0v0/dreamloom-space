import { describe, expect, it } from 'vitest'
import {
  alreadyImported,
  buildAliasIndex,
  lookupAlias,
  mentionCast,
  proposeMerges,
  resolveEntity,
} from '../../src/domain/entity'
import type { Persona } from '../../src/domain/types'
import { idGenFactory, makeCast } from '../helpers'

describe('buildAliasIndex', () => {
  it('名字与别名都进索引', () => {
    const cast = [makeCast({ id: 'ch_1', name: '林昭', aliases: ['林老板'] })]
    const index = buildAliasIndex(cast)
    expect(index.get('林昭')).toBe('ch_1')
    expect(index.get('林老板')).toBe('ch_1')
    // 原始称呼由 lookupAlias 归一化后查，调用方不必自己 normalize
    expect(lookupAlias(index, '「林昭」')).toBe('ch_1')
  })

  it('已软删或被合并的实体不进索引', () => {
    const cast = [
      makeCast({ id: 'ch_1', name: '林昭', removedAt: 100 }),
      makeCast({ id: 'ch_2', name: '掌柜', supersededBy: 'ch_1' }),
    ]
    const index = buildAliasIndex(cast)
    expect(index.size).toBe(0)
  })
})

describe('resolveEntity', () => {
  const cast = [
    makeCast({ id: 'ch_1', name: '林昭', aliases: ['林老板'] }),
    makeCast({ id: 'ch_2', name: '掌柜' }),
    makeCast({ id: 'ch_3', name: '林昭昭' }),
  ]

  it('别名命中算 exact', () => {
    const r = resolveEntity('林老板', cast)
    expect(r).toMatchObject({ status: 'exact', id: 'ch_1' })
  })

  it('名字相近只给候选，不直接命中', () => {
    const r = resolveEntity('林昭召', cast)
    expect(r.status).toBe('similar')
    expect(r.id).toBeNull()
    expect(r.candidates.map((c) => c.name)).toContain('林昭昭')
  })

  it('完全无关的名字判为新实体', () => {
    const r = resolveEntity('韩梅梅', cast)
    expect(r).toMatchObject({ status: 'new', id: null })
    expect(r.candidates).toHaveLength(0)
  })

  it('两字名共用姓氏不被当成候选（李雷/李雪）', () => {
    const twoChar = [makeCast({ id: 'ch_9', name: '李雷' })]
    const r = resolveEntity('李雪', twoChar)
    expect(r.status).toBe('new')
  })
})

describe('proposeMerges', () => {
  it('共用同一别名时提出合并建议', () => {
    const cast = [
      makeCast({ id: 'ch_1', name: '林昭', aliases: ['林老板'] }),
      makeCast({ id: 'ch_2', name: '林老板' }),
    ]
    const proposals = proposeMerges(cast, 'sp_1', 1000, idGenFactory())
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ reason: 'shared-alias', status: 'pending' })
    expect(proposals[0].confidence).toBeGreaterThan(0.8)
  })

  it('名字相近时给出低置信建议', () => {
    const cast = [
      makeCast({ id: 'ch_1', name: '林昭昭' }),
      makeCast({ id: 'ch_2', name: '林昭召' }),
    ]
    const proposals = proposeMerges(cast, 'sp_1', 1000, idGenFactory())
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ reason: 'similar-name' })
    expect(proposals[0].confidence).toBeLessThan(0.8)
  })

  it('无关的两个人不产生建议', () => {
    const cast = [makeCast({ id: 'ch_1', name: '林昭' }), makeCast({ id: 'ch_2', name: '掌柜' })]
    expect(proposeMerges(cast, 'sp_1', 1000, idGenFactory())).toHaveLength(0)
  })

  it('已被合并的角色不再参与建议', () => {
    const cast = [
      makeCast({ id: 'ch_1', name: '林昭', aliases: ['林老板'] }),
      makeCast({ id: 'ch_2', name: '林老板', supersededBy: 'ch_1' }),
    ]
    expect(proposeMerges(cast, 'sp_1', 1000, idGenFactory())).toHaveLength(0)
  })
})

describe('alreadyImported', () => {
  const persona = {
    id: 'pe_1',
    v: 1,
    name: '林昭',
    aliases: [],
    appearance: '',
    oneLine: '',
    personality: [],
    abilities: [],
    voice: '',
    backstory: '',
    secrets: [],
    tags: [],
    origin: 'user',
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
  } as Persona

  it('按 personaId 识别已导入', () => {
    const cast = [makeCast({ id: 'ch_1', name: '林昭', personaId: 'pe_1' })]
    expect(alreadyImported(cast, persona)?.id).toBe('ch_1')
  })

  it('按名字兜底识别', () => {
    const cast = [makeCast({ id: 'ch_2', name: '林昭' })]
    expect(alreadyImported(cast, persona)?.id).toBe('ch_2')
  })

  it('同名的已软删实例不算已导入', () => {
    const cast = [makeCast({ id: 'ch_3', name: '林昭', removedAt: 10 })]
    expect(alreadyImported(cast, persona)).toBeNull()
  })
})

describe('mentionCast · 在场人物', () => {
  const cast = [
    makeCast({ id: 'ch_1', name: '林昭', aliases: ['林记者'] }),
    makeCast({ id: 'ch_2', name: '掌柜' }),
    makeCast({ id: 'ch_3', name: '阿棠' }),
    makeCast({ id: 'ch_4', name: '沈砚', removedAt: 10 }),
  ]

  it('按出现顺序返回在场角色', () => {
    expect(mentionCast(cast, '掌柜抬头看见林昭，把茶推过去。')).toEqual(['ch_2', 'ch_1'])
  })

  it('别名也算在场', () => {
    expect(mentionCast(cast, '林记者推门进来。')).toEqual(['ch_1'])
  })

  it('已软删的角色不算在场', () => {
    expect(mentionCast(cast, '沈砚站在门外。')).toEqual([])
  })

  it('没有提名的段落返回空', () => {
    expect(mentionCast(cast, '雾从码头漫上来。')).toEqual([])
  })

  it('单字提名不算（太容易误伤）', () => {
    const single = [makeCast({ id: 'ch_9', name: '林' })]
    expect(mentionCast(single, '林子里很静。')).toEqual([])
  })
})
