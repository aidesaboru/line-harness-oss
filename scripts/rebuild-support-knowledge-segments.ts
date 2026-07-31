import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  deriveOperationalKnowledgeSegments,
  parseKnowledgeBody,
} from '../apps/worker/src/services/support-knowledge.js'

type ImportRow = {
  id: string
  line_account_id: string
  source_permalink: string | null
  source_posted_at: string | null
  title: string
  category: string
  question: string
  answer: string
  body: string
  manual_id: string | null
}

type WranglerResult = Array<{ results?: ImportRow[] }>

// The historical corpus is fixed. These deterministic segments were reviewed
// on 2026-07-31 and need human editing before they can be used operationally.
const curatedReviewSegmentIds = new Set([
  'knowledge-segment-c4fd0053c5885b22ca4c13b98adbbddb',
  'knowledge-segment-246f2f0692213cfc06307ed69105d733',
  'knowledge-segment-f5e09576b7b5deef9eaf2afb4b7af319',
  'knowledge-segment-554917d12da54f95c76508617b43b90e',
  'knowledge-segment-43087e961586a5d991f8f789af370213',
  'knowledge-segment-6ed50f62e5f6d5c06906a01010c9c268',
  'knowledge-segment-fe9d7bd1bb276db1978f992d37e0c958',
  'knowledge-segment-76b3cb0bc57c70b78a40b9775a1a22dc',
  'knowledge-segment-45311110becf30fd8cf3882cbc361259',
  'knowledge-segment-fc3b10632f1c0dd24be55cb5b40099d3',
  'knowledge-segment-3616586ad204b3aa637f68a3e122d600',
  'knowledge-segment-af7342ee22a7475c9eb2823dd8c126f2',
  'knowledge-segment-29c57b28d483b1023d6877d18abf3a29',
  'knowledge-segment-fcb2dc05163aa1024a4e074db94438f3',
  'knowledge-segment-05c78e27944345e0f68890908b7ae080',
  'knowledge-segment-5427660a62922260905de0c640bf8549',
  'knowledge-segment-9e027d85843638515f84b7989cb9ceff',
  'knowledge-segment-3f341010453b058a32ed0cde614e8712',
  'knowledge-segment-23855f75992372fa0116a3daebd5755a',
  'knowledge-segment-192a243b54cabc82eaaab265863c7cb0',
  'knowledge-segment-cf47340745280c5d05bf46427922bcfe',
  'knowledge-segment-505f81e16e4a1522e9b9ba30dab89e6f',
  'knowledge-segment-41b35a9d7885189f47f5ee2cf1e3fcbc',
  'knowledge-segment-68c1a87f271740dd228916df706649be',
  'knowledge-segment-e4c9e30122aa6bc912be06d7abf73f1b',
  'knowledge-segment-fce6ebf14ec571e7bfab26145b0a8ad0',
  'knowledge-segment-a99a0b8c8e2c1b4392d7b3e08fc04eb3',
  'knowledge-segment-8f0829f90916997c8b428b30098be875',
  'knowledge-segment-2ec28c95b29eba9428d8d2099cd44803',
  'knowledge-segment-a5f16878aa62f8a6c7e9f9127398f8a8',
  'knowledge-segment-7653b1e2ecbe5db3d8bfd3f524cda7e6',
  'knowledge-segment-9f154fdd80f1454995f3e0be26d02e00',
  'knowledge-segment-98a720770d415713163158851e9f5a5e',
  'knowledge-segment-dc61fa7d988b3a19634e6360336fec5e',
])

const inputPath = process.argv[2]
const outputPath = process.argv[3]
if (!inputPath || !outputPath) {
  throw new Error('Usage: tsx scripts/rebuild-support-knowledge-segments.ts input.json output.sql')
}

function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return `'${value.replaceAll("'", "''")}'`
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value
}

function keywords(value: string): string {
  return Array.from(new Set(
    value
      .replace(/[^\p{Letter}\p{Number}ー一-龯ぁ-んァ-ン]+/gu, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2 && word.length <= 18),
  )).slice(0, 20).join(' ')
}

function knowledgeBody(customer: string, question: string, resolution: string): string {
  const sections: string[] = []
  if (customer.trim()) sections.push(`【顧客・案件情報】\n${customer.trim()}`)
  sections.push(`【問い合わせ内容】\n${question.trim()}`)
  sections.push(`【解決回答】\n${resolution.trim()}`)
  return truncate(sections.join('\n\n'), 64 * 1024)
}

function jstNow(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '')
}

