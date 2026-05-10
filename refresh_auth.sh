#!/bin/bash
# =============================================================
# NotebookLM 再認証スクリプト
# 使い方: bash refresh_auth.sh
# 実行環境: WSL2（Ubuntu）
# =============================================================

set -e  # エラー時に即終了

REPO_URL="https://github.com/manato1201/Research-Collector/settings/secrets/actions"
STORAGE_PATH="$HOME/.notebooklm/storage_state.json"

echo ""
echo "======================================"
echo "  NotebookLM 再認証スクリプト"
echo "======================================"
echo ""

# Step 1: notebooklm-py のインストール確認
echo "📦 [1/4] notebooklm-py の確認..."
if ! command -v notebooklm &> /dev/null; then
    echo "  → インストールします..."
    pip install "notebooklm-py[browser]" -q
    playwright install chromium -q
else
    echo "  → OK（インストール済み）"
fi

# Step 2: ログイン
echo ""
echo "🔐 [2/4] Googleログインを開始します..."
echo "  ブラウザが開いたら Google にログインして ENTER を押してください"
echo ""
notebooklm login

# Step 3: storage_state.json の存在確認
echo ""
echo "✅ [3/4] 認証ファイルを確認しています..."
if [ ! -f "$STORAGE_PATH" ]; then
    echo "  ❌ エラー: $STORAGE_PATH が見つかりません"
    echo "  もう一度 notebooklm login を実行してください"
    exit 1
fi
echo "  → OK（$STORAGE_PATH）"

# Step 4: 1行JSONに圧縮してクリップボードにコピー
echo ""
echo "📋 [4/4] GitHub Secrets 用の値を生成しています..."

JSON_VALUE=$(cat "$STORAGE_PATH" | python3 -c \
    "import sys,json; print(json.dumps(json.load(sys.stdin)))")

# クリップボードへのコピー（xclip / xsel / clip.exe に対応）
COPIED=false
if command -v xclip &> /dev/null; then
    echo "$JSON_VALUE" | xclip -selection clipboard
    COPIED=true
elif command -v xsel &> /dev/null; then
    echo "$JSON_VALUE" | xsel --clipboard --input
    COPIED=true
elif command -v clip.exe &> /dev/null; then
    # WSL2からWindowsのクリップボードを使う
    echo "$JSON_VALUE" | clip.exe
    COPIED=true
fi

echo ""
echo "======================================"
echo "  完了！次の手順でSecretを更新してください"
echo "======================================"
echo ""
if [ "$COPIED" = true ]; then
    echo "  ✅ 値をクリップボードにコピーしました"
else
    echo "  ⚠️  クリップボードへのコピーに失敗しました"
    echo "  以下の値を手動でコピーしてください:"
    echo ""
    echo "$JSON_VALUE"
    echo ""
fi
echo "  1. 以下のURLを開く:"
echo "     $REPO_URL"
echo ""
echo "  2. NOTEBOOKLM_AUTH_JSON の「Update」をクリック"
echo ""
echo "  3. クリップボードの内容を貼り付けて「Save secret」"
echo ""
echo "  4. GitHub Actions で手動実行して確認"
echo "     → Actions → Daily Research Collect → Run workflow"
echo ""
