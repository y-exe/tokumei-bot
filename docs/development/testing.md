# 開発・テスト

[目次](../README.md) · [旧Botからの移行](migration.md)

## コマンド

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run dev
```

`check`は型チェック、`test`はNode.jsのテストランナー、`dev`は変更監視付き起動です。
開発起動にも[環境変数](../operations/setup.md)が必要です。

## ファイル配置

| 場所 | 役割 |
| --- | --- |
| `src/index.ts`・`src/app.ts` | 起動、Discord操作の振り分け |
| `src/commands.ts`・`src/register.ts` | コマンド定義・登録 |
| `src/domain/` | 設定、投稿検証、共通エラー |
| `src/ui/` | 案内、フォーム、プレビュー、操作セッション |
| `src/services/` | 投稿・案内再送・通報処罰・通常投稿の制御 |
| `src/media/` | URL取得、加工、モデル推論、安全判定 |
| `src/infra/` | DB、暗号化、直列化、診断、監視、lookup |
| `src/migration/`・`src/migrate.ts` | 旧データの移行 |
| `tests/` | 機能・回帰テスト |
| `docs/` | 利用・管理・開発の説明 |
| `.local/`・`models/` | ローカル検証用データ・取得モデル。Git管理外 |

## 実画像の検証

指定がない実画像テストはスキップされます。画像やCookieをGitへ追加しないでください。

| 環境変数 | 用意するファイル | テスト |
| --- | --- | --- |
| `SAFETY_FIXTURES_DIR` | `sfw.jpg`・`nsfw-real.jpg`・`nsfw-anime.png`・`nsfl.jpg` | `tests/safety.test.ts` |
| 同上 | `exposed-real.jpg`・`exposed-anime.png` | `tests/nudity.test.ts` |
| `SAFETY_ALLOWED_IMAGE` | 許可したい画像1枚のパス | `tests/nudity.test.ts` |
| `SAFETY_SWIMSUIT_IMAGE` | 水着画像1枚のパス | `tests/anime-nudity.test.ts` |
| `SAFETY_REPORTED_IMAGE_DIR` | `nsfw-1.jpg`〜`nsfw-4.jpg` | `tests/anime-nudity.test.ts` |

部位検出の実画像は、成人のみの適法なサンプルを使用してください。
例：PowerShellで指定したテストを実行する場合。

```powershell
$env:SAFETY_FIXTURES_DIR = 'C:\path\to\fixtures'
bunx tsx --test tests/safety.test.ts
```

## CIと変更時の確認

mainへのpushで型チェック・テスト・Docker検証・GHCR公開を実行します。
Dockerは読み取り専用・ネットワークなし・512MiB制限でモデル起動を確認します。

- コマンドを変えたら[登録処理](../operations/setup.md)も実行する。
- モデルを変えたら[入出力・前処理・閾値](models.md)を実ファイルで確認する。
- 設定・公開動作を変えたら、対応する文書も更新する。
- 診断ログにはCookieやトークンを含めない。[エラー調査](../operations/maintenance.md)
