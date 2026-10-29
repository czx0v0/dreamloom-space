/** 极简 hash 路由：路径够用即可，不引路由库。 */

import { useEffect, useState } from 'react'

export type Route =
  | { name: 'shelf' }
  | { name: 'new' }
  | { name: 'play'; spaceId: string }
  | { name: 'codex'; spaceId: string; tab?: string; focus?: string }
  | { name: 'timeline'; spaceId: string }
  | { name: 'settings' }
  | { name: 'export'; spaceId: string }

export function parseHash(hash = window.location.hash): Route {
  const clean = hash.replace(/^#\/?/, '')
  // 必须保留全部段：早前只解构前三段，导致 `#/s/:id/codex/cast` 里的 tab 被丢掉，
  // 标签深链一直是空转的。现在按段取，多余段自然为 undefined。
  const parts = clean.split('/').filter(Boolean)
  const [head, id, section, tab, focus] = parts
  if (head === 'new') return { name: 'new' }
  if (head === 'settings') return { name: 'settings' }
  if (head === 's' && id) {
    if (section === 'codex') return { name: 'codex', spaceId: id, tab, focus }
    if (section === 'timeline') return { name: 'timeline', spaceId: id }
    if (section === 'export') return { name: 'export', spaceId: id }
    return { name: 'play', spaceId: id }
  }
  return { name: 'shelf' }
}

export function navigate(path: string) {
  window.location.hash = path
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash())
  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
