import { describe, expect, it } from 'vitest'
import {
  canTransition,
  countChars,
  fallbackChoices,
  isLikelyRepeat,
  parseNarration,
  visibleSceneText,
} from '../../src/domain/scene'

describe('visibleSceneText · 流式增量', () => {
  it('标签还没闭合时先返回空，避免闪出半个标签', () => {
    expect(visibleSceneText('<sce')).toBe('')
    expect(visibleSceneText('<scene')).toBe('')
  })

  it('闭合开标签后立刻可见', () => {
    expect(visibleSceneText('<scene>他推开门')).toBe('他推开门')
  })

  it('闭合标签到达后截断', () => {
    expect(visibleSceneText('<scene>他推开门</scene><choices>1. 走')).toBe('他推开门')
  })

  it('尾部残片 </sc 被剥掉', () => {
    expect(visibleSceneText('<scene>他推开门</sc')).toBe('他推开门')
  })

  it('模型没按格式输出时退化为全文', () => {
    const prose = '他推开门，雾涌进来，屋里没有人，只有一盏还没熄的灯。'
    expect(visibleSceneText(prose)).toBe(prose)
  })

  it('开头有前言时从 <scene> 开始取', () => {
    expect(visibleSceneText('好的，下面是续写：<scene>正文开始')).toBe('正文开始')
  })
})

describe('parseNarration', () => {
  it('正文与选项分开', () => {
    const raw = `<scene>
他推开门。
</scene>
<choices>
1. 走进去
2. 转身离开
3. 敲门
</choices>`
    const p = parseNarration(raw)
    expect(p.scene).toBe('他推开门。')
    expect(p.choices.map((c) => c.label)).toEqual(['走进去', '转身离开', '敲门'])
    expect(p.hadSceneTag).toBe(true)
    expect(p.hadChoicesTag).toBe(true)
  })

  it('容忍中文序号与项目符号', () => {
    const raw = `<scene>x</scene><choices>
1、走进去
- 转身离开
· 敲门
</choices>`
    expect(parseNarration(raw).choices.map((c) => c.label)).toEqual(['走进去', '转身离开', '敲门'])
  })

  it('选项缺失时返回空数组（由上层兜底）', () => {
    const p = parseNarration('<scene>只有正文</scene>')
    expect(p.choices).toEqual([])
    expect(p.hadChoicesTag).toBe(false)
  })

  it('options 数量受 choiceLimit 限制', () => {
    const raw = '<scene>x</scene><choices>1. a\n2. b\n3. c\n4. d</choices>'
    expect(parseNarration(raw, 2).choices).toHaveLength(2)
  })

  it('scene 未闭合但 choices 已开始时不会把选项算进正文', () => {
    const raw = '<scene>正文<choices>1. a</choices>'
    expect(parseNarration(raw).scene).toBe('正文')
  })
})

describe('fallbackChoices', () => {
  it('永远不返回空', () => {
    expect(fallbackChoices(null, 3)).toHaveLength(3)
    expect(fallbackChoices('追查旧案', 1)).toHaveLength(1)
  })
})

describe('状态机', () => {
  it('允许的转移', () => {
    expect(canTransition('streaming', 'committed')).toBe(true)
    expect(canTransition('streaming', 'aborted')).toBe(true)
    expect(canTransition('committed', 'orphan')).toBe(true)
  })

  it('非法的转移', () => {
    expect(canTransition('aborted', 'committed')).toBe(false)
    expect(canTransition('orphan', 'committed')).toBe(false)
    expect(canTransition('committed', 'aborted')).toBe(false)
  })
})

describe('countChars', () => {
  it('不计空白', () => {
    expect(countChars('他 推 开\n门')).toBe(4)
  })
})

describe('isLikelyRepeat', () => {
  const a = '他推开门，雾涌进来，屋里没有人，只有一盏还没熄的灯。'

  it('完全相同判为重复', () => {
    expect(isLikelyRepeat(a, a)).toBe(true)
  })

  it('只差空白与标点仍判为重复', () => {
    expect(isLikelyRepeat(a, a.replace(/，/g, ' '))).toBe(true)
  })

  it('正常承接不误判', () => {
    expect(isLikelyRepeat(a, '掌柜抬头看了他一眼，把茶碗往前推了半寸。')).toBe(false)
  })

  it('过短的段落不做判断（避免误伤）', () => {
    expect(isLikelyRepeat('他推门。', '他推门。')).toBe(true)
    expect(isLikelyRepeat('很短', '很短的两句')).toBe(false)
  })

  it('空值不判重复', () => {
    expect(isLikelyRepeat('', 'x')).toBe(false)
  })
})

describe('选项意图标签', () => {
  const wrap = (lines: string) => `<scene>\n正文。\n</scene>\n<choices>\n${lines}\n</choices>`

  it('四个标签各自被识别，label 不含标签', () => {
    const parsed = parseNarration(
      wrap(
        [
          '1. [追问] 问掌柜那封信是谁交来的',
          '2. 【行动】推门进仓库',
          '3. [观察] 在门外等一会',
          '4. [离开] 回客栈',
        ].join('\n'),
        4,
      ),
    )
    expect(parsed.choices.map((c) => c.intent)).toEqual(['追问', '行动', '观察', '离开'])
    expect(parsed.choices[0].label).toBe('问掌柜那封信是谁交来的')
  })

  it('白名单外的标签原样留在文案里，不当作意图', () => {
    const parsed = parseNarration(wrap('1. [重要] 别忘那封信'), 1)
    expect(parsed.choices[0].intent).toBeUndefined()
    expect(parsed.choices[0].label).toBe('[重要] 别忘那封信')
  })

  it('只有标签没有内容时丢掉这一条', () => {
    const parsed = parseNarration(wrap('1. [追问]\n2. [行动] 追出去'), 2)
    expect(parsed.choices).toHaveLength(1)
    expect(parsed.choices[0].intent).toBe('行动')
  })
})
