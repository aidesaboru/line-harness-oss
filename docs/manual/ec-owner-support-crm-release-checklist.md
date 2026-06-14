---
title: ECオーナー通達LINE サポートCRM 本番投入前チェックリスト
status: draft
updated: 2026-06-14
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

# パイプでも同じPR用summaryを作れます。
corepack pnpm preflight:support-crm | corepack pnpm preflight:support-crm:summary
```

- [ ] `Failures to fix` が出ていない
- [ ] `Skipped optional checks` が出ていない
- [ ] `preflight:support-crm:summary` の出力だけをPR本文に貼った
- [ ] `preflight: full coverage required` が出ていない
- [ ] `preflight:support-crm:dry-run` が失敗していない
- [ ] `SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0` を付けていない
- [ ] staff APIキーのログイン情報にスタッフ名が入っている
- [ ] staffによる案件作成、担当変更、エスカレ担当指定、マニュアル作成/更新/無効化が403で止まる
- [ ] staff管理APIのcreate/update/detail/delete/regenerate-key payload/path IDがDB helperや最後のowner保護check前に検証される
  - Worker staff route testsでは、壊れたJSON、空payload、不正staff ID/name/email/role/isActiveがDB helperや最後のowner保護check前に400で止まり、正常payload/path IDはtrim/null正規化されることを確認済み。
- [ ] staff一覧/作成/更新/APIキー再生成失敗時に、staff ID、staff email、APIキー、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker staff route testsでは、staff一覧、作成、更新、APIキー再生成の失敗ログが例外種別だけになり、API errorは固定文言になり、staff ID、staff email、APIキー、token-like text、raw例外本文が出ないことを確認済み。
- [ ] 未完了案件を再オープンにできない
- [ ] 完了済み案件からの顧客返信がLINE送信前に止まる
- [ ] 未対応のチャット `messageType` がLINE送信前、DB記録前に止まる
- [ ] サポート案件一覧、友だち一覧、conversionイベント一覧の不正な `limit` / `offset` queryがSQL bind前に安全な値へ戻る
  - Worker support/friends/conversion route testでは、無効な `limit` は既定値に戻り、小数の `offset` は整数化され、`Infinity` のような有限でない値は0へ戻ることを確認済み。
- [ ] support案件/エスカレーション/manual APIのquery/path ID/JSON payloadがDB/イベント副作用前に検証される
  - Worker support route testsでは、壊れたJSON、不正なlineAccountId/caseId/escalationId/manualId/friendId/manualIds/activeがDB access、SQL bind、support event作成、case/escalation/manual更新前に400で止まり、正常IDはtrimされることを確認済み。
  - Worker support route testsでは、巨大な案件本文、内部メモ、event metadata、エスカレーション質問/回答、manual本文がcase/escalation/manual/eventのDB mutation前に400で止まることも確認済み。
- [ ] support案件/エスカレーション/manual API失敗時に、案件本文、内部メモ、manual本文、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker support route testsでは、summary/case作成/manual作成の失敗時にconsoleへ例外種別だけが残り、customer summary、manual本文、friend ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] users-grouped顧客統合一覧のqueryが集計前に検証される
  - Worker users-grouped route testsでは、不正な `q/account/page/pageSize/onlyDups/refresh` が顧客統合集計service呼び出し前に400で止まり、正常queryはtrim/parse/上限丸めされることを確認済み。
- [ ] users-grouped顧客統合一覧失敗時に、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker users-grouped route testsでは、aggregation失敗時にconsoleへ例外種別だけが残り、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] conversionイベント一覧/reportのID/date queryがfriend可視範囲check/SQL bind前に検証される
  - Worker conversion/calendar access route testsでは、不正な `conversionPointId/friendId/affiliateCode/startDate/endDate` がfriend可視範囲checkやSQL bind前に400で止まり、正常queryはtrimされることを確認済み。
- [ ] calendar空き枠取得の不正な `slotMinutes` / `startHour` / `endHour` queryが安全に処理される
  - Worker calendar route testでは、0分刻みや非数値は既定値に戻り、開始時刻が終了時刻以上の窓はcalendar接続や予約取得の前に400で止まることを確認済み。
- [ ] calendar空き枠/予約一覧の `connectionId` / `date` / `friendId` queryがCalendar接続lookup、予約範囲lookup、friend可視範囲check、SQL bind前に検証される
  - Worker conversion/calendar access route testsでは、不正な `connectionId/date/friendId` が副作用前に400で止まり、存在しない日付も拒否され、正常queryはtrimされることを確認済み。
- [ ] Google Calendar接続/空き枠/予約/status API失敗時に、connection ID、booking ID、friend ID、calendar ID、event ID、access/refresh/API token、予約タイトル、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker conversion/calendar access route testsでは、接続一覧/作成、予約作成、FreeBusy/createEvent/deleteEvent失敗時にconsoleへ例外種別だけが残り、API errorは固定文言になり、connection ID、booking ID、friend ID、calendar ID、event ID、access/refresh/API token、予約タイトル、token-like text、raw例外本文が出ないことを確認済み。
- [ ] booking admin API共通の `account_id` queryがメニュー/スタッフ/シフト/予約管理SQL前に検証される
  - Worker booking access route testsでは、不正な `account_id` がDB lookup前に400で止まり、正常queryはtrimされることを確認済み。
- [ ] booking admin APIのmenu/staff/shift/booking path IDが更新/削除/所属確認/予約判断SQL前に検証される
  - Worker booking access route testsでは、不正なmenu/staff/booking path IDがSQL前に400で止まり、正常path IDはtrimされることを確認済み。
- [ ] booking admin APIのmenu/staff/staff_menus/shifts/generate/requests payloadと `status` / `from` / `to` queryがDB書き込みや予約lookup前に検証される
  - Worker booking access route testsでは、不正なJSON、型違い、範囲外数値、不正date/time/status/actionがDB書き込みやbooking lookup前に400で止まり、正常payload/queryはtrimされることを確認済み。
- [ ] booking LIFF staff選択の `menus/:id/staff` path IDがstaff lookup SQL前に検証される
  - Worker booking LIFF access route testsでは、不正なmenu path IDがstaff lookup SQL前に400で止まり、正常path IDはtrimされることを確認済み。
- [ ] booking LIFF availabilityの `liffId` / `menu_id` / `staff_id` / `from` / `to` queryがLINE account lookupやavailability helper呼び出し前に検証される
  - Worker booking LIFF access route testsでは、不正な `liffId` はLINE account lookup前に404で止まり、不正な `menu_id/staff_id/from/to` はavailability helper前に400で止まり、正常queryはtrimされることを確認済み。
- [ ] booking LIFF予約作成の `Idempotency-Key` と `menu_id` / `staff_id` / `starts_at` / `customer_note` payloadがLINE verifyやidempotency lookup前に検証される
  - Worker booking LIFF access route testsでは、不正な `Idempotency-Key`、壊れたJSON、不正な予約payloadがLINE verifyやidempotency lookup前に400で止まり、正常payloadのIDはtrimされることを確認済み。
- [ ] conversation一覧/詳細の `lineAccountId` / `minHoursSince` / `maxHoursSince` / `before` / `friendId` query/pathがfriend可視範囲checkやSQL bind前に検証される
  - Worker conversations route testsでは、不正なID、NaN、逆転した時間範囲、不正cursorがDBへ到達せず400で止まり、正常query/pathはtrimされ、`limit` / `offset` は安全な範囲へ丸められることを確認済み。
- [ ] conversation一覧/詳細失敗時に、会話本文、絞り込み値、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker conversations route testsでは、queue/detail失敗時にconsoleへ例外種別だけが残り、API errorは固定文言になり、会話本文、絞り込み値、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] legacy users顧客ID APIのcreate/update/link/match payloadとuser/friend path IDがDB helperやfriend可視範囲check前に検証される
  - Worker users route testsでは、壊れたJSON、空payload、不正email/phone/externalId/displayName/userId/friendIdがDB helperやfriend可視範囲check前に400で止まり、正常payload/path IDはtrim/null正規化されることを確認済み。
- [ ] legacy users顧客ID API失敗時に、user ID、friend ID、email、phone、external ID、displayName、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker users route testsでは、一覧、作成、link、matchの失敗ログが例外種別だけになり、API errorは固定文言になり、user ID、friend ID、email、phone、external ID、displayName、token-like text、raw例外本文が出ないことを確認済み。
- [ ] account-settingsテスト送信先APIのaccountId query/payloadとfriendIds payloadがDB read/write前に検証される
  - Worker account-settings route testsでは、壊れたJSON、不正accountId/friendId、過大friendIdsがDB read/write前に400で止まり、正常payload/queryはtrim/dedupeされることを確認済み。
- [ ] dedup-preview APIのaccountIds/dedupPriority/targetTagId payloadが配信対象計算前に検証される
  - Worker broadcasts access route testsでは、壊れたJSON、空accountIds、不正ID、不正targetTagIdがdedup preview計算前に400で止まり、正常payloadはtrim/dedupeされ、dedupPriorityはaccountIds内へfilterされることを確認済み。
- [ ] broadcast管理APIのquery/path/create/update/segment payloadがDB/LINE副作用前に検証される
  - Worker broadcasts access route testsでは、不正なlineAccountId query、broadcast path ID、messageType/targetType/Flex/image JSON/HTTPS画像URL/segment条件/IDがDB helper、SQL bind、LINE送信、対象計算前に400で止まり、正常payloadはtrim/dedupeされることを確認済み。
- [ ] multi-account broadcastの失敗/skipログに、LINE account ID、channel token、LINE user ID、raw例外本文が出ない
  - Worker dedup-broadcast service testsでは、multicast失敗時のconsoleは例外種別だけにし、inactive/missing account skipログにもaccount IDを出さず、failedAccountIdsの戻り値/DB記録は維持されることを確認済み。
- [ ] friends APIのquery/path/tag/metadata/direct message payloadがfriend可視範囲check、DB/LINE副作用前に検証される
  - Worker friends route testsでは、不正なlineAccountId/tagId/search/metadata query、friend/tag path ID、metadata更新payload、messageType/Flex/image JSON/HTTPS画像URLがfriend可視範囲check、DB helper、SQL bind、LINE送信、tag scenario副作用前に400で止まり、正常値はtrimされることを確認済み。
- [ ] friends一覧/件数/ref stats/詳細/tag/metadata/message API失敗時に、検索語、metadata、message本文、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker friends route testsでは、friend list/direct message失敗時にconsoleへ例外種別だけが残り、direct messageのAPI errorは固定文言になり、検索語、message本文、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] auto-replies管理APIのaccountId query、auto-reply path ID、create/update payloadがDB helper前に検証される
  - Worker management role guard testsでは、壊れたJSON、不正accountId/path ID、不正responseType/isActive、空本文/空updateがDB helper前に400で止まり、正常payloadはtrim/null正規化され、template snapshot補完が走ることを確認済み。
- [ ] notification rule管理APIのlineAccountId/status query、rule path ID、create/update payloadがDB helper/SQL bind前に検証される
  - Worker notifications route testsでは、壊れたJSON、不正lineAccountId/status/path ID、不正eventType/channels/isActive、空updateがDB helper/SQL bind前に400で止まり、正常payloadはtrim/dedupeされることを確認済み。
- [ ] automations管理APIのlineAccountId query、automation path ID、create/update payloadがDB helper/SQL bind前に検証される
  - Worker automations route testsでは、壊れたJSON、不正lineAccountId/path ID、不正eventType/action type/isActive/priority、空updateがDB helper/SQL bind前に400で止まり、正常payloadはtrimされ、action typeとlineAccountIdが正規化されることを確認済み。
- [ ] Google Calendar接続/予約/status path/payloadが副作用前に検証される
  - Worker conversion/calendar access route testsでは、不正な接続削除/予約status path ID、壊れたJSON、不正な `calendarId/authType/token/connectionId/friendId/title/startAt/endAt/metadata/status` がDB helper、DB write、friend可視範囲check、Calendar接続lookup前に400で止まり、正常path/payloadはtrimされることを確認済み。
- [ ] automations logs、notifications、Stripe events、ad conversion logs、admin diagnosticsの不正な数値queryがDB helper呼び出しやSQL bind前に安全な値へ戻る
  - Worker route testsでは、無効値、小数、過大値、`Infinity` が既定値、上限、整数へ正規化されることを確認済み。Worker routes/services内の生の `Number(c.req.query(...))` / `parseInt(c.req.query(...))` 検索も0件。
- [ ] admin diagnostics/repair APIの `accountId` query、broadcast/friend path ID、tag/content診断payloadが副作用前に検証される
  - Worker admin diagnostics route testsでは、不正な `accountId`、unsafeなbroadcast/friend path ID、壊れたJSON、空/過大なtag/content payloadがDB accessやLINE profile refresh前に400で止まり、正常値はtrimされることを確認済み。LINE profile refresh失敗ログもLINE HTTP statusまたは例外種別だけを残し、channel token、LINE response body、token-like text、raw例外本文を出さないことを確認済み。
- [ ] Stripe eventsの `friendId` / `eventType` queryがDB helper呼び出し前に検証される
  - Worker operations route testsでは、不正な `friendId/eventType` がDB helper前に400で止まり、正常queryはtrimされることを確認済み。
- [ ] affiliate reportの `id` / `startDate` / `endDate` path/queryがDB helper呼び出し前に検証される
  - Worker operations route testsでは、不正なaffiliate ID、壊れたdate、逆転したdate範囲がDB helper前に400で止まり、正常値はtrimされることを確認済み。
- [ ] 公開フォーム送信/返信時に、回答データ、送信先、レスポンスステータス、friend ID、LINE user IDがconsoleへ出ない
  - `apps/worker/src/client/form.ts` と `apps/worker/src/routes/forms.ts` の `Form reply|console.log` 検索は0件で、Worker typecheck/buildも通過済み。
- [ ] 公開フォームsubmitのWebhook gateが、LIFFクライアントの事前確認や `_skipWebhook` 自己申告を信じず、Worker側で毎回再判定される
  - Worker form access route testsでは、`_skipWebhook` を送ってもWebhook gateが呼ばれ、gate拒否時はreward tag/scenario side effectが走らず、Webhook fetch失敗も伏せ字化された結果だけ保存されることを確認済み。
- [ ] 公開フォームopened、partial、submitの友だち紐付けが、caller supplied `lineUserId` / `friendId` ではなくLINE ID token検証済みのLINE user IDだけを使う
  - Worker form access route testsでは、自己申告 `friendId` / `lineUserId` だけではpartial metadata writeやsubmit side effectが走らず、Bearer ID tokenで検証できた場合だけ友だちに紐付くことを確認済み。
- [ ] 公開フォームpartial/submitが壊れたJSONや大きすぎる `data` を副作用前に拒否する
  - Worker form access route testsでは、壊れたJSON、オブジェクト以外の `data`、16KB超の `data` がLINE ID token検証、Webhook、submission保存、reward side effect前に400で止まることを確認済み。
- [ ] フォーム定義/公開送信/管理APIのpath `formId` が副作用前に検証される
  - Worker form access route testsでは、不正なform path IDがDB lookup/write、D1 prepare、LINE ID token検証、Webhook、submission保存、reward side effect前に400で止まり、正常IDはtrimされることを確認済み。
- [ ] フォーム管理、公開opened/partial/submit、Webhook失敗通知、submit後side-effect失敗時に、form ID、回答データ、friend ID、LINE user ID、idToken、tag/scenario ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker form access route testsでは、失敗ログが例外種別だけになり、API errorは固定文言になり、回答本文、ID、idToken、token-like text、raw例外本文が出ないことを確認済み。
- [ ] `/api/liff/profile` が、caller supplied `lineUserId` ではなくLINE ID token検証済みのLINE user IDだけで友だちプロフィールを返す
  - Worker LIFF access route testsでは、自己申告 `lineUserId` だけでは401になり、巨大/非文字列のbody `idToken` はLINE verify前に400で止まり、Bearer ID tokenまたはbody `idToken` の検証済みsubjectだけで友だち情報を返すことを確認済み。
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
- [ ] event admin/LIFF event APIのquery/path IDがDB/helper/booking副作用前に検証される
  - Worker events route testsでは、不正な `account_id/liffId/eventId/slotId/bookingId/status/slot_id` がDB access、LIFF auth helper、availability helper、booking判断/更新前に400で止まり、正常query/path IDはtrimされることを確認済み。
- [ ] Webhook follow、LIFF/X Harness連携、booking LIFF認証時に、LINE user ID、friend ID、表示名、Xユーザー名、channel候補、verify失敗bodyがconsoleへ出ない
  - Webhook/events/broadcast/admin-diagnostics route tests、Worker typecheck、Worker buildで、Webhook/profile refresh/broadcast test-sendの失敗ログ匿名化後も動作が壊れていないことを確認済み。
- [ ] admin update APIのsetup/stream失敗時に、Cloudflare project名、update ID、token-like text、raw例外本文がエラー応答へ出ない
  - Worker admin update route testsでは、`/admin/update/start` setup失敗と `/admin/update/stream/:id` SSE error frameが固定errorと例外種別だけを返すことを確認済み。
- [ ] admin update履歴から成功済み更新を手動rollbackできる
  - Worker admin update route testsでは、`/admin/update/rollback/:id` が不正ID、不存在row、失敗/期限切れrow、snapshot欠落rowを止め、成功済みrowだけrollback履歴行を作成し、既存rollback engineをbackground実行することを確認済み。Web update-client testsでは、Rollback開始APIにadmin key付きPOSTを送ることを確認済み。
- [ ] Webhook管理APIがowner/adminだけに制限され、path/payloadをDB lookup/write前に検証し、incoming receive公開エンドポイントは署名検証付きで維持される
  - Worker webhooks route testsでは、staffがincoming/outgoing webhook設定の一覧、作成、更新、削除を実行できず、不正な更新/削除/receive path ID、壊れたJSON、不正なname/sourceType/url/eventTypes/secret/isActiveはDB lookup/write前に400で止まり、外部システム用の `/api/webhooks/incoming/:id/receive` は有効IDでは403ではなく署名不足の401で止まることを確認済み。
- [ ] Webhook管理/公開incoming receive API失敗時に、webhook ID、sourceType、URL、eventTypes、secret、signature、payload本文、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker webhooks route testsでは、incoming/outgoing管理と公開incoming receiveの失敗ログが例外種別だけになり、API errorは固定文言になり、webhook ID、sourceType、URL、eventTypes、secret、signature、payload本文、token-like text、raw例外本文が出ないことを確認済み。
- [ ] LINEアカウント管理APIが壊れた/unsafe path ID/payloadをDB lookup/write前に拒否する
  - Worker line-accounts route testsでは、詳細、metadata更新、credential更新、削除の不正path IDと、登録、metadata更新、credential更新、表示順更新の壊れたJSON、不正なchannelId/name/credential/Login/LIFF/isActive/displayOrderがDB lookup、DB write、重複lookup前に400で止まり、正常payloadはtrimされることを確認済み。
- [ ] LINEアカウント管理API失敗時に、LINE account ID、channel ID、channel token/secret、Login Channel ID/Secret、LIFF ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker line-accounts route testsでは、登録、main pool自動登録、metadata更新、credential更新の失敗ログが例外種別だけになり、API errorは固定文言になり、LINE account ID、channel ID、channel token/secret、Login Channel ID/Secret、LIFF ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] Meet Harness callbackがHMAC署名付きリクエストだけを受け付ける
  - Worker meet-callback route testsでは、`MEET_CALLBACK_SECRET` 未設定、`X-Meet-Callback-Signature` 不足、不正署名をDB lookupやLINE push前に拒否し、正しいHMAC-SHA256 hex署名だけがmetadata保存まで進むことを確認済み。
- [ ] Stripe webhookが署名付きでも壊れた/巨大payloadをDB前に拒否する
  - Worker operations route testsでは、署名付きの正しいbounded payloadだけが記録され、壊れたJSONはDB lookup/記録前に400、1MiB超payloadはDB lookup/記録前に413で止まることを確認済み。
- [ ] ad-platforms/affiliates/tracked-links管理APIのpath/payloadが、不正な値をDB/外部送信前に拒否する
  - Worker operations route testsでは、不正なadPlatformId/affiliateId/trackedLinkId、壊れたJSON、許可以外の広告platform名、巨大/ネストした広告config、長すぎる名前、URL-safeではないaffiliate code、不正なcommissionRate、HTTP(S)以外または2048文字超のoriginalUrl、不正な関連ID、不正なisActiveがDB lookup/write、click-detail/logs lookup、削除、広告CV test送信lookup前に400で止まり、正常値はtrim/正規化されることを確認済み。
- [ ] Stripe events/webhook、ad-platforms、affiliates/click、tracked-links管理、tracked-link公開redirect非同期記録の失敗時に、Stripe event/friend ID、広告config/token、affiliate code、クリックURL、IP、tracked link ID、tag/scenario ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker operations route testsでは、失敗ログが例外種別だけになり、API errorは固定文言になり、payload本文、ID、URL、IP、token-like text、raw例外本文が出ないことを確認済み。
- [ ] 公開QR proxy `/api/qr` が無制限な外部QR生成proxyにならない
  - Worker QR proxy testsでは、`data` がHTTP(S) URLではない、長すぎる、`size` が正方形ではない/大きすぎる/形式不正、外部QR rendererが画像以外を返す場合に拒否することを確認済み。
- [ ] 公開short-link `/r/:ref` が無制限なDB lookup/LIFF URL生成/HTML反映導線にならない
  - Worker QR proxy testsでは、不正な `ref/form/pool/gate/xh/ig/t` がDB lookup、QR fetch、HTML生成前に400で止まり、正常値はtrimされ、help fallbackは検証済みqueryだけを保持することを確認済み。
- [ ] 公開pool入口 `/pool/:slug` が無制限なDB lookup/LIFF auth redirect導線にならない
  - Worker management role guard testsでは、不正な `slug/ref/form/gate/xh/ig` がDB lookupやLIFF auth redirect前に400で止まり、正常値はtrimされ、`account` や未知queryは `/auth/line` へ転送しないことを確認済み。
- [ ] scenario/reminder/scoring/template/message-templateの定義参照・変更APIとtag定義変更APIがowner/adminだけに制限される
  - Worker scenario/support-friend/content-management route testsでは、staffがscenario/step、reminder/step、scoring rule、reusable template、message-templateの一覧/詳細/作成/更新/削除を実行できず、tag定義の作成/削除もできず、friend単位の操作は見えるsupport case友だちの範囲に残ることを確認済み。
- [ ] reminder/scoring rule定義payloadとfriend score/reminder操作payloadが副作用前に検証される
  - Worker support-friend access route testsでは、壊れたJSON、不正なID、空/過大なname/description/reason/messageContent、不正なmessageType/Flex/image JSON、不正date、不正score/offsetがDB helperやfriend reminder SQL前に400で止まり、正常payload/path IDはtrimされることを確認済み。
- [ ] scoring rule/reminder定義APIとfriend score/reminder操作API失敗時に、rule/reminder名、reason、messageContent、targetDate、friend ID、LINE user ID、reminder ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker support-friend access route testsでは、scoring rule作成、friend score追加、friend reminder登録の失敗時にconsoleへ例外種別だけが残り、API errorは固定文言になり、rule/reminder名、reason、targetDate、friend ID、LINE user ID、reminder ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] scenario定義/step/reorderのquery/path ID/payloadがDB lookup/write前に検証される
  - Worker scenarios route testsでは、壊れたJSON、不正なlineAccountId/scenarioId/stepId/friendId/startAt/name/triggerType/deliveryMode/isActive/stepOrder/messageType/messageContent/condition/reorderがDB lookup、stats計算、friend可視範囲check、batch update、write前に400で止まり、正常値はtrimされることを確認済み。step更新/削除/reorderはpath上のscenarioに属するstepだけを対象にする。
- [ ] tag/template/message-template定義path/payloadがDB書き込み前に検証される
  - Worker content management route testsでは、不正なtag/template/message-template path ID、壊れたJSON、不正なname/color/category/messageType/messageContent、壊れたFlex/image JSON、空updateがDB helper、D1 prepare、DB write、既存template lookup前に400で止まり、正常値はtrimされることを確認済み。
- [ ] template一覧の `category` queryがDB helper呼び出し前に検証される
  - Worker content management route testsでは、過大な `category` queryがDB helper前に400で止まり、正常値はtrimされることを確認済み。
- [ ] scenario/tag/template/message-template/automation/auto-reply/notification rule API失敗時に、scenario/template/tag/rule名、messageContent、auto-reply本文、automation actions/conditions、notification channels/conditions、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker scenarios/content-management/management-role-guards testsでは、失敗ログが例外種別だけになり、API errorは固定文言になり、payload本文、名前、ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] automation/auto-reply/notification ruleの管理参照・変更APIとtraffic pool/operatorの管理一覧・変更APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffがautomation、auto-reply、notification ruleの一覧/詳細/ログ取得や作成/更新/削除を実行できず、traffic pool、pool-account、operatorの管理一覧取得や作成/更新/削除でもDB helperへ到達しないことを確認済み。automations管理payload/query/path IDの壊れたJSON、不正なeventType/action type/isActive/priority、空update、auto-reply管理payload/query/path IDの壊れたJSON、不正なkeyword/matchType/responseType/ID/isActive、空本文/空update、notification rule管理payload/query/path IDの壊れたJSON、不正なeventType/channels/status/isActive、空update、traffic pool/operator管理path ID/payloadの壊れたJSON、不正なpoolId/poolAccountId/slug/name/activeAccountId/lineAccountId/operatorId/email/role/isActiveもDB helper/write前に400で止まる。
- [ ] traffic pool管理API失敗時に、pool ID、pool account ID、LINE account ID、slug、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker management role guard testsでは、traffic pool一覧、作成、更新、削除、pool account一覧、追加、toggle、削除の失敗ログが例外種別だけになり、API errorは固定文言になり、pool ID、pool account ID、LINE account ID、slug、token-like text、raw例外本文が出ないことを確認済み。
- [ ] booking/event admin APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffがbooking/event admin routeへ直接アクセスしても403で止まり、DBへ到達しないことを確認済み。Events route testsではowner文脈の既存admin操作が引き続き通ることを確認済み。
- [ ] rich menu catalog/group管理APIがowner/adminだけに制限される
  - Worker rich-menu group/support-friend access route testsでは、staffがLINE rich menu catalogやrich menu group管理APIへ直接アクセスしても403で止まり、見えている友だち単位のrich menu参照は引き続き通ることを確認済み。
- [ ] rich menu publish/unpublishの非致命LINE API失敗ログ/warningsに、channel token、richMenu ID、raw例外本文が出ない
  - Worker rich-menu publisher testsでは、default lookup/clear失敗時のconsole/warningsが例外種別だけを残し、channel-token-like text、richMenu ID、raw LINE error messageを出さないことを確認済み。
- [ ] rich menu editor画像とLINE外部画像proxyが認証なしで読めない
  - Worker auth middleware testsでは、`/api/rich-menu-images/...` と `/api/rich-menu-groups/external/:richMenuId/image` が未認証では401になり、session cookie付きGETでは通ることを確認済み。
- [ ] rich menu catalog/friend操作APIのquery/path/payload/imageがDB/LINE副作用前に検証される
  - Worker support-friend access route testsでは、不正なaccountId/richMenuId、create payload、画像base64/contentType、friend path ID、friend link payloadがDB lookup、friend可視範囲check、LINE fetch、LINE link、LINE画像upload前に400で止まることを確認済み。
- [ ] rich menu catalog/friend操作API失敗時に、channel token、LINE account ID、friend ID、LINE user ID、richMenu ID、token-like text、raw LINE/API例外本文がconsole/エラー応答へ出ない
  - Worker support-friend access route testsでは、catalog取得/friend rich menuリンク失敗時にconsoleへ例外種別だけが残り、API errorは固定文言になり、channel token、LINE account ID、friend ID、LINE user ID、richMenu ID、token-like text、raw LINE/API例外本文が出ないことを確認済み。
- [ ] rich menu group管理APIのquery/path/payload/R2 keyがDB/LINE/R2副作用前に検証される
  - Worker rich-menu group route testsでは、不正なaccountId/richMenuId/groupId/pageId/tagId、apply-to-tag payload、force query、画像R2 keyがDB helper、SQL bind、LINE fetch、R2 get/put前に400で止まり、正常なID/name/chatBarText/actionTypeはtrimされることを確認済み。
- [ ] entry route/conversion point/Google Calendar接続/account health・migration管理APIがowner/adminだけに制限される
  - Worker management role guard testsでは、staffが流入経路、conversion point一覧/作成/削除、Google Calendar接続一覧/作成/削除、account health/migration管理APIへ直接アクセスしても403で止まり、DB helperやD1へ到達しないことを確認済み。Conversion/calendar access route testsでは、friend単位のconversion/calendar booking操作が引き続き可視範囲内で通ることを確認済み。
- [ ] entry route管理path ID/payloadがDB helper前に検証される
  - Worker management role guard testsでは、不正なentry route path ID、壊れたJSON、不正なrefCode/name/redirectUrl/関連ID/runAccountFriendAddScenarios/isActiveがDB helper/write前に400で止まり、正常path/payloadはtrim/null正規化されることを確認済み。
- [ ] entry route管理API失敗時に、entry route ID、tag ID、scenario ID、pool ID、template ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker management role guard testsでは、entry route一覧、詳細、作成、更新、削除、funnel取得の失敗ログが例外種別だけになり、API errorは固定文言になり、entry route ID、関連ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] account health/migration APIのaccount/migration path IDとmigration作成payloadがDB helperやD1 count前に検証される
  - Worker management role guard testsでは、壊れたJSON、不正なfromAccountId/toAccountId/migrationIdがDB helperやD1 count前に400で止まり、正常payload/path IDはtrimされることを確認済み。
- [ ] account health/migration API失敗時に、account ID、migration ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker management role guard testsでは、account health、migration一覧、migration作成、migration詳細の失敗ログが例外種別だけになり、API errorは固定文言になり、account ID、migration ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] conversion point削除path ID/作成payloadがDB helper前に検証される
  - Worker management role guard testsでは、不正なconversion point削除path ID、壊れたJSON、不正なname/eventType/valueがDB helper/write前に400で止まり、正常path/payloadはtrim/value null正規化されることを確認済み。
- [ ] conversion記録payloadがfriend可視範囲check/DB書き込み前に検証される
  - Worker conversion/calendar access route testsでは、壊れたJSON、不正なconversionPointId/friendId/userId/affiliateCode/metadataがfriend可視範囲checkやDB write前に400で止まり、正常payloadはtrim/null正規化/metadata文字列化されることを確認済み。
- [ ] conversion point管理、conversion記録、conversionイベント一覧/report API失敗時に、conversion point ID、friend ID、user ID、affiliate code、metadata、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker conversion/calendar access route testsでは、conversion point一覧/作成/削除、conversion記録、events、reportの失敗ログが例外種別だけになり、API errorは固定文言になり、conversion point ID、friend ID、user ID、affiliate code、metadata、token-like text、raw例外本文が出ないことを確認済み。
- [ ] friends ref集計、重複統計、ref流入分析、LIFFリンクwrap、画像削除APIがowner/adminだけに制限される
  - Worker friends/duplicates/LIFF/image access route testsでは、staffがfriends ref集計、重複統計、ref summary/detail、LIFFリンクwrap、画像削除へ直接アクセスしても403で止まり、画像アップロードはstaffのチャット返信用に維持されることを確認済み。
- [ ] 重複統計API失敗時に、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker duplicates route testsでは、stats失敗時にconsoleへ例外種別だけが残り、API errorは固定文言になり、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文が出ないことを確認済み。
- [ ] 画像upload/公開表示/削除APIのpayloadとR2 keyがR2 put/get/delete前に検証される
  - Worker image access route testsでは、壊れたJSON、不正base64/mimeType/filename、空/過大画像、不正R2 keyがR2 put/get/delete前に400/404で止まり、正常filename/keyはtrimされることを確認済み。
- [ ] 画像upload/削除API失敗時に、filename、R2 key、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker image access route testsでは、R2 put/delete失敗時のconsoleは例外種別だけになり、API errorは固定文言になり、filename、R2 key、token-like text、raw例外本文が出ないことを確認済み。
- [ ] LINE incoming画像の取得/保存失敗時に、channel token、LINE message ID、LINE account ID、raw例外本文がconsoleへ出ない
  - Worker incoming-image service testsでは、LINE Content API非200、fetch失敗、R2保存失敗時にHTTP statusや例外種別だけを残し、channel token、messageId、accountId、raw例外本文をconsoleへ出さないことを確認済み。
- [ ] LIFF OAuth token交換、LINE token refresh、IG Harness notify、X Harness action失敗時に、外部レスポンス本文、LINE friend UUID、LINE account名/ID/access token、tag名、例外本文がconsoleへ出ない
  - Webhook/webhooks/events route tests、Worker typecheck、Worker buildで、公開導線に近いLIFF/外部連携ログ匿名化後も動作が壊れていないことを確認済み。
  - Worker token refresh service testsでは、LINE token API失敗時に外部レスポンス本文/account名/secretをconsoleへ出さず、成功時もaccount ID/name/access tokenをconsoleへ出さないことを確認済み。
  - Worker event route testsでは、event bookingの予約処理/通知失敗時にraw例外本文、LINE user ID、channel tokenをconsoleへ出さないことを確認済み。
- [ ] LINE画像payloadのHTTPS検証が送信前に効く
  - Preflightでは、staff可視チャットの `/send/validate` でHTTPS画像payloadが200になり、非HTTPS `originalContentUrl` が400で止まることを確認する。
- [ ] チャットloading/send/send-validate失敗時に、LINE APIレスポンス本文、channel token、LINE user ID、friend ID、raw例外本文がconsole/エラー応答へ出ない
  - Worker chat route testsでは、loadingのLINE API非200、send/validate内部例外、sendのLINE push失敗時にHTTP statusや例外種別だけを残し、外部本文、channel token、LINE user ID、friend ID、raw例外本文をconsoleやAPI errorへ出さないことを確認済み。
- [ ] チャット一覧/詳細/作成/更新とoperator管理失敗時に、friend ID、LINE user ID、LINE account ID、operator payload、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker chat route testsでは、chat list、chat作成、operator作成の失敗時にconsoleへ例外種別だけが残り、friend ID、LINE user ID、LINE account ID、operator payload details、token-like text、raw例外本文が出ないことを確認済み。
- [ ] 未対応インボックス一覧/件数失敗時に、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文がconsole/エラー応答へ出ない
  - Worker inbox route testsでは、unanswered list/countの失敗時にconsoleへ例外種別だけが残り、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文が出ないことを確認済み。
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
corepack pnpm --filter worker test -- src/routes/friends.test.ts # 10 tests
corepack pnpm --filter worker test -- src/routes/conversions-calendar-access.test.ts
corepack pnpm --filter worker test -- src/routes/automations.test.ts src/routes/operations-access.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/notifications.test.ts
corepack pnpm --filter worker test -- src/routes/operations-access.test.ts # 30 tests
corepack pnpm --filter worker test -- src/routes/webhook.test.ts src/routes/webhooks.test.ts src/routes/events.test.ts # webhooks 33 tests
corepack pnpm --filter worker test -- src/routes/webhooks.test.ts # 36 tests
corepack pnpm --filter worker test -- src/routes/liff-access.test.ts src/routes/forms-access.test.ts src/middleware/auth.test.ts
corepack pnpm --filter worker test -- src/routes/forms-access.test.ts # 14 tests
corepack pnpm --filter worker test -- src/routes/scenarios.test.ts # 18 tests
corepack pnpm --filter worker test -- src/routes/content-management-access.test.ts # 19 tests
corepack pnpm --filter worker test -- src/routes/management-role-guards.test.ts # 35 tests
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
- What changed: サポート案件/チャット/スタッフAPI、friend/inbox/users-grouped/users/account-settings/conversions/calendar/conversation/scenario APIのstaff可視範囲guard、broadcast管理/配信/集計/dedup-preview API、admin診断/repair API、フォーム管理API、売上・広告・計測運用API、friends ref集計/重複統計/ref分析/LIFFリンクwrap/画像削除APIのowner/admin制限、rich menu画像GET認証、Meet Harness callbackのHMAC署名検証、公開QR proxy入力制限、公開short-link入力制限、公開pool入口入力制限、公開フォーム/LIFF payload入力制限、公開LIFF profile idToken入力制限、公開LIFF config/ref analytics入力制限、公開affiliate click入力制限、support案件/エスカレーション/manual query/path/JSON入力制限、support書き込みpayloadサイズ制限、inbox query入力制限、users-grouped query入力制限、ad-platforms/affiliates/tracked-links管理API payload入力制限、scenario定義/step/reorder query/path/payload入力制限、entry route管理API path/payload入力制限、conversion point作成payload入力制限、conversion記録payload入力制限、conversionイベント/report query入力制限、calendar空き枠/予約一覧query入力制限、conversation一覧/詳細query入力制限、chat一覧/詳細/作成/更新/送信query/path/payload入力制限、friends query/path/tag/metadata/direct message payload入力制限、broadcast管理payload/query/path/segment条件入力制限、dedup-preview payload入力制限、automation payload入力制限、auto-reply payload入力制限、notification rule payload入力制限、event booking Idempotency-Key入力制限、event admin/LIFF event query/path入力制限、フォーム公開GET/submit境界、CORS、サポートCRM UI、案件一覧の更新順/初回選択/キュー解除、staffサイドバーの管理メニュー非表示、staff管理URL直打ちの `/support` 退避、チャット返信の案件履歴連携、staffフォーム/クリップボード/認証キャッシュ helper、Preflight、strict Preflight dry-run、PR-safe Preflight summary、strict必須credential guard、dry-run checklist audit、release readiness、strict Preflight用fixture候補抽出/コマンドテンプレ、synthetic fixture seed/cleanup/cleanup verification、テスト、運用ドキュメント、PR用CI検証範囲。
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
- `corepack pnpm --filter worker test -- src/routes/conversions-calendar-access.test.ts` # 39 tests
- `corepack pnpm --filter worker test -- src/middleware/auth.test.ts src/routes/users.test.ts src/routes/account-settings.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/broadcasts-access.test.ts src/routes/forms-access.test.ts src/routes/operations-access.test.ts`
- `corepack pnpm --filter worker test -- src/routes/users.test.ts` # 14 tests
- `corepack pnpm --filter worker test -- src/routes/duplicates-access.test.ts` # 3 tests
- `corepack pnpm --filter worker test -- src/routes/forms-access.test.ts` # 14 tests
- `corepack pnpm --filter worker test -- src/routes/operations-access.test.ts` # 30 tests
- `corepack pnpm --filter worker test -- src/routes/support-friend-access-routes.test.ts` # 21 tests
- `corepack pnpm --filter worker test -- src/routes/scenarios.test.ts` # 18 tests
- `corepack pnpm --filter worker test -- src/routes/content-management-access.test.ts` # 19 tests
- `corepack pnpm --filter worker test -- src/routes/line-accounts.test.ts` # 28 tests
- `corepack pnpm --filter worker test -- src/routes/staff.test.ts` # 12 tests
- `corepack pnpm --filter worker test -- src/routes/broadcasts-access.test.ts`
- `corepack pnpm --filter worker test -- src/routes/management-role-guards.test.ts` # 35 tests
- `corepack pnpm --filter worker test -- src/routes/notifications.test.ts`
- `corepack pnpm --filter worker test -- src/routes/automations.test.ts`
- `corepack pnpm --filter worker test -- src/routes/rich-menu-groups.test.ts`
- `corepack pnpm --filter worker test -- src/routes/webhooks.test.ts` # 36 tests
- `corepack pnpm --filter worker test`
- `corepack pnpm --filter worker test -- src/routes/support.test.ts src/routes/chats.test.ts src/routes/staff.test.ts src/services/support-access.test.ts`
- `corepack pnpm build`
- `corepack pnpm --filter worker build`
- `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 corepack pnpm --filter web build`
- `git diff --check`
- Browser smoke with login mock session confirms unauthenticated `/support` redirects to `/login`; entering an API key calls `/api/auth/login`, the next `/api/auth/session` succeeds, and the dashboard renders the login staff identity, owner role, selected LINE account, and KPI cards.
- Browser smoke with owner/admin/staff mock sessions confirms `/support` role UI: owner/admin show one `新規案件` button; staff shows zero `新規案件` buttons. Staff mock sidebar only shows 友だち管理, 個別チャット, サポートCRM, and 未対応 while hiding management menus; direct staff access to `/broadcasts` returns to `/support`; direct admin access to `/staff` also returns to `/support`.
- Web helper and Worker route/service tests confirm `/notifications` builds server-side unanswered inbox queries for search/account/1時間以上/page/pageSize, summary count uses the same filters, unsafe `q/account` filters stop before inbox service calls, valid filters are trimmed, and invalid or oversized `page` / `pageSize` / `minWaitMinutes` values are ignored or capped before they can produce `NaN`.
- Browser smoke with empty staff-name mock session confirms `/support` shows the staff-name warning, does not render the dummy case/manual/staff suggestion/unanswered badge, and does not call `/api/support/summary`, `/api/support/cases`, `/api/support/manuals`, `/api/chats`, `/api/staff`, or `/api/inbox/unanswered/count`.
- Browser smoke with list-control mock session confirms updated sort is `updatedAt` desc even when API order differs, initial detail matches the first displayed case, priority sort reorders locally, overdue queue sends `queue=overdue`, status selection clears queue, and search sends `q=Gamma`.
- Browser smoke with outside-list mock session confirms hidden selected cases keep the detail panel with an explanatory banner; resolved hidden cases reveal the completed list with `status=resolved`, while unresolved hidden cases reset to `queue=unresolved`.
- Browser smoke with long-chat mock session confirms the chat screen starts with the latest two messages, calls `/api/chats/:id` with `beforeCreatedAt` and `beforeId` when loading older history, prepends the two older messages in chronological order, and hides the load-older button after `hasMoreMessages=false`.
- Browser smoke with draft-handoff mock session confirms `チャットで返信` opens `/chats?friend=...&supportCase=...&lineAccount=...`, fills the chat message box with the support reply draft, and keeps the support-case title in the linked-draft banner after the URL fallback reruns.
- Browser smoke with URL-fallback mock session confirms a direct `/chats?friend=...&supportCase=...&lineAccount=...` link without a sessionStorage draft shows the support-case link banner, starts with an empty message box and disabled send button, and sends text with `supportCaseId`/`lineAccountId` in the payload.
- `corepack pnpm preflight:support-crm:dry-run` success path: strict release env shape passes with secrets redacted.
- `corepack pnpm preflight:support-crm:dry-run` failure path: missing admin origin, staff key, staff fixture IDs, and disabled staff mutation guard are reported before network calls.
- `corepack pnpm preflight:support-crm:summary` converts the full Preflight log into a PR-safe summary that omits URLs, API keys, friend IDs, and case IDs. Script tests and a strict dry-run pipe check confirm stdin/piped logs are read reliably.
- Script test verifies the release checklist includes every strict dry-run env and the mutation-guard warning, so docs cannot silently drift from the command.
- Worker/script tests verify staff cannot use `/api/friends`, friends ref stats, unanswered inbox list/count, users-grouped customer aggregation, legacy users customer identity, account-settings test recipients, broadcast management/send/count/insight/dedup-preview APIs, admin diagnostics/repair APIs, form management/submission-list APIs, booking/event admin APIs, rich menu catalog/group management APIs, entry route/conversion point/Google Calendar connection/account health migration management APIs, duplicate/ref analytics APIs, LIFF link wrapping, image deletion, Stripe events, ad-platforms, affiliate management/reporting, tracked-link management, scenario/reminder/scoring/template/message-template definition read/mutation APIs, tag definition mutation APIs, automation/auto-reply/notification rule/traffic pool/operator management APIs, conversion history/report, calendar bookings, direct message history/send, conversation queue/detail, scenario manual enrollment, score, reminder, or rich-menu friend endpoints to bypass support-case friend visibility or role boundaries. Support route tests verify malformed support case/escalation/manual query values, path IDs, JSON payloads, and oversized write payload text/metadata stop before DB access, SQL bind, support event writes, or manual/case/escalation mutations while valid IDs and strings are trimmed before lookup or update. Inbox route tests verify unsafe unanswered inbox q/account filters stop before inbox service calls while valid filters are trimmed and oversized numeric filters are capped. Users-grouped route tests verify malformed customer aggregation query values stop before aggregation/service calls while valid q/account/page/pageSize/onlyDups/refresh values are trimmed, parsed, and capped. Meet callback route tests verify unsigned or incorrectly signed callbacks stop before DB lookup or LINE push. Webhook route tests verify malformed or unsafe incoming/outgoing webhook management path IDs and payloads stop before DB lookup/writes while the public receive endpoint remains signature-gated. Line account route tests verify malformed or unsafe path IDs and create/update/order payloads stop before DB lookup, DB writes, or duplicate Login/LIFF lookup. Line account route tests also verify create, main-pool auto-enroll, metadata update, and credential update failure logs and error responses keep only exception kind or fixed internal error, without LINE account IDs, channel IDs, channel tokens/secrets, Login Channel IDs/secrets, LIFF IDs, token-like text, or raw exception messages. Traffic pool/operator route tests verify malformed or unsafe public pool `slug/ref/form/gate/xh/ig`, pool/pool-account/operator path IDs, and payloads stop before DB helpers or writes, while public pool redirects forward only validated retry query values. Auth middleware tests verify rich menu editor/external image GETs are cookie-authenticated and unauthenticated requests stop before route handling. Admin diagnostics route tests verify unsafe account filters, path IDs, and tag/content diagnostic payloads stop before DB access, LINE profile refresh, or repair SQL. Entry route tests verify malformed or unsafe management path IDs and refCode/name/redirectUrl/reference/boolean payloads stop before DB helpers/writes. Conversion point tests verify malformed or unsafe delete path IDs and name/eventType/value payloads stop before DB helpers/writes. Conversion tracking tests verify malformed or unsafe conversionPointId/friendId/userId/affiliateCode/metadata payloads stop before friend access checks or DB writes. Conversion query tests verify malformed conversion event/report filter values stop before friend access checks or SQL bind. Calendar query tests verify malformed or unsafe connectionId/date/friendId filters stop before Calendar connection lookup, booking range lookup, friend access checks, or SQL bind. Conversation query tests verify malformed or unsafe lineAccountId/hour range/friendId/cursor values stop before friend access checks or SQL bind, while paging is normalized. Calendar route tests verify malformed or unsafe connection/booking/status path IDs and payloads stop before DB helpers, DB writes, friend access checks, or Calendar connection lookup. Scenario route tests verify malformed or unsafe scenario list filters, scenario/step/enroll path IDs, preview startAt cursors, and scenario/step/reorder payloads stop before DB lookup, stats computation, friend visibility checks, batch updates, or writes, while valid values are trimmed and step update/delete/reorder mutations stay scoped to the path scenario. Content management route tests verify malformed or unsafe tag/template/message-template path IDs and tag/template/message-template payloads stop before DB helpers, D1 prepare, DB writes, or lookup, and oversized template category query filters stop before DB helper calls. QR proxy tests verify public QR generation rejects unsafe URL/size inputs before upstream fetch, and public short links reject unsafe ref/form/pool/gate/xh/ig/t values before DB lookup, QR fetch, or HTML rendering while valid values are trimmed and help fallback keeps only validated retry params. Form/LIFF access route tests verify malformed form path IDs and malformed or oversized public payloads stop before LINE verification, webhook calls, submission writes, DB lookup/write, D1 prepare, or LINE push; LIFF profile/config/ref analytics tests verify malformed or oversized profile body idToken, unsafe liffId/lineAccountId/refCode values stop before LINE verification, DB access, LINE bot info fetch, or SQL bind while valid values are trimmed. Operations route tests verify malformed or oversized public Stripe webhook, Stripe events filter query, affiliate report query, affiliate click, tracked-link redirect, and ad-platform/affiliate/tracked-link management path/payload values stop before DB lookup, DB helper call, click/event recording, external test-send lookup, or writes. Events route tests verify malformed or oversized event booking idempotency keys stop before LINE verification or idempotency reservation, and malformed event admin/LIFF account/query/path values stop before DB access, LIFF auth helpers, availability helpers, or booking mutations while valid IDs and filters are trimmed. Chat route tests verify malformed or unsafe chat list filters, chat/friend path IDs, message cursors, create/update payloads, send payload IDs, and loading/send paths stop before DB helpers, SQL bind, friend access checks, LINE loading/send calls, or writes while valid IDs, filters, cursors, and payload fields are trimmed. Chat reply tests verify text/image support replies record `customer_reply_sent` support-case events, update cases to `customer_reply`, survive URL fallback without `lineAccountId`, reject resolved-case sends before LINE push or DB writes, and web helper tests verify image+text sends attach the support case to only one send step.
- Calendar route tests verify connection list/create, booking create, and Google FreeBusy/createEvent/deleteEvent failure logs and error responses keep only exception kind or fixed internal error, without connection IDs, booking IDs, friend IDs, calendar IDs, event IDs, access/refresh/API tokens, booking titles, token-like text, or raw exception messages.
- Conversion/calendar access route tests verify conversion point list/create/delete, conversion track, conversion events, and conversion report failure logs and error responses keep only exception kind or fixed internal error, without conversion point IDs, friend IDs, user IDs, affiliate codes, metadata, token-like text, or raw exception messages.
- Image access route tests verify image upload/delete failure logs and error responses keep only exception kind or fixed internal error, without filenames, R2 keys, token-like text, or raw exception messages.
- Management role guard tests verify traffic pool, entry route, and account health/migration failure logs and error responses keep only exception kind or fixed internal error, without pool IDs, pool-account IDs, LINE account IDs, slugs, entry route IDs, related IDs, account IDs, migration IDs, token-like text, or raw exception messages.
- Staff route tests verify staff list, create, update, and regenerate-key failure logs and error responses keep only exception kind or fixed internal error, without staff IDs, staff emails, API keys, token-like text, or raw exception messages.
- Users route tests verify list, create, link, and match failure logs and error responses keep only exception kind or fixed internal error, without user IDs, friend IDs, emails, phones, external IDs, display names, token-like text, or raw exception messages.
- Duplicates route tests verify stats failure logs and error responses keep only exception kind or fixed internal error, without LINE account IDs, friend IDs, LINE user IDs, token-like text, or raw exception messages.
- Support-friend access route tests verify malformed rich menu catalog account/rich-menu IDs, create payloads, image payloads, friend path IDs, and friend link payloads stop before DB lookup, friend visibility checks, LINE fetch, LINE link, or image upload while visible-friend rich menu reads still work.
- Support-friend access route tests verify rich menu catalog/friend operation failure logs and error responses keep only exception kind or fixed internal error, without channel tokens, LINE account IDs, friend IDs, LINE user IDs, richMenu IDs, token-like text, or raw LINE/API error messages.
- Support-friend access route tests verify scoring rule/friend score/friend reminder failure logs and error responses keep only exception kind or fixed internal error, without rule/reminder names, reasons, target dates, friend IDs, LINE user IDs, reminder IDs, token-like text, or raw exception messages.
- Scenario/content-management/management role guard tests verify scenario/tag/template/message-template/automation/auto-reply/notification rule failure logs and error responses keep only exception kind or fixed internal error, without scenario/template/tag/rule names, message bodies, automation actions/conditions, notification channels/conditions, friend IDs, LINE user IDs, token-like text, or raw exception messages.
- Operations route tests verify Stripe events/webhook, ad-platforms, affiliates/click, tracked-links management, and tracked-link async click-recording failure logs and error responses keep only exception kind or fixed internal error, without Stripe/friend IDs, ad config/token values, affiliate codes, URLs, IPs, tracked link IDs, tag/scenario IDs, token-like text, or raw exception messages.
- Form access route tests verify form management, public opened, public submit, and submit side-effect failure logs and error responses keep only exception kind or fixed internal error, without form IDs, answer data, friend IDs, LINE user IDs, idTokens, tag/scenario IDs, token-like text, or raw exception messages.
- Webhooks route tests verify incoming/outgoing management and public incoming receive failure logs and error responses keep only exception kind or fixed internal error, without webhook IDs, sourceType, URLs, eventTypes, secrets, signatures, payload text, token-like text, or raw exception messages.
- Friends route tests verify malformed lineAccountId/tagId/search/metadata query values, friend/tag path IDs, metadata updates, and direct message payloads stop before friend visibility checks, DB helpers, SQL bind, LINE push, or tag scenario side effects while valid values are normalized.
- Friends route tests verify friend list/direct-message failure logs and direct-message error responses keep only exception kind or fixed internal error, without search text, message bodies, LINE account IDs, friend IDs, LINE user IDs, token-like text, or raw exception messages.
- Broadcast access tests verify malformed or unsafe broadcast query/path/create/update/send-segment/segment-count payloads stop before DB helpers, SQL bind, LINE send, or recipient/segment computation while valid values are trimmed and normalized. They also verify malformed or unsafe dedup-preview account/tag payloads stop before recipient preview computation while valid IDs are trimmed, deduped, and priority-filtered.
- Broadcast access tests verify manual and scheduled per-account insight fetch failures keep only exception kind or LINE HTTP status in logs and stored raw responses, without account IDs in logs, channel tokens, LINE user IDs, token-like text, or raw LINE/API exception messages.
- Management role guard tests verify malformed or unsafe auto-reply account/path/payload values stop before DB helpers while valid values are trimmed, null-normalized, and template snapshots are filled from the selected template.
- Notifications route tests verify malformed or unsafe notification rule query/path/payload values stop before DB helpers or SQL bind while valid rule payloads are trimmed and channels are deduped.
- Automations route tests verify malformed or unsafe automation query/path/payload values stop before DB helpers or SQL bind while valid rule payloads, action types, priorities, and account scopes are normalized before persistence.
- Step delivery and event bus tests verify scenario condition/action failure logs and automation action failure results keep only exception kind or LINE HTTP status, without friend IDs, tag IDs, webhook IDs, token-like text, or raw exception messages.
- Booking reminder, event booking reminder, and ad conversion tests verify retry `last_error` / conversion `errorMessage` values keep only exception kind or provider HTTP status, without channel tokens, LINE user IDs, friend IDs, click IDs, token-like text, or raw external response bodies.
- Broadcast, reminder delivery, and health monitor tests verify multicast/reminder/health failure logs keep only exception kind or LINE HTTP status, without broadcast IDs, friend IDs, LINE user IDs, account IDs, token-like text, or raw external response bodies. Segment send and scheduled cron failure logs use the same bounded error-kind pattern.
- Webhook, LIFF, and booking route tests plus raw log searches verify webhook event/profile/scenario/auto-reply, LIFF auth/link/analytics/form-link, and booking notification failure logs keep only exception kind or LINE HTTP status, without scenario step IDs, scenario IDs, friend IDs, LINE user IDs, account IDs, token-like text, or raw exception messages.
- Raw client-error searches verify LIFF, booking, and form client failure screens use fixed public messages instead of API response bodies or raw exception messages; the configured Webhook gate failure message remains the only public custom message.
- Rich-menu group route tests verify malformed or unsafe rich menu account/rich-menu/group/page/tag query/path values, apply-to-tag bodies, force query values, and image R2 keys stop before DB helpers, SQL bind, LINE fetch, or R2 get/put while valid IDs and labels are normalized.
- Rich-menu group route tests verify publish/unpublish/set-default/bulk-link failure responses keep only fixed error codes plus exception kind or LINE HTTP status, without channel tokens, richMenu IDs, LINE user IDs, token-like text, or raw LINE/API/DB error messages.
- Admin update route tests verify setup, rollback setup, and SSE stream failures keep only fixed errors plus exception kind, without Cloudflare project names, update IDs, token-like text, or raw exception messages. Update-engine orchestrator tests verify persisted update errors and rollback events keep only exception kind plus HTTP status, without Cloudflare account/token, provider response bodies, or snapshot URLs. They also verify manual rollback rejects malformed or unavailable source rows before rollback side effects, creates a linked rollback history row, runs the rollback engine, and marks the source update as rolled back after success.
- Web support-meta/clipboard/staff-form tests verify manual editor validation, copy fallback behavior, staff creation payload validation, stable user-facing staff management failure messages, and fallback handling for unknown support API raw error strings; raw chat/staff/friends/forms/booking/event/rich-menu/reminder/scoring/scenario/broadcast/template/automation/webhook/friend-add/inflow/accounts/pools/update UI error searches verify chat list/detail/history/send/loading/status/notes, friend detail sidebar, friends list, form submissions, booking management, event booking management, booking staff, shifts, menus, menu staff assignments, event list/form/slot operations, shared image upload failures, rich menu list/create/edit/apply failures, reminder list/detail/create/step/status/delete failures, scoring list/create/status/delete failures, scenario list/create/detail/step/reorder/preview failures, broadcast list/create/delete/insight/dedup-preview/test-send failures, template list/detail/create/update/delete failures, automation list/create/status/delete failures, webhook list/create/update/delete/secret-rotate failures, friend-add settings list/create/update failures, inflow link save failures, LINE account list/create/edit/settings/reorder/delete/toggle failures, pool list/create/delete/member add/remove failures, update start/progress/final failures, and staff management failures do not directly display API error strings or raw exceptions; support/staff pages route destructive actions through the shared in-app confirmation dialog before API calls.
- `corepack pnpm support-crm:release-readiness` separates local/PR evidence failures, missing PR-safe Preflight summary evidence, stale PR body commit evidence, unmergeable PR states, stale CI runs, and external waits such as draft status, production strict Preflight, and fork PR CI approval. When GitHub returns a workflow run URL, the next action includes that URL for maintainer approval or log review.
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
- Secrets/tokens handling changed? `Yes`: browser auth cache handling is centralized and stale local values are cleared on session failure/logout. LINE token refresh logs no longer print account names, account IDs, access tokens, channel secrets, or external token API response bodies. `MEET_CALLBACK_SECRET` is added for HMAC-SHA256 verification of Meet Harness completion callbacks.
- New/changed network calls? `Yes`: Support UI verifies current staff identity via `/api/staff/me`; update history can now POST `/admin/update/rollback/:id` with the admin key to start a manual rollback for an eligible successful update row; fixture helpers can run D1 SELECT, read-only cleanup verification, or explicitly confirmed synthetic fixture INSERT/cleanup through Wrangler. Preflight dry-run adds no network calls. Release readiness reads PR/Actions metadata through `gh`. Support case/escalation/manual writes now reject oversized text and event metadata before case/escalation/manual/event mutations. LIFF form definition GET/opened/partial/submit remain public, but form PUT/DELETE/list/submissions now require authenticated owner/admin, and public form/LIFF path IDs or payloads now reject malformed or oversized input before LINE verification, webhook calls, submission writes, DB lookup/write, D1 prepare, or LINE push. Public affiliate click remains public but now rejects malformed JSON, oversized or URL-unsafe codes, and unsafe/oversized URLs before affiliate lookup or click recording. Public short links remain public but now reject unsafe ref/form/pool/gate/xh/ig/t inputs before DB lookup, QR fetch, LIFF URL rendering, or help HTML reflection. Rich menu editor/external image GETs are no longer auth-skipped and require cookie/Bearer auth. Public pool links remain public but now reject unsafe slug/ref/form/gate/xh/ig before DB lookup or LIFF auth redirect and forward only validated retry query values. Owner/admin admin diagnostics/repair, ad-platform, affiliate, tracked-link, scenario definition, template list filter, entry route management path/payload, conversion point creation, conversion tracking, conversion event/report filter, Stripe events filter, affiliate report filter, calendar slot/booking query/path/payload, chat list/detail/create/update/send/loading query/path/payload, and conversation queue/detail query calls now reject malformed or unsafe payload/query/path values before friend access checks, DB helper calls, DB lookup/writes, LINE loading/send calls, LINE profile refresh, repair SQL, Calendar connection lookup, booking range lookup, SQL bind, or ad conversion test-send lookup. Event booking LIFF予約作成は不正/巨大な `Idempotency-Key` をLINE verificationやidempotency予約前に拒否する。`/api/meet-callback` remains public at the auth middleware layer but now requires `MEET_CALLBACK_SECRET` and a valid `X-Meet-Callback-Signature` HMAC before DB lookup or LINE push. `/api/qr` remains public but now forwards only bounded HTTP(S) URL data and square QR sizes to the external QR renderer.
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

- `FAIL`: こちらで直してから再確認する項目です。例: ローカル差分あり、PR head未push、PR本文の最新commit SHA/検証証跡不足、merge conflictやbase追従不足、CI失敗。
- PR本文の検証証跡には、最新commit SHA、`preflight:support-crm:dry-run`、`preflight:support-crm:summary`、remote strict Preflight、remote cleanup verification、GitHub Actions statusを含めます。
- `WAIT`: 外部状態や本番切替前の未実施確認です。例: fork PRのGitHub Actions承認待ち、PR merge stateがbranch protection/check待ち、最新commitのCI run待ち、PRがdraftのまま、本番LINE公式アカウントの実データstrict Preflight未実施。Actions承認待ちでは、管理者へ渡すrun URLも表示します。
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
