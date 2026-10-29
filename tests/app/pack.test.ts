import { describe, expect, it } from 'vitest'
import { cluesSection, outlineSection, placeEventsSection, placesSection } from '../../src/app/pack'
import type { SpaceMeta } from '../../src/domain/types'
import { makePlace, makeState } from '../helpers'
import type { Clue, Scene } from '../../src/domain/types'

let seq = 0
function makeScene(index: number, clues: Clue[] = []): Scene {
  seq += 1
  return {
    id: `sc_${index}`,
    spaceId: 'sp_1',
    index,
    status: 'committed',
    action: null,
    choices: [],
    placeId: null,
    participants: [],
    summary: null,
    clues,
    textChars: 0,
    model: 'test',
    inTok: 0,
    outTok: 0,
    committedAt: 1,
    archivedAt: null,
    patchId: null,
  }
}

function clue(text: string, status: 'open' | 'resolved' = 'open'): Clue {
  seq += 1
  return {
    id: `cl_${seq}`,
    kind: 'open-thread',
    text,
    thread: { kind: 'main', id: null, label: '主线' },
    sceneId: 'sc_0',
    status,
    resolvedAtSceneId: status === 'resolved' ? 'sc_9' : null,
  }
}

describe('cluesSection', () => {
  it('列出未收伏笔并标出埋下的幕号', () => {
    const scenes = [makeScene(0, [clue('那封信的三个字')])]
    expect(cluesSection(scenes, 8)).toBe('主线：\n- 那封信的三个字（第 1 幕埋下，已悬 0 幕）')
  })

  it('悬了 12 幕以上明确标注「该收了」', () => {
    const scenes = Array.from({ length: 15 }, (_, i) =>
      makeScene(i, i === 2 ? [clue('码头那声哨响')] : []),
    )
    const out = cluesSection(scenes, 8)
    expect(out).toContain('第 3 幕埋下')
    expect(out).toContain('已悬 12 幕，该收了')
  })

  it('刚开始的伏笔不该催收', () => {
    const scenes = Array.from({ length: 5 }, (_, i) =>
      makeScene(i, i === 3 ? [clue('掌柜的口音')] : []),
    )
    expect(cluesSection(scenes, 8)).toContain('已悬 1 幕')
    expect(cluesSection(scenes, 8)).not.toContain('该收了')
  })

  it('已收的伏笔不再出现', () => {
    const scenes = [makeScene(0, [clue('已经解开的谜', 'resolved'), clue('还悬着的谜')])]
    const out = cluesSection(scenes, 8)
    expect(out).toContain('还悬着的谜')
    expect(out).not.toContain('已经解开的谜')
  })

  it('超过条数上限时只保留最近的', () => {
    const scenes = Array.from({ length: 10 }, (_, i) => makeScene(i, [clue(`伏笔${i}`)]))
    const out = cluesSection(scenes, 3)
    // 一行分组标题 + 三条线索 + 一行积压要求
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
    expect(out).toContain('伏笔9')
    expect(out).not.toContain('- 伏笔0')
  })

  it('没有幕时返回空串（避免 prompt 里出现空标题）', () => {
    expect(cluesSection([], 8)).toBe('')
  })
})

describe('cluesSection · 归属与催收', () => {
  it('按线索归属分组，模型才知道这条服务于谁', () => {
    const scenes = [
      makeScene(0, [
        { ...clue('信是谁寄的'), thread: { kind: 'main', id: null, label: '主线' } },
        { ...clue('父亲的死因'), thread: { kind: 'cast', id: 'ch_1', label: '林昭' } },
        { ...clue('后厨那口井'), thread: { kind: 'place', id: 'pl_1', label: '同福客栈' } },
      ]),
    ]
    const out = cluesSection(scenes, 8)
    expect(out).toContain('主线：')
    expect(out).toContain('林昭：')
    expect(out).toContain('同福客栈：')
  })

  it('同一归属的线索收在同一组里', () => {
    const thread = { kind: 'cast' as const, id: 'ch_1', label: '林昭' }
    const scenes = [
      makeScene(0, [{ ...clue('旧伤'), thread }]),
      makeScene(1, [{ ...clue('那封信'), thread }]),
    ]
    const out = cluesSection(scenes, 8)
    expect(out.split('林昭：')).toHaveLength(2)
    expect(out).toContain('- 旧伤')
    expect(out).toContain('- 那封信')
  })

  it('有逾期线索时下硬要求收掉一条', () => {
    const scenes = Array.from({ length: 15 }, (_, i) =>
      makeScene(i, i === 0 ? [clue('很旧的坑')] : []),
    )
    const out = cluesSection(scenes, 8)
    expect(out).toContain('本幕要求')
    expect(out).toContain('必须收掉其中至少一条')
  })

  it('积压到 6 条也要求先收再审新的', () => {
    const scenes = Array.from({ length: 7 }, (_, i) => makeScene(i, [clue(`坑${i}`)]))
    const out = cluesSection(scenes, 12)
    expect(out).toContain('累积 7 条')
    expect(out).toContain('必须先收掉一条旧线索')
  })

  it('只有一两条新线索时不催，避免被逼着草草收尾', () => {
    const scenes = [makeScene(0, [clue('新坑一')]), makeScene(1, [clue('新坑二')])]
    const out = cluesSection(scenes, 8)
    expect(out).not.toContain('本幕要求')
  })
})

