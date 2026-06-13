---
title: ECオーナー通達LINE サポートCRM 本番投入前チェックリスト
status: draft
updated: 2026-06-13
---

# ECオーナー通達LINE サポートCRM 本番投入前チェックリスト

このチェックリストは、サポートCRMを検証用LINE公式アカウントから本番LINE公式アカウントへ切り替える前に使います。

「画面で見た」「APIで止まった」「テストが通った」を分けて確認します。大学の実験レポートでいうと、目視結果、機械的な検査結果、考察を分けるイメージです。

変更内容をレビューする場合は、先に[変更サマリー](./ec-owner-support-crm-change-summary.md)で、実装、テスト、運用ドキュメント、レビュー観点を確認します。

## 1. 事前準備

- [ ] Worker URL、管理画面URL、本番LINE公式アカウントIDを確認した
- [ ] ownerまたはadminのAPIキーを用意した
- [ ] staff権限のAPIキーを用意した
- [ ] staff権限のスタッフ名が空欄ではないことを確認した
- [ ] staffが見えてよい案件、見えてはいけない案件を1件ずつ用意した
- [ ] staffが見えてよいチャット、見えてはいけないチャットを1件ずつ用意した
- [ ] 未完了案件と完了済み案件のfixture IDを用意した
- [ ] 検証用LINE公式アカウントで送受信確認が終わっている

## 2. 自動検査

strict Preflightに使うfixture IDは、D1から候補を拾えます。このコマンドは読み取り専用の `SELECT` だけを実行し、DBの更新やLINE送信はしません。出力には、候補IDだけでなく、APIキーをplaceholderにしたdry-run/strict Preflight用のコマンドテンプレも出ます。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_STAFF_NAME=staffのスタッフ名 \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures
```

同姓同名のstaffがいる場合は、`/staff` 画面やDBで確認したstaff member IDを足します。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_STAFF_NAME=staffのスタッフ名 \
SUPPORT_CRM_STAFF_MEMBER_ID=staff_membersのID \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures
```

Cloudflareに接続せずSQLだけ確認したい場合:

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_STAFF_NAME=staffのスタッフ名 \
corepack pnpm support-crm:fixtures:sql
```

出力内の `# TODO export SUPPORT_CRM_STAFF_...=<required-fixture-id>` が残っている場合は、strict Preflightに必要なfixtureがまだ足りません。既存データで用意するか、下のsynthetic fixtureを使います。

既存データにstaff権限、未完了案件、完了済み案件、見えてはいけない案件/友だちが足りない場合は、検証用D1にsynthetic fixtureを作れます。通常は先にSQLだけ確認します。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_FIXTURE_STAFF_NAME="Preflight Staff" \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures:seed-sql
```

検証用D1に対象の `line_accounts` 行がまだ無い場合だけ、`SUPPORT_CRM_FIXTURE_CREATE_LINE_ACCOUNT=1` を付けるとsynthetic LINEアカウントも同時に作れます。本番LINE公式アカウントの行が既にあるD1では付けません。

実際にD1へ書く場合は、明示フラグを付けます。このコマンドはstaff APIキー、見える/見えない友だち、未完了/完了済みサポート案件を作ります。実顧客へのLINE送信はしません。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_FIXTURE_STAFF_NAME="Preflight Staff" \
SUPPORT_CRM_FIXTURE_WRITE=1 \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures:seed
```

