@echo off
chcp 65001 >nul
echo -----------------------------
echo [1/3] git add .
git add .
echo.

echo [2/3] git commit -m "1"
git commit -m "1"
echo.

echo [3/3] git push
git push
echo.

echo -----------------------------
echo complete
pause >nul
