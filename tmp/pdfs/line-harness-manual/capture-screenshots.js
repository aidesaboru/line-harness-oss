const { chromium } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')

const base = 'http://127.0.0.1:4175'
const outDir = '/Users/shinichi/Project/ec-owner-line-harness/tmp/pdfs/line-harness-manual/screenshots'
const now = '2026-06-29T10:30:00+09:00'
const accountId = 'acc-ec-owner'
const avatar = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#06C755"/><text x="48" y="57" font-family="Arial" font-size="30" font-weight="700" text-anchor="middle" fill="white">EC</text></svg>',
)

const tags = [
  { id: 'tag-vip', name: '重要', color: '#ef4444', createdAt: now },
  { id: 'tag-shop', name: '出店者', color: '#22c55e', createdAt: now },
  { id: 'tag-wait', name: '確認中', color: '#f59e0b', createdAt: now },
]

const lineAccounts = [{
  id: accountId,
  channelId: '2010413723',
  name: 'ECオーナーLINE',
  displayName: 'ECオーナーLINE',
  pictureUrl: avatar,
  basicId: '@ec-owner',
  channelAccessToken: '',
  channelSecret: '',
  loginChannelId: null,
  loginChannelSecret: null,
  liffId: null,
  isActive: true,
  country: '日本',
  role: '本番',
  displayOrder: 0,
  createdAt: now,
  updatedAt: now,
  stats: { friendCount: 1280, activeScenarios: 0, messagesThisMonth: 420 },
}]

const staff = [
  { id: 'staff-owner', name: '吉田 京平', email: 'owner@example.com', role: 'owner', apiKey: '', isActive: true, createdAt: now, updatedAt: now },
  { id: 'staff-primary', name: '一次担当A', email: 'primary@example.com', role: 'staff', apiKey: '', isActive: true, createdAt: now, updatedAt: now },
  { id: 'staff-secondary', name: 'オーナー', email: 'secondary@example.com', role: 'admin', apiKey: '', isActive: true, createdAt: now, updatedAt: now },
  { id: 'staff-support', name: '梶原 麻奈美', email: 'kajihara@example.com', role: 'admin', apiKey: '', isActive: true, createdAt: now, updatedAt: now },
]
const assigneeOptions = staff.map(({ id, name, role, isActive }) => ({ id, name, role, isActive }))

const friends = [
  {
    id: 'friend-001',
    lineUserId: 'U001',
    displayName: '田中 美咲',
    pictureUrl: null,
    statusMessage: null,
    isFollowing: true,
    tags: [tags[0], tags[1]],
    metadata: { customerNumber: 'C-1024', companyName: '田中ショップ', contactName: '田中 美咲', storeName: 'MISA EC', contractType: '月額プラン' },
    createdAt: '2026-05-20T09:10:00+09:00',
    updatedAt: '2026-06-29T09:58:00+09:00',
  },
  {
    id: 'friend-002',
    lineUserId: 'U002',
    displayName: '佐藤 健',
    pictureUrl: null,
    statusMessage: null,
    isFollowing: true,
    tags: [tags[2]],
    metadata: { customerNumber: '', companyName: '佐藤商店', contactName: '佐藤 健', storeName: '', contractType: '初期構築' },
    createdAt: '2026-05-25T12:20:00+09:00',
    updatedAt: '2026-06-29T08:12:00+09:00',
  },
  {
    id: 'friend-003',
    lineUserId: 'U003',
    displayName: '山本 彩',
    pictureUrl: null,
    statusMessage: null,
    isFollowing: true,
    tags: [],
    metadata: { customerNumber: 'C-1088', companyName: '', contactName: '山本 彩', storeName: 'AY STORE', contractType: '' },
    createdAt: '2026-06-01T13:00:00+09:00',
    updatedAt: '2026-06-28T18:40:00+09:00',
  },
]

