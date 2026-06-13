---
title: ECオーナー通達LINE サポートCRM 変更サマリー
status: draft
updated: 2026-06-13
---

# ECオーナー通達LINE サポートCRM 変更サマリー

このファイルは、今回のサポートCRM差分をレビュー、PR作成、本番投入前確認で使うための提出用サマリーです。

大きく見ると、今回の変更は「staffが見てよい範囲だけを見る」「チャット返信と案件履歴がつながる」「本番切替前に機械的に検査できる」「PRで同じ範囲をCIに載せる」の4点です。

## 1. 実装

### Worker API

- support案件一覧、詳細、更新、履歴、エスカレーション、マニュアル操作にstaff可視範囲とrole別権限を適用
- support案件一覧、友だち一覧、conversionイベント一覧の `limit` / `offset` queryは、SQL bind前に既定値、整数、有限値へ丸める
- calendar空き枠取得の `slotMinutes` / `startHour` / `endHour` queryは、0以下、範囲外、非数値を既定値へ戻し、開始時刻が終了時刻以上なら400で止める
- automations logs、notifications、Stripe events、ad conversion logs、admin diagnosticsの `limit` / `offset` / `days` queryも既定値、上限、整数へ正規化し、Worker routes/services内の生の `Number(c.req.query(...))` / `parseInt(c.req.query(...))` を残さない
- staffは自分が作成、担当、エスカレ先になっている案件だけを扱う
- staffに見えているサポート案件へ紐づく友だちだけ、チャット一覧とチャット詳細で表示
- staffが `/api/friends`、未対応インボックス一覧/件数、users-grouped顧客統合、legacy users顧客ID API、account-settingsテスト送信先、conversion履歴/集計、calendar予約、direct message履歴、conversation一覧/詳細、scenario手動登録、score、reminder、rich-menu APIを使っても、自分に見えるサポート案件へ紐づく友だちだけに制限
- broadcast管理API（一覧、詳細、作成、更新、削除、preview-count、dedup-preview、本送信、segment送信、test-send、insight取得、progress、segment count）はowner/adminだけに制限
- admin診断/repair API（プロフィール再取得、broadcast reset、タグ/配信漏れチェック、recent messages、friend debugなど `/api/admin/*`）はowner/adminだけに制限
- フォーム管理API（一覧、作成、更新、削除、回答一覧）はowner/adminだけに制限し、LIFF用のフォーム定義GET、opened、partial、submit公開エンドポイントは維持
- `/api/forms/:id` の公開認証skipはGET/HEADだけに限定し、同じパスのPUT/DELETEが未認証で通らないようにした
- 公開フォームsubmitのWebhook gateは、LIFFクライアントの事前確認や `_skipWebhook` 自己申告を信じず、Worker側で毎回再判定する
- 公開フォームのopened、partial、submitで友だちへ紐付ける処理は、caller supplied `lineUserId` / `friendId` ではなくLINE ID token検証済みのLINE user IDだけを使う
- `/api/liff/profile` はcaller supplied `lineUserId` で友だち情報を返さず、LINE ID token検証済みのLINE user IDだけでプロフィールを解決する
- `/api/liff/send-form-link` はフォームURL push前にLINE ID tokenのsubjectとcaller supplied `lineUserId` の一致を必須にする
- tracked-link公開リダイレクト `/t/:linkId` はcaller supplied `f` / `lu` を友だち本人として扱わず、LINEアプリ内では `ref` 付きLIFFへ回し、`/api/liff/link` のLINE ID token検証後にだけ友だち付きクリック、tag、scenario attributionを行う
- 公開フォーム送信クライアントとフォームsubmit routeは、回答データ、送信先、レスポンスステータス、friend ID、LINE user IDをconsoleへ出さない
- Webhook follow、LIFF/X Harness連携、booking LIFF認証は、LINE user ID、friend ID、表示名、Xユーザー名、channel候補、verify失敗bodyをconsoleへ出さない
- LIFF OAuth token交換、IG Harness notify、X Harness action失敗ログは、外部レスポンス本文、LINE friend UUID、tag名、例外本文をconsoleへ出さず、HTTP statusや例外種別だけにする
- Webhookプロフィール取得、profile refresh、broadcast test-sendの失敗ログは、LINE user IDやfriend IDを含めない
- 売上・広告・計測運用API（Stripe events、ad-platforms、affiliates管理/レポート、tracked-links管理）はowner/adminだけに制限し、公開Webhook/クリック/リダイレクトは維持
- 完了済み案件からの顧客返信をLINE送信前に拒否
- チャット送信APIで `text`、`flex`、`image` 以外のmessageTypeや壊れた画像/Flex payloadをLINE送信前、DB記録前に拒否
- チャット送信後に案件ステータスを「顧客返信待ち」へ更新し、案件履歴に顧客返信イベントを残す
- 画像だけの返信でも、サポート案件への履歴連携を行う
- `lineAccountId` を持たないURL fallback経由でも、友だちのLINEアカウントから案件履歴を残す
- 完了済み案件への `/send` と `/send/validate` はLINE送信、チャット記録、案件履歴記録の前に400で止める
- staff名の空欄保存を防ぎ、staff名がないAPIキーをPreflightと画面で検知できるようにした
- credentialed CORSをまとめ、ブラウザログインで必要な `Access-Control-Allow-Credentials` を確認できるようにした