seed fixtureを使い終わったら、同じprefixのsyntheticデータを削除します。古いWorkerに対してPreflightを実行してstaffが作れてしまった検証案件、synthetic friendに紐づくチャット行、明示フラグで作ったsynthetic LINEアカウントも、同じcleanupで消せます。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_FIXTURE_WRITE=1 \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures:cleanup
```

cleanup後は、残り件数がすべて0か確認します。この確認は読み取り専用で、synthetic fixtureの消し残しに気づくための最後の確認です。

```bash
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_D1_ENV=production \
corepack pnpm support-crm:fixtures:verify-cleanup
```

軽い確認では次を実行します。

```bash
SUPPORT_CRM_API_URL=https://your-worker.example.com \
SUPPORT_CRM_ADMIN_ORIGIN=https://your-admin.example.com \
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_OWNER_API_KEY=ownerのAPIキー \
SUPPORT_CRM_STAFF_API_KEY=staffのAPIキー \
corepack pnpm preflight:support-crm
```

本番切替前の最終確認では、任意チェックのスキップも失敗扱いにします。

先にdry-runで、必要な環境変数が揃っているかを確認します。このdry-runはWorkerやD1へ接続せず、APIキーは伏せ字で表示します。
strict確認では `SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0` を付けません。このguardを切ると、staffによる作成・更新禁止の確認が抜けます。

```bash
SUPPORT_CRM_API_URL=https://your-worker.example.com \
SUPPORT_CRM_ADMIN_ORIGIN=https://your-admin.example.com \
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_OWNER_API_KEY=ownerのAPIキー \
SUPPORT_CRM_STAFF_API_KEY=staffのAPIキー \
SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1 \
SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=staffが見えてよい案件ID \
SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID=staffが見えてはいけない案件ID \
SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID=staffが見えてよい未完了案件ID \
SUPPORT_CRM_STAFF_RESOLVED_CASE_ID=staffが見えてよい完了済み案件ID \
SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID=staffが見えてよい友だちID \
SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID=staffが見えてはいけない友だちID \
SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=完了済み案件に紐づく友だちID \
corepack pnpm preflight:support-crm:dry-run
```

```bash
SUPPORT_CRM_API_URL=https://your-worker.example.com \
SUPPORT_CRM_ADMIN_ORIGIN=https://your-admin.example.com \
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_OWNER_API_KEY=ownerのAPIキー \
SUPPORT_CRM_STAFF_API_KEY=staffのAPIキー \
SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1 \
SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=staffが見えてよい案件ID \
SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID=staffが見えてはいけない案件ID \
SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID=staffが見えてよい未完了案件ID \
SUPPORT_CRM_STAFF_RESOLVED_CASE_ID=staffが見えてよい完了済み案件ID \
SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID=staffが見えてよい友だちID \
SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID=staffが見えてはいけない友だちID \
SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=完了済み案件に紐づく友だちID \
corepack pnpm preflight:support-crm
```

PR本文にPreflight結果を貼る場合は、生ログではなくPR用summaryを使います。summaryは件数とチェック名だけを出し、URL、APIキー、友だちID、案件IDがPR本文に混ざらないようにします。生ログは手元に残します。

```bash
SUPPORT_CRM_API_URL=https://your-worker.example.com \
SUPPORT_CRM_ADMIN_ORIGIN=https://your-admin.example.com \
SUPPORT_CRM_LINE_ACCOUNT_ID=本番LINE公式アカウントID \
SUPPORT_CRM_OWNER_API_KEY=ownerのAPIキー \
SUPPORT_CRM_STAFF_API_KEY=staffのAPIキー \
SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1 \
SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=staffが見えてよい案件ID \
SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID=staffが見えてはいけない案件ID \
SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID=staffが見えてよい未完了案件ID \
SUPPORT_CRM_STAFF_RESOLVED_CASE_ID=staffが見えてよい完了済み案件ID \
SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID=staffが見えてよい友だちID \
SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID=staffが見えてはいけない友だちID \
SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=完了済み案件に紐づく友だちID \
corepack pnpm preflight:support-crm > support-crm-preflight.log
corepack pnpm preflight:support-crm:summary --file support-crm-preflight.log
```

- [ ] `Failures to fix` が出ていない
- [ ] `Skipped optional checks` が出ていない
- [ ] `preflight:support-crm:summary` の出力だけをPR本文に貼った
- [ ] `preflight: full coverage required` が出ていない
- [ ] `preflight:support-crm:dry-run` が失敗していない
- [ ] `SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0` を付けていない
- [ ] staff APIキーのログイン情報にスタッフ名が入っている
- [ ] staffによる案件作成、担当変更、エスカレ担当指定、マニュアル作成/更新/無効化が403で止まる
- [ ] 未完了案件を再オープンにできない
- [ ] 完了済み案件からの顧客返信がLINE送信前に止まる
- [ ] 未対応のチャット `messageType` がLINE送信前、DB記録前に止まる
- [ ] `corepack pnpm support-crm:fixtures` で出た候補IDを使っている

## 3. 画面確認

- [ ] `/login` でAPIキーによるログインができる
- [ ] セッション切れ時に `/support` から `/login` へ戻る
- [ ] owner/adminで「新規案件」が表示される
- [ ] staffで「新規案件」が表示されない
- Local mock browser smokeでは、owner/adminで「新規案件」ボタンが1件、staffで0件であることを確認済み。ここは本番切替前に実データでも同じ確認をします。
- [ ] staffで自分に関係する案件だけが表示される
- [ ] staffで自分に関係する案件に紐づくチャットだけが表示される
- [ ] staffで自分に関係しない友だちのdirect履歴APIが表示されない
- [ ] staff名が空欄の古いアカウントでは、画面に理由が表示され操作が止まる
- Local empty-staff browser smokeでは、理由文が表示され、ダミー案件/マニュアル/スタッフ候補/未対応99件バッジは表示されず、サポート案件/マニュアル/チャット候補/スタッフ一覧/未対応件数APIも呼ばれないことを確認済み。
- [ ] 案件一覧の未完了、期限超過、24h滞留、担当者なし、エスカレ、自分宛、顧客返信待ち、完了のキューが切り替わる
- [ ] 検索、ステータス絞り込み、並び替えが使える
- Local list-control browser smokeでは、APIが別順で返しても「更新が新しい順」は `updatedAt` 降順になり、初回詳細も一覧先頭に一致し、期限超過キュー、完了ステータス、検索 `q=Gamma` が期待通り切り替わることを確認済み。
- [ ] 選択中の案件が絞り込み外にある場合、画面に理由と戻り操作が出る
- Local outside-list browser smokeでは、完了案件をURL直指定して未完了一覧の外に置いた場合に理由と `完了案件を表示` が出て `status=resolved` の一覧へ戻れること、未完了案件をステータス絞り込みで外に置いた場合に `絞り込みをリセット` で `queue=unresolved` の一覧へ戻れることを確認済み。
- [ ] 長いチャットで過去メッセージを読み込める
- Local long-chat browser smokeでは、初期表示で最新2件だけを表示し、`過去のメッセージを読み込む` で `beforeCreatedAt`/`beforeId` 付きAPIを呼び、古い2件が前に追加され、全4件が古い順に並び、追加後に読み込みボタンが消えることを確認済み。
- [ ] サポート案件から「チャットで返信」を押すと、チャット入力欄に返信案が入る
- Local draft-handoff browser smokeでは、サポート案件の `チャットで返信` から `/chats?friend=...&supportCase=...&lineAccount=...` へ遷移し、メッセージ入力欄に返信案が入り、案件タイトル付きの紐付けバナーが `返信案を入力中` と表示されることを確認済み。
- [ ] sessionStorageが使えない環境でも、URLの `supportCase` で案件紐付けが残る
- Local URL-fallback browser smokeでは、sessionStorage draftなしの `/chats?friend=...&supportCase=...&lineAccount=...` 直リンクで案件紐付けバナーが `に紐づけ中` と表示され、テキスト送信payloadに `supportCaseId` と `lineAccountId` が入ることを確認済み。
- [ ] テキスト返信で案件履歴に顧客返信イベントが残る
- [ ] 画像だけの返信でも案件履歴に顧客返信イベントが残る
- [ ] 画像とテキストを同時に送っても、不要な「案件更新だけ確認が必要」警告が出ない
- [ ] 完了済み案件では、再オープンしてから返信する運用になっている
- [ ] マニュアル作成/編集でタイトル、本文、URL形式の保存前チェックが効く
- [ ] マニュアル無効化、スタッフ削除、APIキー再生成は画面内確認ダイアログで止まる
- [ ] クリップボードAPIが使えない環境でも、コピー失敗時の案内が表示される

## 4. ローカル検証コマンド

PRに載せる検証コマンドは次を基準にします。

```bash
corepack pnpm --filter web test
corepack pnpm test:scripts
corepack pnpm --filter worker typecheck
corepack pnpm --filter worker test
corepack pnpm --filter worker test -- src/routes/support.test.ts src/routes/chats.test.ts src/routes/staff.test.ts src/services/support-access.test.ts
corepack pnpm build
corepack pnpm --filter worker build
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 corepack pnpm --filter web build
git diff --check
```

画面応答確認:

```bash
PORT=3001 NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 corepack pnpm --filter web dev
curl -sS -o /dev/null -w 'staff %{http_code}\n' http://localhost:3001/staff
curl -sS -o /dev/null -w 'support %{http_code}\n' http://localhost:3001/support
curl -sS -o /dev/null -w 'chats %{http_code}\n' 'http://localhost:3001/chats?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke'
```

## 5. PR用変更要約

PR本文には、次の内容を貼ります。秘密値、本番の友だちID、実際の顧客情報は書きません。

```md
## Summary

