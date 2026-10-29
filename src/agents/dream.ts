/** 入梦客户端：一次一步，只拿回一段旁白。 */

import { DomainError, ERR } from '../domain/errors'
import type { DreamRequest } from './contracts'
import { headers, readApiError, type ApiOptions } from './narrator'
import type { DreamPort, DreamStepResult } from './ports'

export function createDream(opts: ApiOptions = {}): DreamPort {
  return {
    async step(req: DreamRequest): Promise<DreamStepResult> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/dream`, {
          method: 'POST',
          headers: headers(opts),
          body: JSON.stringify(req),
        })
      } catch {
        throw new DomainError(ERR.NETWORK)
      }
      if (!res.ok) throw await readApiError(res)
      const body = (await res.json()) as { narration?: string }
      return { narration: String(body?.narration ?? '').trim() }
    },
  }
}
