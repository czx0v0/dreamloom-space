/**
 * 生图提示词：从档案里拼出来，不交给模型自由发挥。
 *
 * 为什么不用"让 LLM 先写一段 prompt"：多一次调用就多一次漂移，
 * 而这里需要的东西（谁、在哪、什么风格）档案里都有，直接取更准也更便宜。
 */

import type { CanonState, Place, Scene, SpaceMeta } from './types'

/** 统一的画风：不加这句，同一空间里的图会一半写实一半像游戏原画 */
const STYLE =
  '中文叙事插画，电影感构图，柔和自然光，细节克制，画面里不要出现文字、水印或边框'

const clean = (v: string | undefined | null, limit = 80) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)

function worldLine(canon: CanonState): string {
  const w = canon.world
  return (
    clean(w.oneLine, 60) ||
    clean(w.premise, 90) ||
    [clean(w.era, 20), clean(w.theme, 30)].filter(Boolean).join('，')
  )
}

export function coverPrompt(meta: SpaceMeta, canon: CanonState): string {
  const protag = canon.cast.find((c) => c.id === meta.protagId) ?? canon.cast.find((c) => c.status === 'alive')
  // 旧存档可能没有 removedAt 字段，用 == null 一并收下
  const place = canon.places.find((p) => p.removedAt == null)
  const parts = [
    `《${clean(meta.title, 30)}》封面插画`,
    worldLine(canon) && `世界：${worldLine(canon)}`,
    place && `地点：${clean(place.name, 20)}${clean(place.oneLine, 40) ? `（${clean(place.oneLine, 40)}）` : ''}`,
    protag && `人物：${clean(protag.name, 12)}，${clean(protag.oneLine, 40)}`,
    clean(meta.genre, 12) && `类型：${clean(meta.genre, 12)}`,
    clean(meta.tone, 12) && `基调：${clean(meta.tone, 12)}`,
    '竖构图，留出标题空间',
    STYLE,
  ]
  return parts.filter(Boolean).join('。')
}

export function castPrompt(name: string, oneLine: string, appearance: string, traits: string[], voice = ''): string {
  const parts = [
    `人物立绘：${clean(name, 12)}`,
    clean(oneLine, 50) && `身份：${clean(oneLine, 50)}`,
    clean(appearance, 90) && `外形：${clean(appearance, 90)}`,
    traits.length > 0 && `性格：${traits.slice(0, 4).map((t) => clean(t, 10)).join('、')}`,
    clean(voice, 30) && `气质：${clean(voice, 30)}`,
    '半身像，视线看向画面外，背景是这一世界的环境虚化',
    STYLE,
  ]
  return parts.filter(Boolean).join('。')
}

export function placePrompt(place: Place): string {
  const parts = [
    `场景设定图：${clean(place.name, 20)}`,
    clean(place.kind, 10) && `类型：${clean(place.kind, 10)}`,
    clean(place.oneLine, 60) && `印象：${clean(place.oneLine, 60)}`,
    place.features.length > 0 && `特征：${place.features.slice(0, 5).map((f) => clean(f, 12)).join('、')}`,
    '没有人或只有一个远景人影，强调空间本身',
    STYLE,
  ]
  return parts.filter(Boolean).join('。')
}

export function scenePrompt(
  scene: Scene,
  text: string,
  place: Place | null,
  present: string[],
): string {
  // 正文取前半段：结尾往往在给选择做铺垫，画面感不如开头强
  const excerpt = clean(text.replace(/\n+/g, ' '), 220)
  const parts = [
    `第 ${scene.index + 1} 幕画面：${excerpt}`,
    place && `地点：${clean(place.name, 20)}`,
    present.length > 0 && `在场：${present.slice(0, 4).map((n) => clean(n, 12)).join('、')}`,
    '横构图，强调这一瞬间的动作与光线',
    STYLE,
  ]
  return parts.filter(Boolean).join('。')
}

/** 摘要配图复用这一幕的画面：摘要说的是同一件事，没必要再画一次 */
export const summaryPrompt = scenePrompt