### Web UI

- サポートCRMで現在のログイン権限を `/api/staff/me` から確認し、ローカルキャッシュだけでowner/admin操作を出さない
- staffでは新規案件、担当/期限/優先度変更、マニュアル作成/更新/無効化などの管理操作を非表示または読み取り専用化
- staffのサイドバーは、友だち管理、個別チャット、サポートCRM、未対応だけに絞り、配信、分析、設定などの管理メニューを表示しない。管理URLを直接開いた場合も `/support` へ戻す
- 未対応インボックスは、検索、LINEアカウント、1時間以上、ページ番号をAPIへ渡すサーバ側ページネーションにし、上部カードの件数/アカウント別件数/最古待ち時間も同じ絞り込み条件に連動させ、2000件一括取得の表示上限に頼らず古い未対応まで追えるようにした。不正な `page` / `pageSize` / `minWaitMinutes` queryは既定値または未指定扱いへ戻す
- スタッフ管理画面はowner専用として、adminが `/staff` を直接開いた場合も `/support` へ戻す
- staff名が空欄の古いアカウントでは、理由を表示し、案件/マニュアル/チャット候補/スタッフ候補/未対応件数の読み込みと操作を止める
- 未認証で `/support` を開くと `/login` へ戻り、APIキーでログイン後はスタッフ名/role/CSRFをキャッシュしてダッシュボードへ進む
- 案件一覧に未完了、期限超過、24h滞留、担当者なし、エスカレ、自分宛、顧客返信待ち、完了のキューを整理
- 案件一覧の「更新が新しい順」はAPIの返却順に依存せず `updatedAt` 降順にし、初回詳細は表示順の先頭に合わせる。ステータス絞り込みを選んだときは、前に選んでいた優先キューを解除する
- 選択中の案件が現在の絞り込み外にある場合、理由と復帰ボタンを表示
- 長いチャットで過去メッセージを追加読み込みできる
- サポート案件の「チャットで返信」からチャット入力欄へ返信案を引き継ぐ
- チャット返信のURL fallbackが再実行されても、sessionStorageから取れた案件タイトル、返信案、LINEアカウントIDを保持し、紐付けバナーをIDだけの表示に戻さない
- 画像+テキストを同時に送る場合は、サポート案件の紐付けを画像側だけに付け、二重更新や不要な警告を避ける
- LINE画像返信はファイルアップロードに加えて、HTTPS画像URLを直接入力できる
- sessionStorageが使えない場合でも、URLの `supportCase` で案件紐付けを維持
- まだチャット行がない友だちへの `/chats?friend=...&supportCase=...` 直リンクでも、友だち詳細から空チャットを表示して初回返信できる
- 画像とテキストを同時に送っても、案件がすでに「顧客返信待ち」なら不要な復旧警告を出さない
- コピー、スタッフフォーム、認証キャッシュ、確認ダイアログをhelper化し、失敗時の案内を画面に出す
- マニュアル編集はタイトル、本文、URL形式を保存前に検査し、マニュアル無効化、スタッフ削除、APIキー再生成は画面内確認ダイアログを通してから実行する

### Scripts

