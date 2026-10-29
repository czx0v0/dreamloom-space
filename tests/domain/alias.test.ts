import { describe, expect, it } from 'vitest'
import { isSameName, isSimilarName, levenshtein, normalizeName } from '../../src/domain/alias'

describe('normalizeName', () => {
  it('去掉空白、全角、引号与书名号', () => {
    expect(normalizeName('  林 昭 ')).toBe('林昭')
    expect(normalizeName('「林昭」')).toBe('林昭')
    expect(normalizeName('《林昭》')).toBe('林昭')
    expect(normalizeName('“林昭”')).toBe('林昭')
    expect(normalizeName('林\u3000昭')).toBe('林昭')
  })

  it('剥称谓但必须留下至少两个字', () => {
    expect(normalizeName('林昭先生')).toBe('林昭')
    expect(normalizeName('沈砚老师')).toBe('沈砚')
  })

  it('剥完只剩一个字时不剥，避免绰号与真名相撞', () => {
    expect(normalizeName('王老师')).toBe('王老师')
    expect(normalizeName('林老板')).toBe('林老板')
  })

  it('全角字母转半角并小写', () => {
    expect(normalizeName('Ｌｉｎ')).toBe('lin')
    expect(normalizeName('LIN')).toBe('lin')
  })
})

describe('levenshtein', () => {
  it('基础距离', () => {
    expect(levenshtein('林昭', '林昭')).toBe(0)
    expect(levenshtein('林昭', '林昭昭')).toBe(1)
    expect(levenshtein('林昭', '林')).toBe(1)
  })

  it('超过上限时早停并返回哨兵值', () => {
    expect(levenshtein('林昭', '韩梅梅', 1)).toBeGreaterThan(1)
  })
})

describe('isSameName（自动合并的唯一依据）', () => {
  it('归一化后相同即同一实体', () => {
    expect(isSameName('林昭', '「林昭」')).toBe(true)
    expect(isSameName('林昭', '林昭先生')).toBe(true)
    expect(isSameName('林 昭', '林昭')).toBe(true)
  })

  it('差一个字就不是同一人', () => {
    expect(isSameName('李雷', '李雪')).toBe(false)
    expect(isSameName('林昭昭', '林昭召')).toBe(false)
    expect(isSameName('林昭', '林')).toBe(false)
  })

  it('空名不参与判等', () => {
    expect(isSameName('', '')).toBe(false)
    expect(isSameName('  ', '林昭')).toBe(false)
  })
})

describe('isSimilarName（只用于提示，不用于合并）', () => {
  it('3 字名首字相同且距离 1，提示可能是同一人', () => {
    expect(isSimilarName('林昭昭', '林昭召')).toBe(true)
  })

  it('两字名一律不提示（姓氏相同太常见）', () => {
    expect(isSimilarName('李雷', '李雪')).toBe(false)
    expect(isSimilarName('王刚', '王钢')).toBe(false)
  })

  it('首字不同不提示', () => {
    expect(isSimilarName('林昭昭', '韩梅梅')).toBe(false)
  })

  it('完全相同时不重复提示', () => {
    expect(isSimilarName('林昭', '林昭')).toBe(false)
  })
})

describe('makeId · 唯一性', () => {
  it('同一毫秒 + 固定随机数也不会重复（1024 个内）', async () => {
    const { makeId, resetIdSequence } = await import('../../src/domain/ids')
    resetIdSequence()
    const ids = new Set<string>()
    for (let i = 0; i < 1024; i++) ids.add(makeId('ch', 1700000000000, () => 0.5))
    expect(ids.size).toBeLessThanOrEqual(1024)
    expect(ids.size).toBeGreaterThan(1000)
  })
})
