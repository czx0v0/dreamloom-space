/**
 * 叙事流过滤器：从流式 token 里剥掉 `<scene>` / `<choices>` 结构标签。
 *
 * 模型是边生成边吐字的，`<scene>` 会在第一个增量里就出现，`<choices>` 可能在
 * 任意位置出现。直接把这些增量喂给界面，用户会先看到 `<scene>` 四个字符，
 * 结尾再看到一串选项原文——这正是「特殊标记没处理」的另一半。
 *
 * 做成有状态的小对象而不是正则一次性替换：增量是跨 chunk 切的，
 * 标签本身可能被切成 `<sce` + `ne>`，必须能跨调用边界缓冲。
 */

/** 见到开标签之前，最多缓冲这么多字符；超过就认为模型没按格式写，直接当正文。 */
const NO_TAG_TOLERANCE = 200

/** 尾部保留长度：可能是半个闭合标签，留到下一次调用再判断。 */
const TAIL_KEEP = 12

const OPEN_TAG = '<scene>'
const STOP_PATTERNS = ['</scene>', '</choices>', '<choices>']

export interface SceneStream {
  /** 推入一段增量，返回可以立刻显示的正文（可能为空串）。 */
  push(chunk: string): string
  /** 流结束时调用，吐出所有剩余内容。 */
  flush(): string
}

export function createSceneStream(): SceneStream {
  let buffer = ''
  let started = false
  let stopped = false

  function drain(): string {
    if (stopped) return ''

    if (!started) {
      const at = buffer.indexOf(OPEN_TAG)
      if (at >= 0) {
        started = true
        buffer = buffer.slice(at + OPEN_TAG.length)
      } else if (
        buffer.length > NO_TAG_TOLERANCE ||
        STOP_PATTERNS.some((p) => buffer.includes(p))
      ) {
        // 模型没写 <scene>：不能一直憋着让用户干等，按正文处理
        started = true
      } else {
        return ''
      }
    }

    let cut = -1
    for (const pattern of STOP_PATTERNS) {
      const at = buffer.indexOf(pattern)
      if (at >= 0 && (cut < 0 || at < cut)) cut = at
    }
    if (cut >= 0) {
      stopped = true
      const text = buffer.slice(0, cut)
      buffer = ''
      return text
    }

    if (buffer.length <= TAIL_KEEP) return ''
    const text = buffer.slice(0, -TAIL_KEEP)
    buffer = buffer.slice(-TAIL_KEEP)
    return text
  }

  return {
    push(chunk: string): string {
      if (stopped) return ''
      buffer += chunk
      return drain()
    },
    flush(): string {
      if (stopped) return ''
      const text = started ? buffer : revealWithoutTag(buffer)
      buffer = ''
      stopped = true
      return text
    },
  }
}

/** flush 时还没有开标签：把可能残留的标签清理掉再当正文。 */
function revealWithoutTag(raw: string): string {
  const at = raw.indexOf(OPEN_TAG)
  let text = at >= 0 ? raw.slice(at + OPEN_TAG.length) : raw
  for (const pattern of STOP_PATTERNS) {
    const cut = text.indexOf(pattern)
    if (cut >= 0) text = text.slice(0, cut)
  }
  return text
}
