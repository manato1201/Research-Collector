@echo off
:: =============================================================
:: NotebookLM 認証更新バッチファイル
:: タスクスケジューラから自動起動される
:: =============================================================

:: PowerShellウィンドウをわかりやすいタイトルで開く
title NotebookLM 認証更新

:: refresh_auth.ps1 を実行
:: -ExecutionPolicy Bypass: 実行ポリシーを一時的に無効化
:: -File: 実行するスクリプトのパス
powershell.exe -ExecutionPolicy Bypass -File "%~dp0refresh_auth.ps1"

:: 完了後にウィンドウを5秒間表示してから閉じる
echo.
echo 5秒後にウィンドウを閉じます...
timeout /t 5
