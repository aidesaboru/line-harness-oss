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
const delegationOnlyPattern = /^(?:こちら|上記|本件)?\s*(?:は|を|の)?\s*(?:CO|担当(?:者|部署)?|運営者)(?:に|へ).{0,30}(?:確認|共有|依頼)(?:済み|しました|いたしました|します|中)?[\s。!！]*$/u;
const directResponseRequestOpeningPattern = /^(?:こちら(?:の|は|も)?|上記|本件|下記)(?:の内容)?\s*(?:ご対応|対応|ご確認|確認|返信|回答)/u;
const contextResponseRequestOpeningPattern = /^こちらの内容確認のため[\s\S]{0,120}ご対応/u;
const responseRequestLinePattern = /(?:ご対応|ご確認|返信文|ご回答|ご教示).*(?:お願い|ください|可能でしょうか|できますでしょうか|でしょうか)/u;
const definitiveAnswerPattern = /対象外|対象です|不要です|必要です|可能です|できません|となります|理由|ため|場合は|してください|てください|お伝えください|ご案内|返信例|回答例|完了|対応済み|振り込み予定|入金します|負担/u;
const boilerplateLinePattern = /^(?:!channel|<!channel>|cc[:：]?|お疲れ様です[。！!]?|いつもお世話になっております[。！!]?|よろしくお願いいたします[。！!]?|ご確認(?:のほど)?よろしくお願いいたします[。！!]?)$/iu;
const deadlineLinePattern = /^[\s:＊*_\w.-]*(?:回答)?(?:期限|期日)\s*[:：]?/iu;
const mentionOnlyPattern = /^(?:\s*@[^\s]+(?:\s+さん)?\s*)+(?:cc[:：]?\s*)?$/iu;
const concreteTitleTopicPattern = /保険(?:名|会社|商品)?|口座(?:名義|番号|登録|変更|振込)?|契約(?:内容|更新|解約|名義|期間)?|審査(?:状況|結果|通過)?|入金|振込|請求|支払|決済|返金|返品|交換|配送|納品|注文|商品|税|申告|売上|手数料|アカウント|ログイン|登録|名義|解約|更新/u;
const genericTitleRequestPattern = /(?:ご対応|対応|ご確認|確認|返信文?|ご回答|回答|ご返答|返答|ご教示).*(?:お願い|ください|いただけますか|いただきたい|可能でしょうか|できますでしょうか)/u;
const titleIntentPattern = /[?？]|確認|教えて|できます|でしょう|対応|方法|理由|必要|いつ|どこ|どの|どう/u;

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
  let score = Math.min(28, Math.floor(value.length / 16));
  if (/[。！？!?]/u.test(value)) score += 5;
  if (definitiveAnswerPattern.test(value)) score += 32;
  if (/ただし|例外|契約|手順|確認後|送付先|連絡先/u.test(value)) score += 8;
  if (/確認します|確認いたします|確認中|お待ちください|共有します/u.test(value)) score -= 32;
  if (delegationOnlyPattern.test(value)) score -= 48;
  const firstLine = value.split('\n', 1)[0] ?? '';
  const responseRequestOpening = !/^こちら(?:の)?対応ありがとうございます/u.test(value)
    && (
      directResponseRequestOpeningPattern.test(value)
      || contextResponseRequestOpeningPattern.test(value)
      || responseRequestLinePattern.test(firstLine)
    );
  if (responseRequestOpening) score -= 50;
  const questionCount = (value.match(/[?？]/g) ?? []).length;
  if (questionCount >= 3) score -= 50;
  else if (questionCount === 2) score -= 28;
  else if (questionCount === 1 && /[?？]\s*$/u.test(value)) score -= 10;
  if (value.length < 18) score -= 12;
  return score;
}

function pickResolution(blocks: string[]): { resolution: string; remaining: string[]; score: number } {
  if (blocks.length === 0) return { resolution: '', remaining: [], score: 0 };
  const ranked = blocks
    .map((block, index) => ({ block, index, score: resolutionScore(block) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked[0];
  if (selected.score < 15) {
    return { resolution: '', remaining: blocks, score: selected.score };
  }
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

function titleSentences(value: string): string[] {
  return stripSlackNoise(value)
    .split('\n')
    .flatMap((line) => line.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .map((sentence) => sentence
      .replace(/^\d{2,6}[\s_、.]+/, '')
      .replace(/^(?:質問|問い合わせ|確認事項)\s*[:：]\s*/u, '')
      .trim())
    .filter((sentence) => sentence.length >= 4);
}

function isGenericTitleRequest(value: string): boolean {
  return genericTitleRequestPattern.test(value) && !concreteTitleTopicPattern.test(value);
}

function titleSpecificityScore(value: string, index: number): number {
  let score = Math.min(24, value.length);
  if (concreteTitleTopicPattern.test(value)) score += 80;
  if (titleIntentPattern.test(value)) score += 18;
  if (/[A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-Ｚａ-ｚ0-9０-９_-]{1,}/u.test(value)) score += 12;
  if (isGenericTitleRequest(value)) score -= 120;
  if (/^(?:こちら|上記|本件|下記)/u.test(value)) score -= 15;
  if (/^(?:株式会社|合同会社|有限会社)?[^?？]{0,20}(?:様|さん)?$/u.test(value)) score -= 40;
  if (value.length > 72) score -= Math.min(24, value.length - 72);
  return score - index;
}

function conciseKnowledgeTitle(value: string): string {
  const concise = value
    .replace(/[。！？!?]+$/gu, '')
    .replace(/という(?=(?:保険|口座|契約|審査))/gu, '')
    .replace(/(?:に)?ついて[、,]\s*/gu, 'の')
    .replace(/(?:を|は)?(?:ご)?(?:確認|対応|回答|返信|返答|教示)(?:したい|してください|をお願いします|していただけますか|していただきたいです|できますか|可能でしょうか|すればよいでしょうか).*$/u, '')
    .replace(/(?:は)?(?:いつ|どこ|どのように|どうすれば).*(?:ますか|ですか|でしょうか)$/u, '')
    .replace(/[\s、,・:：]+$/u, '')
    .trim();
  const title = concise || value.replace(/[。！？!?]+$/gu, '').trim();
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
}

function titleCandidate(currentTitle: string, question: string): string {
  const candidates = titleSentences(question)
    .map((value, index) => ({ value, score: titleSpecificityScore(value, index) }))
    .sort((a, b) => b.score - a.score);
  const fromQuestion = candidates.find((candidate) => !isGenericTitleRequest(candidate.value))?.value;
  const rawFallback = stripSlackNoise(currentTitle)
    .replace(/^[:\w_-]+\s*/, '')
    .replace(/^[＊*]+|[＊*]+$/g, '')
    .trim();
  const fallback = titleSentences(currentTitle)
    .find((candidate) => !isGenericTitleRequest(candidate))
    ?? (isGenericTitleRequest(rawFallback) ? '' : rawFallback);
  const value = fromQuestion || fallback || '対応ナレッジ';
  return conciseKnowledgeTitle(value);
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
  return { status: score >= 70 && pickedScore >= 30 ? 'ready' : 'needs_review', score };
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
