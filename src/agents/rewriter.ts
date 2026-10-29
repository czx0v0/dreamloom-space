/**
 * 改写某一幕：压缩或重写。
 *
 * 服务端只返回候选文本，落库由 app 层决定——正文是权威数据，
 * 不能让"顺手点了一下"悄悄改掉历史。
 */

import { DomainError } from '../domain/errors'
import { headers, readApiError, type ApiOptions } from './narrator'
import type { RewritePort, RewriteRequest, RewriteResponse } from './ports'

export function createRewriter(opts: ApiOptions = {}): RewritePort {
  return {
    async rewrite(req: RewriteRequest): Promise<RewriteResponse> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/rewrite`, {
          method: 'POST',
          headers: headers(opts),
          body: JSON.stringify(req),
        })
      } catch {
        throw new DomainError('E_NETWORK')
      }

      if (!res.ok) throw await readApiError(res)
      const body = (await res.json()) as RewriteResponse
      return { text: String(body?.text ?? ''), usage: body?.usage }
    },
  }
}
