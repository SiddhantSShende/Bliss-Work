@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set ANDROID_DIR=%SCRIPT_DIR%android
set OUT_DIR=%SCRIPT_DIR%build\apk

echo ========================================
echo  BlissWork Android APK Build
echo ========================================

where java >nul 2>nul
if errorlevel 1 (
  if "%JAVA_HOME%"=="" (
    echo ERROR: No Java found. Install a JDK ^(17+^) or set JAVA_HOME.
    exit /b 1
  )
)
echo OK Environment validated

cd /d "%ANDROID_DIR%"
call gradlew.bat assembleDebug --console=plain
if errorlevel 1 (
  echo ERROR: Gradle build failed.
  exit /b 1
)
echo OK Gradle build completed

set APK_SRC=%ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk
if not exist "%APK_SRC%" (
  echo ERROR: Expected APK not found at %APK_SRC%
  exit /b 1
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
set APK_DEST=%OUT_DIR%\BlissWork-debug.apk
copy /y "%APK_SRC%" "%APK_DEST%" >nul
echo OK APK generated

echo.
echo APK:
echo %APK_DEST%