function isHighConfidenceOperationalCandidate(segment: {
  status: string
  question: string
  resolution: string
  questionBlockIndex: number
  answerBlockIndex: number
}): boolean {
  if (segment.status !== 'ready') return false
  const gap = segment.answerBlockIndex - segment.questionBlockIndex
  if (gap < 1 || gap > 2) return false
  const combined = `${segment.question}\n${segment.resolution}`
  if (/パスワード\s*[:：]\s*\S+|(?:口座番号|普通)\s*[:：]?\s*\d{5,}|https?:\/\/(?:drive\.google|docs\.google)|\b(?=[A-Za-z0-9]{8,}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/iu.test(combined)) {
    return false
  }
  const explicitIntent = /[?？]|どのよう|どうすれば|どうしたら|なぜ|いつから|いつ頃|何月|何日|何ヶ月|必要でしょうか|可能でしょうか|認識で|合っていますか|対応範囲/u.test(segment.question)
  const requestIntent = /(?:ご対応|ご確認|回答|返信|案内|教示|連絡|共有).{0,50}(?:お願い|ください|いただけ)/u.test(segment.question)
  if (!explicitIntent && !requestIntent) return false
  if (/(?:完了|対応|確認)(?:後|しましたら|したら).{0,30}(?:お知らせ|報告|共有|連絡).{0,20}(?:ください|お願い)/u.test(segment.question)) {
    return false
  }
  if (/どなた|誰から|お名前(?:と|や)?電話番号|対応完了.*(?:でしょうか|教えて)|進捗.*(?:どう|いかが)/u.test(segment.question)) {
    return false
  }
  if (/^(?:こちら|上記|本件|下記).{0,50}(?:状況|進捗|対応済み|確認済み|完了|いかが)/u.test(segment.question)) {
    return false
  }
  const affirmativeClaim = /(?:支払|入金|振込|対応|確認).{0,10}(?:済み|完了)/u.test(segment.question)
  const negativeAnswer = /未払い|未入金|されていない|できていない|未完了/u.test(segment.resolution)
  if (affirmativeClaim && negativeAnswer) return false
  if (/^(?:回答)?(?:有難うございます|ありがとうございます).{0,100}(?:そうですよね|承知|認識)/u.test(segment.resolution)) {
    return false
  }
  if (/リマインド|確認でき次第|一旦.{0,20}引き取|明日.{0,20}(?:電話|連絡)|改めて対応|お話.{0,10}できなかった|文脈を把握していない|共有完了|連携済み/u.test(segment.resolution)) {
    return false
  }
  if (/(?:ログイン(?:ID|PW)|パスワード|合言葉)/iu.test(segment.question)) return false
  const reusableRule = /理由|対象外|不要です|必要です|可能です|となります|場合は|してください|お伝えください|負担|手順|ルール|申告|処理|ため|ので/u.test(segment.resolution)
  if (!reusableRule) return false
  const caseCompletion = /(?:振込|入金|格納|配送|発送|対応|手続|申請|処理|連絡|共有|お伝え).{0,20}(?:完了|済み)(?:です|しました|しております|になります)/u.test(segment.resolution)
  if (caseCompletion && !reusableRule) return false
  return true
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as WranglerResult
const rows = parsed.flatMap((item) => item.results ?? [])
const now = jstNow()
const revisedAt = now.slice(0, 10)
const statements: string[] = []
const speakerStats = new Map<string, { total: number; questions: number; definitive: number }>()
for (const row of rows) {
  for (const block of row.answer.split(/\n\s*---\s*\n/g)) {
    const speaker = block.match(/^\s*@([^\s\n]+)/u)?.[1]
    if (!speaker) continue
    const stats = speakerStats.get(speaker) ?? { total: 0, questions: 0, definitive: 0 }
    stats.total += 1
    if (/[?？]|でしょうか|ですか|ますか|(?:ご対応|ご確認|回答|返信|共有|案内|教示|連絡|報告).{0,40}(?:お願い|ください|いただけ)/u.test(block)) {
      stats.questions += 1
    }
    if (/対象外|不要です|必要です|可能です|できません|となります|理由|ため|場合は|してください|てください|お伝えください|ご案内|返信例|回答例|完了|対応済み|振り込み予定|入金します|負担/u.test(block)) {
      stats.definitive += 1
    }
    speakerStats.set(speaker, stats)
  }
}
const responderLabels = Array.from(speakerStats.entries())
  .filter(([, stats]) => stats.total >= 8 && stats.questions / stats.total <= 0.3 && stats.definitive / stats.total >= 0.28)
  .map(([speaker]) => speaker)
let ready = 0
let needsReview = 0
let parentsDemoted = 0

for (const row of rows) {
  if (row.manual_id) {
    const parentReviewNote = 'Slackスレッドの原文です 案件単位に分割した回答候補を確認してください'
    statements.push(`
INSERT INTO support_manual_revisions (
  id, manual_id, line_account_id, change_type, snapshot, actor_id, actor_name, created_at
)
SELECT
  ${sqlText(randomUUID())}, id, line_account_id, 'split_source_thread',
  json_object(
    'title', title,
    'category', category,
    'body', body,
    'url', url,
    'keywords', keywords,
    'owner', owner,
    'approvedBy', approved_by,
    'revisedAt', revised_at,
    'isActive', CASE WHEN is_active = 1 THEN json('true') ELSE json('false') END,
    'question', knowledge_question,
    'resolution', knowledge_resolution,
    'procedure', knowledge_procedure,
    'applicability', knowledge_applicability,
    'cautions', knowledge_cautions,
    'sourceBody', knowledge_source_body,
    'knowledgeStatus', knowledge_status,
    'qualityScore', knowledge_quality_score,
    'reviewNote', knowledge_review_note
  ),
  'knowledge-segmenter', 'ナレッジ再構築', ${sqlText(now)}
FROM support_manuals
WHERE id = ${sqlText(row.manual_id)}
  AND knowledge_status <> 'verified'
  AND (knowledge_status <> 'needs_review' OR knowledge_review_note <> ${sqlText(parentReviewNote)});`.trim())
    statements.push(`
UPDATE support_manuals
SET knowledge_status = 'needs_review',
    knowledge_quality_score = MIN(knowledge_quality_score, 45),
    knowledge_review_note = ${sqlText(parentReviewNote)},
    updated_by = 'knowledge-segmenter',
    updated_at = ${sqlText(now)}
WHERE id = ${sqlText(row.manual_id)}
  AND knowledge_status <> 'verified'
  AND (knowledge_status <> 'needs_review' OR knowledge_review_note <> ${sqlText(parentReviewNote)});`.trim())
    parentsDemoted += 1
  }

  const customer = parseKnowledgeBody(row.body).customer
  const segments = deriveOperationalKnowledgeSegments({
    title: row.title,
    body: row.body,
    question: row.question,
    answer: row.answer,
    responderLabels,
  })

  for (const segment of segments) {
    const segmentKey = createHash('sha256')
      .update(`${row.id}\n${segment.questionBlockIndex}\n${segment.answerBlockIndex}\n${segment.question}\n${segment.resolution}`)
      .digest('hex')
    const manualId = `knowledge-segment-${segmentKey.slice(0, 32)}`
    const segmentId = `segment-${segmentKey.slice(0, 40)}`
    const status = isHighConfidenceOperationalCandidate(segment) && !curatedReviewSegmentIds.has(manualId)
      ? 'ready'
      : 'needs_review'
    const reviewNote = status === 'ready'
      ? 'Slackスレッドから案件単位に分割した回答候補です'
      : `Slackスレッドから案件単位に分割しました ${segment.reviewNote}`.trim()
    const body = knowledgeBody(customer, segment.question, segment.resolution)
    const searchKeywords = keywords(`${segment.title}\n${segment.question}\n${segment.resolution}\n${segment.procedure}`)

    if (status === 'ready') ready += 1
    else needsReview += 1

    statements.push(`
INSERT OR IGNORE INTO support_manuals (
  id, line_account_id, title, category, body, url, keywords, owner, approved_by,
  revised_at, is_active, created_by, updated_by, created_at, updated_at,
  knowledge_question, knowledge_resolution, knowledge_procedure,
  knowledge_applicability, knowledge_cautions, knowledge_source_body,
  knowledge_status, knowledge_quality_score, knowledge_review_note
) VALUES (
  ${sqlText(manualId)}, ${sqlText(row.line_account_id)}, ${sqlText(segment.title)},
  ${sqlText(row.category || 'other')}, ${sqlText(body)}, ${sqlText(row.source_permalink)},
  ${sqlText(searchKeywords)}, 'Slack過去ログ 分割済み', NULL,
  ${sqlText(revisedAt)}, 1, 'knowledge-segmenter', 'knowledge-segmenter',
  ${sqlText(now)}, ${sqlText(now)}, ${sqlText(segment.question)},
  ${sqlText(segment.resolution)}, ${sqlText(segment.procedure)},
  ${sqlText(segment.applicability)}, ${sqlText(segment.cautions)}, ${sqlText(row.body)},
  ${sqlText(status)}, ${segment.qualityScore}, ${sqlText(reviewNote)}
);`.trim())
    statements.push(`
INSERT OR IGNORE INTO support_knowledge_segments (
  id, knowledge_import_id, manual_id, segment_key,
  question_block_index, answer_block_index, created_at
) VALUES (
  ${sqlText(segmentId)}, ${sqlText(row.id)}, ${sqlText(manualId)}, ${sqlText(segmentKey)},
  ${segment.questionBlockIndex}, ${segment.answerBlockIndex}, ${sqlText(now)}
);`.trim())
  }
}

writeFileSync(outputPath, `${statements.join('\n\n')}\n`, { mode: 0o600 })
process.stdout.write(JSON.stringify({
  imports: rows.length,
  parentsDemoted,
  segments: ready + needsReview,
  ready,
  needsReview,
  statements: statements.length,
  responderLabels,
  outputPath,
}) + '\n')
