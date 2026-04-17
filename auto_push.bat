@echo off
chcp 65001 >nul
echo -----------------------------
echo [1/3] 执行 git add .
git add .
echo.

echo [2/3] 执行 git commit -m "1"
git commit -m "1"
echo.

echo [3/3] 执行 git push
git push
echo.

echo -----------------------------
echo 推送完成！按任意键退出...
pause >nul
