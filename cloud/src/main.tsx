import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConsolePage } from './pages/ConsolePage'
import { HomePage } from './home/HomePage'
import { FrameEval } from './dev/FrameEval'
import { AuthGate } from './components/AuthGate'
import './styles.css'
import { setImageOps } from './ai/image-ops'
import { browserImageOps } from './ai/frame-pack'

// 送模型的图在浏览器里用画布处理（云端服务用自己的实现）
setImageOps(browserImageOps)

/**
 * 页面：
 * - 默认：正式页面（《产品逻辑》3.6）
 * - ?dev=console 调试台（第一层参数、模型设置、片段详情……）
 * - ?dev=frames  送图方案对比（开发用）
 */
const devPage = new URLSearchParams(location.search).get('dev')

/** 页面出错时显示一句话，而不是整页空白（错误详情在浏览器控制台） */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <p>页面出了点问题：{this.state.error.message}</p>
        <button onClick={() => location.reload()}>刷新页面</button>
      </div>
    )
  }
}

function Root() {
  if (import.meta.env.DEV && devPage === 'frames') return <FrameEval />
  if (devPage === 'console') return <ConsolePage />
  return <HomePage />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <Root />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
)
