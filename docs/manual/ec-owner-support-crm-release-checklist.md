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
- [ ] サポート案件一覧、友だち一覧、conversionイベント一覧の不正な `limit` / `offset` queryがSQL bind前に安全な値へ戻る
  - Worker support/friends/conversion route testでは、無効な `limit` は既定値に戻り、小数の `offset` は整数化され、`Infinity` のような有限でない値は0へ戻ることを確認済み。
- [ ] calendar空き枠取得の不正な `slotMinutes` / `startHour` / `endHour` queryが安全に処理される
  - Worker calendar route testでは、0分刻みや非数値は既定値に戻り、開始時刻が終了時刻以上の窓はcalendar接続や予約取得の前に400で止まることを確認済み。
- [ ] automations logs、notifications、Stripe events、ad conversion logs、admin diagnosticsの不正な数値queryがDB helper呼び出しやSQL bind前に安全な値へ戻る
  - Worker route testsでは、無効値、小数、過大値、`Infinity` が既定値、上限、整数へ正規化されることを確認済み。Worker routes/services内の生の `Number(c.req.query(...))` / `parseInt(c.req.query(...))` 検索も0件。
- [ ] 公開フォーム送信/返信時に、回答データ、送信先、レスポンスステータス、friend ID、LINE user IDがconsoleへ出ない
  - `apps/worker/src/client/form.ts` と `apps/worker/src/routes/forms.ts` の `Form reply|console.log` 検索は0件で、Worker typecheck/buildも通過済み。
- [ ] 公開フォームsubmitのWebhook gateが、LIFFクライアントの事前確認や `_skipWebhook` 自己申告を信じず、Worker側で毎回再判定される
  - Worker form access route testsでは、`_skipWebhook` を送ってもWebhook gateが呼ばれ、gate拒否時はreward tag/scenario side effectが走らず、Webhook fetch失敗も伏せ字化された結果だけ保存されることを確認済み。
- [ ] 公開フォームopened、partial、submitの友だち紐付けが、caller supplied `lineUserId` / `friendId` ではなくLINE ID token検証済みのLINE user IDだけを使う
  - Worker form access route testsでは、自己申告 `friendId` / `lineUserId` だけではpartial metadata writeやsubmit side effectが走らず、Bearer ID tokenで検証できた場合だけ友だちに紐付くことを確認済み。
- [ ] 公開フォームpartial/submitが壊れたJSONや大きすぎる `data` を副作用前に拒否する
  - Worker form access route testsでは、壊れたJSON、オブジェクト以外の `data`、16KB超の `data` がLINE ID token検証、Webhook、submission保存、reward side effect前に400で止まることを確認済み。
- [ ] `/api/liff/profile` が、caller supplied `lineUserId` ではなくLINE ID token検証済みのLINE user IDだけで友だちプロフィールを返す
  - Worker LIFF access route testsでは、自己申告 `lineUserId` だけでは401になり、Bearer ID tokenまたはbody `idToken` の検証済みsubjectだけで友だち情報を返すことを確認済み。
- [ ] `/api/liff/send-form-link` が、フォームURL push前にLINE ID tokenのsubjectとcaller supplied `lineUserId` の一致を必須にする
  - Worker LIFF access route testsでは、`idToken` なし、または `idToken` のsubjectと `lineUserId` が一致しない場合、friend lookupやform-link push前に401/403で止まることを確認済み。
- [ ] `/api/liff/link` と `/api/liff/send-form-link` が壊れたJSONや巨大payloadをLINE verify前に拒否する
  - Worker LIFF access route testsでは、壊れたJSON、巨大なref/IGSIDなどの公開payloadがLINE token verify、DB lookup、LINE push前に400で止まることを確認済み。
- [ ] tracked-link公開リダイレクト `/t/:linkId` が、不正IDをDB前に止め、caller supplied `f` / `lu` を友だち本人として信じない
  - Worker operations/LIFF access route testsでは、空白/128文字超の `linkId` はDB lookupやclick保存前に404で止まり、`?f=` / `?lu=` 自己申告では匿名クリック扱いになり、LINEアプリ内クリックは `ref` 付きLIFFへ回り、`/api/liff/link` のLINE ID token検証後にだけ友だち付きクリック、tag、scenario attributionが起きることを確認済み。LIFFから戻った `/t/:linkId?lh_liff=1` では二重の匿名クリック記録も起きない。
