'use client'

import { useEffect, useState } from 'react'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type NavigatorWithStandalone = Navigator & { standalone?: boolean }

function InstallIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  )
}

export default function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [isIos, setIsIos] = useState(false)
  const [isStandalone, setIsStandalone] = useState(true)
  const [showIosGuide, setShowIosGuide] = useState(false)

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as NavigatorWithStandalone).standalone)
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    setIsStandalone(standalone)
    setIsIos(ios)

    const onInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    const onInstalled = () => {
      setInstallPrompt(null)
      setShowIosGuide(false)
      setIsStandalone(true)
    }

    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (isStandalone || (!installPrompt && !isIos)) return null

  const requestInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt()
      await installPrompt.userChoice
      setInstallPrompt(null)
      return
    }
    setShowIosGuide(true)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void requestInstall()}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
        aria-label="ホーム画面に追加"
        title="ホーム画面に追加"
      >
        <InstallIcon />
      </button>

      {showIosGuide && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 p-3" role="dialog" aria-modal="true" aria-labelledby="pwa-install-title">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => setShowIosGuide(false)} aria-label="閉じる" />
          <div className="relative w-full max-w-md rounded-lg bg-white px-5 pb-[calc(20px_+_env(safe-area-inset-bottom))] pt-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="pwa-install-title" className="text-base font-bold text-slate-900">ホーム画面に追加</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">共有メニューを開き「ホーム画面に追加」を選択してください</p>
              </div>
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
                aria-label="閉じる"
              >
                <CloseIcon />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
