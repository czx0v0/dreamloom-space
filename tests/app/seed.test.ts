import { describe, expect, it } from 'vitest'
import { parseSeedText, validateSeed } from '../../src/app/seed'
import { DomainError } from '../../src/domain/errors'

const base = () => ({
  world: { name: '雾港', era: '民国十七年', theme: '真相值不值得', premise: '旧账未清', rules: ['天黑不出海'], factions: ['潮帮'] },
  cast: [
    { name: '林昭', role: 'protagonist', oneLine: '记者', voice: '慢', traits: ['固执'], goal: '查父亲死因' },
    { name: '阿棠', role: 'support', oneLine: '客栈姑娘', voice: '', traits: [], goal: '' },
  ],
  places: [
    { name: '同福客栈', kind: '客栈', oneLine: '', features: [] },
    { name: '三号仓库', kind: '仓库', oneLine: '', features: [] },
  ],
  opening: '雾漫上码头。',
})

describe('validateSeed · 正常输入', () => {
  it('原样通过，不产生调整说明', () => {
    const d = validateSeed(base())
    expect(d.cast).toHaveLength(2)
    expect(d.places).toHaveLength(2)
    expect(d.notes).toEqual([])
    expect(d.world.name).toBe('雾港')
  })
})

describe('validateSeed · 降级', () => {
  it('没有主角时把第一个人升为主角', () => {
    const raw = base()
    raw.cast = raw.cast.map((c) => ({ ...c, role: 'support' }))
    const d = validateSeed(raw)
    expect(d.cast[0].role).toBe('protagonist')
    expect(d.notes.join()).toContain('没有指定主角')
  })

  it('多个主角时只留第一个', () => {
    const raw = base()
    raw.cast = raw.cast.map((c) => ({ ...c, role: 'protagonist' }))
    const d = validateSeed(raw)
    expect(d.cast.filter((c) => c.role === 'protagonist')).toHaveLength(1)
    expect(d.notes.join()).toContain('只保留第一个')
  })

  it('名字为空的人被丢弃', () => {
    const raw = base()
    raw.cast = [...raw.cast, { name: '  ', role: 'extra', oneLine: '', voice: '', traits: [], goal: '' }]
    expect(validateSeed(raw).cast).toHaveLength(2)
  })

  it('人物一个都不剩时直接失败（不硬造人）', () => {
    const raw = base()
    raw.cast = [{ name: '', role: 'support', oneLine: '', voice: '', traits: [], goal: '' }]
    expect(() => validateSeed(raw)).toThrow(DomainError)
  })

  it('人物超过 5 个截断并说明', () => {
    const raw = base()
    raw.cast = Array.from({ length: 8 }, (_, i) => ({
      name: `人${i}`,
      role: 'support',
      oneLine: '',
      voice: '',
      traits: [],
      goal: '',
    }))
    const d = validateSeed(raw)
    expect(d.cast).toHaveLength(5)
    expect(d.notes.join()).toContain('超过 5 个')
  })

  it('地点不足两个时补一个（否则无处可去）', () => {
    const raw = base()
    raw.places = [{ name: '同福客栈', kind: '客栈', oneLine: '', features: [] }]
    const d = validateSeed(raw)
    expect(d.places).toHaveLength(2)
    expect(d.notes.join()).toContain('地点太少')
  })

  it('地点超过 4 个截断', () => {
    const raw = base()
    raw.places = Array.from({ length: 6 }, (_, i) => ({
      name: `地${i}`,
      kind: '场所',
      oneLine: '',
      features: [],
    }))
    expect(validateSeed(raw).places).toHaveLength(4)
  })

  it('非法 role 归为 support', () => {
    const raw = base()
    raw.cast = [{ name: '某人', role: 'boss', oneLine: '', voice: '', traits: [], goal: '' }]
    const d = validateSeed(raw)
    expect(d.cast[0].role).toBe('protagonist') // 唯一的一个人会被升为主角
  })

  it('世界名缺失时给一个可用的默认名', () => {
    expect(validateSeed({ ...base(), world: {} }).world.name).toBe('未命名世界')
  })
})

describe('parseSeedText', () => {
  it('能从带代码块与尾逗号的输出里解析出来', () => {
    const text = '```json\n{"world":{"name":"雾港"},"cast":[{"name":"林昭","role":"protagonist"}],"places":[{"name":"客栈"}]}\n```'
    const d = parseSeedText(text)
    expect(d.world.name).toBe('雾港')
    expect(d.places).toHaveLength(2)
  })

  it('完全不是 JSON 时抛可读错误', () => {
    expect(() => parseSeedText('我写了一段散文，不是 JSON')).toThrow(DomainError)
  })
})

describe('validateSeed · 剧情节拍', () => {
  it('提取合法的事件节点', () => {
    const d = validateSeed({
      ...base(),
      events: [
        { at: 4, text: '雨停了' },
        { at: 9, text: '有人敲门' },
      ],
    })
    expect(d.events).toEqual([
      { atSceneIndex: 4, text: '雨停了' },
      { atSceneIndex: 9, text: '有人敲门' },
    ])
  })

  it('最多保留 3 个', () => {
    const d = validateSeed({
      ...base(),
      events: Array.from({ length: 6 }, (_, i) => ({ at: i, text: `事件${i}` })),
    })
    expect(d.events).toHaveLength(3)
  })

  it('幕序重复的只留第一个，非法值丢弃', () => {
    const d = validateSeed({
      ...base(),
      events: [
        { at: 3, text: '第一个' },
        { at: 3, text: '重复幕序' },
        { at: -1, text: '负数' },
        { text: '没有幕序' },
      ],
    })
    expect(d.events).toEqual([{ atSceneIndex: 3, text: '第一个' }])
  })

  it('没有 events 字段时是空数组，不报错', () => {
    expect(validateSeed(base()).events).toEqual([])
  })
})
