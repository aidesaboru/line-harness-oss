---
title: ECオーナー通達LINE サポートCRM 変更サマリー
status: draft
updated: 2026-06-14
---

# ECオーナー通達LINE サポートCRM 変更サマリー

このファイルは、今回のサポートCRM差分をレビュー、PR作成、本番投入前確認で使うための提出用サマリーです。

大きく見ると、今回の変更は「staffが見てよい範囲だけを見る」「壊れた入力を副作用前に止める」「チャット返信と案件履歴がつながる」「本番切替前に機械的に検査できる」「PRで同じ範囲をCIに載せる」の5点です。

## 1. 実装

### Worker API

- support案件一覧、詳細、更新、履歴、エスカレーション、マニュアル操作にstaff可視範囲とrole別権限を適用
- support案件一覧、友だち一覧、conversionイベント一覧の `limit` / `offset` queryは、SQL bind前に既定値、整数、有限値へ丸める
- calendar空き枠取得の `slotMinutes` / `startHour` / `endHour` queryは、0以下、範囲外、非数値を既定値へ戻し、開始時刻が終了時刻以上なら400で止める
- calendar空き枠/予約一覧の `connectionId` / `date` / `friendId` queryは、Calendar接続lookup、予約範囲lookup、friend可視範囲check、SQL bind前に検証し、正常値はtrimする
- booking admin API共通の `account_id` queryは、メニュー/スタッフ/シフト/予約管理SQL前に検証し、正常値はtrimする
- booking admin APIのmenu/staff/shift/booking path IDは、更新/削除/所属確認/予約判断SQL前に検証し、正常値はtrimする
- booking admin APIのmenu/staff/staff_menus/shifts/generate/requests payloadと `status` / `from` / `to` queryは、DB書き込みや予約lookup前に検証し、正常値はtrimする
- booking LIFF staff選択の `menus/:id/staff` path IDは、staff lookup SQL前に検証し、正常値はtrimする
- booking LIFF availabilityの `liffId` / `menu_id` / `staff_id` / `from` / `to` queryは、LINE account lookupやavailability helper呼び出し前に検証し、正常値はtrimする
- booking LIFF予約作成の `Idempotency-Key` と `menu_id` / `staff_id` / `starts_at` / `customer_note` payloadは、LINE verify、idempotency lookup、menu lookup前に検証し、正常値はtrimする
- conversation一覧/詳細の `lineAccountId` / `minHoursSince` / `maxHoursSince` / `before` / `friendId` query/pathは、friend可視範囲checkやSQL bind前に検証し、`limit` / `offset` は安全な範囲へ丸める
- conversation一覧/詳細の失敗ログとエラー応答は、会話本文、検索/絞り込み値、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- Stripe eventsの `friendId` / `eventType` queryは、DB helper呼び出し前に検証し、正常値はtrimする
- affiliate reportの `id` / `startDate` / `endDate` path/queryは、DB helper呼び出し前に検証し、正常値はtrimする
- Google Calendar接続削除/予約status更新のpath IDと、接続作成、予約作成、予約status更新payloadは、壊れたJSON、不正な `calendarId/authType/token/connectionId/friendId/title/startAt/endAt/metadata/status` をDB helper、DB書き込み、friend可視範囲check、Google Calendar API呼び出し前に400で止める
- Google Calendar接続/空き枠/予約/予約status APIの失敗ログ、FreeBusy/createEvent/deleteEventの非致命warning、エラー応答は、connection ID、booking ID、friend ID、calendar ID、event ID、access/refresh/API token、予約タイトル、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- automations logs、notifications、Stripe events、ad conversion logs、admin diagnosticsの `limit` / `offset` / `days` queryも既定値、上限、整数へ正規化し、Worker routes/services内の生の `Number(c.req.query(...))` / `parseInt(c.req.query(...))` を残さない
- admin diagnostics/repair APIの `accountId` query、broadcast/friend path ID、tag/content診断payloadは、DB lookup、LINE profile refresh、repair SQL前に検証し、正常値はtrimする
- staffは自分が作成、担当、エスカレ先になっている案件だけを扱う
- support案件/エスカレーション/manual APIのquery/path ID/JSON payloadは、壊れたJSON、不正なlineAccountId/caseId/escalationId/manualId/friendId/manualIds/active、巨大な案件本文/内部メモ/返信案/イベントmetadata/エスカレーション質問・回答/manual本文をDB lookup/write、SQL bind、friend可視範囲check、support event作成前または更新前に400で止め、正常IDと文字列はtrimして参照・更新する
- support案件/エスカレーション/manual APIの失敗ログは、案件本文、manual本文、内部メモ、token-like text、raw例外本文をconsoleへ出さず、例外種別だけにする
- users-grouped顧客統合一覧の `q/account/page/pageSize/onlyDups/refresh` queryは、顧客統合集計とstaff可視範囲付きDB read前に検証し、正常値はtrim/上限丸めしてserviceへ渡す
- users-grouped顧客統合一覧の失敗ログは、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文をconsoleへ出さず、例外種別だけにする
- staffに見えているサポート案件へ紐づく友だちだけ、チャット一覧とチャット詳細で表示
- staffが `/api/friends`、未対応インボックス一覧/件数、users-grouped顧客統合、legacy users顧客ID API、account-settingsテスト送信先、conversion履歴/集計、calendar予約、direct message履歴、chat一覧/詳細/作成/更新/送信、conversation一覧/詳細、scenario手動登録、score、reminder、rich-menu APIを使っても、自分に見えるサポート案件へ紐づく友だちだけに制限
- 未対応インボックス一覧/件数の失敗ログは、検索語、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文をconsoleへ出さず、例外種別だけにする
- scenario、reminder、scoring rule、template、message templateの定義参照/作成/更新/削除とtag定義の作成/削除はowner/adminだけに制限し、staffは見えている友だちへの手動登録やscore/reminder操作だけを可視範囲内で使える
- staff管理APIのcreate/update/detail/delete/regenerate-key payload/path IDは、壊れたJSON、不正なstaff ID/name/email/role/isActiveをDB helperや最後のowner保護check前に400で止め、正常値はtrim/null正規化する
- staff一覧/作成/更新/APIキー再生成失敗ログとエラー応答は、staff ID、staff email、APIキー、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- legacy users顧客ID APIのcreate/update/link/match payloadとuser/friend path IDは、壊れたJSON、不正なemail/phone/externalId/displayName/friendId/userIdをDB helperやfriend可視範囲check前に400で止め、正常値はtrim/null正規化する
- legacy users顧客ID APIの一覧/詳細/作成/更新/削除/link/accounts/match失敗ログとエラー応答は、user ID、friend ID、email、phone、external ID、displayName、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- account-settingsテスト送信先APIのaccountId query/payloadとfriendIds payloadは、壊れたJSON、不正なID、過大なfriendIdsをDB read/write前に400で止め、正常値はtrim/dedupeして保存・参照する
- dedup-preview APIのaccountIds/dedupPriority/targetTagId payloadは、壊れたJSON、空accountIds、不正ID、不正targetTagIdを配信対象計算前に400で止め、正常値はtrim/dedupeし、dedupPriorityはaccountIds内へfilterする
- broadcast管理APIのlineAccountId query、broadcast path ID、create/update payload、send-segment/segment count条件payloadは、壊れたJSON、不正なmessageType/targetType/Flex/image JSON/HTTPS画像URL/segment条件/IDをDB helper、SQL bind、LINE送信、対象計算前に400で止め、正常値はtrim/dedupeして保存・参照する
- multi-account broadcastの失敗/skipログは、LINE account ID、channel token、LINE user ID、raw例外本文をconsoleへ出さず、失敗account IDは戻り値/DB状態だけに残す
- friends APIのlineAccountId/tagId/search/metadata query、friend/tag path ID、metadata更新payload、direct message payloadは、friend可視範囲check、DB helper、SQL bind、LINE送信前に400で止め、正常値はtrimする
- friends一覧/件数/ref stats/詳細/tag/metadata/message APIの失敗ログとdirect message失敗応答は、検索語、metadata、message本文、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- reminder/scoring rule定義payloadとfriend score/reminder操作payloadは、壊れたJSON、不正なID、空/過大なname/description/reason/messageContent、不正なmessageType/Flex/image JSON、不正date、不正score/offsetをDB helperやfriend reminder SQL前に400で止め、正常値はtrimする
- scoring rule/reminder定義APIとfriend score/reminder操作APIの失敗ログは、rule/reminder名、reason、messageContent、targetDate、friend ID、LINE user ID、reminder ID、token-like text、raw例外本文を出さず、例外種別だけにする
- scenario定義/step/reorderのquery/path ID/payloadは、壊れたJSON、不正なlineAccountId/scenarioId/stepId/friendId/startAt/name/triggerType/deliveryMode/isActive/stepOrder/messageType/messageContent/condition/reorderをDB lookup/write、stats計算、friend可視範囲check前に400で止め、正常値はtrimして保存・参照する。step更新/削除/reorderはpath上のscenarioに属するstepだけを対象にする
- tag/template/message-template定義path ID/payloadは、壊れたJSON、不正なtagId/templateId/messageTemplateId/name/color/category/messageType/messageContent、壊れたFlex/image JSON、空updateをDB helper、D1 prepare、DB書き込み前に400で止め、正常値はtrimして保存する
- template一覧の `category` queryは、DB helper呼び出し前に長さ検証し、正常値はtrimする
- automation、auto-reply、notification ruleの管理参照/変更APIとtraffic pool/operatorの管理一覧・変更APIはowner/adminだけに制限し、staffが運用ルールや流入先、担当者マスタを直接参照/変更できないようにした。automation管理payload/query/path IDは壊れたJSON、不正なeventType/action type/isActive/priority、空updateをDB helper/SQL bind前に400で止め、正常値はtrimし、action typeとlineAccountIdを正規化する。auto-reply管理payload/query/path IDは壊れたJSON、不正なkeyword/matchType/responseType/ID/isActive、空本文/空updateをDB helper前に400で止め、正常値はtrim/null正規化する。notification rule管理payload/query/path IDは壊れたJSON、不正なeventType/channels/status/isActive、空updateをDB helper/SQL bind前に400で止め、正常値はtrim/dedupeする。traffic pool管理path ID/payloadは壊れたJSON、不正なpoolId/poolAccountId/slug/name/activeAccountId/lineAccountId/isActiveをDB helper/write前に400で止める。operator管理path ID/payloadは壊れたJSON、不正なoperatorId/name/email/role/isActive、空updateをDB helper前に400で止め、正常値はtrimする
- scenario/tag/template/message-template/automation/auto-reply/notification rule APIの失敗ログは、scenario/template/tag/rule名、messageContent、auto-reply本文、automation actions/conditions、notification channels/conditions、friend ID、LINE user ID、token-like text、raw例外本文を出さず、例外種別だけにする
- traffic pool管理APIの失敗ログとエラー応答は、pool ID、pool account ID、LINE account ID、slug、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- booking admin APIとevent admin APIはowner/adminだけに制限し、staffが予約メニュー、予約スタッフ、シフト、予約申請、イベント、イベント枠、イベント予約判断へ直接アクセスできないようにした
- rich menu catalogとrich menu group管理APIはowner/adminだけに制限し、staffのrich menu操作は見えている友だち単位の付け外し/参照に限定した。rich menu catalog APIのaccountId/richMenuId/create payload/画像payload/friend path ID/friend link payloadと、rich menu group管理APIのaccountId/richMenuId/groupId/pageId/tagId、apply-to-tag payload、画像R2 keyはDB helper、SQL bind、LINE API、R2 get/put前に検証し、正常なID/name/chatBarText/actionTypeはtrimする。rich menu editor画像とLINE外部画像proxyはcookie認証対象にし、未認証GETでは返さない
- rich menu catalog/friend操作APIの失敗ログとエラー応答は、channel token、LINE account ID、friend ID、LINE user ID、richMenu ID、token-like text、raw LINE/API例外本文を出さず、例外種別と固定エラーだけにする
- rich menu publish/unpublishの非致命LINE API失敗ログ/warningsは、channel token、richMenu ID、raw例外本文を出さず、例外種別だけにする
- entry route管理、conversion point定義参照/作成/削除、Google Calendar接続管理、account health/migration APIはowner/adminだけに制限し、staffは友だち単位で許可されたcalendar booking/conversion記録だけを使える
- entry route管理path ID/payloadは、不正なentryRouteId、壊れたJSON、不正なrefCode/name/redirectUrl/関連ID/runAccountFriendAddScenarios/isActiveをDB helper/書き込み前に400で止め、正常path/payloadはtrim/null正規化して使う
- entry route管理APIの失敗ログとエラー応答は、entry route ID、tag ID、scenario ID、pool ID、template ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- account health/migration APIのaccount/migration path IDとmigration作成payloadは、壊れたJSON、不正なfromAccountId/toAccountId/migrationIdをDB helperやD1 count前に400で止め、正常値はtrimする
- account health/migration APIの失敗ログとエラー応答は、account ID、migration ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- conversion point削除path IDと作成payloadは、不正なconversionPointId、壊れたJSON、不正なname/eventType/valueをDB helper/書き込み前に400で止め、正常path/payloadはtrim/value null正規化して使う
- conversion記録payloadは、壊れたJSON、不正なconversionPointId/friendId/userId/affiliateCode/metadataをfriend可視範囲checkやDB書き込み前に400で止め、正常payloadはtrim/null正規化/metadata文字列化して保存する
- conversion point管理、conversion記録、conversionイベント一覧/report APIの失敗ログとエラー応答は、conversion point ID、friend ID、user ID、affiliate code、metadata、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- LINEアカウント管理API（詳細、登録、metadata更新、credential更新、削除、表示順更新）は壊れたJSON、不正なpath ID/channelId/name/credential/Login/LIFF/isActive/displayOrderをDB lookup、DB書き込み、重複lookup前に400で止め、Login Channel ID/Secretの片側だけ保存される状態を防ぐ
- LINEアカウント管理APIの登録、main pool自動登録、metadata更新、credential更新失敗ログとエラー応答は、LINE account ID、channel ID、channel token/secret、Login Channel ID/Secret、LIFF ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- 重複統計、friends ref集計、流入ref分析、LIFFリンクwrap、画像削除APIはowner/adminだけに制限し、staffのチャット画像アップロードと公開画像表示は維持
- 重複統計APIの失敗ログとエラー応答は、LINE account ID、friend ID、LINE user ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- 画像upload/公開表示/削除APIは、壊れたJSON、不正なbase64/mimeType/filename、空/過大な画像、不正なR2 keyをR2 put/get/delete前に止め、正常key/filenameはtrimする
- 画像upload/削除APIの失敗ログとエラー応答は、filename、R2 key、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- broadcast管理API（一覧、詳細、作成、更新、削除、preview-count、dedup-preview、本送信、segment送信、test-send、insight取得、progress、segment count）はowner/adminだけに制限し、管理payload/query/path IDは副作用前に検証する
- admin診断/repair API（プロフィール再取得、broadcast reset、タグ/配信漏れチェック、recent messages、friend debugなど `/api/admin/*`）はowner/adminだけに制限
- Webhook管理API（incoming/outgoingの一覧、作成、更新、削除）はowner/adminだけに制限し、更新/削除/receive path IDと作成/更新payloadの壊れたJSON、不正なname/sourceType/url/eventTypes/secret/isActiveをDB lookup/write前に400で止め、外部システムからのincoming receive公開エンドポイントは署名検証付きで維持
- Webhook管理/公開incoming receive APIの失敗ログとエラー応答は、webhook ID、sourceType、URL、eventTypes、secret、signature、payload本文、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- Meet Harness完了callback `/api/meet-callback` は `MEET_CALLBACK_SECRET` と `X-Meet-Callback-Signature` のHMAC-SHA256署名検証を必須にし、未設定/未署名/不正署名ではDB lookupやLINE push前に止める
- Stripe webhook `/api/integrations/stripe/webhook` は署名検証を維持しつつ、1MiB超body、壊れたJSON、必須ID/type/object欠落、巨大metadataをDB記録や自動化副作用前に400/413で止める
- 公開QR proxy `/api/qr` はQR化する `data` をHTTP(S) URLかつ2048文字以内、`size` を120-512pxの正方形だけに制限し、外部QR rendererの非画像レスポンスを中継しない
- 公開short-link `/r/:ref` と `/r/:ref/help` は `ref/form/pool/gate/xh/ig/t` をDB lookupやLIFF URL/HTML生成前に検証し、正常値はtrimしたうえでLIFF URLやhelp fallbackに使う
- 公開pool入口 `/pool/:slug` は `slug/ref/form/gate/xh/ig` をDB lookupやLIFF auth redirect前に検証し、正常値だけtrimして `/auth/line` へ渡し、`account` や未知queryは転送しない
- フォーム管理API（一覧、作成、更新、削除、回答一覧）はowner/adminだけに制限し、LIFF用のフォーム定義GET、opened、partial、submit公開エンドポイントは維持
- `/api/forms/:id` の公開認証skipはGET/HEADだけに限定し、同じパスのPUT/DELETEが未認証で通らないようにした
- フォーム定義GET、opened、partial、submit、管理更新/削除/回答一覧のpath `formId` は、DB lookup/write、D1 prepare、LINE ID token検証、Webhook、submission保存、reward side effect前に検証し、正常値はtrimする
- 公開フォームsubmitのWebhook gateは、LIFFクライアントの事前確認や `_skipWebhook` 自己申告を信じず、Worker側で毎回再判定する
- 公開フォームのopened、partial、submitで友だちへ紐付ける処理は、caller supplied `lineUserId` / `friendId` ではなくLINE ID token検証済みのLINE user IDだけを使う
- 公開フォームpartial/submitは壊れたJSON、オブジェクト以外の `data`、100項目超または16KB超の `data` をID token検証、Webhook、DB保存前に400で止める
- `/api/liff/profile` はcaller supplied `lineUserId` で友だち情報を返さず、body `idToken` も型/長さをLINE verify前に検証し、LINE ID token検証済みのLINE user IDだけでプロフィールを解決する
- `/api/liff/send-form-link` はフォームURL push前にLINE ID tokenのsubjectとcaller supplied `lineUserId` の一致を必須にする
- `/api/liff/link` と `/api/liff/send-form-link` は壊れたJSON、巨大なID token/ref/gate/xh/IGSID/displayName/lineUserId/formIdをLINE verify、DB lookup、LINE push前に400で止める
- tracked-link公開リダイレクト `/t/:linkId` は空白/非ASCII/128文字超の `linkId` をDB lookupやclick記録前に404で止め、caller supplied `f` / `lu` を友だち本人として扱わず、LINEアプリ内では `ref` 付きLIFFへ回し、`/api/liff/link` のLINE ID token検証後にだけ友だち付きクリック、tag、scenario attributionを行う
- event booking LIFF予約作成 `/api/liff/events/:id/bookings` は `Idempotency-Key` を128文字以内の可視ASCIIに制限し、不正/巨大keyはLINE verifyやidempotency予約前に400で止める
- event admin/LIFF event APIの `account_id/liffId/eventId/slotId/bookingId/status/slot_id` query/pathは、DB lookup、LIFF認証、availability helper、booking判断/更新前に検証し、正常値はtrimして参照する
- 公開フォーム送信クライアントとフォームsubmit routeは、回答データ、送信先、レスポンスステータス、friend ID、LINE user IDをconsoleへ出さない
- 公開LIFF/booking/formクライアントの失敗画面は、APIレスポンス本文やraw例外本文を表示せず、固定の利用者向けエラーだけを出す。Webhook gateの管理者設定メッセージだけは公開用文言として維持する
- フォーム管理、公開opened/partial/submit、Webhook失敗通知、submit後side-effectの失敗ログとエラー応答は、form ID、回答データ、friend ID、LINE user ID、idToken、tag/scenario ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- Webhook follow、LIFF/X Harness連携、booking LIFF認証は、LINE user ID、friend ID、表示名、Xユーザー名、channel候補、verify失敗bodyをconsoleへ出さない
- LIFF OAuth token交換、LINE token refresh、IG Harness notify、X Harness action失敗ログは、外部レスポンス本文、LINE friend UUID、LINE account名/ID/access token、tag名、例外本文をconsoleへ出さず、HTTP statusや例外種別だけにする
- event bookingの予約処理/通知失敗ログは、LINE user ID、channel token、外部例外本文をconsoleへ出さず、例外種別だけにする
- LINE incoming画像の取得/保存失敗ログは、channel token、LINE message ID、LINE account ID、raw例外本文をconsoleへ出さず、HTTP statusや例外種別だけにする
- Webhookプロフィール取得、profile refresh、broadcast test-sendの失敗ログは、LINE user IDやfriend IDを含めない
- 売上・広告・計測運用API（Stripe events、ad-platforms、affiliates管理/レポート、tracked-links管理）はowner/adminだけに制限し、公開Webhook/クリック/リダイレクトは維持
- ad-platforms/affiliates/tracked-links管理APIのpath IDと作成/更新/test payloadは、壊れたJSON、不正なadPlatformId/affiliateId/trackedLinkId、許可以外の広告platform名、巨大/ネストした広告config、空/長すぎる名前、URL-safeではないaffiliate code、不正なcommissionRate、HTTP(S)以外または2048文字超のoriginalUrl、不正な関連ID、不正なisActiveをDB lookup/writeや外部CV送信前に400で止める
- 公開affiliate click `/api/affiliates/click` は壊れたJSON、空/128文字超またはURL-safeではない `code`、HTTP(S)以外または2048文字超の `url` をDB lookupやクリック保存前に400で止める
- Stripe events/webhook、ad-platforms、affiliates/click、tracked-links管理、tracked-link公開redirect非同期記録の失敗ログとエラー応答は、Stripe event/friend ID、広告config/token、affiliate code、クリックURL、IP、tracked link ID、tag/scenario ID、token-like text、raw例外本文を出さず、例外種別と固定エラーだけにする
- 完了済み案件からの顧客返信をLINE送信前に拒否
- チャット送信APIで `text`、`flex`、`image` 以外のmessageTypeや壊れた画像/Flex payloadをLINE送信前、DB記録前に拒否
- チャットloading/send/send-validate失敗ログとエラー応答は、LINE APIレスポンス本文、channel token、LINE user ID、friend ID、raw例外本文を出さず、HTTP statusや例外種別だけにする
- チャット一覧/詳細/作成/更新とoperator管理の失敗ログは、friend ID、LINE user ID、LINE account ID、operator payload、token-like text、raw例外本文をconsoleへ出さず、例外種別だけにする
- チャット送信後に案件ステータスを「顧客返信待ち」へ更新し、案件履歴に顧客返信イベントを残す
- 画像だけの返信でも、サポート案件への履歴連携を行う
- `lineAccountId` を持たないURL fallback経由でも、友だちのLINEアカウントから案件履歴を残す
- 完了済み案件への `/send` と `/send/validate` はLINE送信、チャット記録、案件履歴記録の前に400で止める
- staff名の空欄保存を防ぎ、staff名がないAPIキーをPreflightと画面で検知できるようにした
- credentialed CORSをまとめ、ブラウザログインで必要な `Access-Control-Allow-Credentials` を確認できるようにした
- admin update履歴の成功行は、rollback期限内かつsnapshot情報が揃っている場合だけ、画面から手動rollbackを開始できる。rollback操作は別のupdate_history行として記録し、完了後に元の更新行を `rolled_back` にする

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
- アップデート履歴画面のRollbackボタンは未実装alertではなく、`/admin/update/rollback/:id` を呼び、既存の進捗モーダルでrollback進行を確認できる

