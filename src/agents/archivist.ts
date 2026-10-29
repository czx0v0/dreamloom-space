/**
 * 档案员 Agent（客户端封装）。
 *
 * 为什么解析与校验放在这里而不是服务端：
 * `parseLooseJson` 与 `validateOps` 已经在 domain 层测透了，服务端再实现一遍就是双份真相。
 * 坏 JSON 的处理因此变成「客户端解析失败 → 带原文再请求一次修复」，
 * 服务端只负责出修复 prompt。
 */

import { DomainError, ERR } from '../domain/errors'
import { parseLooseJson } from '../domain/jsonrepair'
import { validateOps } from '../domain/validate'
import type { ArchiveRequest, ArchiveResponse } from './contracts'
import type { ApiOptions } from './narrator'
import { readApiError } from './narrator'
import type { ArchivistPort } from './ports'

interface RawArchiveBody {
  text: string
  repaired: boolean
}

async function postArchive(
  body: Record<string, unknown>,
  opts: ApiOptions,
): Promise<RawArchiveBody> {
  // 与 narrator 共用同一套头：漏一个 x-llm-base，档案员就会打到服务端的默认地址上
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.apiKey ? { 'x-llm-key': opts.apiKey } : {}),
    ...(opts.token ? { 'x-dreamloom-token': opts.token } : {}),
    ...(opts.providerBase ? { 'x-llm-base': opts.providerBase } : {}),
    ...(opts.model ? { 'x-llm-model': opts.model } : {}),
  }

  let res: Response
  try {
    res = await fetch(`${opts.baseUrl ?? ''}/api/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch {
    throw new DomainError(ERR.NETWORK)
  }
  if (!res.ok) throw await readApiError(res)
  return (await res.json()) as RawArchiveBody
}

export function createArchivist(opts: ApiOptions = {}): ArchivistPort {
  return {
    async archive(req: ArchiveRequest): Promise<ArchiveResponse> {
      const first = await postArchive({ ...req }, opts)

      let parsed = tryParse(first.text, req.sceneText)
      let repaired = first.repaired
      if (!parsed) {
        // 只修格式，不许补内容；失败就放弃，不阻塞下一幕
        const second = await postArchive(
          { ...req, repair: { previousRaw: first.text.slice(0, 4000) } },
          opts,
        )
        parsed = tryParse(second.text, req.sceneText)
        repaired = true
      }

      if (!parsed) {
        throw new DomainError(ERR.PARSE_FAILED, '这一段的档案没能整理出来，正文已保留')
      }

      return {
        summary: parsed.summary,
        ops: parsed.ops,
        warnings: parsed.warnings,
        usage: { inTok: 0, outTok: 0 },
        repaired,
      }
    },
  }
}

function tryParse(
  raw: string,
  sceneText: string,
): { summary: string; ops: ReturnType<typeof validateOps>['ops']; warnings: string[] } | null {
  let data: unknown
  try {
    data = parseLooseJson(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>

  const { ops, warnings: opWarnings } = validateOps(record.ops, sceneText, { maxOps: 20 })
  const rawWarnings = Array.isArray(record.warnings)
    ? record.warnings.filter((w): w is string => typeof w === 'string').slice(0, 5)
    : []

  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 80) : ''

  // 一条 op 都没解析出来的情况下，仍然接受摘要（摘要对大纲有价值）
  return { summary, ops, warnings: [...opWarnings, ...rawWarnings].slice(0, 10) }
}