const chats = [
  {
    id: 'friend-001',
    friendId: 'friend-001',
    friendName: '田中 美咲',
    friendPictureUrl: null,
    operatorId: null,
    status: 'unread',
    notes: '返金条件を確認してから返信。',
    lastMessageAt: '2026-06-29T09:58:00+09:00',
    lastMessageContent: '返金の条件について確認したいです。',
    lastMessageDirection: 'incoming',
    lastMessageType: 'text',
    createdAt: '2026-06-20T10:00:00+09:00',
    updatedAt: '2026-06-29T09:58:00+09:00',
  },
  {
    id: 'friend-002',
    friendId: 'friend-002',
    friendName: '佐藤 健',
    friendPictureUrl: null,
    operatorId: null,
    status: 'in_progress',
    notes: '二次対応へ確認中。',
    lastMessageAt: '2026-06-29T08:40:00+09:00',
    lastMessageContent: '審査状況はいつ頃わかりますか？',
    lastMessageDirection: 'incoming',
    lastMessageType: 'text',
    createdAt: '2026-06-18T10:00:00+09:00',
    updatedAt: '2026-06-29T08:40:00+09:00',
  },
  {
    id: 'friend-003',
    friendId: 'friend-003',
    friendName: '山本 彩',
    friendPictureUrl: null,
    operatorId: null,
    status: 'resolved',
    notes: 'お礼のみ。返信不要で完了。',
    lastMessageAt: '2026-06-28T18:40:00+09:00',
    lastMessageContent: 'ありがとうございました！',
    lastMessageDirection: 'incoming',
    lastMessageType: 'text',
    createdAt: '2026-06-15T10:00:00+09:00',
    updatedAt: '2026-06-28T18:40:00+09:00',
  },
]

const chatDetails = {
  'friend-001': {
    ...chats[0],
    messages: [
      { id: 'msg-001', direction: 'incoming', messageType: 'text', content: '返金の条件について確認したいです。', source: 'line', createdAt: '2026-06-29T09:58:00+09:00' },
      { id: 'msg-002', direction: 'outgoing', messageType: 'text', content: '確認いたします。注文番号を教えてください。', source: 'harness', createdAt: '2026-06-29T10:03:00+09:00' },
      { id: 'msg-003', direction: 'incoming', messageType: 'file', content: JSON.stringify({ fileName: '注文内容.pdf', url: 'https://example.com/order.pdf' }), source: 'line', createdAt: '2026-06-29T10:08:00+09:00' },
    ],
    hasMoreMessages: false,
    nextMessagesBefore: null,
  },
  'friend-002': {
    ...chats[1],
    messages: [
      { id: 'msg-011', direction: 'incoming', messageType: 'text', content: '審査状況はいつ頃わかりますか？', source: 'line', createdAt: '2026-06-29T08:40:00+09:00' },
      { id: 'msg-012', direction: 'outgoing', messageType: 'text', content: '担当に確認し、確認でき次第ご連絡します。', source: 'harness', createdAt: '2026-06-29T08:48:00+09:00' },
    ],
    hasMoreMessages: false,
    nextMessagesBefore: null,
  },
  'friend-003': {
    ...chats[2],
    messages: [
      { id: 'msg-021', direction: 'incoming', messageType: 'text', content: 'ありがとうございました！', source: 'line', createdAt: '2026-06-28T18:40:00+09:00' },
    ],
    hasMoreMessages: false,
    nextMessagesBefore: null,
  },
}

function supportCase(partial) {
  return {
    id: partial.id,
    lineAccountId: accountId,
    friendId: partial.friendId ?? null,
    friendName: partial.friendName ?? null,
    friendPictureUrl: null,
    lineUserId: partial.lineUserId ?? null,
    title: partial.title,
    category: partial.category ?? 'operation',
    priority: partial.priority ?? 'medium',
    status: partial.status ?? 'in_progress',
    primaryAssignee: partial.primaryAssignee ?? '一次担当A',
    escalationAssignee: partial.escalationAssignee ?? 'オーナー',
    escalationLevel: partial.escalationLevel ?? 'L2',
    dueAt: partial.dueAt ?? '2026-06-29T17:00:00+09:00',
    nextCheckAt: null,
    customerNumber: partial.customerNumber ?? null,
    companyName: partial.companyName ?? null,
    contactName: partial.contactName ?? null,
    storeName: partial.storeName ?? null,
    contractType: partial.contractType ?? null,
    customerSummary: partial.customerSummary ?? '',
    internalNote: partial.internalNote ?? '',
    customerReplyDraft: partial.customerReplyDraft ?? '',
    resolutionNote: partial.resolutionNote ?? '',
    manualIds: partial.manualIds ?? [],
    createdBy: partial.createdBy ?? '一次担当A',
    updatedBy: partial.updatedBy ?? '一次担当A',
    closedAt: null,
    reopenedAt: null,
    createdAt: partial.createdAt ?? '2026-06-29T09:00:00+09:00',
    updatedAt: partial.updatedAt ?? '2026-06-29T10:10:00+09:00',
  }
}

