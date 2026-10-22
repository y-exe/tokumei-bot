# 運用・エラー調査

[目次](../README.md) · [初回セットアップ](setup.md)

## Docker

```sh
docker build -t tokumei-bot .
docker run -d --name tokumei-bot --env-file .env \
  --read-only --tmpfs /tmp:rw,size=128m --memory=512m --cpus=2 \
  -e MEDIA_CONCURRENCY=1 -e ANIME_INFERENCE_THREADS=2 tokumei-bot
```

`.env`のDB接続先はコンテナから届くアドレスにします。
動画解析には書き込み可能な`/tmp`が必要です。Kubernetesでは`emptyDir`等をマウントします。
CPU上限が1コアなら `ANIME_INFERENCE_THREADS=1` を使用してください。

モデルはイメージに同梱するため、起動時のモデル取得は不要です。
Discord・DB・URLからの取得には、それぞれの接続が必要です。

## 監視と保守

| 項目 | 確認する内容 |
| --- | --- |
| `/live` | プロセスのHTTP応答。通常200 |
| `/ready` | Discord接続とDB疎通。準備中・障害時は503 |
| ログ | 起動完了、モデルのRSS、推論時間、取得・送信・DBエラー |
| 定期処理 | 1分ごとの期限切れログ削除、通報通知の再試行、監視先への通知 |
| バックアップ | PostgreSQLと`ENCRYPTION_KEY`を組み合わせて保管 |

バックアップはBot自身では作りません。運用環境で取得・復元手順を用意します。
暗号化鍵を失うと、保存済みWebhookの復号ができません。

## エラーID

予期しない障害では次の形式を表示します。

> **処理エラー**
>
> 処理を完了できませんでした。時間をおいて再試行してください。
>
> エラーID: `0a4dcaf0`

上記のIDは例です。実際は8桁の小文字16進数を生成します。
サーバー管理権限のある人は `/error code:0a4dcaf0` で、そのサーバーの詳細を非公開で照会できます。
以前の `ERR-` 形式も検索できます。

- 詳細はDBの`v2_diagnostics`へ30日保存。IDの重複時は再生成。
- 原因・スタック・操作名・Discordのコードを記録し、URLと秘密環境変数を秘匿。
- DBへ保存できない場合は同じIDを標準エラーログへ記録。
- 投稿拒否・入力ミス・期限切れなどにはIDを付けず、具体的な理由を表示。

## よくある確認先

| 症状 | 確認先 |
| --- | --- |
| `/setup`や投稿が失敗 | [Botの権限](setup.md)、エラーIDの詳細 |
| URLの画像を取得できない | [公開状態・Cookie・対応サイト](../guide/media.md) |
| 水着などが拒否される | [安全判定](../guide/media-safety.md)。分類スコアと部位検出は別 |
| 画像処理が遅い | CPU制限と推論時間。2スレッドなら2コア以上 |
| 案内が見つからない | `/panel`。受付停止中なら設定も確認 |
| lookupへ接続できない | [Tailscale接続・DNS・転送](lookup.md) |

mainへのpushでGitHub Actionsが検証・イメージ公開を行います。
実際の反映先・自動更新の設定は、各デプロイ環境で管理します。
