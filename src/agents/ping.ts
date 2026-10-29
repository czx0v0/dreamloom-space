/**
 * 连通性探测客户端：设置页「测试连接」用。
 *
 * 真正的请求打在服务端（`/api/ping`）：浏览器直连上游会被 CORS 拦，
 * 而且把 Key 直接发到第三方域名上，页面上就多了一个不该有的出口。
 */

import { DomainError, ERR } from '../domain/errors'
import { headers, readApiError, type ApiOptions } from './narrator'

export interface PingResult {
  ok: boolean
  /** 往返毫秒 */
  ms: number
  /** 上游回显的模型名，与填写不一致时说明兼容层替换了模型 */
  model: string
  endpoint: string
}

export function createPing(opts: ApiOptions = {}) {
  return {
    async check(override: Partial<ApiOptions> = {}): Promise<PingResult> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/ping`, {
          method: 'POST',
          headers: headers({ ...opts, ...override }),
        })
      } catch {
        throw new DomainError(ERR.NETWORK)
      }
      if (!res.ok) throw await readApiError(res)
      const body = (await res.json()) as Partial<PingResult>
      return {
        ok: body.ok !== false,
        ms: Number(body.ms) || 0,
        model: String(body.model ?? ''),
        endpoint: String(body.endpoint ?? ''),
      }
    },
  }
}