- [ ] 公開affiliate click `/api/affiliates/click` が壊れたJSONや巨大/unsafe code・URLをDB前に拒否する
  - Worker operations route testsでは、壊れたJSON、128文字超またはURL-safeではない `code`、HTTP(S)以外または2048文字超の `url` がaffiliate lookupやclick保存前に400で止まることを確認済み。
- [ ] event booking LIFF予約作成の `Idempotency-Key` が無制限にDB予約へ流れない
  - Worker events route testsでは、不正/巨大な `Idempotency-Key` がLINE ID token検証やidempotency予約前に400で止まることを確認済み。
- [ ] Webhook follow、LIFF/X Harness連携、booking LIFF認証時に、LINE user ID、friend ID、表示名、Xユーザー名、channel候補、verify失敗bodyがconsoleへ出ない
  - Webhook/events/broadcast/admin-diagnostics route tests、Worker typecheck、Worker buildで、Webhook/profile refresh/broadcast test-sendの失敗ログ匿名化後も動作が壊れていないことを確認済み。
- [ ] Webhook管理APIがowner/adminだけに制限され、incoming receive公開エンドポイントは署名検証付きで維持される
  - Worker webhooks route testsでは、staffがincoming/outgoing webhook設定の一覧、作成、更新、削除を実行できず、壊れたJSON、不正なname/sourceType/url/eventTypes/secret/isActiveはDB write前に400で止まり、外部システム用の `/api/webhooks/incoming/:id/receive` は403ではなく署名不足の401で止まることを確認済み。
- [ ] LINEアカウント管理APIが壊れた/unsafe payloadをDB書き込み前に拒否する
  - Worker line-accounts route testsでは、登録、metadata更新、credential更新、表示順更新の壊れたJSON、不正なchannelId/name/credential/Login/LIFF/isActive/displayOrderがDB writeや重複lookup前に400で止まり、正常payloadはtrimされることを確認済み。
- [ ] Meet Harness callbackがHMAC署名付きリクエストだけを受け付ける
  - Worker meet-callback route testsでは、`MEET_CALLBACK_SECRET` 未設定、`X-Meet-Callback-Signature` 不足、不正署名をDB lookupやLINE push前に拒否し、正しいHMAC-SHA256 hex署名だけがmetadata保存まで進むことを確認済み。
- [ ] Stripe webhookが署名付きでも壊れた/巨大payloadをDB前に拒否する
  - Worker operations route testsでは、署名付きの正しいbounded payloadだけが記録され、壊れたJSONはDB lookup/記録前に400、1MiB超payloadはDB lookup/記録前に413で止まることを確認済み。
- [ ] ad-platforms/affiliates/tracked-links管理APIのpayloadが、不正な値をDB/外部送信前に拒否する
  - Worker operations route testsでは、壊れたJSON、許可以外の広告platform名、巨大/ネストした広告config、長すぎる名前、URL-safeではないaffiliate code、不正なcommissionRate、HTTP(S)以外または2048文字超のoriginalUrl、不正な関連ID、不正なisActiveがDB writeや広告CV test送信lookup前に400で止まり、正常payloadはtrim/正規化されることを確認済み。
- [ ] 公開QR proxy `/api/qr` が無制限な外部QR生成proxyにならない
  - Worker QR proxy testsでは、`data` がHTTP(S) URLではない、長すぎる、`size` が正方形ではない/大きすぎる/形式不正、外部QR rendererが画像以外を返す場合に拒否することを確認済み。
- [ ] scenario/reminder/scoring/template/message-templateの定義参照・変更APIとtag定義変更APIがowner/adminだけに制限される
  - Worker scenario/support-friend/content-management route testsでは、staffがscenario/step、reminder/step、scoring rule、reusable template、message-templateの一覧/詳細/作成/更新/削除を実行できず、tag定義の作成/削除もできず、friend単位の操作は見えるsupport case友だちの範囲に残ることを確認済み。
