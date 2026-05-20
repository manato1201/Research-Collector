# =============================================================
# NotebookLM 再認証スクリプト（Windows PowerShell版）
# 使い方: .\refresh_auth.ps1
# =============================================================

$REPO         = "manato1201/Research-Collector"
$STORAGE_PATH = "$env:USERPROFILE\.notebooklm\storage_state.json"

# ----------------------------------------------------------------
# ヘルパー関数（PowerShellでは使う前に定義する必要がある）
# ----------------------------------------------------------------
function Invoke-ManualUpdate {
    param($Json, $Repo)
    $Json | Set-Clipboard
    Write-Host ""
    Write-Host "  Copied to clipboard." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Manual steps:" -ForegroundColor Yellow
    Write-Host "  1. Open: https://github.com/$Repo/settings/secrets/actions" -ForegroundColor White
    Write-Host "  2. Click 'Update' on NOTEBOOKLM_AUTH_JSON" -ForegroundColor White
    Write-Host "  3. Paste and save" -ForegroundColor White
}

function Invoke-WorkflowsByDay {
    param($Repo)
    $day = [int](Get-Date).DayOfWeek
    Write-Host "  Today: $((Get-Date).ToString('yyyy/MM/dd (dddd)'))" -ForegroundColor White

    # 毎日: Daily Research Collect
    gh workflow run daily_collect.yml --repo $Repo
    Write-Host "    OK: Daily Research Collect" -ForegroundColor Green

    # 日曜: Weekly Auth Check も実行
    if ($day -eq 0) {
        Start-Sleep -Seconds 3
        gh workflow run auth_check.yml --repo $Repo
        Write-Host "    OK: Weekly Auth Check (Sunday)" -ForegroundColor Green
    }

    # 月曜: Weekly Research Digest も実行
    if ($day -eq 1) {
        Start-Sleep -Seconds 3
        gh workflow run weekly_digest.yml --repo $Repo
        Write-Host "    OK: Weekly Research Digest (Monday)" -ForegroundColor Green
    }
}

# ----------------------------------------------------------------
# Step 1: notebooklm-py の確認
# ----------------------------------------------------------------
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  NotebookLM Auth Refresh" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/5] Checking notebooklm-py..." -ForegroundColor Yellow
if (-not (Get-Command notebooklm -ErrorAction SilentlyContinue)) {
    Write-Host "  Installing..."
    pip install "notebooklm-py[browser]" -q
    playwright install chromium
} else {
    Write-Host "  OK" -ForegroundColor Green
}

# ----------------------------------------------------------------
# Step 2: ログイン
# ----------------------------------------------------------------
Write-Host ""
Write-Host "[2/5] Starting Google login..." -ForegroundColor Yellow
Write-Host "  Browser will open. Login to Google then press ENTER."
Write-Host ""
notebooklm login

# ----------------------------------------------------------------
# Step 3: storage_state.json の確認
# ----------------------------------------------------------------
Write-Host ""
Write-Host "[3/5] Checking auth file..." -ForegroundColor Yellow
if (-not (Test-Path $STORAGE_PATH)) {
    Write-Host "  ERROR: $STORAGE_PATH not found." -ForegroundColor Red
    exit 1
}
Write-Host "  OK ($STORAGE_PATH)" -ForegroundColor Green

# ----------------------------------------------------------------
# Step 4: GitHub Secrets を更新
# ----------------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Updating GitHub Secrets..." -ForegroundColor Yellow

$json = (Get-Content $STORAGE_PATH -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)

if (Get-Command gh -ErrorAction SilentlyContinue) {
    $null = gh auth status 2>&1
    if ($LASTEXITCODE -eq 0) {
        $json | gh secret set NOTEBOOKLM_AUTH_JSON --repo $REPO
        Write-Host "  OK: NOTEBOOKLM_AUTH_JSON updated" -ForegroundColor Green

        # auth-expired Issue があれば自動クローズ
        $issueJson = gh issue list --repo $REPO --label "auth-expired" --state open --json number 2>$null
        if ($issueJson) {
            $issues = $issueJson | ConvertFrom-Json
            if ($issues.Count -gt 0) {
                $issueNum = $issues[0].number
                gh issue close $issueNum --repo $REPO --comment "Re-authenticated successfully."
                Write-Host "  OK: Issue #$issueNum closed" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "  WARNING: gh not logged in. Run: gh auth login" -ForegroundColor Yellow
        Invoke-ManualUpdate $json $REPO
        exit 0
    }
} else {
    Write-Host "  INFO: GitHub CLI not found." -ForegroundColor Yellow
    Invoke-ManualUpdate $json $REPO
    exit 0
}

# ----------------------------------------------------------------
# Step 5: 曜日に応じてワークフローを自動再実行
# ----------------------------------------------------------------
Write-Host ""
Write-Host "[5/5] Triggering workflows..." -ForegroundColor Yellow
Invoke-WorkflowsByDay $REPO

# ----------------------------------------------------------------
# 完了
# ----------------------------------------------------------------
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Done!" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Check Actions:" -ForegroundColor White
Write-Host "  https://github.com/$REPO/actions" -ForegroundColor Cyan
Write-Host ""
