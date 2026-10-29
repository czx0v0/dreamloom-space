import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyPrefs, loadPrefs } from './prefs'
import './styles.css'

// 挂载前先应用主题与字号，避免首帧闪一下默认样式
applyPrefs(loadPrefs())

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
