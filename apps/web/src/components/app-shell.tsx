'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import { UpdateBanner } from './update/update-banner'
import AuthGuard from './auth-guard'
import StaffRouteGuard from './staff-route-guard'
import AppNotifier from './app-notifier'
import StaffPresenceHeartbeat from './staff-presence-heartbeat'
import { AccountProvider } from '@/contexts/account-context'
import MobileBottomNav from './layout/mobile-bottom-nav'
import PwaRuntime from './pwa/pwa-runtime'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/login') {
    return <>{children}</>
  }

  const isMobileWorkspace = pathname.startsWith('/chats') || pathname.startsWith('/internal-chat')

  return (
    <AuthGuard>
      <StaffRouteGuard>
        <AccountProvider>
          <div className="flex min-h-[100dvh] flex-col">
            <PwaRuntime />
            <AppNotifier />
            <StaffPresenceHeartbeat />
            {/* Phase 6: banner above sidebar+header so it pins to the top of the
                admin shell. Renders nothing while loading; one of latest/fork/
                upgrade once /admin/version + manifest resolve. */}
            <UpdateBanner />
            <div className="flex flex-1 min-h-0">
              <Sidebar />
              <main className={`min-w-0 flex-1 pb-[calc(64px_+_env(safe-area-inset-bottom))] pt-[calc(64px_+_env(safe-area-inset-top))] lg:pb-0 lg:pt-0 ${isMobileWorkspace ? 'overflow-hidden' : 'overflow-auto'}`}>
                <div className={isMobileWorkspace ? 'h-full px-0 pb-0 lg:px-8 lg:pb-8 lg:pt-8' : 'px-4 pb-6 sm:px-6 lg:px-8 lg:pb-8 lg:pt-8'}>
                  {children}
                </div>
              </main>
              <MobileBottomNav />
            </div>
          </div>
        </AccountProvider>
      </StaffRouteGuard>
    </AuthGuard>
  )
}
