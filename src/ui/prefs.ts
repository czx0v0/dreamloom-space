/**
 * 界面与生成的全局偏好。
 *
 * 存在 localStorage 而不是 IndexedDB：
 *  - 它不属于任何故事空间，清存档时不该被一起清掉；
 *  - 需要在 React 挂载前就应用到 <html>，同步读取最省事。
 */

import type { CharPreset } from '../domain/types'

export type Theme = 'paper' | 'cool' | 'dark'

export interface Prefs {
  theme: Theme
  /** 正文缩放：0.92 小 / 1 标准 / 1.12 大 / 1.28 特大 */
  fontScale: number
  /** 新建空间的默认字数档位 */
  preset: CharPreset
  /** 新建空间的默认温度 */
  temperature: number
  /** 新建空间的默认选项数 */
  choiceCount: number
}

const STORAGE_KEY = 'dreamloom.prefs.v1'

export const DEFAULT_PREFS: Prefs = {
  theme: 'paper',
  fontScale: 1,
  preset: 'short',
  temperature: 0.9,
  choiceCount: 4,
}

export const THEME_LABEL: Record<Theme, string> = {
  paper: '暖纸',
  cool: '冷白',
  dark: '夜色',
}

export const FONT_SCALES: Array<{ value: number; label: string }> = [
  { value: 0.92, label: '小' },
  { value: 1, label: '标准' },
  { value: 1.12, label: '大' },
  { value: 1.28, label: '特大' },
]

function coerce(raw: unknown): Prefs {
  const input = (raw ?? {}) as Partial<Prefs>
  const theme: Theme =
    input.theme === 'cool' || input.theme === 'dark' || input.theme === 'paper'
      ? input.theme
      : DEFAULT_PREFS.theme
  const fontScale = FONT_SCALES.some((f) => f.value === input.fontScale)
    ? (input.fontScale as number)
    : DEFAULT_PREFS.fontScale
  const preset: CharPreset =
    input.preset === 'short' || input.preset === 'medium' || input.preset === 'long'
      ? input.preset
      : DEFAULT_PREFS.preset
  const temperature =
    typeof input.temperature === 'number' && input.temperature >= 0 && input.temperature <= 2
      ? input.temperature
      : DEFAULT_PREFS.temperature
  const choiceCount =
    typeof input.choiceCount === 'number' && input.choiceCount >= 0 && input.choiceCount <= 5
      ? Math.round(input.choiceCount)
      : DEFAULT_PREFS.choiceCount
  return { theme, fontScale, preset, temperature, choiceCount }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? coerce(JSON.parse(raw)) : { ...DEFAULT_PREFS }
  } catch {
    // 存档损坏不该让整个应用打不开
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下写入会失败，忽略即可：只是偏好没能记住 */
  }
}

/** 应用到 <html>：主题走属性选择器，字号走 CSS 变量。 */
export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement
  root.dataset.theme = prefs.theme
  root.style.setProperty('--font-scale', String(prefs.fontScale))
}
