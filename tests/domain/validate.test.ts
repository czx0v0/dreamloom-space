import { describe, expect, it } from 'vitest'
import { evidenceIn, validateOps } from '../../src/domain/validate'

const SCENE = `林昭把伞收起来，靠在门框上。「你迟到了。」掌柜说。
窗外雾很重，能听见码头上的汽笛。他想起父亲生前常说的一句话：
雾里没有好人。`

describe('evidenceIn', () => {
  it('原文片段成立', () => {
    expect(evidenceIn('林昭把伞收起来', SCENE)).toBe(true)
  })

  it('忽略空白与标点差异', () => {
    expect(evidenceIn('林昭 把伞 收起来。', SCENE)).toBe(true)
  })

  it('省略号拼接多段原文时逐段校验', () => {
    expect(evidenceIn('林昭把伞收起来…雾里没有好人', SCENE)).toBe(true)
    expect(evidenceIn('林昭把伞收起来…他从未去过北方', SCENE)).toBe(false)
  })

  it('改写过的句子不通过', () => {
    expect(evidenceIn('林昭把雨伞收好了', SCENE)).toBe(false)
  })

  it('过短的证据视为无效', () => {
    expect(evidenceIn('雾', SCENE)).toBe(false)
  })
})

describe('validateOps', () => {
  const opts = { maxOps: 3 }

  it('合法 op 通过', () => {
    const { ops, warnings } = validateOps(
      [
        {
          op: 'upsert-cast',
          ref: '林昭',
          evidence: '林昭把伞收起来',
          confidence: 0.9,
          value: { oneLine: '查旧案的记者', status: 'alive', traits: ['冷静'] },
        },
      ],
      SCENE,
      opts,
    )
    expect(ops).toHaveLength(1)
    expect(warnings).toHaveLength(0)
    expect(ops[0]).toMatchObject({ op: 'upsert-cast', ref: '林昭' })
  })

  it('evidence 不在正文中则丢弃并记 warning', () => {
    const { ops, warnings } = validateOps(
      [{ op: 'upsert-cast', ref: '北方来客', evidence: '北方来客推门而入', value: { oneLine: 'x' } }],
      SCENE,
      opts,
    )
    expect(ops).toHaveLength(0)
    expect(warnings.join()).toContain('evidence 不在正文中')
  })

  it('非法状态被忽略但其余字段保留', () => {
    const { ops, warnings } = validateOps(
      [
        {
          op: 'upsert-cast',
          ref: '掌柜',
          evidence: '掌柜说',
          value: { status: 'zombie', oneLine: '客栈掌柜' },
        },
      ],
      SCENE,
      opts,
    )
    expect(ops).toHaveLength(1)
    expect((ops[0] as { value: { status?: string } }).value.status).toBeUndefined()
    expect(warnings.join()).toContain('非法状态')
  })

  it('字段超长被截断', () => {
    const longOneLine = '很长的一句话'.repeat(20)
    const { ops } = validateOps(
      [{ op: 'upsert-cast', ref: '掌柜', evidence: '掌柜说', value: { oneLine: longOneLine } }],
      SCENE,
      opts,
    )
    const value = (ops[0] as { value: { oneLine: string } }).value
    expect(value.oneLine.length).toBeLessThanOrEqual(40)
  })

  it('未知 op 丢弃但不抛错', () => {
    const { ops, warnings } = validateOps([{ op: 'delete-world', evidence: '雾很重' }], SCENE, opts)
    expect(ops).toHaveLength(0)
    expect(warnings.join()).toContain('未知 op')
  })

  it('超过 maxOps 的部分被截断', () => {
    const raw = Array.from({ length: 6 }, () => ({
      op: 'append-clue',
      kind: 'open-thread',
      text: '雾里有汽笛声',
      evidence: '码头上的汽笛',
    }))
    const { ops, warnings } = validateOps(raw, SCENE, { maxOps: 3 })
    expect(ops).toHaveLength(3)
    expect(warnings.join()).toContain('超过上限')
  })

  it('关系两端相同则丢弃', () => {
    const { ops } = validateOps(
      [{ op: 'upsert-relation', a: '林昭', b: '林昭', kind: 'enemy', evidence: '林昭把伞收起来' }],
      SCENE,
      opts,
    )
    expect(ops).toHaveLength(0)
  })
})
