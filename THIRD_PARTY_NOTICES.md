# モデルの出典

## Anime Censor Detection v1.0 s

- 出典: https://huggingface.co/deepghs/anime_censor_detection/tree/0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s
- 作者: DeepGHS
- モデルカードのライセンス: MIT
- 参照実装: https://github.com/deepghs/imgutils/blob/main/imgutils/generic/yolo.py

モデルは改変せず取得しています。ラベルと推奨閾値は配布JSONから読み込み、ラベルはONNXメタデータとも照合します。

## NudeNet 320n

- 元プロジェクト: https://github.com/notAI-tech/NudeNet
- 配布元: https://huggingface.co/deepghs/nudenet_onnx/tree/44956a0587943016350c7815f9e0dec089d45cae
- ONNX内の作者情報: Ultralytics
- ONNX内のライセンス情報: AGPL-3.0 License (https://ultralytics.com/license)
- ライセンス本文: https://www.gnu.org/licenses/agpl-3.0.html
- 配布元のモデルカードはApache-2.0と記載していますが、同梱ONNXのライセンス表記は上記の通りです。

モデルは改変せず取得しています。Node.js前後処理の参照元は元プロジェクトと https://github.com/deepghs/imgutils/blob/main/imgutils/detect/nudenet.py です。ラベルはONNXメタデータから読み取ります。

## image-safety-classifier-xs

- 出典: https://huggingface.co/OwenElliott/image-safety-classifier-xs/tree/54f4560bd9c5ee92d45dc30418a8f8680e80de6d
- 作者: OwenElliott
- モデルカードのライセンス: MIT

モデルは改変せず取得しています。
