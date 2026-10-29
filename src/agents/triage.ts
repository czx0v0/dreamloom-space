/** 收线判定客户端：只要一段 JSON 文本，解析与校验在 `domain/triage.ts`。 */

import { DomainError, ERR } from '../domain/errors'
import { headers, readApiError, type ApiOptions } from './narrator'
import type { TriagePort, TriageRequest } from './ports'

export function createTriage(opts: ApiOptions = {}): TriagePort {
  return {
    async triage(req: TriageRequest): Promise<{ text: string }> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/triage`, {
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