- `corepack pnpm preflight:support-crm` を追加
- owner/admin/staff APIキーのログイン権限、CORS、サポート要約、案件一覧、マニュアル検索、チャット一覧を検査
- staffによる案件作成、担当変更、エスカレ担当指定、マニュアル作成/更新/無効化が拒否されることを検査
- optional fixtureでstaff可視範囲、friend direct履歴/score/reminder APIの可視範囲、未完了案件の再オープン禁止、完了済み案件からの返信禁止、未対応チャットmessageTypeの送信前拒否、LINE画像payloadのHTTPS検証を検査
- `corepack pnpm preflight:support-crm:dry-run` で本番切替前の環境変数不足を実通信なし・APIキー伏せ字で確認
- `corepack pnpm preflight:support-crm:summary` でPreflight生ログを、URL、APIキー、友だちID、案件IDを含めないPR用summaryへ変換
- dry-runのstrict必須envと本番投入前チェックリストがズレたらscript testで検知
- `corepack pnpm support-crm:release-readiness` でPR-safe summaryを含むPR証跡、最新commitのCI run head、draft解除前の内部FAIL、外部WAIT、PASSを整理
- `SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1` で任意チェックのスキップも失敗扱いにする
- strict modeではowner/adminキー、staffキー、staff fixture ID、CORS origin、staff mutation guard有効化を必須にする
- `corepack pnpm support-crm:fixtures` でstrict Preflight用の候補IDをD1から読み取り専用で抽出
- fixture候補出力に、APIキーplaceholder付きのdry-run/strict Preflightコマンドテンプレを追加
- 既存データに検証fixtureが足りない場合に、synthetic fixtureをseed/cleanupできる補助コマンドを追加
- 検証用D1にLINEアカウント行が無い場合は `SUPPORT_CRM_FIXTURE_CREATE_LINE_ACCOUNT=1` でsynthetic LINEアカウントもseedできる
- cleanupではsynthetic friendに紐づくチャット行も削除し、古いWorkerで作られた検証チャット残骸を残さない
- `corepack pnpm support-crm:fixtures:verify-cleanup` でcleanup後のLINEアカウント、staff、案件、イベント、メッセージ、友だち、チャット残骸を読み取り専用で確認

### CI

- Worker CIのPR対象を `apps/web/**`、`scripts/**`、`package.json` まで広げた
- PR上で、script tests、Web tests、Worker typecheck/test/build、Web production buildをまとめて確認する
- fork PRのGitHub Actionsは管理者承認が必要なので、承認待ちの間は同じコマンドをローカルで再現して確認する

## 2. テスト

追加/更新した主なテスト:

- `apps/worker/src/services/support-access.test.ts`
- `apps/worker/src/routes/support.test.ts`
- `apps/worker/src/routes/chats.test.ts`
- `apps/worker/src/routes/support-friend-access-routes.test.ts`
- `apps/worker/src/routes/users.test.ts`
- `apps/worker/src/routes/account-settings.test.ts`
- `apps/worker/src/routes/admin-diagnostics-access.test.ts`
- `apps/worker/src/routes/broadcasts-access.test.ts`
- `apps/worker/src/routes/forms-access.test.ts`
- `apps/worker/src/routes/operations-access.test.ts`
- `apps/worker/src/middleware/auth.test.ts`
- `apps/worker/src/routes/staff.test.ts`
- `apps/web/src/components/support/support-meta.test.ts`
- `apps/web/src/components/layout/sidebar-access.test.ts`
- `apps/web/src/lib/auth-session.test.ts`
- `apps/web/src/lib/clipboard.test.ts`
- `apps/web/src/lib/staff-form.test.ts`
- `apps/web/src/lib/inbox-pagination.test.ts`
- `apps/web/src/lib/support-chat-draft.test.ts`
- `scripts/support-crm-preflight.test.ts`
- `scripts/support-crm-fixture-candidates.test.ts`
- `scripts/support-crm-seed-fixtures.test.ts`

直近で通した検証:

```bash
corepack pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-crm/db --filter @line-harness/update-engine build
corepack pnpm --filter web test
corepack pnpm --filter web test -- src/lib/inbox-pagination.test.ts
corepack pnpm --filter worker test -- src/routes/support.test.ts
corepack pnpm --filter worker test -- src/routes/friends.test.ts
corepack pnpm --filter worker test -- src/routes/conversions-calendar-access.test.ts
corepack pnpm --filter worker test -- src/routes/automations.test.ts src/routes/operations-access.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/notifications.test.ts
corepack pnpm --filter worker test -- src/services/unanswered-inbox.test.ts src/routes/inbox.test.ts
corepack pnpm --filter worker test -- src/routes/webhook.test.ts src/routes/webhooks.test.ts src/routes/events.test.ts
corepack pnpm --filter worker test -- src/routes/liff-access.test.ts src/routes/forms-access.test.ts src/middleware/auth.test.ts
corepack pnpm --filter worker test -- src/routes/operations-access.test.ts src/routes/liff-access.test.ts
corepack pnpm test:scripts
corepack pnpm --filter worker typecheck
corepack pnpm --filter worker build
corepack pnpm --filter worker test -- src/middleware/auth.test.ts src/routes/users.test.ts src/routes/account-settings.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/broadcasts-access.test.ts src/routes/forms-access.test.ts src/routes/operations-access.test.ts
corepack pnpm --filter worker test
corepack pnpm --filter worker test -- src/routes/support.test.ts src/routes/chats.test.ts src/routes/staff.test.ts src/services/support-access.test.ts
corepack pnpm build
corepack pnpm --filter worker build
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 corepack pnpm --filter web build
NEXT_PUBLIC_API_URL=https://ec-owner-line-harness.wayway-dev.workers.dev corepack pnpm --filter web build
git diff --check
```

Preflight dry-run:

- strict release envの成功パターンで `15 passed, 0 skipped, 0 failed`
- strict release envの不足パターンで、admin origin、staff APIキー、staff fixture ID、staff mutation guard無効化が実通信前に失敗として出ることを確認

strict Preflight:

- ローカルfixture flow: seed local D1、strict Preflight、cleanup local D1まで実行し、`19 passed, 0 skipped, 0 failed`
- リモートfixture flow: remote test D1へsynthetic fixtureをseedし、デプロイ済みPR Workerに対してstrict Preflightを実行し、cleanup後のsynthetic行数が0であることを確認
- リモートtest Worker deploy: `3f920e16-3789-430d-8e5e-e2316e266ecf`
- リモートstrict Preflight結果: friend score/reminder API guard追加後に `32 passed, 0 skipped, 0 failed`
- リモートcleanup確認: synthetic fixtureのLINEアカウント、staff、案件、イベント、メッセージ、友だち、チャットがすべて0。一時owner行も `residual_count: 0`
- Remote browser cookie login/session check: Pages originとデプロイ済みWorkerでstaff sessionを確認済み
- support-crm-preflight tests cover HTTPS image payload pass and non-HTTPS image payload rejection through `/send/validate`.
- support route tests confirm support case list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind.
- friends route tests confirm friend list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind while keeping staff friend visibility scope.
- conversion/calendar access tests confirm conversion event list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind while keeping staff friend visibility scope. They also confirm calendar slot query values cannot create zero-minute/negative loops and invalid time windows stop before calendar lookup.
- Automations, operations, admin diagnostics, and notifications route tests confirm invalid, fractional, oversized, and non-finite `limit` / `offset` / `days` values are normalized before DB helper calls or SQL bind.
- `rg -n "Number\\(c\\.req\\.query|parseInt\\(c\\.req\\.query|Number\\.parseInt\\(c\\.req\\.query" apps/worker/src/routes apps/worker/src/services` returns no matches.
- `rg -n "Form reply|console\\.log" apps/worker/src/client/form.ts apps/worker/src/routes/forms.ts` returns no matches, and Worker typecheck/build confirm the public form client and submit route still compile.
- Form access route tests confirm public submit ignores `_skipWebhook`, rechecks the webhook gate server-side, does not run reward tag/scenario side effects when the gate rejects, stores redacted webhook fetch errors, and never trusts caller-supplied `lineUserId` / `friendId` for partial metadata writes or submit side effects.
- LIFF access route tests confirm `/api/liff/profile` rejects caller-supplied `lineUserId` without a valid LINE ID token and resolves the friend only from the verified token subject.
- LIFF access route tests confirm `/api/liff/send-form-link` rejects missing ID tokens and ID tokens whose subject does not match the caller-supplied `lineUserId` before friend lookup or form-link push.
- Operations and LIFF access route tests confirm `/t/:linkId` ignores caller-supplied `f` / `lu`, routes LINE in-app clicks through LIFF with `ref`, skips duplicate anonymous recording after verified LIFF return, and records tracked-link clicks with a friend only after `/api/liff/link` verifies the LINE ID token.
- Webhook/events/broadcast/admin-diagnostics route tests, Worker typecheck, and Worker build confirm removing or anonymizing identifier logs from webhook, LIFF, booking, profile refresh, and broadcast test-send routes does not change behavior.
- LIFF route logging now keeps external integration failures observable without printing LINE friend UUIDs, external response bodies, X Harness tag values, or raw exception messages. Webhook/webhooks/events route tests, Worker typecheck, and Worker build confirm the OAuth/LIFF-adjacent routes still compile and pass.