const supportCases = [
  supportCase({
    id: 'case-001',
    friendId: 'friend-001',
    friendName: '田中 美咲',
    lineUserId: 'U001',
    title: '返金条件の確認',
    category: 'reward',
    priority: 'urgent',
    status: 'waiting_secondary',
    dueAt: '2026-06-29T15:00:00+09:00',
    customerNumber: 'C-1024',
    companyName: '田中ショップ',
    contactName: '田中 美咲',
    storeName: 'MISA EC',
    contractType: '月額プラン',
    customerSummary: '返金対象になるかを確認したい。注文PDFあり。',
    internalNote: '二次対応に判断基準を確認中。',
    customerReplyDraft: '確認のうえ、本日中にご案内いたします。',
    updatedAt: '2026-06-29T10:08:00+09:00',
  }),
  supportCase({
    id: 'case-002',
    friendId: 'friend-002',
    friendName: '佐藤 健',
    lineUserId: 'U002',
    title: '審査状況の確認',
    category: 'operation',
    priority: 'high',
    status: 'customer_reply',
    dueAt: '2026-06-29T18:00:00+09:00',
    companyName: '佐藤商店',
    contactName: '佐藤 健',
    customerSummary: '審査状況の目安を知りたい。',
    internalNote: '二次回答あり。一次担当が返信文を整える。',
    customerReplyDraft: '審査状況を確認しました。現在の見込みは...',
    updatedAt: '2026-06-29T09:40:00+09:00',
  }),
  supportCase({
    id: 'case-003',
    friendId: 'friend-003',
    friendName: '山本 彩',
    lineUserId: 'U003',
    title: 'お礼連絡の完了処理',
    category: 'other',
    priority: 'medium',
    status: 'in_progress',
    dueAt: '2026-06-30T12:00:00+09:00',
    customerNumber: 'C-1088',
    contactName: '山本 彩',
    storeName: 'AY STORE',
    customerSummary: '「ありがとうございました」のみ。返信不要なので完了予定。',
    internalNote: '返信不要。手動で解決済みにして24h滞留から外す。',
    updatedAt: '2026-06-28T18:40:00+09:00',
  }),
]

const manuals = [
  { id: 'manual-001', lineAccountId: accountId, title: '返金判断の確認手順', category: 'reward', body: '注文番号、決済日、利用状況を確認してから返信します。迷う場合は二次対応に回します。', url: null, keywords: '返金,支払い,注文', owner: 'オーナー', approvedBy: '吉田 京平', revisedAt: '2026-06-20', isActive: true, createdBy: '吉田 京平', updatedBy: '吉田 京平', createdAt: '2026-06-01T10:00:00+09:00', updatedAt: '2026-06-20T10:00:00+09:00' },
  { id: 'manual-002', lineAccountId: accountId, title: '二次対応へ回す基準', category: 'operation', body: '一次担当だけで判断しない問い合わせは、件名・問い合わせ内容・期限・緊急度を入れてチケット化します。', url: null, keywords: '二次対応,エスカレーション,判断', owner: 'オーナー', approvedBy: '吉田 京平', revisedAt: '2026-06-24', isActive: true, createdBy: '吉田 京平', updatedBy: '吉田 京平', createdAt: '2026-06-10T10:00:00+09:00', updatedAt: '2026-06-24T10:00:00+09:00' },
  { id: 'manual-003', lineAccountId: accountId, title: '返信不要メッセージの完了ルール', category: 'other', body: 'お礼のみ、スタンプのみなど返信不要の場合は個別チャットを解決済みにします。', url: null, keywords: '完了,返信不要,24h', owner: '一次担当A', approvedBy: '吉田 京平', revisedAt: '2026-06-25', isActive: true, createdBy: '一次担当A', updatedBy: '一次担当A', createdAt: '2026-06-12T10:00:00+09:00', updatedAt: '2026-06-25T10:00:00+09:00' },
]