### Scripts

- `corepack pnpm preflight:support-crm` を追加
- owner/admin/staff APIキーのログイン権限、CORS、サポート要約、案件一覧、マニュアル検索、チャット一覧を検査
- staffによる案件作成、担当変更、エスカレ担当指定、マニュアル作成/更新/無効化が拒否されることを検査
- optional fixtureでstaff可視範囲、friend direct履歴/score/reminder APIの可視範囲、未完了案件の再オープン禁止、完了済み案件からの返信禁止、未対応チャットmessageTypeの送信前拒否、LINE画像payloadのHTTPS検証を検査
- `corepack pnpm preflight:support-crm:dry-run` で本番切替前の環境変数不足を実通信なし・APIキー伏せ字で確認
- `corepack pnpm preflight:support-crm:summary` でPreflight生ログを、URL、APIキー、友だちID、案件IDを含めないPR用summaryへ変換し、`--file` とパイプ入力の両方に対応
- dry-runのstrict必須envと本番投入前チェックリストがズレたらscript testで検知
- `corepack pnpm support-crm:release-readiness` でPR-safe summaryを含むPR証跡、PR本文の最新commit SHA、PR merge state、最新commitのCI run head、Actions承認URL、draft解除前の内部FAIL、外部WAIT、PASSを整理
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
- `apps/worker/src/routes/scenarios.test.ts`
- `apps/worker/src/routes/content-management-access.test.ts`
- `apps/worker/src/routes/management-role-guards.test.ts`
- `apps/worker/src/routes/users.test.ts`
- `apps/worker/src/routes/account-settings.test.ts`
- `apps/worker/src/routes/admin-diagnostics-access.test.ts`
- `apps/worker/src/routes/broadcasts-access.test.ts`
- `apps/worker/src/routes/forms-access.test.ts`
- `apps/worker/src/routes/booking-liff-access.test.ts`
- `apps/worker/src/routes/operations-access.test.ts`
- `apps/worker/src/routes/meet-callback.test.ts`
- `apps/worker/src/qr-proxy.test.ts`
- `apps/worker/src/routes/duplicates-access.test.ts`
- `apps/worker/src/routes/images-access.test.ts`
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
corepack pnpm --filter worker test -- src/routes/friends.test.ts # 10 tests
corepack pnpm --filter worker test -- src/routes/conversions-calendar-access.test.ts # 39 tests
corepack pnpm --filter worker test -- src/routes/automations.test.ts src/routes/operations-access.test.ts src/routes/admin-diagnostics-access.test.ts src/routes/notifications.test.ts
corepack pnpm --filter worker test -- src/routes/operations-access.test.ts # 30 tests
corepack pnpm --filter worker test -- src/services/unanswered-inbox.test.ts src/routes/inbox.test.ts
corepack pnpm --filter worker test -- src/routes/webhook.test.ts src/routes/webhooks.test.ts src/routes/events.test.ts # webhooks 33 tests
corepack pnpm --filter worker test -- src/routes/webhooks.test.ts # 36 tests
corepack pnpm --filter worker test -- src/routes/liff-access.test.ts src/routes/forms-access.test.ts src/middleware/auth.test.ts
corepack pnpm --filter worker test -- src/routes/operations-access.test.ts src/routes/liff-access.test.ts
corepack pnpm --filter worker test -- src/routes/booking-liff-access.test.ts # 18 tests
corepack pnpm --filter worker test -- src/routes/forms-access.test.ts # 14 tests
corepack pnpm --filter worker test -- src/routes/support-friend-access-routes.test.ts # 21 tests
corepack pnpm --filter worker test -- src/routes/scenarios.test.ts # 18 tests
corepack pnpm --filter worker test -- src/routes/content-management-access.test.ts # 19 tests
corepack pnpm --filter worker test -- src/routes/management-role-guards.test.ts # 35 tests
corepack pnpm --filter worker test -- src/routes/line-accounts.test.ts # 28 tests
corepack pnpm --filter worker test -- src/routes/staff.test.ts # 12 tests
corepack pnpm --filter worker test -- src/routes/users.test.ts # 14 tests
corepack pnpm --filter worker test -- src/routes/duplicates-access.test.ts # 3 tests
corepack pnpm --filter worker test -- src/routes/account-settings.test.ts # 7 tests
corepack pnpm --filter worker test -- src/routes/images-access.test.ts # 8 tests
corepack pnpm --filter worker test -- src/routes/broadcasts-access.test.ts # 6 tests
corepack pnpm --filter worker test -- src/routes/management-role-guards.test.ts # 35 tests
corepack pnpm --filter worker test -- src/routes/notifications.test.ts # 4 tests
corepack pnpm --filter worker test -- src/routes/automations.test.ts # 6 tests
corepack pnpm --filter worker test -- src/routes/rich-menu-groups.test.ts # 28 tests
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
- strict dry-runを `corepack pnpm preflight:support-crm:dry-run | corepack pnpm preflight:support-crm:summary` で直接PR-safe summaryへ渡し、`15 passed, 0 skipped, 0 failed` として要約できることを確認

