# 匿名lookup

Tailscaleに接続して `LOOKUP_TAILSCALE_ORIGIN` のHTTPSページを開き、メッセージIDを検索します。追加パスワード・SSH起動リンクは不要です。

`LOOKUP_ALLOWED_TAILSCALE_LOGINS` に許可するTailscaleログイン名をカンマ区切りで指定します。未設定・本人情報なし・別アカウント・タグ付き端末は拒否します。`LOOKUP_TAILSCALE_ORIGIN` 未設定時はlookupを起動しません。

バックエンドは127.0.0.1:8765だけで待ち受け、Tailscale ServeのHTTPSプロキシを経由します。Kubernetesではホストのループバックに転送し、`tailscale serve --bg --https=443 http://127.0.0.1:8765` で接続します。Serveは接続元の本人情報を付与し、クライアントからの同名ヘッダーを除去します。バックエンドをLAN・公開インターネット・Podネットワークへ直接公開しないでください。Funnelは使いません。

照会ページはキャッシュ禁止・CSRF保護・HTMLエスケープを適用します。CookieはSecure・HttpOnly・SameSite=StrictでTailscaleアカウントに紐付けます。30分後はページを開き直すだけで再認証できます。旧管理者キー、`/login`・`/launch`・`/open` は廃止しました。
