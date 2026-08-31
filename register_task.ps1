# =============================================================
# NotebookLM 認証更新タスクをタスクスケジューラに登録する
# 使い方: PowerShellを「管理者として実行」で開いてから .\register_task.ps1
# =============================================================

$TaskName = "NotebookLM AuthRefresh"
$BatPath  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector\run_auth_refresh.bat"
$WorkDir  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector"

Write-Host ""
Write-Host "======================================"  -ForegroundColor Cyan
Write-Host "  タスクスケジューラ登録スクリプト"     -ForegroundColor Cyan
Write-Host "======================================"  -ForegroundColor Cyan
Write-Host ""

# 管理者権限チェック（Register-ScheduledTaskはアクセス拒否になりやすいため事前に検出する）
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "  ❌ 管理者権限が必要です" -ForegroundColor Red
    Write-Host "  PowerShellを「管理者として実行」で開き直してから、再度実行してください。" -ForegroundColor Yellow
    exit 1
}

# トリガー: 1日2回(6:00 / 18:00) — daily_collect.ymlのスケジュールに合わせる
$trigger = @(
    New-ScheduledTaskTrigger -Daily -At "06:00"
    New-ScheduledTaskTrigger -Daily -At "18:00"
)

# アクション: run_auth_refresh.bat を実行
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$BatPath`"" `
    -WorkingDirectory $WorkDir

# 設定
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# 登録（既存があれば上書き）。失敗時は必ず気づけるようtry/catchで判定する。
try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Trigger $trigger `
        -Action $action `
        -Settings $settings `
        -RunLevel Limited `
        -Force `
        -ErrorAction Stop | Out-Null
} catch {
    Write-Host ""
    Write-Host "  ❌ タスクの登録に失敗しました" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  ✅ タスクを登録しました" -ForegroundColor Green
Write-Host "  タスク名: $TaskName"     -ForegroundColor White
Write-Host "  実行時刻: 1日2回(6:00 / 18:00)"  -ForegroundColor White
Write-Host ""
Write-Host "  タスクスケジューラで確認:" -ForegroundColor Yellow
Write-Host "  スタートメニュー > タスクスケジューラ > タスクスケジューラライブラリ" -ForegroundColor White
Write-Host ""

# 手動実行して動作確認
$confirm = Read-Host "今すぐテスト実行しますか？ (y/n)"
if ($confirm -eq "y") {
    try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Host "  ✅ タスクを実行しました" -ForegroundColor Green
    } catch {
        Write-Host "  ❌ タスクの実行に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
    }
}
