'use client'

import { useEffect, useRef } from 'react'
import { api } from '@/lib/api'

const HEARTBEAT_MS = 30_000

export default function StaffPresenceHeartbeat() {
  const inflightRef = useRef(false)
  const hasSentSessionStartRef = useRef(false)

  useEffect(() => {
    let active = true

    const beat = async (sessionStarted = false) => {
      if (!active || inflightRef.current) return
      inflightRef.current = true
      try {
        await api.staff.heartbeat({ sessionStarted })
        if (sessionStarted) hasSentSessionStartRef.current = true
      } catch {
        // Presence should never interrupt the operator workflow.
      } finally {
        inflightRef.current = false
      }
    }

    void beat(true)
    const timer = window.setInterval(() => {
      void beat(!hasSentSessionStartRef.current)
    }, HEARTBEAT_MS)
    const onActive = () => {
      void beat(!hasSentSessionStartRef.current)
    }

    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [])

  return null
}