- [ ] automation/auto-reply/notification ruleの管理参照・変更APIとtraffic pool/operatorの管理一覧・変更APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffがautomation、auto-reply、notification ruleの一覧/詳細/ログ取得や作成/更新/削除を実行できず、traffic pool、pool-account、operatorの管理一覧取得や作成/更新/削除でもDB helperへ到達しないことを確認済み。
- [ ] booking/event admin APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffがbooking/event admin routeへ直接アクセスしても403で止まり、DBへ到達しないことを確認済み。Events route testsではowner文脈の既存admin操作が引き続き通ることを確認済み。
- [ ] rich menu catalog/group管理APIがowner/adminだけに制限される
  - Worker rich-menu group/support-friend access route testsでは、staffがLINE rich menu catalogやrich menu group管理APIへ直接アクセスしても403で止まり、見えている友だち単位のrich menu参照は引き続き通ることを確認済み。
- [ ] entry route/conversion point/Google Calendar接続/account health・migration管理APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffが流入経路、conversion point一覧/作成/削除、Google Calendar接続一覧/作成/削除、account health/migration管理APIへ直接アクセスしても403で止まり、DB helperやD1へ到達しないことを確認済み。Conversion/calendar access route testsでは、friend単位のconversion/calendar booking操作が引き続き可視範囲内で通ることを確認済み。
- [ ] friends ref集計、重複統計、ref流入分析、LIFFリンクwrap、画像削除APIがowner/adminだけに制限される
  - Worker friends/duplicates/LIFF/image access route testsでは、staffがfriends ref集計、重複統計、ref summary/detail、LIFFリンクwrap、画像削除へ直接アクセスしても403で止まり、画像アップロードはstaffのチャット返信用に維持されることを確認済み。
- [ ] LIFF OAuth token交換、IG Harness notify、X Harness action失敗時に、外部レスポンス本文、LINE friend UUID、tag名、例外本文がconsoleへ出ない
  - Webhook/webhooks/events route tests、Worker typecheck、Worker buildで、公開導線に近いLIFF/外部連携ログ匿名化後も動作が壊れていないことを確認済み。
- [ ] LINE画像payloadのHTTPS検証が送信前に効く
  - Preflightでは、staff可視チャットの `/send/validate` でHTTPS画像payloadが200になり、非HTTPS `originalContentUrl` が400で止まることを確認する。
- [ ] `corepack pnpm support-crm:fixtures` で出た候補IDを使っている

## 3. 画面確認

