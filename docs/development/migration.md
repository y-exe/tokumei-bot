# 旧Botからの移行

[目次](../README.md)

旧JSONまたは旧DBから、設定・投稿・匿名ID状態・利用制限をv2へ移します。
最初は保存せずに移行計画を確認します。

## 1. 移行元を指定

| 移行元 | 指定 |
| --- | --- |
| JSONディレクトリ | `--source ./detas` |
| 旧PostgreSQL | `MIGRATION_SOURCE_DATABASE_URL` |

| 内容 | JSON名 |
| --- | --- |
| チャンネル・サーバー設定 | `channels.json`・`guild_settings.json` |
| 禁止語・ドメイン・通報閾値 | `keywords.json`・`domains.json`・`thresholds.json` |
| 利用制限・匿名ID状態 | `banned_users.json`・`anonymous_data.json`・`user_data.json` |
| 投稿ログ | `message_logs.json` |

DBからは`app_json_documents`と直近90日の`anonymous_messages`を読みます。

## 2. チャンネル対応表を作成

`mapping.json`のキーは移行元チャンネルID、値はサーバーIDです。
`globalsGuild`は旧共通ルールを引き継ぐサーバーを指定する任意項目です。

```json
{
  "channels": {
    "111111111111111111": "222222222222222222"
  },
  "globalsGuild": "222222222222222222"
}
```

## 3. 保存せず確認

```sh
bun run migrate --source ./detas --mapping ./mapping.json
```

画像Botからの移行には`--kind image`を付けます。
サーバーID・Webhookのないチャンネルや、警告・期限切れの件数を確認してください。

## 4. 適用

移行先DBをバックアップし、`MIGRATION_TARGET_DATABASE_URL`と`ENCRYPTION_KEY`を設定して実行します。

```sh
bun run migrate --source ./detas --mapping ./mapping.json --apply
```

`DATABASE_URL`は移行先として自動使用しません。
適用後も匿名投稿の受付は停止したままです。設定を確認し、`/setup`から再開します。

旧入力の形式と変換処理は[legacy.ts](../../src/migration/legacy.ts)を参照してください。