describe('placesSection · 你在哪', () => {
  const canon = makeState({
    places: [
      makePlace({ id: 'pl_1', name: '同福客栈', kind: '客栈', oneLine: '什么都记得' }),
      makePlace({
        id: 'pl_2',
        name: '三号仓库',
        kind: '仓库',
        oneLine: '堆着油布',
        features: ['油布', '侧门小屋'],
        exits: ['pl_1', 'pl_3'],
      }),
      makePlace({ id: 'pl_3', name: '二号堆场', kind: '堆场' }),
    ],
  })

  const at = (placeId: string | null) => placesSection(canon, [makeScene(0)].map((s) => ({ ...s, placeId })), 4)

  it('给出「你现在在哪」而不是地点列表', () => {
    const out = at('pl_2')
    expect(out).toContain('【你现在在哪】三号仓库')
    expect(out).toContain('环境：油布、侧门小屋')
  })

  it('能去哪来自 exits', () => {
    const out = at('pl_2')
    expect(out).toContain('【能去哪】同福客栈、二号堆场')
  })

  it('其他地点单列，不混进当前位置', () => {
    const out = at('pl_2')
    expect(out).toContain('【其他已知地点】同福客栈')
    expect(out.match(/三号仓库/g)).toHaveLength(1)
  })

  it('位置未定时不编造「你在哪」', () => {
    const out = at(null)
    expect(out).not.toContain('你现在在哪')
    expect(out).toContain('其他已知地点')
  })
})

describe('placeEventsSection · 用 placeId 定位', () => {
  it('带上当前地点的旧事', () => {
    const canon = makeState({
      places: [
        makePlace({ id: 'pl_1', name: '同福客栈', events: [{ sceneId: 'sc_0', text: '有人死在这里', at: 1 }] }),
        makePlace({ id: 'pl_2', name: '三号仓库' }),
      ],
    })
    const scenes = [{ ...makeScene(1), placeId: 'pl_1' }]
    const out = placeEventsSection(canon, scenes, 3)
    expect(out).toContain('同福客栈')
    expect(out).toContain('有人死在这里')
  })

  it('不再用 participants 里的 id 去匹配地点（那是人物 id）', () => {
    const canon = makeState({
      places: [
        makePlace({ id: 'ch_1', name: '不该被当成地点', events: [{ sceneId: 'sc_0', text: '误匹配', at: 1 }] }),
        makePlace({ id: 'pl_1', name: '同福客栈', events: [{ sceneId: 'sc_0', text: '正确的旧事', at: 1 }] }),
      ],
    })
    const scenes = [{ ...makeScene(1), placeId: 'pl_1', participants: ['ch_1'] }]
    const out = placeEventsSection(canon, scenes, 3)
    expect(out).toContain('正确的旧事')
    expect(out).not.toContain('误匹配')
  })
})

describe('outlineSection · 阶段与固定事件', () => {
  const meta = (over: Partial<SpaceMeta> = {}): SpaceMeta =>
    ({
      id: 'sp_1',
      v: 1,
      title: '雾港',
      cover: '🌫️',
      createdAt: 0,
      updatedAt: 0,
      genre: '悬疑',
      tone: '冷峻',
      pov: 'third',
      protagId: 'ch_1',
      settings: { charPreset: 'short', temperature: 0.9, choiceCount: 3, recentSummaries: 8 },
      hardRules: [],
      mainGoal: '查清父亲死因',
      objectives: [
        {
          id: 'ob_1',
          text: '查清父亲死因',
          kind: 'main',
          status: 'active',
          atSceneId: null,
          origin: 'user',
        },
      ],
      endedAt: null,
      mode: 'goal',
      scheduled: [],
      sceneCount: 0,
      canonRev: 0,
      activeSceneId: null,
      archiveWatermark: null,
      stats: { calls: 0, inTok: 0, outTok: 0, chars: 0 },
      ...over,
    }) as SpaceMeta

  it('给出目标进度与阶段', () => {
    const out = outlineSection(meta(), [])
    expect(out).toContain('主线目标：查清父亲死因')
    expect(out).toContain('待完成（0/1）')
    expect(out).toContain('当前阶段：开场')
  })

  it('本幕到期的固定事件写成「必须发生」', () => {
    const scenes = Array.from({ length: 2 }, (_, i) => makeScene(i))
    const out = outlineSection(
      meta({
        scheduled: [
          { id: 'ev_1', atSceneIndex: 2, text: '凌晨四点码头的灯灭了', fired: false, origin: 'user' },
        ],
      }),
      scenes,
    )
    expect(out).toContain('【本幕必须发生】')
    expect(out).toContain('凌晨四点码头的灯灭了')
  })

  it('已触发或还没到的事件不出现', () => {
    const scenes = [makeScene(0), makeScene(1)]
    const out = outlineSection(
      meta({
        scheduled: [
          { id: 'ev_1', atSceneIndex: 2, text: '已触发过', fired: true, origin: 'user' },
          { id: 'ev_2', atSceneIndex: 9, text: '还没到', fired: false, origin: 'user' },
        ],
      }),
      scenes,
    )
    expect(out).not.toContain('本幕必须发生')
  })

  it('自由模式不给阶段要求', () => {
    const out = outlineSection(meta({ mode: 'free' }), [makeScene(0)])
    expect(out).toContain('当前阶段：自由')
    expect(out).not.toContain('必须让读者离答案更近')
  })

  it('逼近阶段要求朝主目标推进', () => {
    const scenes = Array.from({ length: 25 }, (_, i) => makeScene(i))
    expect(outlineSection(meta(), scenes)).toContain('必须直接朝主目标推进一步')
  })
})
