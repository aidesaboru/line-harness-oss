import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Lリンク',
    short_name: 'Lリンク',
    description: 'LINE公式アカウントCRMサービス',
    lang: 'ja',
    start_url: '/chats?source=pwa',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#00b94f',
    categories: ['business', 'productivity'],
    icons: [
      {
        src: '/icons/l-link-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/l-link-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/l-link-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/l-link-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: '個別チャット',
        short_name: '個別チャット',
        url: '/chats',
        icons: [
          {
            src: '/icons/l-link-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
      {
        name: '社内チャット',
        short_name: '社内チャット',
        url: '/internal-chat',
        icons: [
          {
            src: '/icons/l-link-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
      {
        name: '通知センター',
        short_name: '通知',
        url: '/notifications',
        icons: [
          {
            src: '/icons/l-link-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
    ],
  }
}
