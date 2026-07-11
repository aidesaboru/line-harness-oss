'use client'

import Header from '@/components/layout/header'
import WebPushSettings from '@/components/notifications/web-push-settings'

export default function NotificationSettingsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Header
        title="通知設定"
        description="PC通知と社内チャット通知を管理します。"
      />

      <WebPushSettings />
    </div>
  )
}
