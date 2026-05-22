import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { getRuntimeSettings, getSession } from './lib/backend'
import type { BackendUser } from './lib/backend'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import LoginScreen from './components/LoginScreen'
import GalleryPage from './components/GalleryPage'
import BatchDetailModal from './components/BatchDetailModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const setServerImageBatchMode = useStore((s) => s.setServerImageBatchMode)
  const appMode = useStore((s) => s.appMode)
  const [user, setUser] = useState<BackendUser | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [route, setRoute] = useState(window.location.pathname === '/gallery' ? 'gallery' : 'home')
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  const clearBackendRuntimeState = () => {
    setServerImageBatchMode(false)
    setSettings({ adminServerImagePath: '', backendCodexCli: false })
  }

  const refreshSession = () => {
    getSession()
      .then((res) => {
        setUser(res.user)
        if (res.user?.role !== 'admin') {
          setServerImageBatchMode(false)
        }
        if (res.user) {
          getRuntimeSettings()
            .then((settingsRes) => setSettings({
              adminServerImagePath: settingsRes.settings?.serverImagePath || '',
              backendCodexCli: Boolean(settingsRes.settings?.codexCli),
            }))
            .catch(clearBackendRuntimeState)
        } else {
          clearBackendRuntimeState()
        }
      })
      .catch(() => {
        setUser(null)
        clearBackendRuntimeState()
      })
      .finally(() => setSessionLoaded(true))
  }

  useEffect(() => {
    refreshSession()
  }, [])

  // Auto-redirect to login when session expires during API calls (e.g., polling)
  useEffect(() => {
    const handler = () => {
      setUser(null)
      clearBackendRuntimeState()
    }
    window.addEventListener('gip-session-expired', handler)
    return () => window.removeEventListener('gip-session-expired', handler)
  }, [])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname === '/gallery' ? 'gallery' : 'home')
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: 'home' | 'gallery') => {
    const path = next === 'gallery' ? '/gallery' : '/'
    window.history.pushState(null, '', path)
    setRoute(next)
  }

  if (!sessionLoaded) {
    return <div className="min-h-screen bg-gray-50 dark:bg-gray-950" />
  }

  if (!user) {
    return <LoginScreen onLogin={refreshSession} />
  }

  if (route === 'gallery') {
    return <GalleryPage user={user} onBack={() => navigate('home')} />
  }

  return (
    <>
      <Header
        user={user}
        onLogout={() => {
          setUser(null)
          clearBackendRuntimeState()
          navigate('home')
        }}
        onOpenGallery={() => navigate('gallery')}
      />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar user={user} />
      <DetailModal />
      <BatchDetailModal />
      <Lightbox />
      <SettingsModal user={user} />
      <ConfirmDialog />
      <SupportPromptModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
