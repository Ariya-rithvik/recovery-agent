@echo off
rem Windows launcher. Switches the console to UTF-8 first, or the box-drawing
rem characters in the output render as mojibake in a default cmd window.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.18 or newer is required: https://nodejs.org & pause & exit /b 1)

echo.
echo   STRIPE RECOVERY AGENT
echo   ---------------------
echo   1  demo        the full batch, dry run, no keys needed
echo   2  live        act on a two-row sample using the keys in .env
echo   3  tests       69 safety properties (ledger, pacer, adapters)
echo   4  demo check  everything again with all keys deleted
echo   5  calibrate   predicted vs delivered uplift, by decile
echo   6  learn       Scar: recovery-call failures to an installable skill
echo.
set /p choice=  choose 1-6:

if "%choice%"=="1" node --env-file-if-exists=.env src\recover.mjs
if "%choice%"=="2" node --env-file-if-exists=.env src\recover.mjs --live --approvers=operator1,operator2
if "%choice%"=="3" node src\policy.test.mjs && node src\pacer.test.mjs && node src\adapters.test.mjs
if "%choice%"=="4" node tools\demo-check.mjs
if "%choice%"=="5" node src\calibration.mjs
if "%choice%"=="6" node scar\src\index.ts
pause
