import { describe, expect, it } from 'vitest'
import { parseFrame, parseSseStream } from '../../server/sse.js'

async function* fromChunks(chunks: Array<string | Uint8Array>) {
  for (const chunk of chunks) yield chunk
}

async function collect(chunks: Array<string | Uint8Array>) {
  const out: Array<{ event: string; data: string }> = []
  for await (const frame of parseSseStream(fromChunks(chunks))) out.push(frame)
  return out
}

describe('parseFrame', () => {
  it('默认事件名是 message', () => {
    expect(parseFrame('data: {"a":1}')).toEqual({ event: 'message', data: '{"a":1}' })
  })

  it('解析命名事件', () => {
    expect(parseFrame('event: delta\ndata: {"d":"x"}')).toEqual({ event: 'delta', data: '{"d":"x"}' })
  })

  it('忽略注释帧', () => {
    expect(parseFrame(': ping')).toBeNull()
  })

  it('多行 data 用换行拼接', () => {
    expect(parseFrame('data: 第一行\ndata: 第二行')).toEqual({
      event: 'message',
      data: '第一行\n第二行',
    })
  })
})

describe('parseSseStream', () => {
  it('一个 chunk 里有多帧', async () => {
    const frames = await collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'])
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  it('帧被切在 chunk 边界上也能拼回来', async () => {
    const frames = await collect(['event: delta\ndata: {"d":"他', '推开门"}\n\n'])
    expect(frames).toHaveLength(1)
    expect(frames[0].data).toBe('{"d":"他推开门"}')
  })

  it('CRLF 分隔符', async () => {
    const frames = await collect(['event: a\r\ndata: 1\r\n\r\n'])
    expect(frames).toEqual([{ event: 'a', data: '1' }])
  })

  it('多字节 UTF-8 被切开不会乱码', async () => {
    const payload = 'data: 他说：「雾里有鬼。」\n\n'
    const bytes = new TextEncoder().encode(payload)
    // 故意切在汉字中间
    const frames = await collect([bytes.slice(0, 9), bytes.slice(9)])
    expect(frames[0].data).toBe('他说：「雾里有鬼。」')
  })

  it('忽略心跳注释', async () => {
    const frames = await collect([': ping\n\nevent: delta\ndata: 1\n\n'])
    expect(frames).toHaveLength(1)
  })

  it('结尾没有空行也能取出最后一帧', async () => {
    const frames = await collect(['data: {"done":true}'])
    expect(frames).toHaveLength(1)
    expect(frames[0].data).toBe('{"done":true}')
  })
})
