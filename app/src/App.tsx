import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Workspace from './pages/Workspace'
import NotFound from "./pages/NotFound"
import { Toaster } from '@/components/ui/sonner'

// iframe 渲染器独立分包:隔离 antd 等渲染依赖与全局样式,仅 /render 加载
const RendererPage = lazy(() => import('./pages/RendererPage'))

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/project/:id" element={<Workspace />} />
        <Route
          path="/render"
          element={
            <Suspense fallback={null}>
              <RendererPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster position="bottom-right" />
    </>
  )
}
