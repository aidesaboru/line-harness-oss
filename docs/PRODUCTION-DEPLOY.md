# 本番Workerの安全デプロイ

通常の本番Workerデプロイは、リポジトリrootで次のコマンドを実行します。

```bash
corepack pnpm deploy:worker
```

`apps/worker`で`deploy`を実行した場合も、同じ安全スクリプトを通ります。

## 実行前の設定

認証付きsmoke test用のオーナーAPIキーを、シェルまたはCIのSecretへ設定します。値をコマンド引数や設定ファイルへ書かないでください。

```bash
export PRODUCTION_SMOKE_API_KEY='Secret Managerなどから取得した値'
```

`SUPPORT_CRM_OWNER_API_KEY`が設定済みの場合は、同じ値をsmoke testへ利用できます。

必要な場合だけ、次の環境変数を上書きします。

- `PRODUCTION_WORKER_URL`: カスタムドメインでsmoke testする場合のHTTPS URL
- `PRODUCTION_D1_BACKUP_DIR`: D1 exportの保存先
- `PRODUCTION_SMOKE_ATTEMPTS`: smoke testの試行回数（最大10回）
- `PRODUCTION_SMOKE_DELAY_MS`: smoke testの再試行間隔（最大30000ms）

バックアップの既定保存先は`~/.l-link/backups/d1`です。SQLファイルには本番データが含まれるため、GitやSlackへ添付せず、アクセスできる人を限定してください。

GitHub Actionsではバックアップ先を`RUNNER_TEMP`配下へ限定し、`GITHUB_WORKSPACE`配下への保存を拒否します。このバックアップを平文のGitHub artifactとしてアップロードしてはいけません。長期保管が必要な場合は、リポジトリ外の暗号化された保管先を別途用意してください。

## 安全スクリプトの順序

1. Workerをローカルでビルド
2. 本番のmigration台帳を確認
3. 未適用migrationを番号順に確定
4. 破壊的SQLがないことを検査
5. 現在稼働中のWorkerバージョンをrollback先として記録
6. 未適用migrationがある場合はD1全体をexport
7. DBで削除保護している全19テーブルの件数を記録
8. migration本文と台帳マーカーを同じD1 importで1件ずつ順番に適用
9. 重要テーブルの件数を再取得し、減少がないこととmigration台帳を再確認
10. Workerをデプロイ
11. オーナーAPIキー付きで`/api/chats`をsmoke test
12. smoke test失敗時は直前のWorkerへrollbackし、復旧を再確認

適用済みmigrationに抜けがある場合、バックアップが空の場合、重要テーブルの件数が1件でも減った場合、DB台帳の再確認に失敗した場合は、Workerをデプロイせずに停止します。

## 生デプロイについて

`apps/worker`の`deploy:raw`は、DB確認、バックアップ、smoke test、rollbackを行いません。安全スクリプト内部の最終デプロイに使うための低レベルコマンドです。

```bash
corepack pnpm --filter worker deploy:raw
```

名前どおり危険な迂回経路なので、通常運用や本番復旧では使用しないでください。

## rollbackの範囲

自動rollbackが戻すのはWorkerだけです。D1 migrationは追加専用に限定しているため、新しいテーブルや列が残っていても旧Workerが動作できる前提です。D1を過去状態へ戻す必要がある場合は、自動で実行せず、exportバックアップとCloudflare D1 Time Travelを確認してから別手順で対応します。
