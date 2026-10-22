# 管理者向けlookup

[目次](../README.md)

保存された匿名投稿のメッセージIDから、投稿者を確認するBot管理者専用の画面です。
通常のサーバー管理者向けに投稿者を開示するコマンドはありません。

## 利用方法

1. 許可アカウントの端末でTailscaleを接続する。
2. `https://接続先のホスト名/lookup/` を開く。
3. メッセージIDを入力して検索する。

追加パスワード・SSH起動リンクは不要です。URLを直接開いても利用できます。
保存0・削除済み・保存期限切れの投稿は照会できません。

## 設定

| 変数 | 内容 |
| --- | --- |
| `LOOKUP_TAILSCALE_ORIGIN` | TailscaleのHTTPS origin。例：`https://server.example.ts.net`。パス・末尾の`/`は付けない |
| `LOOKUP_ALLOWED_TAILSCALE_LOGINS` | 許可するTailscaleログイン名。複数ならカンマ区切り |
| `LOOKUP_PORT` | バックエンドのポート。既定8765 |

origin未設定ならlookupを起動しません。許可アカウントが空なら起動時に拒否します。

## 接続経路

`端末 → Tailscale Serve（HTTPS）→ ホストのループバック → Botのループバック`

Botは127.0.0.1:8765だけで待ち受けます。
Kubernetesではホスト127.0.0.1:8765からPodへの転送を別途維持します。

```sh
tailscale serve --bg --https=443 --set-path=/lookup http://127.0.0.1:8765/lookup
tailscale serve status
```

転送するのは`/lookup/`だけです。`/`はほかのプロジェクトに利用できます。
旧設定から移行する際は、lookup用だった`/`の転送だけを外してください。

## アクセス制御

- Serveの本人情報で毎回アカウントを確認し、未許可アカウント・タグ付き端末は拒否。
- バックエンドをLAN・公開インターネットへ直接公開しない。Funnelは使わない。
- Cookieは`/lookup/`限定、Secure・HttpOnly・SameSite=Strict。30分後はページを開き直す。
- キャッシュ禁止・CSRF検証・HTMLエスケープを適用。

同一ホストのページはオリジンを共有します。信頼範囲が異なるアプリはホスト名を分けてください。

接続できない場合は、Tailscaleの接続状態、Serve、内部転送を確認します。
ブラウザーだけDNSエラーになる場合は、独自のDNS設定がTailscaleのMagicDNSを迂回していないか確認してください。
