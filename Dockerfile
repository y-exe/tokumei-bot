FROM python:3.11-slim

# 作業ディレクトリの設定
WORKDIR /app

# 日本語環境の設定 (CHCP 65001 の代わり)
ENV LANG C.UTF-8
ENV LC_ALL C.UTF-8

# 依存関係のインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# コードのコピー
COPY . .

# 実行コマンド
CMD ["python", "main.py"]
