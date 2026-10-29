/**
 * SSE 帧解析（纯函数，无运行时依赖）。
 *
 * 服务端与浏览器共用同一份实现：上游回包的格式和自家回包完全一样，
 * 写两套解析器必然会在某个边界（跨 chunk 切分、CRLF、多字节 UTF-8）上分叉。
 */

/**
 * 逐帧产出 { event, data }。
 * 必须能处理跨 chunk 切分的事件、CRLF、以及多字节 UTF-8 被切开的情况。
 */
export async function* parseSseStream(stream) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })

    let sep = findSeparator(buffer)
    while (sep) {
      const raw = buffer.slice(0, sep.index)
      buffer = buffer.slice(sep.index + sep.length)
      const frame = parseFrame(raw)
      if (frame) yield frame
      sep = findSeparator(buffer)
    }
  }

  buffer += decoder.decode()
  const tail = parseFrame(buffer)
  if (tail) yield tail
}

function findSeparator(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

export function parseFrame(raw) {
  const lines = String(raw ?? '').split(/\r?\n/)
  let event = 'message'
  const dataLines = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return null
  return { event, data: dataLines.join('\n') }
}
