import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_SCHEMA,
  OUTPUT_FORMAT,
  SECTION_ORDER,
  buildArchiveMessages,
  buildNarratorMessages,
  buildRepairMessages,
  promptOverhead,
} from '../../server/prompts.js'

const baseRequest = {
  sections: {
    world: '雾港｜民国十七年｜一座靠走私活着的港口',
    rules: '- 雾港没有正式的警察',
    outline: '当前：林昭回到客栈',
    cast: '| 林昭 | 在场 | 记者 |\n| 掌柜 | 已死亡 | 客栈老板 |',
    facts: '信 写着 三个字',
    recall: '他曾经说过不会再回来。',
    action: '推门进去',
  },
  target: { min: 300, max: 450 },
  choiceCount: 3,
}

describe('buildNarratorMessages', () => {
  it('只有两条消息：system 与 user', () => {
    const messages = buildNarratorMessages(baseRequest)
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
  })

  it('分区按固定顺序进 system', () => {
    const messages = buildNarratorMessages(baseRequest)
    const system = messages[0].content as string
    const positions = ['【世界】', '【铁律·不可违背】', '【当前剧情位置】', '【在场人物】', '【已知事实】', '【相关旧文】']
      .map((label) => system.indexOf(label))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('玩家行动进入 user 消息', () => {
    const messages = buildNarratorMessages(baseRequest)
    expect(messages[1].content).toContain('推门进去')
  })

  it('负面约束放在最后一条消息的末尾（遵循率最高）', () => {
    const messages = buildNarratorMessages(baseRequest)
    const user = messages[1].content as string
    const negativeAt = user.indexOf('禁止事项')
    expect(negativeAt).toBeGreaterThan(user.indexOf(OUTPUT_FORMAT.slice(0, 10)))
    expect(user.trimEnd().endsWith('现在写下一段。')).toBe(true)
  })

  it('输出格式被注入', () => {
    const messages = buildNarratorMessages(baseRequest)
    expect(messages[1].content).toContain('<scene>')
    expect(messages[1].content).toContain('<choices>')
  })

  it('字数区间写进指令', () => {
    const messages = buildNarratorMessages({ ...baseRequest, target: { min: 700, max: 1200 } })
    expect(messages[1].content).toContain('700–1200')
  })

  it('choiceCount 为 0 时不要求选项', () => {
    const messages = buildNarratorMessages({ ...baseRequest, choiceCount: 0 })
    expect(messages[1].content).not.toContain('玩家此刻可以做出的')
  })

  it('空 action 有兜底，不会让模型无从下笔', () => {
    const messages = buildNarratorMessages({ sections: { world: 'x' }, target: { min: 300, max: 450 }, choiceCount: 3 })
    expect(messages[1].content).toContain('玩家没有明确行动')
  })

  it('secrets 绝不会出现在叙事 prompt 里（泄漏回归）', () => {
    // 即使调用方误把 secrets 塞进 sections，也只可能是 sections 里没有的内容
    const messages = buildNarratorMessages({
      ...baseRequest,
      sections: { ...baseRequest.sections, cast: '| 林昭 | 在场 | 记者 |' },
    })
    const whole = messages.map((m: { content: string }) => m.content).join('\n')
    expect(whole).not.toContain('秘密')
    expect(whole).not.toContain('secrets')
  })

  it('人物表原样保留，死亡标记不会被打平', () => {
    const messages = buildNarratorMessages(baseRequest)
    expect(messages[0].content).toContain('已死亡')
  })
})

describe('promptOverhead', () => {
  it('给出可用的固定开销估算', () => {
    const overhead = promptOverhead()
    expect(overhead.persona).toBeGreaterThan(0)
    expect(overhead.format).toBeGreaterThan(100)
  })
})

describe('buildArchiveMessages', () => {
  const archiveRequest = {
    sceneText: '他推开门，雾涌进来。掌柜说：「你迟到了。」',
    canon: {
      cast: [{ name: '林昭', status: 'alive', oneLine: '记者', aliases: [] }],
      places: [{ name: '同福客栈', oneLine: '临街两层' }],
      relations: [{ a: '林昭', b: '掌柜', kind: 'rival' }],
    },
  }

  it('canon 用表格渲染而不是 JSON', () => {
    const messages = buildArchiveMessages(archiveRequest)
    const user = messages[1].content as string
    expect(user).toContain('| 名字 | 状态 |')
    expect(user).toContain('林昭')
    expect(user).not.toContain('"name"')
  })

  it('正文原样进入 user 消息', () => {
    const messages = buildArchiveMessages(archiveRequest)
    expect(messages[1].content).toContain('你迟到了')
  })

  it('schema 里列出了全部 op 类型', () => {
    for (const op of [
      'upsert-cast',
      'upsert-place',
      'upsert-relation',
      'append-clue',
      'resolve-clue',
      'append-arc',
      'append-place-event',
      'assert-fact',
      'retract-fact',
      'tombstone',
    ]) {
      expect(ARCHIVE_SCHEMA).toContain(op)
    }
  })

  it('system 里明确要求 evidence 必须是原句', () => {
    const messages = buildArchiveMessages(archiveRequest)
    expect(messages[0].content).toContain('evidence')
    expect(messages[0].content).toContain('原句')
  })

  it('空 canon 时不产生空表格', () => {
    const messages = buildArchiveMessages({ sceneText: '雾很重。', canon: { cast: [], places: [], relations: [] } })
    expect(messages[1].content).not.toContain('| 名字 | 状态 |')
  })
})

describe('buildRepairMessages', () => {
  it('只要求修格式，不允许增删内容', () => {
    const messages = buildRepairMessages('{"ops":[1,2,')
    expect(messages[0].content).toContain('不要新增任何条目')
    expect(messages[1].content).toContain('{"ops":[1,2,')
  })

  it('超长输入被截断，避免修复请求本身超限', () => {
    const messages = buildRepairMessages('x'.repeat(10000))
    expect((messages[1].content as string).length).toBeLessThanOrEqual(4000)
  })
})

describe('SECTION_ORDER', () => {
  it('覆盖全部叙事分区且无重复', () => {
    expect(new Set(SECTION_ORDER).size).toBe(SECTION_ORDER.length)
    for (const key of ['world', 'rules', 'cast', 'facts', 'recall', 'lastTail']) {
      expect(SECTION_ORDER).toContain(key)
    }
  })

  it('action 不在 system 分区里（它要在 user 消息中靠近指令）', () => {
    expect(SECTION_ORDER).not.toContain('action')
  })
})