strict Preflight:

- ローカルfixture flow: seed local D1、strict Preflight、cleanup local D1まで実行し、`19 passed, 0 skipped, 0 failed`
- リモートfixture flow: remote test D1へsynthetic fixtureをseedし、デプロイ済みPR Workerに対してstrict Preflightを実行し、cleanup後のsynthetic行数が0であることを確認
- リモートtest Worker deploy: `3f920e16-3789-430d-8e5e-e2316e266ecf`
- リモートstrict Preflight結果: friend score/reminder API guard追加後に `32 passed, 0 skipped, 0 failed`
- リモートcleanup確認: synthetic fixtureのLINEアカウント、staff、案件、イベント、メッセージ、友だち、チャットがすべて0。一時owner行も `residual_count: 0`
- Remote browser cookie login/session check: Pages originとデプロイ済みWorkerでstaff sessionを確認済み
- support-crm-preflight tests cover HTTPS image payload pass and non-HTTPS image payload rejection through `/send/validate`.
- support route tests confirm support case list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind.
- Support route tests confirm malformed support case/escalation/manual query values, path IDs, JSON payloads, and oversized write payload text/metadata stop before DB access, SQL bind, support event writes, or manual/case/escalation mutations while valid IDs and strings are trimmed before lookup or update.
- Support route tests also confirm support summary/case/manual failure logs keep only exception kind and omit customer summaries, manual body text, friend IDs, token-like text, and raw exception messages from console output and API error responses.
- Users-grouped route tests confirm malformed customer aggregation query values stop before aggregation/service calls while valid `q/account/page/pageSize/onlyDups/refresh` values are trimmed, parsed, and capped.
- friends route tests confirm friend list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind while keeping staff friend visibility scope.
- friends route tests confirm malformed list/count/ref-stats query values, friend/tag path IDs, metadata updates, and direct message payloads stop before friend visibility checks, DB helpers, SQL bind, LINE push, or tag scenario side effects.
- Friends route tests also confirm friend list/direct-message failure logs and direct-message error responses keep only exception kind or fixed internal error and omit search text, message body, LINE account IDs, friend IDs, LINE user IDs, token-like text, and raw exception messages.
- Chat route tests confirm malformed or unsafe chat list filters, chat/friend path IDs, message cursors, create/update payloads, send payload IDs, and loading/send paths stop before DB helpers, SQL bind, friend access checks, LINE loading/send calls, or writes while valid IDs, filters, cursors, and payload fields are trimmed.
- Chat route tests also confirm chat list/create and operator creation failure logs keep only exception kind and omit friend IDs, LINE user IDs, LINE account IDs, operator payload details, token-like text, and raw exception messages from console output and API error responses.
- Inbox route tests also confirm unanswered list/count failure logs keep only exception kind and omit search text, LINE account IDs, friend IDs, LINE user IDs, token-like text, and raw exception messages from console output and API error responses.
- Users-grouped and conversations route tests also confirm aggregation/queue/detail failure logs and responses keep only exception kind or fixed internal error and omit search text, conversation text, LINE account IDs, friend IDs, LINE user IDs, token-like text, and raw exception messages.
- conversion/calendar access tests confirm conversion event list query values fall back from invalid `limit`, floor fractional `offset`, and reset non-finite `offset` before SQL bind while keeping staff friend visibility scope. They also confirm conversion event/report filters reject malformed IDs or date ranges before friend access checks or SQL bind, valid filters are trimmed, conversion tracking rejects malformed or unsafe payloads before friend access checks or DB writes, valid tracking payloads are trimmed/null-normalized/metadata-serialized, calendar slot query values cannot create zero-minute/negative loops, invalid time windows stop before calendar lookup, malformed or nonexistent calendar date filters are rejected, valid calendar slot/booking query values are trimmed, and malformed or unsafe Calendar connection/booking/status path IDs and payloads stop before DB helpers, DB writes, friend access checks, or Google Calendar lookup.
- Calendar route tests also confirm connection list/create, booking create, and Google FreeBusy/createEvent/deleteEvent failures keep only exception kind or fixed internal error and omit connection IDs, booking IDs, friend IDs, calendar IDs, event IDs, access/refresh/API tokens, booking titles, token-like text, and raw exception messages.
- Booking access route tests confirm malformed admin `account_id` values stop before SQL, malformed admin menu/staff/booking path IDs stop before SQL, malformed LIFF staff-selection path IDs stop before staff lookup SQL, malformed `liffId/menu_id/staff_id/from/to` availability queries stop before LINE account lookup or availability helper calls where applicable, malformed `Idempotency-Key` and booking request payloads stop before LINE verification or idempotency lookup, and valid filters/payload IDs are trimmed before use.
- conversations route tests confirm malformed or unsafe conversation queue/detail query values stop before friend access checks or SQL bind, while valid IDs/cursors are trimmed and paging values are clamped.
- Automations, operations, admin diagnostics, and notifications route tests confirm invalid, fractional, oversized, and non-finite `limit` / `offset` / `days` values are normalized before DB helper calls or SQL bind. Admin diagnostics tests also confirm unsafe `accountId`, broadcast/friend path IDs, and malformed/oversized tag/content diagnostic payloads stop before DB or LINE helper calls while valid values are trimmed. Operations route tests also confirm malformed Stripe events `friendId/eventType` and affiliate report `id/startDate/endDate` filters stop before DB helper calls while valid filters are trimmed.
- `rg -n "Number\\(c\\.req\\.query|parseInt\\(c\\.req\\.query|Number\\.parseInt\\(c\\.req\\.query" apps/worker/src/routes apps/worker/src/services` returns no matches.
- `rg -n "Form reply|console\\.log" apps/worker/src/client/form.ts apps/worker/src/routes/forms.ts` returns no matches, and Worker typecheck/build confirm the public form client and submit route still compile.
- Form access route tests confirm public submit ignores `_skipWebhook`, rechecks the webhook gate server-side, does not run reward tag/scenario side effects when the gate rejects, stores redacted webhook fetch errors, and never trusts caller-supplied `lineUserId` / `friendId` for partial metadata writes or submit side effects.
- Form access route tests confirm malformed form path IDs stop before DB lookup/write, D1 prepare, LINE ID token verification, webhook calls, submission writes, or reward side effects. They also confirm public partial/submit reject malformed JSON, non-object `data`, and oversized `data` before LINE ID token verification, webhook calls, submission writes, or reward side effects.
- Form access route tests also confirm form management, public opened, public submit, and submit side-effect failures keep only exception kind or fixed internal error and omit form IDs, answer data, friend IDs, LINE user IDs, idTokens, tag/scenario IDs, token-like text, and raw exception messages.
- LIFF access route tests confirm `/api/liff/profile` rejects caller-supplied `lineUserId` without a valid LINE ID token, rejects malformed or oversized legacy body `idToken` before LINE verification, and resolves the friend only from the verified token subject.
- LIFF access route tests confirm `/api/liff/send-form-link` rejects missing ID tokens and ID tokens whose subject does not match the caller-supplied `lineUserId` before friend lookup or form-link push.
- LIFF access route tests confirm `/api/liff/link` and `/api/liff/send-form-link` reject malformed or oversized public payloads before LINE ID token verification, DB lookup, or LINE push.
- LIFF access route tests confirm public `/api/liff/config` rejects unsafe `liffId` before DB lookup or LINE bot info fetch, and owner/admin ref analytics reject unsafe `lineAccountId/refCode` before DB access while valid filters are trimmed before SQL bind.
- Operations and LIFF access route tests confirm `/t/:linkId` rejects malformed or oversized link IDs before lookup/click recording, ignores caller-supplied `f` / `lu`, routes LINE in-app clicks through LIFF with `ref`, skips duplicate anonymous recording after verified LIFF return, and records tracked-link clicks with a friend only after `/api/liff/link` verifies the LINE ID token.
- Operations route tests confirm public `/api/affiliates/click` rejects malformed JSON, oversized or URL-unsafe affiliate codes, and unsafe or oversized URLs before affiliate lookup or click recording.
- Operations route tests confirm owner/admin ad-platform, affiliate, and tracked-link management path IDs and payloads reject malformed JSON, unsafe route IDs/codes/URLs, invalid rates/IDs/config values, and invalid booleans before DB lookup, DB writes, click-detail lookup, logs lookup, deletion, or test-send lookup, while valid values are trimmed and normalized before persistence.
- Operations route tests also confirm Stripe events, ad-platform create, public affiliate click, tracked-link create, and tracked-link async click-recording failures keep only exception kind or fixed internal error and omit Stripe/friend IDs, ad config/token values, affiliate codes, URLs, IPs, tracked link IDs, tag/scenario IDs, token-like text, and raw exception messages.
- Events route tests confirm LIFF event booking rejects malformed or oversized `Idempotency-Key` before LINE ID token verification or idempotency reservation.
- Events route tests confirm malformed event admin/LIFF `account_id/liffId/eventId/slotId/bookingId/status/slot_id` query and path values stop before DB access, LIFF auth helpers, availability helpers, or booking mutations while valid IDs and filters are trimmed before lookup.
- Line account route tests confirm malformed or unsafe LINE account path IDs and create/update/order payloads stop before DB lookup, DB writes, or duplicate Login/LIFF lookup, while valid values are trimmed before persistence.
- Line account route tests also confirm create, main-pool auto-enroll, metadata update, and credential update failures keep only exception kind or fixed internal error and omit LINE account IDs, channel IDs, channel tokens/secrets, Login Channel IDs/secrets, LIFF IDs, token-like text, and raw exception messages.
- Webhooks route tests confirm staff cannot manage incoming/outgoing webhook settings, malformed or unsafe management path IDs and payloads stop before DB lookup/writes, and the public incoming receive endpoint remains signature-gated.
- Webhooks route tests also confirm incoming/outgoing management and public incoming receive failures keep only exception kind or fixed internal error and omit webhook IDs, sourceType, URLs, eventTypes, secrets, signatures, payload text, token-like text, and raw exception messages.
- Staff route tests confirm staff list, create, update, and regenerate-key failures keep only exception kind or fixed internal error and omit staff IDs, staff emails, API keys, token-like text, and raw exception messages.
- Users route tests confirm list, create, link, and match failures keep only exception kind or fixed internal error and omit user IDs, friend IDs, emails, phones, external IDs, display names, token-like text, and raw exception messages.
- Meet callback route tests confirm the public `/api/meet-callback` fails closed when `MEET_CALLBACK_SECRET` is missing, rejects missing/malformed/invalid HMAC signatures before DB lookup or LINE push, and accepts a valid signed callback.
- Operations route tests confirm public Stripe webhook accepts valid signed bounded payloads, rejects malformed signed JSON before DB writes, and rejects oversized payloads before DB writes.
- QR proxy tests confirm public `/api/qr` rejects missing, non-URL, non-HTTP(S), oversized, malformed-size, rectangular-size, and oversized-size inputs before upstream fetch, and refuses to relay non-image upstream responses.
- QR proxy tests confirm public short links reject unsafe `ref/form/pool/gate/xh/ig/t` values before DB lookup, QR fetch, or HTML rendering, trim valid values before DB lookup and LIFF URL rendering, and strip unsafe help fallback query values.
- Management role guard tests confirm public pool links reject unsafe `slug/ref/form/gate/xh/ig` values before DB lookup or LIFF auth redirect, trim valid values, and forward only validated retry query values.
- Scenario/support-friend/content-management route tests confirm staff cannot read or mutate scenario, reminder, scoring rule, reusable template, or message-template definitions, cannot mutate tag definitions, and friend-scoped staff operations remain guarded by visible support-case friends. Support-friend access route tests also confirm scoring rule/friend score/friend reminder failure logs keep only exception kind and omit rule/reminder names, reasons, target dates, friend IDs, LINE user IDs, reminder IDs, token-like text, and raw exception messages. Scenario route tests also confirm malformed or unsafe scenario list query values, scenario/step/enroll path IDs, preview startAt cursors, and scenario/step/reorder payloads stop before DB lookup, stats computation, friend visibility checks, batch updates, or writes, valid values are trimmed, and step update/delete/reorder mutations stay scoped to the path scenario. Scenario route tests also confirm scenario create/enroll failure logs keep only exception kind and omit scenario names, message bodies, friend IDs, LINE user IDs, token-like text, and raw exception messages. Content management tests also confirm malformed or unsafe tag/template/message-template path IDs and tag/template/message-template payloads stop before DB helpers, D1 prepare, DB writes, or lookup, oversized template category query filters stop before DB helper calls, and valid values are trimmed. Content management tests also confirm tag/template/message-template failure logs keep only exception kind and omit names, message bodies, IDs, token-like text, and raw exception messages.
- Management role guard tests confirm staff cannot read or mutate automation, auto-reply, notification rule, traffic pool, pool-account, or operator management APIs, and malformed traffic pool/operator management path IDs and payloads stop before DB helpers or writes. Management role guard tests also confirm automation/auto-reply/notification rule failure logs keep only exception kind and omit names, keyword/response bodies, actions, channels, token-like text, and raw exception messages. Management role guard tests also confirm traffic pool failures keep only exception kind or fixed internal error and omit pool IDs, pool-account IDs, LINE account IDs, slugs, token-like text, and raw exception messages.
- Management role guard and events route tests confirm staff cannot access booking/event admin routes while owner/admin event management behavior remains covered.
- Rich-menu group, support-friend access, and auth middleware tests confirm staff cannot manage LINE rich menu catalogs or rich menu groups while visible-friend rich menu operations still work, and rich menu editor/external image GETs require cookie/Bearer auth instead of relying on a public auth skip. Support-friend access route tests also confirm malformed rich menu catalog account/rich-menu IDs, create payloads, image payloads, friend path IDs, and friend link payloads stop before DB lookup, friend visibility checks, LINE fetch, LINE link, or image upload. They also confirm rich menu catalog/friend operation failures keep only exception kind or fixed internal error and omit channel tokens, LINE account IDs, friend IDs, LINE user IDs, richMenu IDs, token-like text, and raw LINE/API error messages. Rich-menu group tests also confirm malformed account/rich-menu/group/page/tag path or query values, malformed apply-to-tag bodies, invalid force values, and unsafe image R2 keys stop before DB helpers, SQL bind, LINE fetch, or R2 get/put while valid IDs and labels are normalized. Rich-menu group publish/unpublish/set-default/bulk-link failure responses now keep only fixed error codes plus exception kind or LINE HTTP status, omitting channel tokens, richMenu IDs, LINE user IDs, token-like text, and raw LINE/API/DB error messages.
- Rich-menu publisher tests confirm publish/unpublish default lookup/clear failure logs and warnings keep only exception kind and omit channel-token-like text, richMenu IDs, and raw LINE error messages.
- Admin update route tests confirm setup, rollback setup, and SSE stream failures keep only fixed errors plus exception kind, without Cloudflare project names, update IDs, token-like text, or raw exception messages. They also confirm manual rollback only starts from valid successful snapshot rows and records a linked rollback history row.
- Management role guard and conversion/calendar access route tests confirm staff cannot manage entry routes, read/mutate conversion points, manage Google Calendar connections, or access account health/migrations while friend-scoped conversion/calendar booking operations still work. Management role guard tests also confirm malformed or unsafe entry route management path IDs and payloads stop before DB helpers/writes, malformed or unsafe account health/migration path IDs and migrate payloads stop before DB helpers or D1 count, and malformed or unsafe conversion point delete path IDs and creation payloads stop before DB helpers/writes, while valid values are trimmed/null-normalized. Conversion/calendar access route tests also confirm conversion point/list/create/delete, conversion track, conversion events, and conversion report failures keep only exception kind or fixed internal error and omit conversion point IDs, friend IDs, user IDs, affiliate codes, metadata, token-like text, and raw exception messages. Management role guard tests also confirm entry route failures keep only exception kind or fixed internal error and omit entry route IDs, related IDs, token-like text, and raw exception messages. Management role guard tests also confirm account health/migration failures keep only exception kind or fixed internal error and omit account IDs, migration IDs, token-like text, and raw exception messages.
- Friends, duplicates, LIFF access, and image access route tests confirm staff cannot read friends ref stats or duplicate/ref analytics, cannot wrap management links, cannot delete arbitrary stored images, can still upload chat/reply images, and malformed image upload payloads or unsafe public/delete keys stop before R2 put/get/delete. Duplicates route tests also confirm stats failure logs and responses keep only exception kind or fixed internal error and omit LINE account IDs, friend IDs, LINE user IDs, token-like text, and raw exception messages.
- Webhook/events/broadcast/admin-diagnostics route tests, Worker typecheck, and Worker build confirm removing or anonymizing identifier logs from webhook, LIFF, booking, profile refresh, and broadcast test-send routes does not change behavior. Admin diagnostics tests also confirm profile refresh failure logs keep only LINE HTTP status or exception kind, without channel tokens, LINE response bodies, token-like text, or raw exception messages.
- LIFF route logging now keeps external integration failures observable without printing LINE friend UUIDs, external response bodies, X Harness tag values, or raw exception messages. Token refresh service tests also confirm LINE token API failure logs keep only the HTTP status, and success logs omit account names, account IDs, and access tokens. Webhook/webhooks/events route tests, Worker typecheck, and Worker build confirm the OAuth/LIFF-adjacent routes still compile and pass.
- Event booking route tests confirm booking-flow and notification failure logs keep only the exception kind and omit LINE user IDs, channel tokens, and raw external error messages.
- Incoming image service tests confirm LINE image fetch/R2 store failure logs keep only HTTP status or exception kind and omit channel tokens, LINE message IDs, LINE account IDs, and raw exception messages.
- Dedup broadcast service tests confirm multi-account broadcast failure/skip console logs omit LINE account IDs, channel tokens, LINE user IDs, and raw multicast exception messages while preserving failedAccountIds in return values and DB state.
- Broadcast access tests confirm manual and scheduled per-account insight fetch failures keep only exception kind or LINE HTTP status in logs and stored insight raw responses, omitting account IDs from logs, channel tokens, LINE user IDs, token-like text, and raw LINE/API exception messages.
- Step delivery and event bus tests confirm scenario condition/action failure logs and automation action failure results keep only exception kind or LINE HTTP status, omitting friend IDs, tag IDs, webhook IDs, token-like text, and raw exception messages.
- Booking reminder, event booking reminder, and ad conversion tests confirm retry `last_error` / conversion `errorMessage` persistence keeps only exception kind or provider HTTP status, omitting channel tokens, LINE user IDs, friend IDs, click IDs, token-like text, and raw external response bodies.
- Broadcast, reminder delivery, and health monitor tests confirm multicast/reminder/health failure logs keep only exception kind or LINE HTTP status, omitting broadcast IDs, friend IDs, LINE user IDs, account IDs, token-like text, and raw external response bodies. Segment send and scheduled cron failure logs follow the same bounded error-kind pattern.
- Webhook, LIFF, and booking route tests plus raw log searches confirm webhook event/profile/scenario/auto-reply, LIFF auth/link/analytics/form-link, and booking notification failure logs keep only exception kind or LINE HTTP status, omitting scenario step IDs, scenario IDs, friend IDs, LINE user IDs, account IDs, token-like text, and raw exception messages.
- Chat route tests confirm loading/send/send-validate failure logs and error responses omit LINE API response bodies, channel tokens, LINE user IDs, friend IDs, and raw exception messages while keeping HTTP status or exception kind observable.

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
- support-meta/clipboard/staff-form testsで、マニュアル保存前検証、コピーfallback、スタッフ作成payload検証、スタッフ管理の固定エラー文、未知のsupport API rawエラーをfallbackに落とすことを確認
- raw chat/staff UI error searchesで、チャット一覧/詳細/過去読み込み/送信/ローディング/ステータス/メモ保存、友だち詳細サイドバー、スタッフ管理がAPI応答文字列やraw exceptionを直接表示しないことを確認
- コンソールエラーは0件

