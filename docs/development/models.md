# 安全判定モデルの仕様

[目次](../README.md) · [判定方針](../guide/media-safety.md)

## 採用モデル

| 用途 | モデル | 配置先・環境変数 |
| --- | --- | --- |
| 3分類 | [image-safety-classifier-xs](https://huggingface.co/OwenElliott/image-safety-classifier-xs/tree/54f4560bd9c5ee92d45dc30418a8f8680e80de6d) | `models/image-safety-xs` / `SAFETY_MODEL_DIR` |
| 一般の部位検出 | [NudeNet 320n](https://huggingface.co/deepghs/nudenet_onnx/tree/44956a0587943016350c7815f9e0dec089d45cae) | `models/nudenet` / `NUDITY_MODEL_DIR` |
| 二次元の部位検出 | [Anime Censor Detection v1.0 s](https://huggingface.co/deepghs/anime_censor_detection/tree/0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s) | `models/anime-censor` / `ANIME_NUDITY_MODEL_DIR` |

リンク先の固定リビジョンを使用します。出典・ライセンスは[第三者表記](../../THIRD_PARTY_NOTICES.md)を参照してください。

## ONNXの入出力と前処理

全モデルはバッチ1・float32・RGB CHW・CPUで実行します。

| モデル | 入力 → 出力 | 前処理 |
| --- | --- | --- |
| 3分類 | `image` 1×3×224×224 → `probabilities` 3分類 | bilinearで伸縮、RGB 0〜255 |
| NudeNet | `images` 1×3×320×320 → `output0` 1×22×2100 | 比率保持でbilinear縮小、右下を黒埋め、0〜1 |
| 二次元 | `images` 1×3×1216×1216 → `output0` 1×7×30324 | bicubicで伸縮、0〜1 |

- 3分類：ラベル順は`config.json`の`pretrained_cfg.label_names`から読む。
- 3分類の正規化・SoftmaxはONNX内に含まれるため、TypeScript側で二重適用しない。
- 固定版に`preprocessor_config.json`はなく、ONNX版の入力仕様に従う。
- 部位検出2モデル：透過画像を白背景へ合成。ラベルはONNXメタデータから検証。
- 二次元モデル：配布`labels.json`とも照合。学習サイズ640に対し、動的入力を1216で使用。

## 部位検出の後処理

| モデル | 候補の閾値 | NMSのIoU | NSFW判定 |
| --- | --- | --- | --- |
| NudeNet | 0.25 | 0.45 | 女性の胸・男女の性器の露出が0.5以上 |
| 二次元 | 配布`threshold.json`の0.238 | 0.7 | 0.6未満は[切り出し再確認](../guide/media-safety.md) |

NudeNetの対象ラベルは`FEMALE_BREAST_EXPOSED`・`FEMALE_GENITALIA_EXPOSED`・`MALE_GENITALIA_EXPOSED`。
二次元は`nipple_f`・`penis`・`pussy`です。
これらのスコアは3分類の確率とは別の値です。

## 手動配置

通常は初回起動時に自動取得し、Dockerではビルド時に同梱します。
手動で置く場合は上表の固定版を使います。

| 配布ファイル | ローカルのファイル名 |
| --- | --- |
| 3分類：`config.json` | `models/image-safety-xs/config.json` |
| 3分類：`onnx/image-safety-classifier-xs.onnx` | `models/image-safety-xs/model.onnx` |
| NudeNet：`320n.onnx` | `models/nudenet/320n.onnx` |
| 二次元：`model.onnx` | `models/anime-censor/model-s.onnx` |
| 二次元：`labels.json`・`threshold.json` | `models/anime-censor/labels.json`・`models/anime-censor/threshold-s.json` |

部位検出2モデルは起動時にSHA-256を検証します。
ハッシュ・メタデータ・入出力の検証は[safety.ts](../../src/media/safety.ts)、[nudity.ts](../../src/media/nudity.ts)、[anime-nudity.ts](../../src/media/anime-nudity.ts)にあります。

## 再利用するAPI

```ts
import { classifyImage } from './src/media/safety.js';

const result = await classifyImage(bufferOrUrl);
// { sfw: number, nsfw: number, nsfl: number, label: 'SFW' | 'NSFW' | 'NSFL' }
```

単体APIはアニメーションの先頭フレームのみを判定します。
投稿時のNSFW拒否には部位検出も使うため、`label`と投稿可否は同一ではありません。
