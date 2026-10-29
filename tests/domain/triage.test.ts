import { describe, expect, it } from 'vitest'
import { parseTriage } from '../../src/domain/triage'
import type { Clue } from '../../src/domain/types'

const clue = (id: string, text: string): Clue => ({
  id,
  kind: 'open-thread',
  known: '已经查到的事',
  unknown: text,
  text,
  thread: { kind: 'main', id: null, label: '主线' },
  sceneId: 'sc_1',
  status: 'open',
  resolvedAtSceneId: null,
})

const clues = [clue('cl_1', '掌柜每晚上楼做什么'), clue('cl_2', '那封信藏在哪')]
const sceneText = '掌柜把钥匙推过来：“楼上那间，是他自己锁的。”他再没上去过。'

describe('parseTriage', () => {
  it('编号 + 正文原句 → 收线', () => {
    const out = parseTriage(
      '{"resolved":[{"n":1,"evidence":"楼上那间，是他自己锁的"}]}',
      clues,
      sceneText,
    )
    expect(out.ids).toEqual(['cl_1'])
    expect(out.dropped).toBe(0)
  })

  it('证据不在正文里就丢弃：宁可漏收，不可错收', () => {
    const out = parseTriage('{"resolved":[{"n":1,"evidence":"他昨晚在楼上烧了账本"}]}', clues, sceneText)
    expect(out.ids).toEqual([])
    expect(out.dropped).toBe(1)
  })

  it('证据过短（<4 字）不算数', () => {
    const out = parseTriage('{"resolved":[{"n":2,"evidence":"楼上"}]}', clues, sceneText)
    expect(out.ids).toEqual([])
    expect(out.dropped).toBe(1)
  })

  it('编号越界丢弃，不越界取到别的线索', () => {
    const out = parseTriage('{"resolved":[{"n":9,"evidence":"他再没上去过"}]}', clues, sceneText)
    expect(out.ids).toEqual([])
    expect(out.dropped).toBe(1)
  })

  it('同一编号重复出现只收一次', () => {
    const out = parseTriage(
      '{"resolved":[{"n":1,"evidence":"他再没上去过"},{"n":1,"evidence":"掌柜把钥匙推过来"}]}',
      clues,
      sceneText,
    )
    expect(out.ids).toEqual(['cl_1'])
  })

  it('空数组与坏 JSON 都不抛错', () => {
    expect(parseTriage('{"resolved":[]}', clues, sceneText).ids).toEqual([])
    expect(parseTriage('模型抽风了', clues, sceneText).ids).toEqual([])
  })
})

describe('parseTriage · 位置判定', () => {
  const places = ['同福客栈', '三号仓库']

  it('只认已知地点，且必须在正文里出现过', () => {
    const out = parseTriage(
      '{"resolved":[],"place":"三号仓库"}',
      clues,
      '他绕到三号仓库后墙，蹲下看那道锁。',
      places,
    )
    expect(out.place).toBe('三号仓库')
  })

  it('清单外的新地名不认（否则会造出一堆重复地点）', () => {
    const out = parseTriage('{"resolved":[],"place":"旧码头"}', clues, '他去了旧码头。', places)
    expect(out.place).toBeNull()
  })

  it('正文没提过这个地名就不认', () => {
    const out = parseTriage('{"resolved":[],"place":"三号仓库"}', clues, '他坐在窗边没动。', places)
    expect(out.place).toBeNull()
  })

  it('null / 原地 视为没有移动', () => {
    expect(parseTriage('{"resolved":[],"place":null}', clues, '他坐着。', places).place).toBeNull()
    expect(parseTriage('{"resolved":[],"place":"原地"}', clues, '他坐着。', places).place).toBeNull()
  })
})
