import { describe, expect, it } from 'vitest'
import {
  buildCodexMarkdown,
  buildExport,
  buildFullMarkdown,
  buildOutlineMarkdown,
  buildStoryText,
  exportFileName,
  exportableScenes,
  type ExportDataSet,
} from '../../src/domain/export'
import type { Scene, SpaceMeta } from '../../src/domain/types'
import { makeCast, makePlace, makeRelation, makeWorld } from '../helpers'

function meta(over: Partial<SpaceMeta> = {}): SpaceMeta {
  return {
    id: 'sp_1',
    v: 1,
    title: '雾港旧案',
    cover: '🌫️',
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    genre: '悬疑',
    tone: '冷峻',
    pov: 'third',
    protagId: 'ch_1',
    settings: { charPreset: 'medium', temperature: 0.9, choiceCount: 3, recentSummaries: 8 },
    hardRules: ['雾港没有警察'],
    mainGoal: '查清十年前的旧案',
    objectives: [],
    endedAt: null,
    mode: 'goal',
    scheduled: [],
    sceneCount: 2,
    canonRev: 3,
    activeSceneId: 'sc_1',
    archiveWatermark: 'sc_1',
    stats: { calls: 2, inTok: 0, outTok: 0, chars: 20 },
    ...over,
  }
}

function scene(index: number, over: Partial<Scene> = {}): Scene {
  return {
    id: `sc_${index}`,
    spaceId: 'sp_1',
    index,
    status: 'committed',
    action: { kind: 'free', text: '推门' },
    choices: [],
    placeId: null,
    participants: [],
    summary: `第 ${index} 幕的摘要`,
    clues: [],
    textChars: 10,
    model: 'test',
    inTok: 0,
    outTok: 0,
    committedAt: 1,
    archivedAt: 1,
    patchId: null,
    ...over,
  }
}

function dataset(): ExportDataSet {
  return {
    space: meta(),
    world: makeWorld({ theme: '真相值不值得', premise: '一桩旧案' }),
    cast: [
      makeCast({ id: 'ch_1', name: '林昭', oneLine: '记者', traits: ['冷静'], secrets: ['他烧过档案'] }),
      makeCast({ id: 'ch_2', name: '掌柜', role: 'support', status: 'dead' }),
    ],
    places: [makePlace({ id: 'pl_1', name: '同福客栈', kind: '客栈', inventory: ['火柴'] })],
    relations: [makeRelation({ id: 'rl_1', aId: 'ch_1', bId: 'ch_2', kind: 'enemy', strength: 4 })],
    facts: [
      {
        id: 'ft_1',
        subject: '信',
        predicate: '写着',
        object: '三个字',
        kind: 'number',
        sceneId: 'sc_0',
        status: 'active',
        updatedAt: 1,
      },
    ],
    scenes: [
      { scene: scene(0, { clues: [
            {
              id: 'cl_1',
              kind: 'open-thread',
              text: '信是谁寄的',
              thread: { kind: 'main', id: null, label: '主线' },
              sceneId: 'sc_0',
              status: 'open',
              resolvedAtSceneId: null,
            },
          ] }), text: '他推开门。' },
      { scene: scene(1, { status: 'aborted' }), text: '这半截不该出现' },
      { scene: scene(2, { status: 'orphan', summary: '分支' }), text: '另一条路。' },
    ],
  }
}

describe('exportableScenes', () => {
  it('只导出 committed 与 orphan，aborted 永不导出', () => {
    const list = exportableScenes(dataset().scenes)
    expect(list.map((s) => s.scene.id)).toEqual(['sc_0', 'sc_2'])
  })
})

describe('buildStoryText', () => {
  it('带标题与幕序', () => {
    const md = buildStoryText(dataset())
    expect(md).toContain('# 雾港旧案')
    expect(md).toContain('## 第 1 幕')
    expect(md).toContain('他推开门。')
    expect(md).not.toContain('这半截不该出现')
  })

  it('孤儿分支被标注', () => {
    expect(buildStoryText(dataset())).toContain('（未采用分支）')
  })

  it('可以取消小标题', () => {
    expect(buildStoryText(dataset(), { withHeadings: false })).not.toContain('## 第 1 幕')
  })
})

describe('buildOutlineMarkdown', () => {
  it('包含主线目标与每幕摘要', () => {
    const md = buildOutlineMarkdown(dataset())
    expect(md).toContain('主线目标')
    expect(md).toContain('查清十年前的旧案')
    expect(md).toContain('第 0 幕的摘要')
    expect(md).toContain('1 开 / 0 收')
  })

  it('没有推进时给出空态', () => {
    const empty = { ...dataset(), scenes: [] }
    expect(buildOutlineMarkdown(empty)).toContain('还没有推进过')
  })
})

describe('buildCodexMarkdown', () => {
  it('六个区块齐全', () => {
    const md = buildCodexMarkdown(dataset())
    for (const heading of ['## 世界', '## 人物', '## 地点', '## 关系', '## 已知事实', '## 伏笔']) {
      expect(md).toContain(heading)
    }
  })

  it('死亡状态被标出', () => {
    expect(buildCodexMarkdown(dataset())).toContain('已死亡')
  })

  it('默认包含未揭示秘密，并显式标注', () => {
    const md = buildCodexMarkdown(dataset())
    expect(md).toContain('秘密（未揭示）')
    expect(md).toContain('他烧过档案')
  })

  it('可以关闭秘密导出（给别人看的时候）', () => {
    const md = buildCodexMarkdown(dataset(), { withSecrets: false })
    expect(md).not.toContain('他烧过档案')
  })

  it('实体与关系用可读标签而不是内部枚举', () => {
    const md = buildCodexMarkdown(dataset())
    expect(md).toContain('敌对')
    expect(md).not.toContain('| enemy |')
  })

  it('表格里的竖线被替换，不会破坏 Markdown', () => {
    const ds = dataset()
    ds.scenes[0].scene.summary = '他说 | 她笑'
    expect(buildOutlineMarkdown(ds)).toContain('他说 ｜ 她笑')
  })
})

describe('buildFullMarkdown', () => {
  it('档案、大纲、正文三段都在且标题不重复', () => {
    const md = buildFullMarkdown(dataset())
    expect(md).toContain('创作档案')
    expect(md).toContain('## 大纲')
    expect(md).toContain('# 正文')
    expect(md.match(/# 雾港旧案/g)?.length).toBe(1)
  })
})

describe('buildExport', () => {
  it('四种产物各不相同', () => {
    const ds = dataset()
    const outputs = (['story', 'outline', 'codex', 'full'] as const).map((f) => buildExport(ds, f))
    expect(new Set(outputs).size).toBe(4)
  })
})

describe('exportFileName', () => {
  it('去掉路径与空白字符', () => {
    expect(exportFileName('雾港 旧案/第二版', 'full')).toBe('雾港-旧案-第二版-全稿.md')
  })

  it('空标题有兜底', () => {
    expect(exportFileName('', 'story')).toBe('未命名-正文.md')
  })
})

describe('buildStoryText · 行动记录', () => {
  const ds = () => {
    const base = dataset()
    base.scenes[0].scene.action = { kind: 'option', text: '让阿棠带路去三号仓库' }
    return base
  }

  it('每幕前带上当时选了什么', () => {
    expect(buildStoryText(ds())).toContain('> 选择：让阿棠带路去三号仓库')
  })

  it('可以关掉，给读者看的版本不需要行动', () => {
    expect(buildStoryText(ds(), { withActions: false })).not.toContain('让阿棠带路')
  })
})
