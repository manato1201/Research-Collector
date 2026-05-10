# =============================================================
# NotebookLM 再認証スクリプト（Windows PowerShell版）
# 使い方: .\refresh_auth.ps1
# 実行環境: Windows PowerShell / PowerShell 7
# =============================================================

$REPO = "manato1201/Research-Collector"
$STORAGE_PATH = "$env:USERPROFILE\.notebooklm\storage_state.json"

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  NotebookLM 再認証スクリプト" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: notebooklm-py の確認
Write-Host "📦 [1/4] notebooklm-py の確認..." -ForegroundColor Yellow
if (-not (Get-Command notebooklm -ErrorAction SilentlyContinue)) {
    Write-Host "  → インストールします..."
    pip install "notebooklm-py[browser]" -q
    playwright install chromium
} else {
    Write-Host "  → OK（インストール済み）" -ForegroundColor Green
}

# Step 2: ログイン
Write-Host ""
Write-Host "🔐 [2/4] Googleログインを開始します..." -ForegroundColor Yellow
Write-Host "  ブラウザが開いたら Google にログインして ENTER を押してください"
Write-Host ""
notebooklm login

# Step 3: storage_state.json の確認
Write-Host ""
Write-Host "✅ [3/4] 認証ファイルを確認しています..." -ForegroundColor Yellow
if (-not (Test-Path $STORAGE_PATH)) {
    Write-Host "  ❌ エラー: $STORAGE_PATH が見つかりません" -ForegroundColor Red
    exit 1
}
Write-Host "  → OK（$STORAGE_PATH）" -ForegroundColor Green

# Step 4: GitHub Secrets を更新
Write-Host ""
Write-Host "🚀 [4/4] GitHub Secrets を更新しています..." -ForegroundColor Yellow

# 1行JSONに圧縮
$json = (Get-Content $STORAGE_PATH -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)

# GitHub CLIで自動更新
if (Get-Command gh -ErrorAction SilentlyContinue) {
    $authStatus = gh auth status 2>&1
    if ($LASTEXITCODE -eq 0) {
        # Secret を更新
        $json | gh secret set NOTEBOOKLM_AUTH_JSON --repo $REPO
        Write-Host "  ✅ NOTEBOOKLM_AUTH_JSON を自動更新しました" -ForegroundColor Green

        # auth-expired Issue があれば自動クローズ
        $issueJson = gh issue list --repo $REPO --label "auth-expired" --state open --json number 2>/dev/null
        if ($issueJson) {
            $issues = $issueJson | ConvertFrom-Json
            if ($issues.Count -gt 0) {
                $issueNum = $issues[0].number
                gh issue close $issueNum --repo $REPO --comment "再認証完了。自動クローズしました。"
                Write-Host "  ✅ Issue #$issueNum をクローズしました" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "  ⚠️  GitHub CLI が未ログインです" -ForegroundColor Yellow
        Write-Host "  以下を実行してログインしてください:" -ForegroundColor Yellow
        Write-Host "     gh auth login" -ForegroundColor White
        _ManualUpdate $json $REPO
    }
} else {
    Write-Host "  ℹ️  GitHub CLI が未インストールです" -ForegroundColor Yellow
    Write-Host "  https://cli.github.com/ からインストールしてください" -ForegroundColor White
    _ManualUpdate $json $REPO
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  完了！" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ---- ヘルパー関数 ----
function _ManualUpdate($json, $repo) {
    # クリップボードにコピー
    $json | Set-Clipboard
    Write-Host ""
    Write-Host "  ✅ 値をクリップボードにコピーしました" -ForegroundColor Green
    Write-Host ""
    Write-Host "  手動更新の手順:" -ForegroundColor Yellow
    Write-Host "  1. 以下のURLを開く:" -ForegroundColor White
    Write-Host "     https://github.com/$repo/settings/secrets/actions" -ForegroundColor Cyan
    Write-Host "  2. NOTEBOOKLM_AUTH_JSON の「Update」をクリック" -ForegroundColor White
    Write-Host "  3. クリップボードの内容を貼り付けて「Save secret」" -ForegroundColor White
    Write-Host "  4. auth-expired Issue があれば手動でクローズ" -ForegroundColor White
}
