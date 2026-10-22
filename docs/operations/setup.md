# セットアップ

[目次](../README.md)

## 必要なもの

| 項目 | 用途 |
| --- | --- |
| Bun 1.3系 | Botの実行・依存関係の導入 |
| Node.js 22.16以上 | テスト用の`tsx` |
| PostgreSQL | 設定・投稿者対応・通報の保存 |
| FFmpeg・ffprobe | 動画のフレーム抽出。Dockerには同梱 |

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
bun run commands
bun run start
```

`commands` は `DISCORD_GUILD_ID` のサーバーへ登録します。
全サーバー向けに登録する場合は `bun run commands --global` を使います。
初回起動時にDBのテーブル作成とモデルの取得を行います。

起動後、Discordで `/setup` → モード選択 →「保存して設置」を実行します。

## 環境変数

必須項目と接続先は自分の環境に合わせて設定してください。

| 変数 | 内容・既定値 |
| --- | --- |
| `DISCORD_BOT_TOKEN` | 必須。Botトークン |
| `DISCORD_APPLICATION_ID` | コマンド登録時に必須。アプリケーションID |
| `DISCORD_GUILD_ID` | サーバー単位でコマンドを登録する場合のID |
| `DATABASE_URL` | DB接続先。代わりに`PGHOST`等のpg接続変数も利用可能 |
| `ENCRYPTION_KEY` | 必須。32バイトをbase64化したWebhook暗号化鍵 |
| `MEDIA_CONCURRENCY` | 取得・画像処理の同時数。1〜8、既定2 |
| `ANIME_INFERENCE_THREADS` | 二次元モデルのCPUスレッド数。1または2、既定1 |
| `PIXIV_PHPSESSID` | Pixivのログイン用Cookie。任意。[更新方法](../guide/media.md) |
| `HEALTH_PORT` | ヘルスチェック用ポート。既定3000 |
| `WATCHER_PUSH_URL`・`WATCHER_IMAGE_PUSH_URL` | 任意。監視先への定期通知 |
| `FFMPEG_PATH`・`FFPROBE_PATH` | 実行ファイル名・パス。既定`ffmpeg`・`ffprobe` |
| `SAFETY_MODEL_DIR` | 既定`models/image-safety-xs` |
| `NUDITY_MODEL_DIR` | 既定`models/nudenet` |
| `ANIME_NUDITY_MODEL_DIR` | 既定`models/anime-censor` |
| `LOOKUP_TAILSCALE_ORIGIN`・`LOOKUP_ALLOWED_TAILSCALE_LOGINS`・`LOOKUP_PORT` | [lookupの設定](lookup.md) |
| `MIGRATION_SOURCE_DATABASE_URL`・`MIGRATION_TARGET_DATABASE_URL` | [旧データの移行](../development/migration.md) |

暗号化鍵は次で生成できます。稼働後はDBと一緒に保管してください。

```sh
bun -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Docker・監視・バックアップは[運用](maintenance.md)を参照してください。
