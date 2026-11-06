# セットアップ

[目次](../README.md)

## 必要なもの

| 項目 | 用途 |
| --- | --- |
| Bun 1.3系 | Botの実行・依存関係の導入 |
| Node.js 22.16以上 | テスト用の`tsx` |
| PostgreSQL | 設定・投稿者対応・通報の保存 |
| FFmpeg・ffprobe | 動画のフレーム抽出。Dockerには同梱 |
| Python・gallery-dl 1.32.19 | 対応サイトの画像URL抽出。Dockerには同梱。手動導入は[ローカル環境](../development/testing.md)を参照 |

## Discordの準備

1. Developer PortalでBotを作り、**Message Content Intent**を有効にする。
2. `bot`・`applications.commands` スコープでサーバーへ招待する。
3. 投稿先で次の権限を付ける。

| 権限 | 必要な処理 |
| --- | --- |
| チャンネルを見る・メッセージを送信・履歴を読む | 投稿と案内 |
| ファイル添付・埋め込みリンク | 画像・動画・表示カード |
| Webhook管理 | 匿名名義での投稿 |
| メッセージ管理 | 通常投稿を削除する設定 |
| メンバーをBAN・タイムアウト | 該当の処罰を使う場合のみ |

## 初回起動

1. PostgreSQLにBot用ユーザーとDBを作る。
2. `.env.example` を `.env` にコピーし、必須項目を設定する。
3. 次を実行する。

```sh
bun install --frozen-lockfile
bun run start
```

起動時にコマンドを全サーバー向けへ自動同期します。定義の追加・変更・削除がある場合だけ更新し、サーバー個別の重複も取り除きます。同期失敗時もBotは起動し、次回起動時に再試行します。
手動で再同期する場合は `bun run commands` を使います（`--global` も同じ動作です）。
開発用にサーバー個別へ登録する場合だけ、`DISCORD_GUILD_ID` を設定して `bun run commands --guild` を使います。全体向けと同じコマンドは重複登録できません。
初回起動時にDBのテーブル作成とモデルの取得を行います。
案内用の絵文字もBotのアプリケーションへ自動追加します。次回以降は再利用し、不足分だけ補充します。サーバーの絵文字枠や手動登録は不要です。追加に失敗した場合は標準絵文字で表示を続けます。

起動後、Discordで `/setup` → 機能・ルールの設定 →「この内容で設置」を実行します。

## 複数サーバーでの運用

設定・匿名IDの採番・連投規制・通報・処罰ログはすべてサーバー(およびチャンネル)単位で分離されており、1つのBotで複数のサーバーに設置できます。設定の既定もサーバーごとに独立します。

### 参加したとき

- 追加した人をサーバーの監査ログ(`Bot追加`)から特定し、設定方法のDMを送ります。監査ログが確認できない場合はサーバーオーナーに送ります。DMの送信は失敗しても起動に影響しません。
- 過去に設置したサーバーで再び追加された場合は、既存の設定がそのまま戻り、設置済みチャンネルで案内を自動再送します。

### 離脱したとき

kick・退出の瞬間にDBへ「離脱」を記録します。離脱サーバーの案内送信や通報通知は即座に停止し、`GUILD_DELETE_GRACE_DAYS`(既定30日)を過ぎた時点の定期清掃で、そのサーバーの設定・投稿・通報・処罰ログなどの全データをDBから削除します。

- 誤操作や一時的な追い出しに備えた猶予期間です。期間内に再追加するとデータはそのまま戻ります。
- 期間内の再追加で案内が消えている場合は、設置チャンネルで `/panel` を実行すると再送できます。
- 猶予期間を過ぎた後も通報やチャンネル参照は残りません。即時消したい場合は `GUILD_DELETE_GRACE_DAYS=1` にして運用してください。
- WebhookはDiscord側に残るため、必要ならサーバー管理者が削除してください。

## sharding運用

`DISCORD_SHARDS=auto` または1〜32を設定すると、1つのコンテナ内でShardingManagerがシャード数だけ子プロセスを起動します。

- コマンド登録・絵文字の作成・ヘルスチェック・lookup・データ清掃・監視通知はシャード0だけが行います。絵文字の再利用や通報通知の送信は各シャード自身が処理し、重複送信は通知の取得(claim)と編集の冪等性で防ぎます。
- `DB_POOL_MAX`×シャード数 がPostgreSQLへの最大接続数になります。既定のままならシャード数分手動で増やしてください。
- 未設定(既定)のままなら従来通り単一プロセスで起動し、数千サーバー未満では単一プロセスで十分です。

## 環境変数

必須項目と接続先は自分の環境に合わせて設定してください。

| 変数 | 内容・既定値 |
| --- | --- |
| `DISCORD_BOT_TOKEN` | 必須。Botトークン |
| `DISCORD_APPLICATION_ID` | 手動の `commands` 実行時に必要。起動時の自動同期では不要 |
| `DISCORD_GUILD_ID` | 開発用の `commands --guild` で使うサーバーID |
| `DATABASE_URL` | DB接続先。代わりに`PGHOST`等のpg接続変数も利用可能 |
| `ENCRYPTION_KEY` | 必須。32バイトをbase64化したWebhook暗号化鍵 |
| `MEDIA_CONCURRENCY` | 取得・画像処理の同時数。1〜8、既定2 |
| `DB_POOL_MAX` | DB接続プールの上限。1〜30、既定5。sharding運用では「この値×シャード数」がDB側の必要接続数になる |
| `DISCORD_SHARDS` | sharding運用のシャード数。`auto` または1〜32。未設定なら単一プロセスで起動 |
| `GUILD_DELETE_GRACE_DAYS` | 離脱サーバーのデータ保持日数。1〜365、既定30 |
| `ANIME_INFERENCE_THREADS` | 二次元モデルのCPUスレッド数。1または2、既定1 |
| `PIXIV_PHPSESSID` | Pixivのログイン用Cookie。任意。[更新方法](../guide/media.md) |
| `HEALTH_PORT` | ヘルスチェック用ポート。既定3000 |
| `WATCHER_PUSH_URL`・`WATCHER_IMAGE_PUSH_URL` | 任意。監視先への定期通知 |
| `FFMPEG_PATH`・`FFPROBE_PATH` | 実行ファイル名・パス。既定`ffmpeg`・`ffprobe` |
| `SAFETY_MODEL_DIR` | 既定`models/image-safety-xs` |
| `NUDITY_MODEL_DIR` | 既定`models/nudenet` |
| `ANIME_NUDITY_MODEL_DIR` | 既定`models/anime-censor` |
| `LOOKUP_TAILSCALE_ORIGIN`・`LOOKUP_ALLOWED_TAILSCALE_LOGINS`・`LOOKUP_PORT` | [lookupの設定](lookup.md) |

暗号化鍵は次で生成できます。稼働後はDBと一緒に保管してください。

```sh
bun -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Docker・監視・バックアップは[運用](maintenance.md)を参照してください。