- Problem: サポートCRMのstaff表示範囲、チャット返信連携、完了済み案件の誤返信防止、本番切替前検査が運用上まだ弱かった。
- Solution: Worker APIでstaff可視範囲と更新権限を絞り、Web UIでrole別操作・空状態・チャット返信導線・確認ダイアログを整え、Preflightと運用マニュアルを追加した。
- What changed: サポート案件/チャット/スタッフAPI、friend/inbox/users-grouped/users/account-settings/conversions/calendar/conversation/scenario APIのstaff可視範囲guard、broadcast管理/配信/集計/dedup-preview API、admin診断/repair API、フォーム管理API、売上・広告・計測運用APIのowner/admin制限、フォーム公開GET/submit境界、CORS、サポートCRM UI、案件一覧の更新順/初回選択/キュー解除、staffサイドバーの管理メニュー非表示、staff管理URL直打ちの `/support` 退避、チャット返信の案件履歴連携、staffフォーム/クリップボード/認証キャッシュ helper、Preflight、strict Preflight dry-run、PR-safe Preflight summary、strict必須credential guard、dry-run checklist audit、release readiness、strict Preflight用fixture候補抽出/コマンドテンプレ、synthetic fixture seed/cleanup/cleanup verification、テスト、運用ドキュメント、PR用CI検証範囲。
- What did NOT change: LINE公式アカウントの本番切替そのもの、DB migration、既存の本番データ、APIキーや秘密値。

