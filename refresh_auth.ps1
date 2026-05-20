$REPO = "manato1201/Research-Collector"
$STORAGE_PATH = "$env:USERPROFILE\.notebooklm\storage_state.json"

Write-Host "======================================"
Write-Host "  NotebookLM Auth Refresh"
Write-Host "======================================"
Write-Host ""

# Step 1: notebooklm-py check
Write-Host "[1/5] Checking notebooklm-py..."
if (-not (Get-Command notebooklm -ErrorAction SilentlyContinue)) {
    pip install "notebooklm-py[browser]" -q
    playwright install chromium
}
Write-Host "  OK"

# Step 2: Login
Write-Host ""
Write-Host "[2/5] Starting Google login..."
Write-Host "  Browser will open. Login then press ENTER."
Write-Host ""
notebooklm login

# Step 3: Check file
Write-Host ""
Write-Host "[3/5] Checking auth file..."
if (-not (Test-Path $STORAGE_PATH)) {
    Write-Host "  ERROR: file not found."
    exit 1
}
Write-Host "  OK"

# Step 4: Update secret
Write-Host ""
Write-Host "[4/5] Updating GitHub Secret..."
$json = (Get-Content $STORAGE_PATH -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)

$ghExists = Get-Command gh -ErrorAction SilentlyContinue
if ($ghExists) {
    $null = gh auth status 2>&1
    if ($LASTEXITCODE -eq 0) {
        $json | gh secret set NOTEBOOKLM_AUTH_JSON --repo $REPO
        Write-Host "  OK: Secret updated"

        $issueJson = gh issue list --repo $REPO --label "auth-expired" --state open --json number 2>$null
        if ($issueJson) {
            $issues = $issueJson | ConvertFrom-Json
            if ($issues.Count -gt 0) {
                $num = $issues[0].number
                gh issue close $num --repo $REPO --comment "Re-authenticated."
                Write-Host "  OK: Issue #$num closed"
            }
        }
    } else {
        Write-Host "  WARNING: gh not logged in. Run: gh auth login"
        $json | Set-Clipboard
        Write-Host "  Copied to clipboard. Paste to GitHub Secrets manually."
        exit 0
    }
} else {
    Write-Host "  INFO: gh not found. Install from https://cli.github.com/"
    $json | Set-Clipboard
    Write-Host "  Copied to clipboard. Paste to GitHub Secrets manually."
    exit 0
}

# Step 5: Trigger workflows
Write-Host ""
Write-Host "[5/5] Triggering workflows..."
$day = [int](Get-Date).DayOfWeek
Write-Host "  Today: $((Get-Date).ToString('yyyy/MM/dd (dddd)'))"

gh workflow run daily_collect.yml --repo $REPO
Write-Host "  OK: Daily Research Collect"

if ($day -eq 0) {
    Start-Sleep -Seconds 3
    gh workflow run auth_check.yml --repo $REPO
    Write-Host "  OK: Weekly Auth Check (Sunday)"
}

if ($day -eq 1) {
    Start-Sleep -Seconds 3
    gh workflow run weekly_digest.yml --repo $REPO
    Write-Host "  OK: Weekly Research Digest (Monday)"
}

Write-Host ""
Write-Host "======================================"
Write-Host "  Done!"
Write-Host "======================================"
Write-Host ""
Write-Host "  https://github.com/$REPO/actions"
Write-Host ""