const escalations = [
  { id: 'esc-001', caseId: 'case-001', caseTitle: '返金条件の確認', friendName: '田中 美咲', lineAccountId: accountId, assignee: 'オーナー', level: 'L2', status: 'pending', question: '注文PDFの内容だと返金対象にしてよいでしょうか？判断基準を確認したいです。', answer: '', dueAt: '2026-06-29T15:00:00+09:00', answeredAt: null, createdBy: '一次担当A', updatedBy: '一次担当A', createdAt: '2026-06-29T10:05:00+09:00', updatedAt: '2026-06-29T10:05:00+09:00' },
  { id: 'esc-002', caseId: 'case-002', caseTitle: '審査状況の確認', friendName: '佐藤 健', lineAccountId: accountId, assignee: 'オーナー', level: 'L2', status: 'answered', question: '審査の目安をどの表現で案内すべきですか？', answer: '今週中の確認見込みと伝えてください。断定表現は避けます。', dueAt: '2026-06-29T18:00:00+09:00', answeredAt: '2026-06-29T09:30:00+09:00', createdBy: '一次担当A', updatedBy: 'オーナー', createdAt: '2026-06-29T09:10:00+09:00', updatedAt: '2026-06-29T09:30:00+09:00' },
  { id: 'esc-003', caseId: 'case-003', caseTitle: 'お礼連絡の完了処理', friendName: '山本 彩', lineAccountId: accountId, assignee: 'オーナー', level: 'L2', status: 'pending', question: '返信不要のため解決済みにしてよいか確認です。', answer: '', dueAt: '2026-06-30T12:00:00+09:00', answeredAt: null, createdBy: '一次担当A', updatedBy: '一次担当A', createdAt: '2026-06-28T18:45:00+09:00', updatedAt: '2026-06-28T18:45:00+09:00' },
]

function detailForCase(id) {
  const selectedCase = supportCases.find((item) => item.id === id) || supportCases[0]
  const detailMessages = (chatDetails[selectedCase.friendId] || chatDetails['friend-001']).messages.map((message) => ({ ...message }))
  return {
    ...selectedCase,
    events: [
      { id: `ev-${selectedCase.id}-1`, caseId: selectedCase.id, eventType: 'created', actorId: 'staff-primary', actorName: '一次担当A', body: 'チケットを作成しました', metadata: {}, createdAt: selectedCase.createdAt },
      { id: `ev-${selectedCase.id}-2`, caseId: selectedCase.id, eventType: 'updated', actorId: 'staff-primary', actorName: '一次担当A', body: '二次対応へ確認依頼しました', metadata: {}, createdAt: selectedCase.updatedAt },
    ],
    escalations: escalations.filter((item) => item.caseId === selectedCase.id),
    manuals: manuals.slice(0, 2),
    recentMessages: detailMessages,
  }
}

function apiResponse(data) {
  return { success: true, data }
}

async function fulfillJson(route, payload, status = 200) {
  const origin = route.request().headers().origin || base
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    },
    body: JSON.stringify(payload),
  })
}

