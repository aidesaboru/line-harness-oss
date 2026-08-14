# D1日次暗号化バックアップ

本番D1は毎日03:17 JSTにGitHub Actionsから読み取り専用でエクスポートします。SQLはrunnerの一時領域だけに置き、AES-256-GCMで暗号化してから削除します。GitHubへ保存するのは暗号化済みファイルと個人情報を含まない検証結果だけです。

## 毎回行う復元確認

暗号化済みファイルを同じrunner内で復号し、D1と同じSQLite形式の一時DBへ全件投入します。本番D1へ復元する処理はありません。復元後に次を確認し、1つでも失敗した場合はバックアップを保存せずworkflowを失敗させます。

- 本番に存在する全テーブルが復元されていること
- チャット、タスク、履歴などの重要テーブルが存在すること
- 削除保護対象テーブルの件数が取得前より減っていないこと
- `PRAGMA integrity_check`が`ok`であること
- 外部キーに不整合がないこと
- 暗号化ファイルが空ではなくSHA-256を計算できること

## GitHub側の設定

Repository Variablesへ次を設定します。

- `D1_ENCRYPTED_BACKUP_ENABLED`: `true`
- `CLOUDFLARE_ACCOUNT_ID`: 対象CloudflareアカウントID
- `D1_DATABASE_NAME`: 本番D1名
- `D1_DATABASE_ID`: 本番D1 ID

Repository Secretsへ次を設定します。値をIssue、Slack、コミットへ貼らないでください。

- `CLOUDFLARE_API_TOKEN`: 対象アカウントだけに限定した`D1 Read`権限のトークン
- `D1_BACKUP_ENCRYPTION_KEY`: 32バイトのランダム値をBase64化した暗号鍵

暗号鍵を失うと保存済みバックアップを復号できません。GitHub Secretsとは別の承認済みSecret Managerにも同じ鍵を保管してください。

## 保存期間と復旧

検証済みの暗号化バックアップはGitHub Actions artifactとして90日保存します。Cloudflare D1 Time Travelも有効なため、直近の誤更新はTime Travel、90日以内の独立コピーは暗号化artifactを使います。

本番への復元は上書きを伴うため自動化しません。障害時は対象日時、Time Travel bookmark、暗号化artifactを確認し、復元先と影響範囲を決めてから手動で実施します。

## 手動確認

Actionsの`Daily encrypted D1 backup`から手動実行できます。成功時はartifact内に`backup.sql.enc`と`verification.json`が作成されます。`verification.json`に顧客データや件数の明細は含めません。
