#!/bin/bash
# =============================================================
# NotebookLM 再認証スクリプト
# 使い方: bash refresh_auth.sh
# 実行環境: WSL2（Ubuntu）
#
# GitHub CLI（gh）がインストールされている場合は
# GitHub Secretsを自動で更新します。
# =============================================================

set -e

REPO="manato1201/Research-Collector"
STORAGE_PATH="$HOME/.notebooklm/storage_state.json"

echo ""
echo "======================================"
echo "  NotebookLM 再認証スクリプト"
echo "======================================"
echo ""

# Step 1: notebooklm-py の確認
echo "📦 [1/5] notebooklm-py の確認..."
if ! command -v notebooklm &> /dev/null; then
    echo "  → インストールします..."
    pip install "notebooklm-py[browser]" -q
    playwright install chromium -q
else
    echo "  → OK（インストール済み）"
fi

# Step 2: ログイン
echo ""
echo "🔐 [2/5] Googleログインを開始します..."
echo "  ブラウザが開いたら Google にログインして ENTER を押してください"
echo ""
notebooklm login

# Step 3: storage_state.json の確認
echo ""
echo "✅ [3/5] 認証ファイルを確認しています..."
if [ ! -f "$STORAGE_PATH" ]; then
    echo "  ❌ エラー: $STORAGE_PATH が見つかりません"
    exit 1
fi
echo "  → OK（$STORAGE_PATH）"

# Step 4: 1行JSONに圧縮
echo ""
echo "📋 [4/5] GitHub Secrets 用の値を生成しています..."
JSON_VALUE=$(cat "$STORAGE_PATH" | python3 -c \
    "import sys,json; print(json.dumps(json.load(sys.stdin)))")

# Step 5: GitHub Secretsの更新
echo ""
echo "🚀 [5/5] GitHub Secrets を更新しています..."

if command -v gh &> /dev/null; then
    # GitHub CLIがある場合は自動更新
    if gh auth status &> /dev/null 2>&1; then
        echo "$JSON_VALUE" | gh secret set NOTEBOOKLM_AUTH_JSON \
            --repo "$REPO"
        echo "  ✅ NOTEBOOKLM_AUTH_JSON を自動更新しました"

        # auth-expired Issueがあれば閉じる
        ISSUE_NUM=$(gh issue list \
            --repo "$REPO" \
            --label "auth-expired" \
            --state open \
            --json number \
            --jq '.[0].number' 2>/dev/null || echo "")

        if [ -n "$ISSUE_NUM" ] && [ "$ISSUE_NUM" != "null" ]; then
            gh issue close "$ISSUE_NUM" \
                --repo "$REPO" \
                --comment "再認証完了。自動クローズしました。"
            echo "  ✅ Issue #$ISSUE_NUM をクローズしました"
        fi
    else
        echo "  ⚠️  GitHub CLI が未ログインです"
        echo "  以下を実行してログインしてください:"
        echo "     gh auth login"
        echo ""
        _copy_to_clipboard "$JSON_VALUE"
    fi
else
    # GitHub CLIがない場合はクリップボードにコピー
    echo "  ℹ️  GitHub CLI が未インストールです（手動更新が必要）"
    _copy_to_clipboard "$JSON_VALUE"
fi

echo ""
echo "======================================"
echo "  完了！"
echo "======================================"
echo ""


# ---- ヘルパー関数 ----
_copy_to_clipboard() {
    local value="$1"
    local copied=false

    if command -v xclip &> /dev/null; then
        echo "$value" | xclip -selection clipboard && copied=true
    elif command -v xsel &> /dev/null; then
        echo "$value" | xsel --clipboard --input && copied=true
    elif command -v clip.exe &> /dev/null; then
        echo "$value" | clip.exe && copied=true
    fi

    if [ "$copied" = true ]; then
        echo "  ✅ 値をクリップボードにコピーしました"
    else
        echo "  ⚠️  クリップボードへのコピーに失敗しました"
        echo "  以下の値を手動でコピーしてください:"
        echo ""
        echo "$value"
        echo ""
    fi

    echo ""
    echo "  手動更新の手順:"
    echo "  1. https://github.com/$REPO/settings/secrets/actions を開く"
    echo "  2. NOTEBOOKLM_AUTH_JSON の「Update」をクリック"
    echo "  3. クリップボードの内容を貼り付けて「Save secret」"
    echo "  4. auth-expired Issue があれば手動でクローズ"
}
