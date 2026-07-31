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

export type OperationalKnowledgeSegment = OperationalKnowledge & {
  questionBlockIndex: number;
  answerBlockIndex: number;
};

type KnowledgeSource = {
  title: string;
  body: string;
  question?: string | null;
  answer?: string | null;
  responderLabels?: readonly string[];
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
const assigneeRequestPattern = /(?:^|\n)(?:<@?[UW][A-Z0-9]+>|@[\p{L}\p{N}_-]+|[^\s、。]{1,20}さん|CO|担当(?:者|部署)?)(?:に|へ|、|,|\s).{0,50}(?:ご対応|対応をお願い|確認をお願い|回答をお願い|返信をお願い|対応依頼|確認依頼|回答依頼|返信依頼)/iu;
const directResponseRequestOpeningPattern = /^(?:こちら(?:の|は|も)?|上記|本件|下記)(?:の内容)?\s*(?:ご対応|対応|ご確認|確認|返信|回答)/u;
const contextResponseRequestOpeningPattern = /^こちらの内容確認のため[\s\S]{0,120}ご対応/u;
const responseRequestLinePattern = /(?:ご対応|ご確認|返信文|ご回答|ご教示).*(?:お願い|ください|可能でしょうか|できますでしょうか|でしょうか)/u;
const questionPattern = /[?？]|(?:でしょうか|ですか|ますか|ませんか|よろしいでしょうか|いかがでしょうか)(?:[。！!\s]|$)/u;
const statusCheckPattern = /(?:状況|進捗|対応済み|確認済み|完了|終わって|どうなって|いつ(?:頃|まで)?).{0,50}(?:確認(?:ください|をお願い|してほしい|いただきたい)|共有(?:ください|をお願い|してほしい|いただきたい)|教えて(?:ください)?|でしょうか|ですか|ますか)/u;
const confirmationRequestPattern = /(?:認識|理解|内容|可否|状況|進捗).{0,50}(?:でよいか|相違ないか|問題ないか|確認依頼|確認してほしい|確認いただきたい)/u;
const relayedRequestPattern = /(?:対応|確認|回答|返信|報告|連絡).{0,40}(?:してほしい|していただきたい|お願いしたい)(?:とのこと|ということ|そうです|です)?/u;
const separateIssueRequestPattern = /(?:別件|別案件|追加でもう一点|もう一点).{0,100}(?:お願い|依頼|確認|対応|回答|返信)/u;
const definitiveAnswerPattern = /対象外|対象です|不要です|必要です|可能です|できません|となります|理由|ため|場合は|してください|てください|お伝えください|ご案内|返信例|回答例|完了|対応済み|振り込み予定|入金します|負担/u;
const boilerplateLinePattern = /^(?:!channel|<!channel>|cc[:：]?|お疲れ様です[。！!]?|いつもお世話になっております[。！!]?|よろしくお願いいたします[。！!]?|ご確認(?:のほど)?よろしくお願いいたします[。！!]?)$/iu;
const deadlineLinePattern = /^[\s:＊*_\w.-]*(?:回答)?(?:期限|期日)\s*[:：]?/iu;
const mentionOnlyPattern = /^(?:\s*@[^\s]+(?:\s+さん)?\s*)+(?:cc[:：]?\s*)?$/iu;
const concreteTitleTopicPattern = /保険(?:名|会社|商品)?|口座(?:名義|番号|登録|変更|振込)?|契約(?:内容|更新|解約|名義|期間)?|審査(?:状況|結果|通過)?|入金|振込|請求|支払|決済|返金|返品|交換|配送|納品|注文|商品|税|申告|売上|手数料|アカウント|ログイン|登録|名義|解約|更新/u;
const genericTitleRequestPattern = /(?:ご対応|対応|ご確認|確認|返信文?|ご回答|回答|ご返答|返答|ご教示).*(?:お願い|ください|いただけますか|いただきたい|可能でしょうか|できますでしょうか)/u;
const titleIntentPattern = /[?？]|確認|教えて|できます|でしょう|対応|方法|理由|必要|いつ|どこ|どの|どう/u;
const unresolvedMemberPattern = /(?:<@(?:U|W)[A-Z0-9]{4,}>|@(?:U|W)[A-Z0-9]{4,}\b|\b(?:U|W)[A-Z0-9]{7,}\b|@?(?:社内|Slack)?メンバー(?:ID)?[\s:_-]*\d+)/iu;
const operationalRequestPattern = /(?:ご(?:対応|確認|回答|返信|返答|共有|案内|教示|連絡|報告|調査|手配|削除|停止|修正|変更).{0,40}(?:ください|お願い|いただけ|いただきたい)|(?:対応|確認|回答|返信|返答|共有|案内|教示|連絡|報告|調査|手配|削除|停止|修正|変更).{0,40}(?:お願い|いただけ|いただきたい|してほしい|可能でしょうか|できますでしょうか))/u;
const closingOnlyPattern = /^(?:ありがとうございます|ありがとうございました|承知しました|承知いたしました|かしこまりました|了解しました|よろしくお願いします|よろしくお願いいたします|助かります|失礼しました)[\s!！。:：_-]*$/u;
const workflowFollowupRequestPattern = /(?:完了|対応|確認)(?:後|しましたら|したら).{0,30}(?:お知らせ|報告|共有|連絡).{0,20}(?:ください|お願い)/u;
const contextOnlyQuestionPattern = /^(?:こちら|上記|本件|下記).{0,50}(?:いかが|状況|進捗|対応済み|確認済み|完了|対応いただ|確認いただ)/u;
const progressOnlyPattern = /^(?:確認します|確認いたします|確認中です|確認しております|対応します|対応いたします).{0,40}(?:お待ち|少々|しばらく|改めて|後ほど)/u;
const topicGroups = [
  /振込|入金|支払|請求|精算|報酬|口座|送金|billpay/iu,
  /配送|発送|返品|返金|商品|注文|送料|破棄|納品|到着|未着/u,
  /税|申告|決算|源泉|控除|勘定|経費|会計|税理士/u,
  /契約|解約|退店|閉店|引き継ぎ|引継ぎ|最低保証/u,
  /ログイン|パスワード|ユーザid|r-login|rms|認証/iu,
  /電話|着信|折り返し|営業電話/u,
  /保険|補償|保険会社|保険商品/u,
  /弁護士|権利|侵害|商標|著作|内容証明/u,
  /住所|住民票|登記|書類|証憑|請求書|納品書/u,
  /融資|銀行提出|商品管理リスト/u,
] as const;

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

function stripConversationSpeaker(value: string): string {
  return normalize(
    stripSlackNoise(value)
      .replace(/`+/g, '')
      .split('\n')
      .map((line) => line
        .replace(/^\s*(?:cc[:：]\s*)?(?:@[^\s、。:：]+\s*)+/iu, '')
        .trim())
      .filter(Boolean)
      .join('\n'),
  );
}

function conversationSpeaker(value: string): string {
  return value.match(/^\s*@([^\s\n]+)/u)?.[1] ?? '';
}

function answerBlocks(value: string): string[] {
  return normalize(value)
    .split(/\n\s*---\s*\n/g)
    .map(stripSlackNoise)
    .filter(Boolean)
    .filter((block) => !pendingOnlyPattern.test(block))
    .filter((block) => !isNonResolutionBlock(block));
}

function isNonResolutionBlock(value: string): boolean {
  const firstLine = value.split('\n', 1)[0] ?? '';
  const responseRequestOpening = !/^こちら(?:の)?対応ありがとうございます/u.test(value)
    && (
      directResponseRequestOpeningPattern.test(value)
      || contextResponseRequestOpeningPattern.test(value)
      || responseRequestLinePattern.test(firstLine)
    );
  return questionPattern.test(value)
    || statusCheckPattern.test(value)
    || confirmationRequestPattern.test(value)
    || relayedRequestPattern.test(value)
    || separateIssueRequestPattern.test(value)
    || delegationOnlyPattern.test(value)
    || assigneeRequestPattern.test(value)
    || workflowFollowupRequestPattern.test(value)
    || responseRequestOpening;
}

function isOperationalQuestionBlock(value: string): boolean {
  const normalized = stripConversationSpeaker(value);
  if (!normalized || pendingOnlyPattern.test(normalized) || closingOnlyPattern.test(normalized)) return false;
  const firstLine = normalized.split('\n', 1)[0] ?? '';
  return isNonResolutionBlock(normalized)
    || operationalRequestPattern.test(normalized)
    || responseRequestLinePattern.test(firstLine);
}

function isConversationNoise(value: string): boolean {
  const normalized = stripConversationSpeaker(value);
  if (!normalized) return true;
  return pendingOnlyPattern.test(normalized)
    || closingOnlyPattern.test(normalized)
    || progressOnlyPattern.test(normalized)
    || delegationOnlyPattern.test(normalized);
}

function topicGroupIndexes(value: string): Set<number> {
  const indexes = new Set<number>();
  topicGroups.forEach((pattern, index) => {
    if (pattern.test(value)) indexes.add(index);
  });
  return indexes;
}

function comparableKnowledgeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/\[(?:電話番号|メールアドレス)\]/gu, '')
    .replace(/お疲れ様です|お世話になっております|ありがとうございます|よろしくお願いいたします|こちら|上記|本件|下記|ご対応|ご確認|お願いいたします|お願いします|いただけますでしょうか|いただきたい|してください|について/gu, '')
    .replace(/[^\p{Letter}\p{Number}ー一-龯ぁ-んァ-ン]+/gu, '');
}

function trigrams(value: string): Set<string> {
  const normalized = comparableKnowledgeText(value);
  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    result.add(normalized.slice(index, index + 3));
  }
  return result;
}

function knowledgeTopicContinuityScore(question: string, resolution: string): number {
  const questionGroups = topicGroupIndexes(question);
  const resolutionGroups = topicGroupIndexes(resolution);
  if (questionGroups.size > 0 || resolutionGroups.size > 0) {
    let sharedGroups = 0;
    for (const group of questionGroups) {
      if (resolutionGroups.has(group)) sharedGroups += 1;
    }
    return sharedGroups * 12;
  }

  const questionTrigrams = trigrams(question);
  const resolutionTrigrams = trigrams(resolution);
  let shared = 0;
  for (const gram of questionTrigrams) {
    if (!resolutionTrigrams.has(gram)) continue;
    shared += 1;
    if (shared >= 12) break;
  }
  return shared;
}

function resolutionScore(value: string): number {
  let score = Math.min(28, Math.floor(value.length / 16));
  if (/[。！？!?]/u.test(value)) score += 5;
  if (definitiveAnswerPattern.test(value)) score += 32;
  if (/ただし|例外|契約|手順|確認後|送付先|連絡先/u.test(value)) score += 8;
  if (/確認します|確認いたします|確認中|お待ちください|共有します/u.test(value)) score -= 32;
  if (value.length < 18) score -= 12;
  return score;
}

function pickResolution(blocks: string[]): { resolution: string; score: number } {
  if (blocks.length === 0) return { resolution: '', score: 0 };
  const ranked = blocks
    .map((block, index) => ({ block, index, score: resolutionScore(block) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked[0];
  if (selected.score < 15) {
    return { resolution: '', score: selected.score };
  }
  return {
    resolution: selected.block,
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

function buildProcedure(resolution: string): string {
  const explicitSteps = extractLines(
    resolution,
    /^(?:(?:手順\s*)?\d+[.)、：:]|[①-⑳]|[-・]|まず(?:、|\s)|次に(?:、|\s)|その後(?:、|\s)|最後に(?:、|\s))/u,
    6,
  );
  return explicitSteps;
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
  const hasUnresolvedMember = unresolvedMemberPattern.test(`${question}\n${resolution}`);
  let score = 0;
  if (question.length >= 18) score += 25;
  else if (question.length >= 8) score += 15;
  if (resolution.length >= 30) score += 30;
  else if (resolution.length >= 18) score += 20;
  if (pickedScore >= 35) score += 20;
  else if (pickedScore >= 18) score += 10;
  if (title.length >= 8 && !deadlineLinePattern.test(title) && !/^[:!@]/.test(title)) score += 15;
  if (!hasUnresolvedMember) score += 10;
  score = Math.max(0, Math.min(95, score));
  return { status: !hasUnresolvedMember && score >= 70 && pickedScore >= 30 ? 'ready' : 'needs_review', score };
}

function buildReviewNote(status: KnowledgeStatus, question: string, resolution: string, score: number): string {
  if (status === 'ready') return '';
  const reasons: string[] = [];
  if (question.length < 18) reasons.push('問い合わせ内容が短く判断条件が不足しています');
  if (!resolution) reasons.push('解決した回答を特定できませんでした');
  else if (resolution.length < 30) reasons.push('結論が短く再利用時の判断材料が不足しています');
  if (unresolvedMemberPattern.test(`${question}\n${resolution}`)) {
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
  const procedure = buildProcedure(resolution);
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

/**
 * Long-running Slack customer threads contain many unrelated requests. Pair a
 * request only with the next concrete response before another request starts.
 * The original source stays untouched; block indexes preserve audit context.
 */
export function deriveOperationalKnowledgeSegments(source: KnowledgeSource): OperationalKnowledgeSegment[] {
  const parsed = parseKnowledgeBody(source.body);
  const rootQuestion = stripConversationSpeaker(source.question || parsed.question || parsed.rest);
  const rawAnswer = source.answer || parsed.answer;
  const rawBlocks = normalize(rawAnswer)
    .split(/\n\s*---\s*\n/g)
  const responderLabels = new Set(source.responderLabels ?? []);
  const segments: OperationalKnowledgeSegment[] = [];
  let pendingQuestions = rootQuestion
    ? [{ text: rootQuestion, index: -1 }]
    : [];

  rawBlocks.forEach((rawBlock, index) => {
    const speaker = conversationSpeaker(rawBlock);
    const block = stripConversationSpeaker(rawBlock);
    if (!block || isConversationNoise(block)) return;
    if (workflowFollowupRequestPattern.test(block) || contextOnlyQuestionPattern.test(block)) return;

    const looksLikeQuestion = isOperationalQuestionBlock(block);
    const looksLikeConcreteAnswer = resolutionScore(block) >= 20 && definitiveAnswerPattern.test(block);
    const responder = responderLabels.size > 0 && responderLabels.has(speaker);
    const canAnswer = looksLikeConcreteAnswer && (responder || !looksLikeQuestion);

    if (canAnswer && pendingQuestions.length > 0) {
      const ranked = pendingQuestions
        .map((question, pendingIndex) => ({
          question,
          pendingIndex,
          score: knowledgeTopicContinuityScore(question.text, block),
        }))
        .sort((a, b) => b.score - a.score || b.question.index - a.question.index);
      const selected = ranked[0];
      const minimumScore = topicGroupIndexes(selected.question.text).size > 0 || topicGroupIndexes(block).size > 0 ? 12 : 2;
      if (selected.score >= minimumScore) {
        const body = `【問い合わせ内容】\n${selected.question.text}\n\n【解決回答】\n${block}`;
        const derived = deriveOperationalKnowledge({
          title: source.title,
          body,
          question: selected.question.text,
          answer: block,
        });
        if (derived.status !== 'unresolved' && derived.resolution) {
          segments.push({
            ...derived,
            sourceBody: source.body,
            questionBlockIndex: selected.question.index,
            answerBlockIndex: index,
          });
          pendingQuestions.splice(selected.pendingIndex, 1);
          return;
        }
      }
    }

    if (looksLikeQuestion || (!responder && !looksLikeConcreteAnswer && block.length >= 12)) {
      pendingQuestions.push({ text: block, index });
      pendingQuestions = pendingQuestions.slice(-12);
    }
  });

  return segments;
}