- [ ] `/login` でAPIキーによるログインができる
- Local login browser smokeでは、未認証 `/support` が `/login` に戻り、APIキー入力で `/api/auth/login` が成功し、続く `/api/auth/session` 成功後に `/` のダッシュボードへ遷移して、ログインスタッフ名、ownerロール、LINEアカウント、KPIカードが表示されることを確認済み。
- [ ] セッション切れ時に `/support` から `/login` へ戻る
- Local login browser smokeでは、最初の `/api/auth/session` が未認証の状態で `/support` から `/login` へ戻ることを確認済み。
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
- [ ] まだチャット行がない友だちでも、サポート案件から初回返信できる
- Local new-chat fallback browser smokeでは、`/api/chats/:friendId` が404でも `/api/friends/:friendId` から空チャットを表示し、`メッセージはまだありません。`、案件紐付けバナー、友だち詳細を確認したうえで、テキスト送信payloadに `supportCaseId` と `lineAccountId` が入ることを確認済み。
- [ ] テキスト返信で案件履歴に顧客返信イベントが残る
- Worker chat route testでは、テキスト返信後にLINE送信、`chat_messages` 記録、`support_case_events.customer_reply_sent` 記録、案件ステータスの `customer_reply` 更新、metadataの `messageId`/`contentPreview`/前後ステータスが揃うことを確認済み。
- [ ] 画像だけの返信でも案件履歴に顧客返信イベントが残る
- Worker chat route testでは、画像返信後にLINE画像送信、`chat_messages` 記録、`support_case_events.customer_reply_sent` 記録、案件ステータスの `customer_reply` 更新が揃うことを確認済み。
- [ ] 画像とテキストを同時に送っても、不要な「案件更新だけ確認が必要」警告が出ない
- Web helper testでは、画像+テキスト同時送信時にサポート案件紐付けを画像側だけへ付け、テキスト側で二重更新しない送信計画になることを確認済み。復旧通知helper testでは、案件が既に `customer_reply` の場合は不要な警告を出さないことを確認済み。
- Local image+text browser smokeでは、LINE画像のHTTPS URL直接入力とテキストを同時に入れて送信し、画像送信payloadだけに `supportCaseId` と `lineAccountId` が入り、続くテキスト送信payloadには案件紐付けが二重に入らないことを確認済み。
- [ ] 完了済み案件では、再オープンしてから返信する運用になっている
- Worker chat route testでは、完了済み案件への `/send` と `/send/validate` がどちらも `再オープン` エラーで400になり、LINE送信、チャット記録、案件履歴記録、案件更新が起きないことを確認済み。
- [ ] マニュアル作成/編集でタイトル、本文、URL形式の保存前チェックが効く
- Web support-meta testでは、マニュアルのタイトルなし、本文なし、`http://`/`https://` 以外のリンクを保存前エラーにし、完全なマニュアルdraftは保存可能になることを確認済み。Worker support routeも同じ必須項目とURL形式をAPI側で400にする。
- [ ] マニュアル無効化、スタッフ削除、APIキー再生成は画面内確認ダイアログで止まる
- Support画面のマニュアル無効化、Staff画面のスタッフ削除/APIキー再生成は、共通の画面内 `alertdialog` (`useConfirmDialog`) で確認後にだけAPIを呼ぶ。キャンセル、Escape、背景クリックでは実行しない。
- [ ] クリップボードAPIが使えない環境でも、コピー失敗時の案内が表示される
- Web clipboard helper testでは、Clipboard API成功、textarea fallback成功、Clipboard API拒否後のfallback、コピー手段なしの失敗報告を確認済み。Staff画面とSupport画面は失敗時に「表示内容を選択コピーしてください」系の案内を出す。

## 4. ローカル検証コマンド

PRに載せる検証コマンドは次を基準にします。

