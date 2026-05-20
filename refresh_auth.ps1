# =============================================================
# NotebookLM 再認証スクリプト（Windows PowerShell版）
# 使い方: .\refresh_auth.ps1
# 実行環境: Windows PowerShell
#
# 認証更新後、今日の曜日に応じて必要なワークフローを自動再実行します。
#
# スケジュール:
#   毎日      → Daily Research Collect
#   日曜      → Weekly Auth Check（+ Daily）
#   月曜      → Weekly Research Digest（+ Daily）
# =============================================================

$REPO = "manato1201/Research-Collector"
$STORAGE_PATH = "$env:USERPROFILE\.notebooklm\storage_state.json"

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  NotebookLM 再認証スクリプト" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------------
# Step 1: notebooklm-py の確認
# ----------------------------------------------------------------
Write-Host "📦 [1/5] notebooklm-py の確認..." -ForegroundColor Yellow
if (-not (Get-Command notebooklm -ErrorAction SilentlyContinue)) {
    Write-Host "  → インストールします..."
    pip install "notebooklm-py[browser]" -q
    playwright install chromium
} else {
    Write-Host "  → OK（インストール済み）" -ForegroundColor Green
}

# ----------------------------------------------------------------
# Step 2: ログイン
# ----------------------------------------------------------------
Write-Host ""
Write-Host "🔐 [2/5] Googleログインを開始します..." -ForegroundColor Yellow
Write-Host "  ブラウザが開いたら Google にログインして ENTER を押してください"
Write-Host ""
notebooklm login

# ----------------------------------------------------------------
# Step 3: storage_state.json の確認
# ----------------------------------------------------------------
Write-Host ""
Write-Host "✅ [3/5] 認証ファイルを確認しています..." -ForegroundColor Yellow
if (-not (Test-Path $STORAGE_PATH)) {
    Write-Host "  ❌ エラー: $STORAGE_PATH が見つかりません" -ForegroundColor Red
    exit 1
}
Write-Host "  → OK（$STORAGE_PATH）" -ForegroundColor Green

# ----------------------------------------------------------------
# Step 4: GitHub Secrets を更新
# ----------------------------------------------------------------
Write-Host ""
Write-Host "🚀 [4/5] GitHub Secrets を更新しています..." -ForegroundColor Yellow

$json = (Get-Content $STORAGE_PATH -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)

if (Get-Command gh -ErrorAction SilentlyContinue) {
    $authStatus = gh auth status 2>&1
    if ($LASTEXITCODE -eq 0) {
        # Secret を更新
        $json | gh secret set NOTEBOOKLM_AUTH_JSON --repo $REPO
        Write-Host "  ✅ NOTEBOOKLM_AUTH_JSON を自動更新しました" -ForegroundColor Green

        # auth-expired Issue があれば自動クローズ
        $issueJson = gh issue list `
            --repo $REPO `
            --label "auth-expired" `
            --state open `
            --json number 2>$null
        if ($issueJson) {
            $issues = $issueJson | ConvertFrom-Json
            if ($issues.Count -gt 0) {
                $issueNum = $issues[0].number
                gh issue close $issueNum `
                    --repo $REPO `
                    --comment "再認証完了。自動クローズしました。"
                Write-Host "  ✅ Issue #$issueNum をクローズしました" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "  ⚠️  GitHub CLI が未ログインです" -ForegroundColor Yellow
        Write-Host "  以下を実行してログインしてください: gh auth login" -ForegroundColor White
        _ManualUpdate $json $REPO
        exit 0
    }
} else {
    Write-Host "  ℹ️  GitHub CLI が未インストールです" -ForegroundColor Yellow
    Write-Host "  https://cli.github.com/ からインストールしてください" -ForegroundColor White
    _ManualUpdate $json $REPO
    exit 0
}

# ----------------------------------------------------------------
# Step 5: 曜日に応じてワークフローを自動再実行
# ----------------------------------------------------------------
Write-Host ""
Write-Host "🔄 [5/5] ワークフローを再実行しています..." -ForegroundColor Yellow

# 今日の曜日を取得（0=日曜, 1=月曜, ..., 6=土曜）
$dayOfWeek = [int](Get-Date).DayOfWeek

Write-Host "  今日: $((Get-Date).ToString('yyyy/MM/dd (dddd)'))" -ForegroundColor White

# Daily Research Collect は毎日実行
Write-Host "  → Daily Research Collect を実行..." -ForegroundColor White
gh workflow run daily_collect.yml --repo $REPO
Write-Host "    ✅ Daily Research Collect を起動しました" -ForegroundColor Green

# 日曜日 → Weekly Auth Check も実行
if ($dayOfWeek -eq 0) {
    Start-Sleep -Seconds 3
    Write-Host "  → Weekly Auth Check を実行（日曜日のため）..." -ForegroundColor White
    gh workflow run auth_check.yml --repo $REPO
    Write-Host "    ✅ Weekly Auth Check を起動しました" -ForegroundColor Green
}

# 月曜日 → Weekly Research Digest も実行
if ($dayOfWeek -eq 1) {
    Start-Sleep -Seconds 3
    Write-Host "  → Weekly Research Digest を実行（月曜日のため）..." -ForegroundColor White
    gh workflow run weekly_digest.yml --repo $REPO
    Write-Host "    ✅ Weekly Research Digest を起動しました" -ForegroundColor Green
}

# ----------------------------------------------------------------
# 完了
# ----------------------------------------------------------------
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  完了！" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Actions タブで実行状況を確認してください:" -ForegroundColor White
Write-Host "  https://github.com/$REPO/actions" -ForegroundColor Cyan
Write-Host ""


# ----------------------------------------------------------------
# ヘルパー関数（GitHub CLIなしの場合）
# ----------------------------------------------------------------
function _ManualUpdate($json, $repo) {
    $json | Set-Clipboard
    Write-Host ""
    Write-Host "  ✅ 値をクリップボードにコピーしました" -ForegroundColor Green
    Write-Host ""
    Write-Host "  手動更新の手順:" -ForegroundColor Yellow
    Write-Host "  1. https://github.com/$repo/settings/secrets/actions を開く" -ForegroundColor White
    Write-Host "  2. NOTEBOOKLM_AUTH_JSON の「Update」をクリック" -ForegroundColor White
    Write-Host "  3. クリップボードの内容を貼り付けて「Save secret」" -ForegroundColor White
    Write-Host "  4. Actions タブから必要なワークフローを手動実行" -ForegroundColor White
}
