<div align="center">
<h1>
  匿名チャットDiscordBot
  
  [![discord.js](https://img.shields.io/badge/discord.js-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discordjs.dev/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
  [![License GPL v3](https://img.shields.io/badge/LICENSE-GPL%20v3-green.svg?style=flat-square)](LICENSE)
</h1>
Discordサーバーに匿名投稿機能を追加するBotです。<br>
<br>

<img src="public/about.png" alt="about">
<br>
<sub>匿名チャットの様子</sub>
</div>
<br/>


## なんのためにつくった...?

サーバー新規参入者にとってみんな共通の顔見知りがあるなかで喋るのは難しい...  
匿名チャットはそんな過疎鯖を活性化するために作られました。  
大型鯖で導入する際は匿名の性質上荒れることも考え、匿名経由での処罰機能等も実装しております！！ 

現在、Beta版として7000人越の鯖に仮導入しております。もし導入したい方はご相談を...

## 軽い説明

このBotは、Discordサーバー内に匿名掲示板のような機能を追加するためのBotです。  
投稿者のDiscordアカウントは通常の投稿表示には出ません。投稿ログの保存が有効な場合、Botは投稿とユーザーIDの対応を保存します。DB管理者やBot管理者は保存された情報を確認できるため、完全な匿名性を保証するものではありません。
「匿名つぶやきモード」と「匿名要望モード」の2つの運用形態をサポートしています。  
通報・処罰はBot経由で行い、サーバー管理者向けの操作画面には匿名投稿者のDiscordユーザーIDを表示しません。

## 特徴など...

* **モード:**
  * **匿名チャットモード:** メッセージに「匿名 001」のようなIDが付与される標準的なモードです。
  * **匿名要望モード:** IDが表示されず「匿名」としてのみ表示される、要望や意見募集に適したモードです。
* **画像:** どちらのモードでも専用ボタンから安全に画像を投稿できます。
* **メッセージの編集・削除・返信:** 投稿者本人は投稿したメッセージを後から操作でき、他者の匿名投稿への返信も可能です。
* **通報システム:** ユーザーは不適切なメッセージを簡単に通報できます。一定数の通報が集まると、自動的に管理者に通知されます。

## コマンドリスト

### ユーザー向け (メッセージを右クリック or 長押し > アプリ)

* `メッセージに返信`: 指定した匿名メッセージに対して返信を行います。(>>[数字]の形式で)
* `メッセージを編集`: 自分が投稿した匿名メッセージの内容を編集します。
* `メッセージを削除`: 自分が投稿した匿名メッセージを削除します。
* `匿名つぶやき通報`: 不適切だと思われる匿名メッセージをサーバー管理者に通報します。

### 管理者向け

* `/setup`: 実行したチャンネルを「匿名つぶやきモード」など好きなモードで設置します。
* `/settings`: このチャンネル、またはサーバー標準の設定を変更します。(禁止キーワード・通報先など)
* `/reports`: 通報を確認して、サーバーBAN・1ヶ月タイムアウト・処罰なしを選択します。
* `/stop`: 実行したチャンネルの匿名投稿受付を停止します。
* `/panel`: このチャンネルの案内を現在の設定でもう一度送ります。(誤って消したとき用)

## ライセンス

[GPL-3.0](LICENSE)  

---

© 2026 yexe
# ローカル画像・動画の安全判定

予期しない処理障害では `ERR-` から始まるエラーコードをインラインコードで表示します。投稿拒否や入力ミスにはコードを付けません。サーバー管理者は `/error code:エラーコード` でそのサーバーの詳細を非公開で照会できます。詳細はPostgreSQLの `v2_diagnostics` に30日間保存し、原因・スタック・操作名・Discordのコードを記録します。投稿本文・ユーザーID・リクエスト全体は記録せず、秘密環境変数とURLは秘匿します。DB障害時は同じコードで標準エラーログに残します。コマンド追加後は `bun run commands` で登録してください。

Dockerではビルド時にモデルを取得して同梱するため、読み取り専用ルートでも起動できます。動画解析には書き込み可能な `/tmp` が必要です。Kubernetesではディスクの `emptyDir` を `/tmp` にマウントしてください。

`bun install` 後、`ffmpeg` と `ffprobe` をPATHに配置してください（Dockerイメージには同梱）。Bot起動時に一度だけ、グロ分類・一般部位検出・二次元部位検出それぞれのCPU用 `onnxruntime-node` セッションを作ります。Pythonや画像判定の外部APIは使用しません。モデルがない初回起動ではHugging Faceから自動取得するため通信が必要です。以後の推論はローカルです。

手動配置する場合は、[モデルの固定リビジョン](https://huggingface.co/OwenElliott/image-safety-classifier-xs/tree/54f4560bd9c5ee92d45dc30418a8f8680e80de6d) の `config.json` と `onnx/image-safety-classifier-xs.onnx` をそれぞれ `models/image-safety-xs/config.json` と `models/image-safety-xs/model.onnx` に置いてください。`SAFETY_MODEL_DIR` で配置先を変更できます。コンテナではこのディレクトリを永続化すると再起動時の再取得を避けられます。

このリビジョンには `preprocessor_config.json` がありません。configの `pretrained_cfg.label_names` を読み込み、ラベルを対応付けます。実ONNXを確認した入出力は `image`（float32、バッチ1、RGB CHW、224×224）と `probabilities`（3分類）です。[ONNX版の仕様](https://huggingface.co/OwenElliott/image-safety-classifier-xs) に従い、RGBに変換してbilinearで224×224に伸縮し、0〜255で入力します。グラフ内に255除算、平均・標準偏差による正規化、Softmaxが含まれるため二重適用しません。通常のtimm版のbicubic・中心クロップとは異なります。モデルを置き換える際はこの仕様を再確認してください。

`src/media/safety.ts` の `classifyImage(Buffer | string)` は `{ sfw, nsfw, nsfl, label }` を返します。URL取得には既存の公開HTTPS限定・サイズ制限付きダウンローダーを使用します。JPEG/PNG/GIF/WebPに対応し、単体APIではアニメーションの先頭フレームを判定します。投稿時はアニメーションも約5秒ごとに判定します。

`/setup` と `/settings` の「画像・動画の安全設定」でNSFW（性器・女性の胸の露出）とNSFL（グロ・流血）を個別に許可できます。初期値と旧設定は両方拒否です。性的画像の投稿拒否には3分類モデルのNSFWスコアを使用せず、NudeNet 320nで `FEMALE_BREAST_EXPOSED`、`FEMALE_GENITALIA_EXPOSED`、`MALE_GENITALIA_EXPOSED` を信頼度0.5以上で検出した場合に拒否します。腹・肩・下着、覆われた胸・性器、男性の胸、臀部のみでは拒否しません。女性の胸カテゴリは乳首そのものの検出ではないため、希望する基準を完全には保証できません。実写と二次元は同じ基準です。グロは既存3分類モデルのNSFL判定を継続します。一般添付、画像URL、X動画リンクを含め送信直前の現在設定で検査します。非画像・非動画ファイルは従来通りです。

部位検出モデルの手動配置は、[固定リビジョン](https://huggingface.co/deepghs/nudenet_onnx/tree/44956a0587943016350c7815f9e0dec089d45cae) の `320n.onnx` を `models/nudenet/320n.onnx` に置いてください。配置先は `NUDITY_MODEL_DIR` で変更できます。起動時にSHA-256を検証します。ラベルと320×320入力サイズは実ONNX内のメタデータから確認しています。実ファイルの入力名は `images`、出力名は `output0`（バッチ1、22×2100）。RGB・0〜1・CHWで入力し、アスペクト比を保って320以内にbilinear縮小、右・下を黒でパディングします。透過部分は白背景に合成します。YOLOの出力をTypeScriptで解釈し、信頼度0.25未満を除外、IoU 0.45のNMSを適用します。部位の信頼度は互いに排他的な3分類確率ではなく、`classifyImage` の既存APIと別の結果です。出典とモデル内ライセンス表記は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

二次元の乳首・性器の見逃しを補うため、[Anime Censor Detection v1.0 s](https://huggingface.co/deepghs/anime_censor_detection/tree/0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s) を併用します。`nipple_f`、`penis`、`pussy` のいずれかを配布元の閾値0.238以上で検出すると拒否します。NudeNet単体で検出できなかった報告画像4枚と、以前に誤拒否された肌露出画像を比較して選定しました。`labels.json` と実ONNXのメタデータを照合し、閾値は `threshold.json` から取得します。動的float32 RGB CHW入力 `images`、出力 `output0`（1×7×30324）、0〜1正規化、1216×1216へbicubic伸縮、NMS IoU 0.7で処理します。学習サイズは640ですが、入力は動的です。1216での比較検証結果に基づく推論解像度であり、モデルの固定入力サイズではありません。モデルはSHA-256検証を行います。

手動配置はこのリビジョンの `model.onnx` を `models/anime-censor/model-s.onnx`、`labels.json` を同ディレクトリの `labels.json`、`threshold.json` を `threshold-s.json` に置いてください。配置先は `ANIME_NUDITY_MODEL_DIR` で変更できます。3つのモデルをビルド時に同梱し、起動時に一度だけ読み込みます。

静止画像は投稿用の縮小・JPEG変換の前に判定します。元画像の判定結果を加工後ファイルのSHA-256とモデル構成バージョンに結び付けて下書き内に保持し、送信時の現在設定で拒否を再評価します。元画像Bufferは保持しません。加工後データやモデル構成が違えば再判定します。URL投稿でも危険画像の拒否を一般的な取得失敗に置き換えません。

動画は先頭と約5秒ごとのフレームを逐次判定します。小さい部位の情報を失わないよう、抽出解像度も1216×1216にしています。最大10分、解析タイムアウトは動画の長さに応じて120〜600秒、取得上限32MiBです。フレームBufferを使い回してメモリを抑えます。`FFMPEG_PATH` / `FFPROBE_PATH` で実行ファイルを指定できます。壊れた画像・動画や判定失敗は拒否します。サンプリング間の短い場面やモデルの誤判定は検出できないことがあります。

メモリ優先でsharpキャッシュ無効、sharp並列数1、CPU推論スレッド1、推論同時数1、CPUメモリアリーナ・メモリパターン無効です。モデルロード時と各推論時にRSS（MiB）・所要時間・ラベルをログに出します。低メモリ環境では `MEDIA_CONCURRENCY=1` も設定してください。

検証は `bun run check` と `bun run test`。実画像4分類の確認は、管理者が用意した成人のみの適法なサンプルを `sfw.jpg`、`nsfw-real.jpg`、`nsfw-anime.png`、`nsfl.jpg` として置き、`SAFETY_FIXTURES_DIR` にディレクトリを指定して `bunx tsx --test tests/safety.test.ts` を実行します。未指定の場合、この4件は明示的にスキップされます。サンプルはGitに追加しないでください。

肌露出の許可確認には `SAFETY_ALLOWED_IMAGE` に画像ファイルのパスを指定し、`bunx tsx --test tests/nudity.test.ts` を実行してください。元画像と投稿時の最適化後画像の両方を検査します。部位検出の実画像確認は `SAFETY_FIXTURES_DIR` 内に `exposed-real.jpg`、`exposed-anime.png`（胸または性器の露出を含む成人サンプル）を配置します。未指定の場合はスキップされます。

今回の見逃し4件は `SAFETY_REPORTED_IMAGE_DIR` 内に `nsfw-1.jpg` 〜 `nsfw-4.jpg` として置き、`bunx tsx --test tests/anime-nudity.test.ts` で検証できます。画像のダウンロード・Gitへの保存は自動で行いません。モデルの検出、投稿前の拒否、縮小後の判定保持、許可設定変更を検証します。
