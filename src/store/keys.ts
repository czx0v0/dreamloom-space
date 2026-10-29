/** 层级 key 的拼装与解析。所有前缀集中在这里，避免各处手写字符串。 */

export const K = {
  spaces: 'sp',
  meta: (sp: string) => `meta/${sp}`,
  world: (sp: string) => `world/${sp}`,
  cast: (sp: string, id: string) => `cast/${sp}/${id}`,
  place: (sp: string, id: string) => `place/${sp}/${id}`,
  rel: (sp: string, id: string) => `rel/${sp}/${id}`,
  scene: (sp: string, id: string) => `scene/${sp}/${id}`,
  text: (sp: string, id: string) => `text/${sp}/${id}`,
  /** 改写前的正文，只保留最近一份，用于撤销一步 */
  textOld: (sp: string, id: string) => `textOld/${sp}/${id}`,
  patch: (sp: string, id: string) => `patch/${sp}/${id}`,
  facts: (sp: string) => `facts/${sp}`,
  merges: (sp: string) => `merges/${sp}`,
  snap: (sp: string, rev: number) => `snap/${sp}/${rev}`,
  persona: (id: string) => `persona/${id}`,
  personas: 'personas',
} as const

export const P = {
  cast: (sp: string) => `cast/${sp}/`,
  place: (sp: string) => `place/${sp}/`,
  rel: (sp: string) => `rel/${sp}/`,
  scene: (sp: string) => `scene/${sp}/`,
  text: (sp: string) => `text/${sp}/`,
  patch: (sp: string) => `patch/${sp}/`,
  snap: (sp: string) => `snap/${sp}/`,
} as const

/** `cast/sp_x/ch_1` → 'ch_1' */
export function idFromKey(key: string): string {
  const idx = key.lastIndexOf('/')
  return idx < 0 ? key : key.slice(idx + 1)
}

/** `snap/sp_x/12` → 12 */
export function revFromKey(key: string): number {
  const raw = idFromKey(key)
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}