ローカル画面応答:

```bash
/staff   200
/support 200
/chats?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke 200
```

ブラウザ確認:

- 未ログインで `/support` を開くと `/login` に戻る
- ログイン画面とAPIキー入力欄が表示される
- owner/admin/staff mock sessionで `/support` を開き、owner/adminは「新規案件」ボタン1件、staffは0件であることを確認
- login mock sessionで、未認証 `/support` が `/login` に戻ること、APIキー入力で `/api/auth/login` と続く `/api/auth/session` が成功し、`/` のダッシュボードにスタッフ名、ownerロール、LINEアカウント、KPIカードが表示されることを確認
- empty staff-name mock sessionで `/support` を開き、スタッフ名警告が出ること、ダミー案件/マニュアル/スタッフ候補/未対応99件バッジが表示されないこと、案件/マニュアル/チャット候補/スタッフ一覧/未対応件数APIが呼ばれないことを確認
- list-control mock sessionで `/support` を開き、APIが優先度/期限寄りの順で返しても初期一覧は更新日時降順になり、詳細欄も先頭案件に一致すること、優先度順、期限超過キュー、完了ステータス、検索 `q=Gamma` が切り替わることを確認
- outside-list mock sessionで `/support` を開き、完了案件が未完了一覧の外にある場合は理由表示と `完了案件を表示` で `status=resolved` の一覧へ戻れること、未完了案件がステータス絞り込みの外にある場合は `絞り込みをリセット` で `queue=unresolved` の一覧へ戻れることを確認
- long-chat mock sessionで `/chats?friend=...` を開き、初期表示は最新2件だけ、`過去のメッセージを読み込む` で `beforeCreatedAt`/`beforeId` 付きAPIを呼び、古い2件が前に追加され、全4件が古い順に並び、追加後に読み込みボタンが消えることを確認
- draft-handoff mock sessionで `/support` の `チャットで返信` から `/chats?friend=...&supportCase=...&lineAccount=...` へ遷移し、チャット入力欄に返信案が入り、案件タイトル付きの紐付けバナーが `返信案を入力中` と表示されることを確認
- URL-fallback mock sessionで sessionStorage draftなしの `/chats?friend=...&supportCase=...&lineAccount=...` 直リンクを開き、案件紐付けバナー、空の入力欄、無効な送信ボタンを確認し、テキスト送信payloadに `supportCaseId` と `lineAccountId` が入ることを確認
- new-chat fallback mock sessionで `/api/chats/:friendId` が404の `/chats?friend=...&supportCase=...&lineAccount=...` 直リンクを開き、友だち詳細から空チャット、案件紐付けバナー、友だち詳細が表示され、初回返信payloadに `supportCaseId` と `lineAccountId` が入ることを確認
- image+text mock sessionでLINE画像のHTTPS URL直接入力とテキストを同時に入れて送信し、画像payloadだけに `supportCaseId`/`lineAccountId` が入り、続くテキストpayloadには案件紐付けが二重に入らないことを確認
- worker chat route testsで、テキスト返信と画像返信が `customer_reply_sent` 案件履歴イベントを残し、案件を `customer_reply` へ更新すること、完了済み案件への `/send` と `/send/validate` はLINE送信/DB記録前に拒否されることを確認
- support-meta/clipboard/staff-form testsで、マニュアル保存前検証、コピーfallback、スタッフ作成payload検証を確認
- コンソールエラーは0件

## 3. 運用ドキュメント

- [サポートCRM運用マニュアル](./ec-owner-support-crm.md)
- [本番投入前チェックリスト](./ec-owner-support-crm-release-checklist.md)

運用マニュアルでは、日次対応、案件化基準、チャット返信、エスカレーション、マニュアル検索、完了条件、staff権限の制限を説明しています。

本番投入前チェックリストでは、fixture候補抽出、synthetic fixture seed/cleanup、Preflightの通常実行とstrict実行、画面確認、PR用変更要約、rollback条件、切替NG条件をまとめています。

## 4. レビューで特に見る場所

