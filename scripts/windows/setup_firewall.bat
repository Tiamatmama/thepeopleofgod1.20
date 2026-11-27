@echo off
title Emotion Center - Firewall Setup
REM Must run as Administrator (right-click -> Run as administrator)

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Please run this file as Administrator.
    echo.
    pause
    exit /b 1
)

echo Removing old rules if any...
netsh advfirewall firewall delete rule name="EmotionCenter 41888" >nul 2>&1
netsh advfirewall firewall delete rule name="EmotionCenter 41443" >nul 2>&1
netsh advfirewall firewall delete rule name="EmotionCenter Block 3001" >nul 2>&1
netsh advfirewall firewall delete rule name="EmotionCenter Block 3443" >nul 2>&1
netsh advfirewall firewall delete rule name="EmotionCenter 3001" >nul 2>&1
netsh advfirewall firewall delete rule name="EmotionCenter 3443" >nul 2>&1

echo Adding rules...

REM Allow only the two current service ports (TCP)
netsh advfirewall firewall add rule name="EmotionCenter 41888" dir=in action=allow protocol=TCP localport=41888 profile=any
netsh advfirewall firewall add rule name="EmotionCenter 41443" dir=in action=allow protocol=TCP localport=41443 profile=any

REM Explicitly block the deprecated ports so nothing can ever bind-serve them to the network
netsh advfirewall firewall add rule name="EmotionCenter Block 3001" dir=in action=block protocol=TCP localport=3001 profile=any
netsh advfirewall firewall add rule name="EmotionCenter Block 3443" dir=in action=block protocol=TCP localport=3443 profile=any

echo.
echo Done. Current EmotionCenter rules:
netsh advfirewall firewall show rule name=all | findstr /C:"EmotionCenter"
echo.
pause