## Related Issue

N/A

## Change Type

- [x] Bug fix
- [x] Feature
- [x] Security hardening
- [x] Documentation
- [ ] Tests only
- [x] Chore / infra

## Scope

- [x] Admin web UI
- [x] Worker API
- [x] Auth / API keys / cookies / CORS / staff permissions
- [x] D1 schema / migrations / account scoping
- [ ] Docs only

## Verification

- `corepack pnpm --filter web test`
- `corepack pnpm --filter web test -- src/components/layout/sidebar-access.test.ts`
- `corepack pnpm --filter web test -- src/lib/support-chat-draft.test.ts`
- `corepack pnpm test:scripts`
- `corepack pnpm --filter worker typecheck`
- `corepack pnpm --filter worker test -- src/middleware/auth.test.ts src/routes/users.test.ts src/routes/account-settings.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/broadcasts-access.test.ts src/routes/forms-access.test.ts src/routes/operations-access.test.ts`
- `corepack pnpm --filter worker test -- src/routes/support-friend-access-routes.test.ts`
- `corepack pnpm --filter worker test`
- `corepack pnpm --filter worker test -- src/routes/support.test.ts src/routes/chats.test.ts src/routes/staff.test.ts src/services/support-access.test.ts`
- `corepack pnpm build`
- `corepack pnpm --filter worker build`
- `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 corepack pnpm --filter web build`
- `git diff --check`
- Browser smoke with owner/admin/staff mock sessions confirms `/support` role UI: owner/admin show one `新規案件` button; staff shows zero `新規案件` buttons. Staff mock sidebar only shows 友だち管理, 個別チャット, サポートCRM, and 未対応 while hiding management menus; direct staff access to `/broadcasts` returns to `/support`; direct admin access to `/staff` also returns to `/support`.
- Browser smoke with empty staff-name mock session confirms `/support` shows the staff-name warning, does not render the dummy case/manual/staff suggestion/unanswered badge, and does not call `/api/support/summary`, `/api/support/cases`, `/api/support/manuals`, `/api/chats`, `/api/staff`, or `/api/inbox/unanswered/count`.
- Browser smoke with list-control mock session confirms updated sort is `updatedAt` desc even when API order differs, initial detail matches the first displayed case, priority sort reorders locally, overdue queue sends `queue=overdue`, status selection clears queue, and search sends `q=Gamma`.
- Browser smoke with outside-list mock session confirms hidden selected cases keep the detail panel with an explanatory banner; resolved hidden cases reveal the completed list with `status=resolved`, while unresolved hidden cases reset to `queue=unresolved`.
- Browser smoke with long-chat mock session confirms the chat screen starts with the latest two messages, calls `/api/chats/:id` with `beforeCreatedAt` and `beforeId` when loading older history, prepends the two older messages in chronological order, and hides the load-older button after `hasMoreMessages=false`.
- Browser smoke with draft-handoff mock session confirms `チャットで返信` opens `/chats?friend=...&supportCase=...&lineAccount=...`, fills the chat message box with the support reply draft, and keeps the support-case title in the linked-draft banner after the URL fallback reruns.
- Browser smoke with URL-fallback mock session confirms a direct `/chats?friend=...&supportCase=...&lineAccount=...` link without a sessionStorage draft shows the support-case link banner, starts with an empty message box and disabled send button, and sends text with `supportCaseId`/`lineAccountId` in the payload.
- `corepack pnpm preflight:support-crm:dry-run` success path: strict release env shape passes with secrets redacted.
- `corepack pnpm preflight:support-crm:dry-run` failure path: missing admin origin, staff key, staff fixture IDs, and disabled staff mutation guard are reported before network calls.
- `corepack pnpm preflight:support-crm:summary` converts the full Preflight log into a PR-safe summary that omits URLs, API keys, friend IDs, and case IDs.
- Script test verifies the release checklist includes every strict dry-run env and the mutation-guard warning, so docs cannot silently drift from the command.
- Worker/script tests verify staff cannot use `/api/friends`, unanswered inbox list/count, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, broadcast management/send/count/insight/dedup-preview APIs, admin diagnostics/repair APIs, form management/submission-list APIs, Stripe events, ad-platforms, affiliate management/reporting, tracked-link management, conversion history/report, calendar bookings, direct message history/send, conversation queue/detail, scenario manual enrollment, score, reminder, or rich-menu friend endpoints to bypass support-case friend visibility or role boundaries. Chat reply tests verify support-case history survives URL fallback without `lineAccountId`, and web helper tests verify image+text sends attach the support case to only one send step.
- `corepack pnpm support-crm:release-readiness` separates local/PR evidence failures, missing PR-safe Preflight summary evidence, stale CI runs, and external waits such as draft status, production strict Preflight, and fork PR CI approval.
- GitHub Actions workflow coverage includes `apps/web/**`, `scripts/**`, `package.json`, Web tests, script tests, and Web production build.
- If this is a fork PR, GitHub Actions may stay `action_required` until a repository maintainer approves the run.
- Local strict Preflight result: `19 passed, 0 skipped, 0 failed`.
- Remote test Worker deploy after friend API guard: `3f920e16-3789-430d-8e5e-e2316e266ecf`.
- Remote strict Preflight result after friend score/reminder guard: `32 passed, 0 skipped, 0 failed`.
- Remote cleanup verification: synthetic fixture line_accounts/staff/cases/events/friends/messages/chats are all `0` after cleanup; the one-time owner staff row is also `0`.
- Browser: `/support` redirects to `/login` when unauthenticated, login screen renders, console error count is 0.
- HTTP: `/staff`, `/support`, `/chats?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke` return 200 locally.
- Not tested: 本番LINE公式アカウントへの実切替、実顧客へのLINE送信、本番LINE公式アカウントの実顧客データを使ったstrict Preflight。