```bash
corepack pnpm --filter web test
corepack pnpm test:scripts
corepack pnpm --filter worker typecheck
corepack pnpm --filter worker test -- src/routes/support.test.ts
corepack pnpm --filter worker test -- src/routes/friends.test.ts
corepack pnpm --filter worker test -- src/routes/conversions-calendar-access.test.ts
corepack pnpm --filter worker test -- src/routes/automations.test.ts src/routes/operations-access.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/notifications.test.ts
corepack pnpm --filter worker test -- src/routes/webhook.test.ts src/routes/webhooks.test.ts src/routes/events.test.ts
corepack pnpm --filter worker test -- src/routes/liff-access.test.ts src/routes/forms-access.test.ts src/middleware/auth.test.ts
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
- What changed: サポート案件/チャット/スタッフAPI、friend/inbox/users-grouped/users/account-settings/conversions/calendar/conversation/scenario APIのstaff可視範囲guard、broadcast管理/配信/集計/dedup-preview API、admin診断/repair API、フォーム管理API、売上・広告・計測運用API、friends ref集計/重複統計/ref分析/LIFFリンクwrap/画像削除APIのowner/admin制限、Meet Harness callbackのHMAC署名検証、公開QR proxy入力制限、公開フォーム/LIFF payload入力制限、公開affiliate click入力制限、ad-platforms/affiliates/tracked-links管理API payload入力制限、event booking Idempotency-Key入力制限、フォーム公開GET/submit境界、CORS、サポートCRM UI、案件一覧の更新順/初回選択/キュー解除、staffサイドバーの管理メニュー非表示、staff管理URL直打ちの `/support` 退避、チャット返信の案件履歴連携、staffフォーム/クリップボード/認証キャッシュ helper、Preflight、strict Preflight dry-run、PR-safe Preflight summary、strict必須credential guard、dry-run checklist audit、release readiness、strict Preflight用fixture候補抽出/コマンドテンプレ、synthetic fixture seed/cleanup/cleanup verification、テスト、運用ドキュメント、PR用CI検証範囲。
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
- `corepack pnpm --filter web test -- src/lib/inbox-pagination.test.ts`
- `corepack pnpm --filter worker test -- src/services/unanswered-inbox.test.ts src/routes/inbox.test.ts`
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
- Browser smoke with login mock session confirms unauthenticated `/support` redirects to `/login`; entering an API key calls `/api/auth/login`, the next `/api/auth/session` succeeds, and the dashboard renders the login staff identity, owner role, selected LINE account, and KPI cards.
- Browser smoke with owner/admin/staff mock sessions confirms `/support` role UI: owner/admin show one `新規案件` button; staff shows zero `新規案件` buttons. Staff mock sidebar only shows 友だち管理, 個別チャット, サポートCRM, and 未対応 while hiding management menus; direct staff access to `/broadcasts` returns to `/support`; direct admin access to `/staff` also returns to `/support`.
- Web helper and Worker route/service tests confirm `/notifications` builds server-side unanswered inbox queries for search/account/1時間以上/page/pageSize, summary count uses the same filters, and invalid `page` / `pageSize` / `minWaitMinutes` values are clamped or ignored before they can produce `NaN`.
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
- Worker/script tests verify staff cannot use `/api/friends`, friends ref stats, unanswered inbox list/count, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, broadcast management/send/count/insight/dedup-preview APIs, admin diagnostics/repair APIs, form management/submission-list APIs, booking/event admin APIs, rich menu catalog/group management APIs, entry route/conversion point/Google Calendar connection/account health migration management APIs, duplicate/ref analytics APIs, LIFF link wrapping, image deletion, Stripe events, ad-platforms, affiliate management/reporting, tracked-link management, scenario/reminder/scoring/template/message-template definition read/mutation APIs, tag definition mutation APIs, automation/auto-reply/notification rule/traffic pool/operator management APIs, conversion history/report, calendar bookings, direct message history/send, conversation queue/detail, scenario manual enrollment, score, reminder, or rich-menu friend endpoints to bypass support-case friend visibility or role boundaries. Meet callback route tests verify unsigned or incorrectly signed callbacks stop before DB lookup or LINE push. Webhook route tests verify malformed or unsafe incoming/outgoing webhook management payloads stop before DB writes while the public receive endpoint remains signature-gated. Line account route tests verify malformed or unsafe create/update/order payloads stop before DB writes or duplicate Login/LIFF lookup. QR proxy tests verify public QR generation rejects unsafe URL/size inputs before upstream fetch. Form/LIFF access route tests verify malformed or oversized public payloads stop before LINE verification, webhook calls, submission writes, DB lookup, or LINE push. Operations route tests verify malformed or oversized public Stripe webhook, affiliate click, tracked-link redirect, and ad-platform/affiliate/tracked-link management payloads stop before DB lookup, click/event recording, external test-send lookup, or writes. Events route tests verify malformed or oversized event booking idempotency keys stop before LINE verification or idempotency reservation. Chat reply tests verify text/image support replies record `customer_reply_sent` support-case events, update cases to `customer_reply`, survive URL fallback without `lineAccountId`, reject resolved-case sends before LINE push or DB writes, and web helper tests verify image+text sends attach the support case to only one send step.
- Web support-meta/clipboard/staff-form tests verify manual editor validation, copy fallback behavior, and staff creation payload validation; support/staff pages route destructive actions through the shared in-app confirmation dialog before API calls.
- `corepack pnpm support-crm:release-readiness` separates local/PR evidence failures, missing PR-safe Preflight summary evidence, stale CI runs, and external waits such as draft status, production strict Preflight, and fork PR CI approval.
- GitHub Actions workflow coverage includes `apps/web/**`, `scripts/**`, `package.json`, Web tests, script tests, and Web production build.
- If this is a fork PR, GitHub Actions may stay `action_required` until a repository maintainer approves the run.
- Local strict Preflight result: `19 passed, 0 skipped, 0 failed`.
- Remote test Worker deploy after friend API guard: `3f920e16-3789-430d-8e5e-e2316e266ecf`.
- Remote strict Preflight result after friend score/reminder guard: `32 passed, 0 skipped, 0 failed`.
- Remote cleanup verification: synthetic fixture line_accounts/staff/cases/events/friends/messages/chats are all `0` after cleanup; the one-time owner staff row is also `0`.
- Browser: `/support` redirects to `/login` when unauthenticated, login screen renders, API-key login reaches `/`, and console error count is 0.
- HTTP: `/staff`, `/support`, `/chats?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke` return 200 locally.
- Not tested: 本番LINE公式アカウントへの実切替、実顧客へのLINE送信、本番LINE公式アカウントの実顧客データを使ったstrict Preflight。

## Security Impact

- New permissions/capabilities? `Yes`: staff visibility is now enforced for support cases, linked chats, unanswered inbox, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, conversion history/report, calendar bookings, and direct friend API access; friends ref stats, broadcast management/send/count/insight/dedup-preview, admin diagnostics/repair, form management/submission-list, booking/event admin, rich menu catalog/group management, entry route/conversion point/Google Calendar connection/account health migration management, duplicate/ref analytics, LIFF link wrapping, image deletion, scenario/reminder/scoring/template/message-template definition read/mutation, tag definition mutation, automation/auto-reply/notification rule/traffic pool/operator management, and revenue/ad/measurement operations APIs are owner/admin-only.
- Secrets/tokens handling changed? `Yes`: browser auth cache handling is centralized and stale local values are cleared on session failure/logout. `MEET_CALLBACK_SECRET` is added for HMAC-SHA256 verification of Meet Harness completion callbacks.
- New/changed network calls? `Yes`: Support UI verifies current staff identity via `/api/staff/me`; fixture helpers can run D1 SELECT, read-only cleanup verification, or explicitly confirmed synthetic fixture INSERT/cleanup through Wrangler. Preflight dry-run adds no network calls. Release readiness reads PR/Actions metadata through `gh`. LIFF form definition GET/opened/partial/submit remain public, but form PUT/DELETE/list/submissions now require authenticated owner/admin, and public form/LIFF payloads now reject malformed or oversized input before LINE verification, webhook calls, submission writes, DB lookup, or LINE push. Public affiliate click remains public but now rejects malformed JSON, oversized or URL-unsafe codes, and unsafe/oversized URLs before affiliate lookup or click recording. Owner/admin ad-platform, affiliate, and tracked-link management calls now reject malformed or unsafe payloads before DB writes or ad conversion test-send lookup. Event booking LIFF予約作成は不正/巨大な `Idempotency-Key` をLINE verificationやidempotency予約前に拒否する。`/api/meet-callback` remains public at the auth middleware layer but now requires `MEET_CALLBACK_SECRET` and a valid `X-Meet-Callback-Signature` HMAC before DB lookup or LINE push. `/api/qr` remains public but now forwards only bounded HTTP(S) URL data and square QR sizes to the external QR renderer.
- Message sending behavior changed? `Yes`: support-case replies validate resolved status before LINE send and record support case events after send; broadcast send/segment/test-send and dedup-preview APIs now require owner/admin before LINE push or recipient preview.
- Customer/friend data access changed? `Yes`: staff chat/inbox/users-grouped/users/account-settings/conversions/calendar/conversation visibility and direct friend API access are limited to friends tied to visible support cases; friends ref stats, broadcast preview/count/progress/insight/dedup-preview, admin recent messages/friend debug/repair APIs, form submission lists, booking/event admin, rich menu catalog/group management, entry route/conversion point/Google Calendar connection/account health migration management, duplicate/ref analytics, LIFF link wrapping, image deletion, scenario/reminder/scoring/template/message-template definition read/mutation, tag definition mutation, automation/auto-reply/notification rule/traffic pool/operator management, and Stripe/ad/affiliate/tracked-link management APIs are owner/admin-only; fixture candidate output does not print friend names or case titles by default.
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
