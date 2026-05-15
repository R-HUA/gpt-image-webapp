import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { getAdminSettings, getSession } from './lib/backend'
import type { BackendUser } from './lib/backend'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
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

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const [user, setUser] = useState<BackendUser | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [route, setRoute] = useState(window.location.pathname === '/gallery' ? 'gallery' : 'home')
  useDockerApiUrlMigrationNotice()

  const refreshSession = () => {
    getSession()
      .then((res) => {
        setUser(res.user)
        if (res.user?.role === 'admin') {
          getAdminSettings()
            .then((settingsRes) => setSettings({ adminServerImagePath: settingsRes.settings?.serverImagePath || '' }))
            .catch(() => {})
        } else {
          setSettings({ adminServerImagePath: '' })
        }
      })
      .catch(() => setUser(null))
      .finally(() => setSessionLoaded(true))
  }

  useEffect(() => {
    refreshSession()
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
      <Header user={user} onLogout={() => { setUser(null); navigate('home') }} onOpenGallery={() => navigate('gallery')} />
      <main data-home-main data-drag-select-surface className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto">
          <SearchBar />
          <TaskGrid />
        </div>
      </main>
      <InputBar user={user} />
      <DetailModal />
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
