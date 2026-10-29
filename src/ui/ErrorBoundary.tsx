/**
 * 渲染兜底：任何一页崩了，都不要整站白屏。
 *
 * 之前的"深度审查"漏了一类问题：页面里读了旧数据里不存在的字段，
 * 一进那个路由就白屏、控制台只有一串压缩后的栈，用户完全不知道发生了什么，
 * 也没法回到其他页面。这里把崩溃收在单个路由内，并给一条能自报家门的路。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 换第几个 key 就重置一次：路由变化时由外层传，避免一直卡在错误页 */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    // 路由变了就清掉错误，否则修好也回不来
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[render]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const detail = `${error.name}: ${error.message}`
    return (
      <div className="page narrow crash">
        <h1>这一页没能打开</h1>
        <p className="muted">
          你的数据没有丢，只是这个页面的渲染出错了。可以回书架继续，或者重试一次。
        </p>
        <pre className="crash-detail">{detail}</pre>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            回到书架
          </button>
          <button className="btn ghost" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(`${detail}\n${error.stack ?? ''}`)
            }}
          >
            复制错误信息
          </button>
        </div>
      </div>
    )
  }
}
