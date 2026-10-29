/** 生图与语音客户端：一次请求一张图 / 一段音频，回来的是 data URL。 */

import { DomainError, ERR } from '../domain/errors'
import { headers, readApiError, type ApiOptions } from './narrator'

export interface DrawResult {
  image: string
  model: string
  ms: number
}

export interface SpeakResult {
  audio: string
  model: string
  ms: number
}

async function post<T>(opts: ApiOptions, path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${opts.baseUrl ?? ''}${path}`, {
      method: 'POST',
      headers: headers(opts),
      body: JSON.stringify(body),
    })
  } catch {
    throw new DomainError(ERR.NETWORK)
  }
  if (!res.ok) throw await readApiError(res)
  return (await res.json()) as T
}

export interface MediaCheckResult {
  ok: boolean
  status: number
  reason: string
  base: string
  model: string
  protocol: string
  /** Key 从哪来：IMAGE_API_KEY / TTS_API_KEY / LLM_API_KEY / 浏览器 */
  keySource: string
  keyTail: string
  configured: boolean
}

export function createMedia(opts: ApiOptions = {}) {
  return {
    /** 生图。size 形如 1024x1024；模型留空由服务端按协议给默认值 */
    draw(req: { prompt: string; size?: string; model?: string }): Promise<DrawResult> {
      return post<DrawResult>(opts, '/api/image', req)
    },
    /**
     * 自检：不生成、不计费，只回答「图和语音的 Key 通不通」。
     * 用参数不全的请求探鉴权——上游回 400 就说明鉴权过了。
     */
    check(
      draft: { imageBase?: string; imageKey?: string; ttsBase?: string; ttsKey?: string } = {},
    ): Promise<{ image: MediaCheckResult; tts: MediaCheckResult }> {
      return post<{ image: MediaCheckResult; tts: MediaCheckResult }>(
        opts,
        '/api/media-check',
        draft,
      )
    },
    /** 朗读一段。voice 留空用供应商默认音色 */
    speak(req: { text: string; voice?: string; speed?: number; model?: string }): Promise<SpeakResult> {
      return post<SpeakResult>(opts, '/api/tts', req)
    },
  }
}
