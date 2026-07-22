import { readFile, writeFile } from 'node:fs/promises'

const placeholder = '__API_ORIGIN_JSON__'
const rawApiOrigin = process.env.NEXT_PUBLIC_API_URL?.trim()

if (!rawApiOrigin) {
  throw new Error('NEXT_PUBLIC_API_URL is required to build the Pages API proxy')
}

const apiOrigin = new URL(rawApiOrigin)
if (apiOrigin.protocol !== 'https:' && apiOrigin.protocol !== 'http:') {
  throw new Error('NEXT_PUBLIC_API_URL must use http or https')
}

const templateUrl = new URL('../cloudflare/_worker.template.js', import.meta.url)
const outputUrl = new URL('../out/_worker.js', import.meta.url)
const template = await readFile(templateUrl, 'utf8')

if (!template.includes(placeholder)) {
  throw new Error(`Pages Worker template is missing ${placeholder}`)
}

const source = template.replace(
  placeholder,
  JSON.stringify(apiOrigin.origin),
)

await writeFile(outputUrl, source)
