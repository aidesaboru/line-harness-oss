'use client'

import { useEffect } from 'react'

export default function PwaRuntime() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      void navigator.serviceWorker.register('/push-sw.js').catch(() => {
        // The app remains usable in browsers that block service workers.
      })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    return () => window.removeEventListener('load', register)
  }, [])

  return null
}
