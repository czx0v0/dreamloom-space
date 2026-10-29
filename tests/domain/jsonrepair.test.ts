import { describe, expect, it } from 'vitest'
import { extractJsonObject, JsonRepairError, parseLooseJson } from '../../src/domain/jsonrepair'

describe('extractJsonObject', () => {
  it('剥掉 markdown fence 与前后废话', () => {
    const text = '好的，结果如下：\n```json\n{"a":1}\n```\n希望有帮助'
    expect(extractJsonObject(text)).toBe('{"a":1}')
  })

  it('字符串内的花括号不会提前截断', () => {
    const text = '{"summary":"他说{我不同意}","n":1}'
    expect(extractJsonObject(text)).toBe(text)
  })

  it('转义引号不会打断字符串状态', () => {
    const text = '{"a":"她说\\"好\\"","b":2}'
    expect(extractJsonObject(text)).toBe(text)
  })

  it('多个对象只取第一个', () => {
    expect(extractJsonObject('{"a":1}{"b":2}')).toBe('{"a":1}')
  })

  it('没有对象时返回 null', () => {
    expect(extractJsonObject('完全没有 JSON')).toBeNull()
  })
})

describe('parseLooseJson', () => {
  it('正常 JSON', () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('尾逗号', () => {
    expect(parseLooseJson('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] })
  })

  it('中文引号', () => {
    expect(parseLooseJson('{“a”:“b”}')).toEqual({ a: 'b' })
  })

  it('中文冒号与逗号', () => {
    expect(parseLooseJson('{"a"："b"，"c"：2}')).toEqual({ a: 'b', c: 2 })
  })

  it('字符串里的真实换行', () => {
    const text = '{"summary":"第一行\n第二行"}'
    expect(parseLooseJson(text)).toEqual({ summary: '第一行\n第二行' })
  })

  it('未闭合的右括号会被补全', () => {
    expect(parseLooseJson('{"a":1,"b":{"c":2')).toEqual({ a: 1, b: { c: 2 } })
  })

  it('外层包着自然语言也能取出', () => {
    expect(parseLooseJson('这是结果：\n{"ops":[]}\n以上。')).toEqual({ ops: [] })
  })

  it('实在解析不出来时抛 JsonRepairError', () => {
    expect(() => parseLooseJson('{ 完全不是 JSON }')).toThrow(JsonRepairError)
  })
})
