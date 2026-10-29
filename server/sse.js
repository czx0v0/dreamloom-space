/** SSE 写帧：服务端专用。 */

// 解析逻辑在 shared/ 下，服务端与前端共用同一份实现
export { parseFrame, parseSseStream } from '../shared/sse.js'

export function createSse(res) {
  let closed = false
  let heartbeat = null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')

  const write = (chunk) => {
    if (closed) return
    try {
      res.write(chunk)
    } catch {
      closed = true
    }
  }

  heartbeat = setInterval(() => write(': ping\n\n'), 15000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  return {
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    comment(text) {
      write(`: ${text}\n\n`)
    },
    close() {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      try {
        res.end()
      } catch {
        /* 客户端已断开 */
      }
    },
    get closed() {
      return closed
    },
  }
}
