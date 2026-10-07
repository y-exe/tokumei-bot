<div align="center">
<h1>
  匿名チャットDiscordBot
  
  [![discord.js](https://img.shields.io/badge/discord.js-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discordjs.dev/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
  [![License GPL v3](https://img.shields.io/badge/LICENSE-GPL%20v3-green.svg?style=flat-square)](LICENSE)
</h1>
新規参入、活発化のために作られたDiscord上に完全匿名チャットを実装するBot!!<br>
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
ユーザーは**完全匿名でメッセージを投稿**でき、投稿者は他のユーザーには分かりません。  
「匿名つぶやきモード」と「匿名要望モード」の2つの運用形態をサポートしています。  
処罰等をしたい場合なども、**Bot経由で処罰が実行されるため、サーバー運営者にも誰かわかることはありません!!**  

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

## ライセンス

[GPL-3.0](LICENSE)  

---

© 2026 yexe