async function apiHandler(route) {
  const req = route.request()
  const url = new URL(req.url())
  const pathname = url.pathname
  const method = req.method()
  if (method === 'OPTIONS') {
    await fulfillJson(route, {}, 204)
    return
  }

  let payload
  if (pathname === '/api/auth/session') payload = { success: true, data: { id: 'staff-owner', name: '吉田 京平', role: 'owner', email: 'owner@example.com' }, csrfToken: 'manual-token' }
  else if (pathname === '/api/line-accounts') payload = apiResponse(lineAccounts)
  else if (pathname === '/api/staff/me') payload = apiResponse({ id: 'staff-owner', name: '吉田 京平', role: 'owner', email: 'owner@example.com' })
  else if (pathname === '/api/staff/assignee-options') payload = apiResponse(assigneeOptions)
  else if (pathname === '/api/staff') payload = apiResponse(staff)
  else if (pathname === '/api/tags') payload = apiResponse(tags)
  else if (pathname === '/api/inbox/unanswered/count') payload = apiResponse({ total: 7 })
  else if (pathname === '/api/admin/version' || pathname === '/admin/version') payload = { success: true, data: { version: 'manual', commit: 'local', buildTime: now } }
  else if (pathname === '/api/support/summary') {
    payload = apiResponse({
      totals: { total: 3, open: 0, primaryAction: 1, escalated: 2, myEscalations: 2, overdue: 0, urgent: 1, dueSoon: 2, unassigned: 0, waitingCustomer: 1, resolved: 0 },
      byStatus: [{ status: 'waiting_secondary', count: 1 }, { status: 'customer_reply', count: 1 }, { status: 'in_progress', count: 1 }],
      byCategory: [{ category: 'reward', count: 1 }, { category: 'operation', count: 1 }, { category: 'other', count: 1 }],
      byAssignee: [{ assignee: '一次担当A', count: 3 }],
    })
  } else if (pathname === '/api/support/cases' && method === 'GET') payload = apiResponse(supportCases)
  else if (pathname === '/api/support/cases' && method === 'POST') payload = apiResponse(supportCases[0])
  else if (pathname.startsWith('/api/support/cases/') && pathname.endsWith('/events')) payload = apiResponse(null)
  else if (pathname.startsWith('/api/support/cases/') && pathname.endsWith('/escalations')) payload = apiResponse(escalations[0])
  else if (pathname.startsWith('/api/support/cases/')) {
    const id = pathname.split('/')[4]
    payload = method === 'GET' ? apiResponse(detailForCase(id)) : apiResponse(supportCases.find((item) => item.id === id) || supportCases[0])
  } else if (pathname === '/api/support/escalations') payload = apiResponse(escalations)
  else if (pathname.startsWith('/api/support/escalations/')) payload = apiResponse(escalations[0])
  else if (pathname === '/api/support/manuals') payload = apiResponse(manuals)
  else if (pathname.startsWith('/api/support/manuals/')) payload = apiResponse(manuals[0])
  else if (pathname === '/api/chats') payload = apiResponse(chats)
  else if (pathname.startsWith('/api/chats/') && pathname.endsWith('/send')) payload = apiResponse({ sent: true, messageId: 'manual-msg', markAsRead: { requested: true, marked: true, reason: null }, supportCase: null })
  else if (pathname.startsWith('/api/chats/') && pathname.endsWith('/external-outgoing')) payload = apiResponse({ recorded: true, messageId: 'external-msg', message: { id: 'external-msg', direction: 'outgoing', messageType: 'text', content: 'LINE公式側で送った文章の記録です。', source: 'line_official', createdAt: now } })
  else if (pathname.startsWith('/api/chats/')) {
    const id = pathname.split('/')[3]
    payload = method === 'GET' ? apiResponse(chatDetails[id] || chatDetails['friend-001']) : apiResponse(chats.find((item) => item.id === id) || chats[0])
  } else if (pathname === '/api/friends') payload = apiResponse({ items: friends, total: friends.length, page: 1, limit: 20, hasNextPage: false })
  else if (pathname === '/api/friends/count') payload = apiResponse({ count: friends.length })
  else if (pathname.startsWith('/api/friends/') && pathname.endsWith('/rich-menu')) payload = apiResponse({ id: null, name: null, isDefault: true })
  else if (pathname.startsWith('/api/friends/')) {
    const id = pathname.split('/')[3]
    payload = apiResponse(friends.find((item) => item.id === id) || friends[0])
  } else if (pathname === '/api/uploads/image') payload = apiResponse({ url: 'https://example.com/sample-upload.png' })
  else if (pathname === '/api/notifications') payload = apiResponse([])
  else if (pathname === '/api/notifications/rules') payload = apiResponse([])
  else payload = apiResponse([])

  await fulfillJson(route, payload)
}

async function capturePage(context, file, routePath, waitText) {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message || error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(base + routePath, { waitUntil: 'domcontentloaded', timeout: 30000 })
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 })
  } catch {}
  try {
    await page.waitForSelector(`text=${waitText}`, { timeout: 12000 })
  } catch {}
  await page.waitForTimeout(1800)

  if (file === '04-friends.png') {
    try {
      await page.locator('button:has-text("編集")').first().click({ timeout: 3000 })
      await page.waitForTimeout(800)
    } catch {}
  }
  if (file === '05-manuals.png') {
    try {
      await page.locator('text=返金判断の確認手順').first().click({ timeout: 3000 })
      await page.waitForTimeout(500)
    } catch {}
  }

  const fullPath = path.join(outDir, file)
  await page.screenshot({ path: fullPath, fullPage: false })
  const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 300)
  await page.close()
  return { file, route: routePath, errors: errors.slice(0, 5), bodyText }
}

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 1,
    locale: 'ja-JP',
  })
  await context.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'acc-ec-owner')
    localStorage.setItem('lh_staff_identity', JSON.stringify({ name: '吉田 京平', role: 'owner', csrfToken: 'manual-token' }))
  })
  await context.route('**/api/**', apiHandler)
  await context.route('**/admin/version**', apiHandler)

  const pages = [
    ['01-ticket-management.png', '/support.html', 'チケット管理'],
    ['02-chat.png', '/chats.html?friend=friend-001', '個別チャット'],
    ['03-escalations.png', '/escalations.html', '二次対応'],
    ['04-friends.png', '/friends.html', '顧客管理'],
    ['05-manuals.png', '/manuals.html', 'マニュアル'],
  ]
  const results = []
  for (const item of pages) {
    results.push(await capturePage(context, ...item))
  }
  await browser.close()
  console.log(JSON.stringify({ outDir, results }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
