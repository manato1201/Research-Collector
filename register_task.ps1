# =============================================================
# NotebookLM 認証更新タスクをタスクスケジューラに登録する
# 使い方: .\register_task.ps1
# =============================================================

$TaskName = "NotebookLM AuthRefresh"
$BatPath  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector\run_auth_refresh.bat"
$WorkDir  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector"

Write-Host ""
Write-Host "======================================"  -ForegroundColor Cyan
Write-Host "  タスクスケジューラ登録スクリプト"     -ForegroundColor Cyan
Write-Host "======================================"  -ForegroundColor Cyan
Write-Host ""

# トリガー: 毎日 AM 5:30
$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "05:30"

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

# 登録（既存があれば上書き）
Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $trigger `
    -Action $action `
    -Settings $settings `
    -RunLevel Limited `
    -Force

Write-Host ""
Write-Host "  ✅ タスクを登録しました" -ForegroundColor Green
Write-Host "  タスク名: $TaskName"     -ForegroundColor White
Write-Host "  実行時刻: 毎日 AM 5:30"  -ForegroundColor White
Write-Host ""
Write-Host "  タスクスケジューラで確認:" -ForegroundColor Yellow
Write-Host "  スタートメニュー > タスクスケジューラ > タスクスケジューラライブラリ" -ForegroundColor White
Write-Host ""

# 手動実行して動作確認
$confirm = Read-Host "今すぐテスト実行しますか？ (y/n)"
if ($confirm -eq "y") {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "  ✅ タスクを実行しました" -ForegroundColor Green
}