- `apps/worker/src/services/support-access.ts`: staff可視範囲のSQL条件
- `apps/worker/src/routes/support.ts`: role別更新制限、完了/再オープン、エスカレーション制限
- `apps/worker/src/routes/chats.ts`: staffチャット可視範囲、送信前検証、顧客返信イベント
- `apps/worker/src/routes/inbox.ts` / `services/unanswered-inbox.ts`: staffの未対応インボックス一覧、件数、未対応friend ID集合の可視範囲
- `apps/worker/src/routes/users-grouped.ts` / `services/users-grouped.ts`: staffの顧客統合一覧、フォーム由来メール/電話、複数アカウント情報の可視範囲
- `apps/worker/src/routes/users.ts`: staffのlegacy users顧客ID一覧、詳細、メール/電話検索、リンク済み友だち、friendリンクの可視範囲
- `apps/worker/src/routes/account-settings.ts`: staffのテスト送信先取得のfriend可視範囲と、テスト送信先更新のowner/admin制限
- `apps/worker/src/routes/broadcasts.ts` / `dedup-preview.ts`: broadcast管理API、dedup preview、配信/集計APIのowner/admin制限
- `apps/worker/src/routes/profile-refresh.ts`: admin診断/repair APIのowner/admin制限
- `apps/worker/src/middleware/auth.ts` / `routes/forms.ts`: フォーム定義公開GETとフォーム管理APIのowner/admin制限
- `apps/worker/src/routes/stripe.ts` / `ad-platforms.ts` / `affiliates.ts` / `tracked-links.ts` / `liff.ts`: 売上・広告・計測運用APIのowner/admin制限、公開エンドポイント維持、tracked-linkの検証済みLIFF attribution
- `apps/worker/src/routes/conversions.ts`: staffのconversion記録、履歴一覧、集計レポートのfriend可視範囲
- `apps/worker/src/routes/calendar.ts`: staffのcalendar予約一覧、予約作成、予約ステータス更新のfriend可視範囲
- `apps/worker/src/routes/friends.ts`: staffのfriend一覧、詳細、direct履歴、direct送信の可視範囲
- `apps/worker/src/routes/support-friend-access.ts`: friend単位APIで共有するstaff可視範囲guard
- `apps/worker/src/routes/conversations.ts`: staffのconversation queue、conversation詳細の可視範囲
- `apps/worker/src/routes/scenarios.ts`: staffのscenario手動登録で使うfriend可視範囲
- `apps/worker/src/routes/scoring.ts` / `reminders.ts` / `rich-menus.ts`: staffのfriend score、reminder、rich-menu操作の可視範囲
- `apps/web/src/app/support/page.tsx`: verified identity前提のUI制御、案件/チャット導線
- `apps/web/src/app/chats/page.tsx`: サポート案件付き送信、画像/テキスト送信時の復旧通知
- `scripts/support-crm-preflight.ts`: 本番切替前の自動検査範囲
- `scripts/support-crm-preflight-summary.ts`: Preflight結果をPRへ安全に共有するための要約範囲
- `scripts/support-crm-fixture-candidates.ts`: strict Preflight用fixture候補の抽出範囲
- `scripts/support-crm-seed-fixtures.ts`: synthetic fixtureのseed/cleanup範囲
- `.github/workflows/worker-ci.yml`: PRで自動検証する範囲

## 5. 含めていないこと

- DB migrationは追加していない
- 本番LINE公式アカウントへの切替は行っていない
- 実顧客へのLINE送信は行っていない
- 本番LINE公式アカウントの実顧客データを使ったstrict Preflightは、環境変数が揃った本番切替前に実行する
- APIキー、顧客情報、実友だちID、private URLはドキュメントに書かない

## 6. 提出前チェック

- [ ] 生成物、`.tsbuildinfo`、local env、秘密値が差分に含まれていない
- [ ] PR本文に上記の検証コマンドとPR-safe Preflight summary証跡を記載した
- [ ] 本番投入前チェックリストの未検証項目をPR本文に明記した
- [ ] rollback先のWorker/Pagesデプロイを確認した
- [ ] staff権限の表示範囲をstrict Preflightで確認した
- [ ] synthetic fixtureを使った場合は `corepack pnpm support-crm:fixtures:verify-cleanup` でcleanup後のD1行数が0であることを確認した
- [ ] fork PRのGitHub Actionsが承認待ちの場合は、管理者承認が必要なことをPR本文に書いた
