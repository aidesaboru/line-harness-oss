export type KnowledgeStatus = 'verified' | 'ready' | 'needs_review' | 'unresolved';

export type OperationalKnowledge = {
  title: string;
  question: string;
  resolution: string;
  procedure: string;
  applicability: string;
  cautions: string;
  sourceBody: string;
  status: KnowledgeStatus;
  qualityScore: number;
  reviewNote: string;
};

type KnowledgeSource = {
  title: string;
  body: string;
  question?: string | null;
  answer?: string | null;
};

const sectionAliases: Record<string, 'question' | 'answer' | 'customer' | 'rest'> = {
  '顧客・案件情報': 'customer',
  顧客情報: 'customer',
  案件情報: 'customer',
  問い合わせ内容: 'question',
  一次対応の問い合わせ: 'question',
  質問: 'question',
  問い: 'question',
  解決回答: 'answer',
  対応ナレッジ: 'answer',
  二次対応の回答: 'answer',
  回答: 'answer',
  本文: 'rest',
};

const pendingOnlyPattern = /^(確認します|確認いたします|確認中です|担当へ確認します|担当者へ確認します|共有します|対応します|承知しました|承知いたしました|ありがとうございます|よろしくお願いします|お願いします)[\s!！。]*$/u;
const boilerplateLinePattern = /^(?:!channel|<!channel>|cc[:：]?|お疲れ様です[。！!]?|いつもお世話になっております[。！!]?|よろしくお願いいたします[。！!]?|ご確認(?:のほど)?よろしくお願いいたします[。！!]?)$/iu;
const deadlineLinePattern = /^(?:[:\w_-]+\s*)*[＊*]?\s*(?:回答)?(?:期限|期日)\s*[:：]?/iu;
const mentionOnlyPattern = /^(?:\s*@[^\s]+(?:\s+さん)?\s*)+(?:cc[:：]?\s*)?$/iu;

