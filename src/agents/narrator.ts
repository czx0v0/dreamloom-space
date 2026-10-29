/**
 * 叙事 Agent（客户端封装）：调 `/api/narrate`，把 SSE 帧转成事件流。
 *
 * 解析器复用 `shared/sse.js` —— 上游回包和自家回包格式一致，
 * 两套解析器迟早会在跨 chunk 或 CRLF 上分叉。
 */

import { parseSseStream } from '../../shared/sse.js'
import { DomainError, ERR } from '../domain/errors'
import type { NarrateRequest } from './contracts'
import type { NarrateEvent, NarrateHandle, NarratorPort } from './ports'

export interface ApiOptions {
  /** BYOK：仅存于用户浏览器，随请求头转发，服务端不落盘 */
  apiKey?: string
  /** 服务端访问口令（可选，防网络扫描） */
  token?: string
  /** 我们自己的服务地址（部署后一般留空，同源） */
  baseUrl?: string
  /** 上游接口地址（如 https://api.deepseek.com/v1）；服务端只放行白名单域名 */
  providerBase?: string
  /** 上游模型名 */
  model?: string
  /**
   * 多模态（生图/语音）的接口地址与 Key。
   * 文本用 DeepSeek、图用百炼是常见组合，所以两者必须能分开配。
   */
  mediaBase?: string
  mediaKey?: string
}

/** 所有 /api 请求共用：接口头只写一份，避免 x-llm-key 在某条路径上漏掉。 */
export function headers(opts: ApiOptions): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey) h['x-llm-key'] = opts.apiKey
  if (opts.token) h['x-dreamloom-token'] = opts.token
  if (opts.providerBase) h['x-llm-base'] = opts.providerBase
  if (opts.model) h['x-llm-model'] = opts.model
  if (opts.mediaBase) h['x-media-base'] = opts.mediaBase
  if (opts.mediaKey) h['x-media-key'] = opts.mediaKey
  return h
}

export async function readApiError(res: Response): Promise<DomainError> {
  let code = ERR.BAD_REQUEST
  let message = ''
  try {
    const body = await res.json()
    code = body?.error?.code ?? code
    message = body?.error?.message ?? ''
  } catch {
    // 网关超时/平台拦截会返回 HTML 或空 body。此时继续套用 E_BAD_REQUEST
    // 的默认文案（"请求参数不对"）是在撒谎：参数没问题，是请求没走到业务层。
    const hint =
      res.status === 502 || res.status === 503 || res.status === 504
        ? '网关或上游超时，通常再试一次就好（生图可能要 20–60 秒）'
        : res.status === 413
          ? '内容太大，被网关截断'
          : '服务器返回了非 JSON 响应'
    return new DomainError(ERR.NETWORK, `${hint}（HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}）`)
  }
  return new DomainError(code, message || undefined)
}

export function createNarrator(opts: ApiOptions = {}): NarratorPort {
  return {
    narrate(req: NarrateRequest, signal?: AbortSignal): NarrateHandle {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })

      async function* run(): AsyncGenerator<NarrateEvent> {
        let res: Response
        try {
          res = await fetch(`${opts.baseUrl ?? ''}/api/narrate`, {
            method: 'POST',
            headers: headers(opts),
            body: JSON.stringify(req),
            signal: controller.signal,
          })
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') return
          throw new DomainError(ERR.NETWORK)
        }

        if (!res.ok || !res.body) throw await readApiError(res)

        for await (const frame of parseSseStream(res.body)) {
          if (frame.data === '[DONE]') break
          let payload: unknown
          try {
            payload = JSON.parse(frame.data)
          } catch {
            continue
          }
          switch (frame.event) {
            case 'meta':
              yield { type: 'meta', data: payload as never }
              break
            case 'delta': {
              const text = (payload as { d?: string })?.d
              if (text) yield { type: 'delta', text }
              break
            }
            case 'notice':
              yield { type: 'notice', data: payload as never }
              break
            case 'usage':
              yield { type: 'usage', data: payload as never }
              break
            case 'done':
              yield { type: 'done', data: payload as never }
              return
            default:
              break
          }
        }
      }

      return {
        events: run(),
        abort: () => {
          controller.abort()
          signal?.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}
