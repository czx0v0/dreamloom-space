/**
 * 生成图的编排：查缓存 → 生图 → 落库。
 *
 * 省钱的规则只有一条：**同一条提示词不重复画**。
 * 用户想换一张，得先改提示词或点「重新生成」（force），
 * 否则每次进页面都调一次接口，几张图就把一天的额度吃掉。
 */

import type { Art, ArtKind } from '../domain/types'
import { fitImage } from './imageFit'
import type { createMedia } from '../agents/media'
import type { createRepo } from '../store/repo'

interface Deps {
  repo: ReturnType<typeof createRepo>
  media: ReturnType<typeof createMedia>
  now: () => number
}

export async function drawArt(
  deps: Deps,
  input: {
    spaceId: string
    kind: ArtKind
    id: string
    prompt: string
    size?: string
    /** true = 忽略缓存，直接重画 */
    force?: boolean
  },
): Promise<{ art: Art; cached: boolean }> {
  const { repo, media, now } = deps
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('没有画面描述')

  if (!input.force) {
    const existing = await repo.loadArt(input.spaceId, input.kind, input.id)
    if (existing && existing.prompt === prompt) return { art: existing, cached: true }
  }

  const result = await media.draw({ prompt, size: input.size })
  // 原图 base64 接近 1.9MB，入库前压到长边 768（图不会糊，存档不会炸）
  const dataUrl = await fitImage(result.image)
  const art: Art = {
    kind: input.kind,
    id: input.id,
    prompt,
    dataUrl,
    model: result.model,
    at: now(),
  }
  await repo.saveArt(input.spaceId, art)
  return { art, cached: false }
}
