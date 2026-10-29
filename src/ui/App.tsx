import { AppProvider } from './store'
import { useRoute } from './router'
import { Codex } from './pages/Codex'
import { NewSpace } from './pages/NewSpace'
import { Play } from './pages/Play'
import { Shelf } from './pages/Shelf'
import { Settings } from './pages/Settings'
import { Export } from './pages/Export'
import { Timeline } from './pages/Timeline'
import { SpaceSettings } from './pages/SpaceSettings'
import { PersonaLibrary } from './pages/PersonaLibrary'
import { Search } from './pages/Search'
import { Dream } from './pages/Dream'
import { ErrorBoundary } from './ErrorBoundary'

export function App() {
  const route = useRoute()
  // 路由变化时重置兜底层，避免一次崩溃把整站锁在错误页
  const resetKey = `${route.name}:${'spaceId' in route ? route.spaceId : ''}`
  return (
    <AppProvider>
      <ErrorBoundary resetKey={resetKey}>
      {route.name === 'shelf' && <Shelf />}
      {route.name === 'new' && <NewSpace />}
      {route.name === 'play' && <Play spaceId={route.spaceId} />}
      {route.name === 'codex' && <Codex spaceId={route.spaceId} tab={route.tab} focus={route.focus} />}
      {route.name === 'timeline' && <Timeline spaceId={route.spaceId} />}
      {route.name === 'settings' && <Settings />}
      {route.name === 'export' && <Export spaceId={route.spaceId} />}
      {route.name === 'spaceSettings' && <SpaceSettings spaceId={route.spaceId} />}
      {route.name === 'library' && <PersonaLibrary />}
      {route.name === 'search' && <Search />}
      {route.name === 'dream' && <Dream spaceId={route.spaceId} />}
      </ErrorBoundary>
    </AppProvider>
  )
}
