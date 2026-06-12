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
- staffは自分が作成、担当、エスカレ先になっている案件だけを扱う
- staffに見えているサポート案件へ紐づく友だちだけ、チャット一覧とチャット詳細で表示
- staffが `/api/friends`、direct message履歴、conversation一覧/詳細、scenario手動登録、score、reminder、rich-menu APIを使っても、自分に見えるサポート案件へ紐づく友だちだけに制限
- 完了済み案件からの顧客返信をLINE送信前に拒否
- チャット送信APIで `text`、`flex`、`image` 以外のmessageTypeや壊れた画像/Flex payloadをLINE送信前、DB記録前に拒否
- チャット送信後に案件ステータスを「顧客返信待ち」へ更新し、案件履歴に顧客返信イベントを残す
- 画像だけの返信でも、サポート案件への履歴連携を行う
- staff名の空欄保存を防ぎ、staff名がないAPIキーをPreflightと画面で検知できるようにした
- credentialed CORSをまとめ、ブラウザログインで必要な `Access-Control-Allow-Credentials` を確認できるようにした

### Web UI

- サポートCRMで現在のログイン権限を `/api/staff/me` から確認し、ローカルキャッシュだけでowner/admin操作を出さない
- staffでは新規案件、担当/期限/優先度変更、マニュアル作成/更新/無効化などの管理操作を非表示または読み取り専用化
- staff名が空欄の古いアカウントでは、理由を表示して操作を止める
- 案件一覧に未完了、期限超過、24h滞留、担当者なし、エスカレ、自分宛、顧客返信待ち、完了のキューを整理
- 選択中の案件が現在の絞り込み外にある場合、理由と復帰ボタンを表示
- 長いチャットで過去メッセージを追加読み込みできる
- サポート案件の「チャットで返信」からチャット入力欄へ返信案を引き継ぐ
- sessionStorageが使えない場合でも、URLの `supportCase` で案件紐付けを維持
- 画像とテキストを同時に送っても、案件がすでに「顧客返信待ち」なら不要な復旧警告を出さない
- コピー、スタッフフォーム、認証キャッシュ、確認ダイアログをhelper化し、失敗時の案内を画面に出す

### Scripts

- `corepack pnpm preflight:support-crm` を追加
- owner/admin/staff APIキーのログイン権限、CORS、サポート要約、案件一覧、マニュアル検索、チャット一覧を検査
- staffによる案件作成、担当変更、エスカレ担当指定、マニュアル作成/更新/無効化が拒否されることを検査
- optional fixtureでstaff可視範囲、friend direct履歴/score/reminder APIの可視範囲、未完了案件の再オープン禁止、完了済み案件からの返信禁止、未対応チャットmessageTypeの送信前拒否を検査
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
- `apps/worker/src/routes/staff.test.ts`
- `apps/web/src/components/support/support-meta.test.ts`
- `apps/web/src/lib/auth-session.test.ts`
- `apps/web/src/lib/clipboard.test.ts`
- `apps/web/src/lib/staff-form.test.ts`
- `apps/web/src/lib/support-chat-draft.test.ts`
- `scripts/support-crm-preflight.test.ts`
- `scripts/support-crm-fixture-candidates.test.ts`
- `scripts/support-crm-seed-fixtures.test.ts`

直近で通した検証:

```bash
corepack pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-crm/db --filter @line-harness/update-engine build
corepack pnpm --filter web test
corepack pnpm test:scripts
corepack pnpm --filter worker typecheck
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

ローカル画面応答:

```bash
/staff   200
/support 200
/chats?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke 200
```

ブラウザ確認:

- 未ログインで `/support` を開くと `/login` に戻る
- ログイン画面とAPIキー入力欄が表示される
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
