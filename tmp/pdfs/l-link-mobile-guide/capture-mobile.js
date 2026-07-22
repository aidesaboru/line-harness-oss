const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const root = '/Users/shinichi/Project/ec-owner-line-harness'
const outDir = path.join(root, 'tmp/pdfs/l-link-mobile-guide/screenshots')
const envPath = path.join(root, '.env.local')

function readEnv(filePath) {
  const result = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) continue
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return result
}

async function waitForScreen(page, heading) {
  await page.waitForLoadState('domcontentloaded')
  await page.getByText(heading, { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1800)
}

async function capture(page, baseUrl, route, heading, filename) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitForScreen(page, heading)
  await page.screenshot({ path: path.join(outDir, filename), fullPage: false })
}

async function main() {
  const env = readEnv(envPath)
  const baseUrl = (env.LINE_HARNESS_ADMIN_URL || 'https://ec-owner-line-harness-admin.pages.dev').replace(/\/$/, '')
  const apiKey = env.LINE_HARNESS_ADMIN_API_KEY
  if (!apiKey) throw new Error('LINE_HARNESS_ADMIN_API_KEY is missing')

  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  })

  const page = await context.newPage()
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1200)
  const apiKeyInput = page.locator('input[type="password"]')
  if (!(await apiKeyInput.count())) {
    await page.screenshot({ path: path.join(outDir, 'login-debug.png'), fullPage: false })
    throw new Error(`Login form was not found at ${page.url()}`)
  }
  await apiKeyInput.fill(apiKey)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30000 }),
    page.getByRole('button', { name: 'ログイン' }).click(),
  ])

  await capture(page, baseUrl, '/internal-chat', '社内相談', '01-internal-chat.png')
  await capture(page, baseUrl, '/notifications', '通知センター', '02-notifications.png')
  await capture(page, baseUrl, '/support', 'チケット管理', '03-support.png')
  await capture(page, baseUrl, '/chats', 'オペレーターチャット', '04-chats.png')

  await page.goto(`${baseUrl}/internal-chat`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitForScreen(page, '社内相談')
  const installButton = page.getByRole('button', { name: 'ホーム画面に追加' })
  await installButton.waitFor({ timeout: 10000 })
  await installButton.click()
  await page.getByRole('dialog').waitFor({ timeout: 10000 })
  await page.screenshot({ path: path.join(outDir, '05-install-guide.png'), fullPage: false })

  await browser.close()
  process.stdout.write(JSON.stringify({ baseUrl, outDir }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
