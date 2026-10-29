/**
 * KV 端口：仓储只依赖这个接口，不依赖 IndexedDB。
 * 单库单 store + 前缀 key（不用 idb-keyval 的多 store：同一 db 的第二个 store
 * 在 db 已存在时不会触发 upgrade，会直接 NotFoundError）。
 */

export interface KvPort {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  del(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

/** 测试与 SSR 用的内存实现。 */
export function createMemoryKv(initial: Record<string, unknown> = {}): KvPort & {
  dump: () => Record<string, unknown>
} {
  const map = new Map<string, unknown>(Object.entries(initial))
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined
    },
    async set<T>(key: string, value: T) {
      map.set(key, structuredClone(value))
    },
    async del(key: string) {
      map.delete(key)
    },
    async keys(prefix: string) {
      return Array.from(map.keys()).filter((k) => k.startsWith(prefix))
    },
    dump() {
      return Object.fromEntries(map)
    },
  }
}

/** 浏览器实现。延迟 import，避免测试环境加载 IndexedDB。 */
export async function createIdbKv(): Promise<KvPort> {
  const mod = await import('idb-keyval')
  return {
    get: <T,>(key: string) => mod.get<T>(key),
    set: <T,>(key: string, value: T) => mod.set(key, value),
    del: (key: string) => mod.del(key),
    async keys(prefix: string) {
      const all = await mod.keys()
      return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
    },
  }
}
