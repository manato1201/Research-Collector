# =============================================================
# ローカル限定 追加収集タスク(IMPROVEMENT_PLAN.md Phase 5/6/7)をタスクスケジューラに登録する
# register_task.ps1(NotebookLM AuthRefresh)と同型の構成。
# 使い方: PowerShellを「管理者として実行」で開いてから .\register_local_extra_task.ps1
# =============================================================

$TaskName = "ResearchCollector LocalExtra"
$BatPath  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector\run_local_extra_collect.bat"
$WorkDir  = "C:\Users\matuu\Desktop\GameDevelopment\Research-Collector"

Write-Host ""
Write-Host "======================================"  -ForegroundColor Cyan
Write-Host "  ローカル限定タスク登録スクリプト"       -ForegroundColor Cyan
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

# 実行対象スクリプトの存在チェック（gitignore対象のためcloneしただけでは存在しない）
if (-not (Test-Path $BatPath)) {
    Write-Host "  ❌ $BatPath が見つかりません" -ForegroundColor Red
    Write-Host "  local_collect_extra.py / run_local_extra_collect.bat はgitignore対象のローカル限定ファイルです。" -ForegroundColor Yellow
    Write-Host "  先にこれらのファイルを作成してから、再度実行してください。" -ForegroundColor Yellow
    exit 1
}

# トリガー: 1日1回(06:15) — 「NotebookLM AuthRefresh」の06:00トリガー直後(15分バッファ)を狙う。
# refresh_auth.ps1は毎回notebooklm loginでブラウザログイン待ちになる仕様のため、
# 人がその場にいないタイミングだとローカルのstorage_state.jsonが更新されないまま
# 失効している可能性がある。AuthRefresh直後に実行することで、ログイン直後の
# フレッシュなセッションを使える可能性を上げる(2026-08-22の実機テストで、
# 認証切れ直後の実行が失敗することを確認したための対応)。
$trigger = New-ScheduledTaskTrigger -Daily -At "06:15"

# アクション: run_local_extra_collect.bat を実行
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
Write-Host "  実行時刻: 1日1回(06:15、AuthRefreshの06:00直後)"  -ForegroundColor White
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
