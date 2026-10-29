/** 辅助生成客户端：固定事件 / 隐藏秘密。只拿回原始文本，解析在 domain/suggest.ts。 */

import { DomainError, ERR } from '../domain/errors'
import type { SuggestContext, SuggestKind } from '../domain/suggest'
import { headers, readApiError, type ApiOptions } from './narrator'
import type { SuggestPort } from './ports'

export function createSuggest(opts: ApiOptions = {}): SuggestPort {
  return {
    async suggest(req: { kind: SuggestKind; context: SuggestContext; target?: string }): Promise<{ text: string }> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/suggest`, {
          method: 'POST',
          headers: headers(opts),
          body: JSON.stringify(req),
        })
      } catch {
        throw new DomainError(ERR.NETWORK)
      }
      if (!res.ok) throw await readApiError(res)
      const body = (await res.json()) as { text?: string }
      return { text: String(body?.text ?? '') }
    },
  }
}
