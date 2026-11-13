@echo off
chcp 65001 >nul
where pwsh.exe >nul 2>nul
if errorlevel 1 (
    echo 未找到 PowerShell 7。
    pause
    exit /b 1
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\GitPlayground.ps1" -Action Stop
if errorlevel 1 (
    pause
    exit /b 1
)
