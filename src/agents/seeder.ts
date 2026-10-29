/**
 * 空间设定生成：一句话 → 完整世界观草稿。
 *
 * 与档案员同一个原则：客户端只拿原始文本，解析与校验在 domain 层完成，
 * 服务端不重复实现一遍。
 */

import { DomainError } from '../domain/errors'
import { headers, readApiError, type ApiOptions } from './narrator'
import type { SeedPort, SeedRequest, SeedResponse } from './ports'

export function createSeeder(opts: ApiOptions = {}): SeedPort {
  return {
    async generate(req: SeedRequest): Promise<SeedResponse> {
      let res: Response
      try {
        res = await fetch(`${opts.baseUrl ?? ''}/api/seed`, {
          method: 'POST',
          headers: headers(opts),
          body: JSON.stringify({
            oneLine: req.oneLine,
            genre: req.genre,
            tone: req.tone,
          }),
        })
      } catch {
        throw new DomainError('E_NETWORK')
      }

      if (!res.ok) throw await readApiError(res)
      const body = (await res.json()) as SeedResponse
      return { text: String(body?.text ?? ''), usage: body?.usage }
    },
  }
}