## Security Impact

- New permissions/capabilities? `Yes`: staff visibility is now enforced for support cases, linked chats, unanswered inbox, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, conversion history/report, calendar bookings, and direct friend API access; broadcast management/send/count/insight/dedup-preview, admin diagnostics/repair, form management/submission-list, and revenue/ad/measurement operations APIs are owner/admin-only.
- Secrets/tokens handling changed? `Yes`: browser auth cache handling is centralized and stale local values are cleared on session failure/logout.
- New/changed network calls? `Yes`: Support UI verifies current staff identity via `/api/staff/me`; fixture helpers can run D1 SELECT, read-only cleanup verification, or explicitly confirmed synthetic fixture INSERT/cleanup through Wrangler. Preflight dry-run adds no network calls. Release readiness reads PR/Actions metadata through `gh`. LIFF form definition GET/opened/partial/submit remain public, but form PUT/DELETE/list/submissions now require authenticated owner/admin.
- Message sending behavior changed? `Yes`: support-case replies validate resolved status before LINE send and record support case events after send; broadcast send/segment/test-send and dedup-preview APIs now require owner/admin before LINE push or recipient preview.
- Customer/friend data access changed? `Yes`: staff chat/inbox/users-grouped/users/account-settings/conversions/calendar/conversation visibility and direct friend API access are limited to friends tied to visible support cases; broadcast preview/count/progress/insight/dedup-preview, admin recent messages/friend debug/repair APIs, form submission lists, and Stripe/ad/affiliate/tracked-link management APIs are owner/admin-only; fixture candidate output does not print friend names or case titles by default.
- Direct friend API access changed? `Yes`: staff friend list, friend count, friend detail, unanswered inbox list/count, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, conversion history/report, calendar bookings, direct message history, direct send, tag, metadata, conversation queue/detail, scenario manual enrollment, score, reminder, and rich-menu friend endpoints now share the support-case friend visibility guard.
- D1 migration or data deletion changed? `No`: no schema migration. Fixture cleanup deletes only synthetic fixture rows matching the configured prefix, synthetic friend chats, the optional synthetic line_account row, and the known old-preflight guard title.