function normalize(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/(^|\n)```/g, '$1')
    .replace(/```\n?/g, '')
    .replace(/<!channel>/gi, '')
    .replace(/(^|\s)!channel(?=\s|$)/gi, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function append(current: string, value: string): string {
  const next = normalize(value);
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

export function parseKnowledgeBody(body: string): { question: string; answer: string; customer: string; rest: string } {
  const result = { question: '', answer: '', customer: '', rest: '' };
  const matches = Array.from(body.matchAll(/【([^】]+)】/g));
  if (matches.length === 0) {
    result.rest = normalize(body);
    return result;
  }
  matches.forEach((match, index) => {
    const label = normalize(match[1] ?? '');
    const key = sectionAliases[label] ?? 'rest';
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    result[key] = append(result[key], body.slice(start, end));
  });
  return result;
}

function stripSlackNoise(value: string): string {
  const lines = normalize(value)
    .split('\n')
    .map((line) => line.replace(/^\s*[>*]+\s*/, '').replace(/[*_~]/g, '').trim())
    .filter(Boolean)
    .filter((line) => !boilerplateLinePattern.test(line))
    .filter((line) => !deadlineLinePattern.test(line))
    .filter((line) => !mentionOnlyPattern.test(line));
  return normalize(lines.join('\n'));
}

function answerBlocks(value: string): string[] {
  return normalize(value)
    .split(/\n\s*---\s*\n/g)
    .map(stripSlackNoise)
    .filter(Boolean)
    .filter((block) => !pendingOnlyPattern.test(block));
}

function resolutionScore(value: string): number {
  let score = Math.min(35, Math.floor(value.length / 12));
  if (/[。！？!?]/u.test(value)) score += 5;
  if (/してください|となります|可能です|できません|不要です|必要です|対応済み|完了|案内|回答|送付|連絡|確認後|理由/u.test(value)) score += 24;
  if (/確認します|確認いたします|確認中|お待ちください|共有します/u.test(value)) score -= 28;
  if ((value.match(/[?？]/g) ?? []).length >= 2) score -= 18;
  if (value.length < 18) score -= 24;
  return score;
}

function pickResolution(blocks: string[]): { resolution: string; remaining: string[]; score: number } {
  if (blocks.length === 0) return { resolution: '', remaining: [], score: 0 };
  const ranked = blocks
    .map((block, index) => ({ block, index, score: resolutionScore(block) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = ranked[0];
  return {
    resolution: selected.block,
    remaining: blocks.filter((_, index) => index !== selected.index),
    score: selected.score,
  };
}

function extractLines(value: string, pattern: RegExp, limit = 4): string {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const line of value.split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (!pattern.test(line) || seen.has(line)) continue;
    seen.add(line);
    matches.push(line);
    if (matches.length >= limit) break;
  }
  return matches.join('\n');
}

function buildProcedure(remaining: string[], resolution: string): string {
  const explicitSteps = extractLines(
    resolution,
    /^(?:\d+[.)、]|[①-⑳]|[-・])|まず|次に|その後|確認して|送付して|連絡して|案内して/u,
    6,
  );
  if (explicitSteps) return explicitSteps;
  const substantive = remaining.filter((block) => resolutionScore(block) >= 18).slice(0, 3);
  if (substantive.length === 0) return '';
  return substantive.map((block, index) => `${index + 1}. ${block}`).join('\n');
}

function titleCandidate(currentTitle: string, question: string): string {
  const candidates = stripSlackNoise(question)
    .split('\n')
    .map((line) => line.replace(/^\d{2,6}[\s_、.]+/, '').trim())
    .filter((line) => line.length >= 8)
    .filter((line) => !/^(?:株式会社|合同会社|有限会社)?[^?？]{0,20}(?:様|さん)?$/u.test(line));
  const fromQuestion = candidates.find((line) => /[?？]|確認|教えて|できます|でしょう|対応|方法|理由|必要|いつ|どこ|どの/u.test(line)) ?? candidates[0];
  const fallback = stripSlackNoise(currentTitle)
    .replace(/^[:\w_-]+\s*/, '')
    .replace(/^[＊*]+|[＊*]+$/g, '')
    .trim();
  const value = fromQuestion || fallback || '対応ナレッジ';
  return value.length > 80 ? `${value.slice(0, 79).trimEnd()}…` : value;
}

function qualityStatus(question: string, resolution: string, title: string, pickedScore: number): { status: KnowledgeStatus; score: number } {
  if (!resolution) return { status: 'unresolved', score: Math.min(35, question.length >= 18 ? 30 : 15) };
  let score = 0;
  if (question.length >= 18) score += 25;
  else if (question.length >= 8) score += 15;
  if (resolution.length >= 30) score += 30;
  else if (resolution.length >= 18) score += 20;
  if (pickedScore >= 35) score += 20;
  else if (pickedScore >= 18) score += 10;
  if (title.length >= 8 && !deadlineLinePattern.test(title) && !/^[:!@]/.test(title)) score += 15;
  if (!/@(?:社内メンバー\d+|[UW][A-Z0-9]{4,})\b/u.test(`${question}\n${resolution}`)) score += 10;
  score = Math.max(0, Math.min(100, score));
  return { status: score >= 70 ? 'ready' : 'needs_review', score };
}

function buildReviewNote(status: KnowledgeStatus, question: string, resolution: string, score: number): string {
  if (status === 'ready') return '';
  const reasons: string[] = [];
  if (question.length < 18) reasons.push('問い合わせ内容が短く判断条件が不足しています');
  if (!resolution) reasons.push('解決した回答を特定できませんでした');
  else if (resolution.length < 30) reasons.push('結論が短く再利用時の判断材料が不足しています');
  if (/@(?:社内メンバー\d+|[UW][A-Z0-9]{4,})\b/u.test(`${question}\n${resolution}`)) {
    reasons.push('メンバー表記の確認が必要です');
  }
  return reasons.length > 0 ? reasons.join(' / ') : `品質スコア${score}のため内容確認が必要です`;
}

export function deriveOperationalKnowledge(source: KnowledgeSource): OperationalKnowledge {
  const parsed = parseKnowledgeBody(source.body);
  const question = stripSlackNoise(source.question || parsed.question || parsed.rest);
  const rawAnswer = source.answer || parsed.answer;
  const blocks = answerBlocks(rawAnswer);
  const picked = pickResolution(blocks);
  const resolution = picked.resolution;
  const procedure = buildProcedure(picked.remaining, resolution);
  const applicability = extractLines(question, /場合|とき|対象|について|際に/u, 3);
  const cautions = extractLines(`${resolution}\n${procedure}`, /ただし|注意|例外|不可|できません|必要|不要|必ず|確認のうえ/u, 4);
  const title = titleCandidate(source.title, question);
  const quality = qualityStatus(question, resolution, title, picked.score);
  return {
    title,
    question,
    resolution,
    procedure,
    applicability,
    cautions,
    sourceBody: source.body,
    status: quality.status,
    qualityScore: quality.score,
    reviewNote: buildReviewNote(quality.status, question, resolution, quality.score),
  };
}
