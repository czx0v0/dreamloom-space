import { describe, expect, it } from 'vitest'
import { auditScene, hasBlockingIssue, type AuditContext } from '../../src/domain/audit'

function ctx(over: Partial<AuditContext> = {}): AuditContext {
  return {
    deadNames: ['林昭'],
    knownNames: ['林昭', '掌柜'],
    actionVerbs: ['说', '走', '笑', '转身'],
    target: { min: 100, max: 200 },
    ...over,
  }
}

describe('auditScene · 死角色', () => {
  it('死者说话被拦截', () => {
    const text = '林昭说：「你终于回来了。」' + '雾'.repeat(100)
    const issues = auditScene(text, ctx())
    expect(hasBlockingIssue(issues)).toBe(true)
    expect(issues[0].code).toBe('DEAD_ACTING')
  })

  it('死者转身离开被拦截', () => {
    const text = '他看见林昭转身走进雾里。' + '雾'.repeat(100)
    expect(hasBlockingIssue(auditScene(text, ctx()))).toBe(true)
  })

  it('回忆语境下只提示不拦截', () => {
    const text = '他想起林昭生前说过的话。' + '雾'.repeat(100)
    const issues = auditScene(text, ctx())
    expect(hasBlockingIssue(issues)).toBe(false)
    expect(issues.some((i) => i.code === 'DEAD_IN_MEMORY')).toBe(true)
  })

  it('死者仅被提及而没有动作时不报', () => {
    const text = '林昭的伞还挂在门后。' + '雾'.repeat(100)
    expect(auditScene(text, ctx())).toHaveLength(0)
  })
})

describe('auditScene · 未知人名', () => {
  it('出现档案外的人名给出提示', () => {
    const text = '张三说：「别去了。」' + '雾'.repeat(100)
    const issues = auditScene(text, ctx())
    expect(issues.some((i) => i.code === 'UNKNOWN_NAME')).toBe(true)
  })

  it('已知人名不误报', () => {
    const text = '掌柜说：「别去了。」' + '雾'.repeat(100)
    const issues = auditScene(text, ctx())
    expect(issues.some((i) => i.code === 'UNKNOWN_NAME')).toBe(false)
  })

  it('常见泛称不误报', () => {
    const text = '众人说：「别去了。」' + '雾'.repeat(100)
    const issues = auditScene(text, ctx())
    expect(issues.some((i) => i.code === 'UNKNOWN_NAME')).toBe(false)
  })
})

describe('auditScene · 字数', () => {
  it('过短给出提示', () => {
    const issues = auditScene('太短了', ctx({ deadNames: [] }))
    expect(issues.some((i) => i.code === 'TOO_SHORT')).toBe(true)
  })

  it('过长给出提示', () => {
    const issues = auditScene('字'.repeat(400), ctx({ deadNames: [] }))
    expect(issues.some((i) => i.code === 'TOO_LONG')).toBe(true)
  })

  it('区间内不提示', () => {
    const issues = auditScene('字'.repeat(150), ctx({ deadNames: [] }))
    expect(issues.filter((i) => i.code === 'TOO_SHORT' || i.code === 'TOO_LONG')).toHaveLength(0)
  })
})