## Safety Checklist

- [x] This PR is focused on one problem and contains no unrelated commits.
- [ ] I searched for existing issues/PRs to avoid duplicates.
- [x] No secrets, tokens, customer data, friend IDs, private URLs, or private configuration are included.
- [x] No generated build output, `.tsbuildinfo`, local env files, or formatting-only churn is included.
- [x] Docs or tests were updated when useful.
- [x] Deployment impact is understood.
- [x] For high-risk areas, I included a clear rollback or recovery note.
- [x] I personally verified the behavior described above.

## Rollback / Recovery

- Keep the previous deployed Worker and Pages deployment available for rollback.
- If staff cannot see expected work, first verify staff name, role, and fixture visibility with `corepack pnpm preflight:support-crm`.
- If strict fixture IDs are hard to find, run `SUPPORT_CRM_LINE_ACCOUNT_ID=... SUPPORT_CRM_STAFF_NAME=... corepack pnpm support-crm:fixtures` and use the suggested env values.
- If the target D1 lacks strict Preflight data, run `corepack pnpm support-crm:fixtures:seed-sql` first, then `SUPPORT_CRM_FIXTURE_WRITE=1 corepack pnpm support-crm:fixtures:seed`, and clean up afterward with `SUPPORT_CRM_FIXTURE_WRITE=1 corepack pnpm support-crm:fixtures:cleanup` followed by `corepack pnpm support-crm:fixtures:verify-cleanup`.
- If chat replies fail for completed cases, reopen the support case before sending.
- If Preflight strict mode fails because optional checks are skipped, fill the missing `SUPPORT_CRM_STAFF_*` fixture envs before switching production traffic.
```

## 6. PR draft解除前のreadiness確認

PRをdraftからreadyにする前に、内部で直すべき未達と外部待ちを分けます。

```bash
corepack pnpm support-crm:release-readiness
```

見方:

- `FAIL`: こちらで直してから再確認する項目です。例: ローカル差分あり、PR head未push、PR本文の検証証跡不足、CI失敗。
- PR本文の検証証跡には、`preflight:support-crm:dry-run`、`preflight:support-crm:summary`、remote strict Preflight、remote cleanup verification、GitHub Actions statusを含めます。
- `WAIT`: 外部状態や本番切替前の未実施確認です。例: fork PRのGitHub Actions承認待ち、最新commitのCI run待ち、PRがdraftのまま、本番LINE公式アカウントの実データstrict Preflight未実施。
- `PASS`: その項目は現時点の証跡で満たしています。

## 7. 切替判断

本番切替に進んでよい条件:

- [ ] 最終Preflightがstrict modeで成功している
- [ ] owner/adminとstaffの両方で画面確認が完了している
- [ ] 顧客返信のテキスト、画像、画像＋テキストの確認が完了している
- [ ] staffの見えてよい/見えてはいけない案件とチャットを確認済み
- [ ] rollback先のWorker/Pagesデプロイを確認済み
- [ ] 担当者に、完了済み案件は再オープンしてから返信する運用を説明済み

次のどれかに当てはまる場合は、切替を止めます。

- `Skipped optional checks` が残っている
- staff名が空欄のスタッフがいる
- staffで見えてはいけない案件またはチャットが見えている
- 完了済み案件から返信できてしまう
- チャット送信後にLINE送信履歴と案件履歴のどちらかが残らない
