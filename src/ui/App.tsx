import { AppProvider } from './store'
import { useRoute } from './router'
import { Codex } from './pages/Codex'
import { NewSpace } from './pages/NewSpace'
import { Play } from './pages/Play'
import { Shelf } from './pages/Shelf'
import { Settings } from './pages/Settings'
import { Export } from './pages/Export'
import { Timeline } from './pages/Timeline'

export function App() {
  const route = useRoute()
  return (
    <AppProvider>
      {route.name === 'shelf' && <Shelf />}
      {route.name === 'new' && <NewSpace />}
      {route.name === 'play' && <Play spaceId={route.spaceId} />}
      {route.name === 'codex' && <Codex spaceId={route.spaceId} tab={route.tab} focus={route.focus} />}
      {route.name === 'timeline' && <Timeline spaceId={route.spaceId} />}
      {route.name === 'settings' && <Settings />}
      {route.name === 'export' && <Export spaceId={route.spaceId} />}
    </AppProvider>
  )
}