## 3. 運用ドキュメント

- [サポートCRM運用マニュアル](./ec-owner-support-crm.md)
- [本番投入前チェックリスト](./ec-owner-support-crm-release-checklist.md)

運用マニュアルでは、日次対応、案件化基準、チャット返信、エスカレーション、マニュアル検索、完了条件、staff権限の制限を説明しています。

本番投入前チェックリストでは、fixture候補抽出、synthetic fixture seed/cleanup、Preflightの通常実行とstrict実行、画面確認、PR用変更要約、rollback条件、切替NG条件をまとめています。

## 4. レビューで特に見る場所

- `apps/worker/src/services/support-access.ts`: staff可視範囲のSQL条件
- `apps/worker/src/routes/support.ts`: role別更新制限、完了/再オープン、エスカレーション制限、support case/escalation/manual query/path/JSON検証
- `apps/worker/src/routes/chats.ts`: staffチャット可視範囲、chat query/path/payload検証、送信前検証、顧客返信イベント
- `apps/worker/src/routes/inbox.ts` / `services/unanswered-inbox.ts`: staffの未対応インボックス一覧、件数、未対応friend ID集合の可視範囲、unanswered inbox query検証
- `apps/worker/src/routes/users-grouped.ts` / `services/users-grouped.ts`: staffの顧客統合一覧、フォーム由来メール/電話、複数アカウント情報の可視範囲、users-grouped query検証
- `apps/worker/src/routes/users.ts`: staffのlegacy users顧客ID一覧、詳細、メール/電話検索、リンク済み友だち、friendリンクの可視範囲
- `apps/worker/src/routes/account-settings.ts`: staffのテスト送信先取得のfriend可視範囲と、テスト送信先更新のowner/admin制限
- `apps/worker/src/routes/automations.ts` / `auto-replies.ts` / `notifications.ts` / `traffic-pools.ts` / `chats.ts`: automation、auto-reply、notification ruleの管理参照/変更APIとtraffic pool/operator管理一覧・変更APIのowner/admin制限、公開pool入口入力制限、automation/auto-reply/notification rule/traffic pool/operator path/payload検証
- `apps/worker/src/routes/booking.ts` / `events.ts`: booking/event admin routeのowner/admin制限、event admin/LIFF event query/path検証、LIFF公開導線の維持
- `apps/worker/src/routes/rich-menus.ts` / `rich-menu-groups.ts`: LINE rich menu catalog/group管理APIのowner/admin制限、rich menu catalog query/path/payload/image検証、rich menu group query/path/payload/R2 key検証、friend単位操作の維持
- `apps/worker/src/routes/entry-routes.ts` / `conversions.ts` / `calendar.ts` / `health.ts` / `friends.ts` / `duplicates.ts` / `liff.ts` / `images.ts`: 流入経路、conversion point定義参照/作成/削除、Google Calendar接続、account health/migration、friends ref集計、重複統計、ref分析、LIFF profile idToken入力検証、LIFF config/ref analytics入力検証、LIFFリンクwrap、画像削除APIのowner/admin制限とentry route path/payload検証、conversion point path/payload検証、calendar query/path/payload検証
- `apps/worker/src/routes/broadcasts.ts` / `dedup-preview.ts`: broadcast管理API、dedup preview、配信/集計APIのowner/admin制限、broadcast query/path/payload/segment条件検証、dedup-preview payload検証
- `apps/worker/src/routes/profile-refresh.ts`: admin診断/repair APIのowner/admin制限
- `apps/worker/src/routes/webhooks.ts`: webhook管理APIのowner/admin制限、path/payload検証、incoming receive署名検証の維持
- `apps/worker/src/index.ts`: 公開QR proxyの入力制限、公開short-link入力制限、外部QR rendererレスポンス検証
- `apps/worker/src/middleware/auth.ts` / `routes/forms.ts`: フォーム定義公開GETとフォーム管理APIのowner/admin制限、フォームpath/payload境界
- `apps/worker/src/routes/stripe.ts` / `ad-platforms.ts` / `affiliates.ts` / `tracked-links.ts` / `liff.ts`: 売上・広告・計測運用APIのowner/admin制限、Stripe events/affiliate report query検証、ad-platform/affiliate/tracked-link管理path/payload検証、公開affiliate click入力境界、公開エンドポイント維持、tracked-linkの検証済みLIFF attribution
- `apps/worker/src/routes/conversions.ts`: staffのconversion記録、履歴一覧、集計レポートのfriend可視範囲とconversion記録payload/query検証
- `apps/worker/src/routes/calendar.ts`: staffのcalendar予約一覧、予約作成、予約ステータス更新のfriend可視範囲
- `apps/worker/src/routes/friends.ts`: staffのfriend一覧、詳細、direct履歴、direct送信の可視範囲と、friends query/path/tag/metadata/direct message payload検証
- `apps/worker/src/routes/support-friend-access.ts`: friend単位APIで共有するstaff可視範囲guard
- `apps/worker/src/routes/conversations.ts`: staffのconversation queue、conversation詳細の可視範囲とquery/path検証
- `apps/worker/src/routes/scenarios.ts`: scenario定義/step管理のowner/admin制限、scenario query/path/payload検証、step削除スコープ、staffのscenario手動登録で使うfriend可視範囲
- `apps/worker/src/routes/scoring.ts` / `reminders.ts`: scoring rule/reminder定義管理のowner/admin制限と、staffのfriend score/reminder操作の可視範囲
- `apps/worker/src/routes/tags.ts` / `templates.ts` / `message-templates.ts`: tag/template/message template定義管理のowner/admin制限とpath/payload検証
- `apps/worker/src/routes/rich-menus.ts`: staffのrich-menu操作のfriend可視範囲とfriend rich menu path/payload検証
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
