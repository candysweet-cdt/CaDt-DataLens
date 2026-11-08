@echo off
setlocal
set BIN=build\bin\CaDt-DataLens.exe
if not exist "%BIN%" (
  echo Missing %BIN%
  exit /b 1
)
echo Starting CaDt-DataLens
start "" "%BIN%" %*
endlocal
