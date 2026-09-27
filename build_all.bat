@echo off
cd /d "%~dp0"
echo ================================================
echo   FaceID - Build automatique complet
echo ================================================

echo [1/3] Installation des dependances (une par une)...
pip install "setuptools<81" --force-reinstall
pip install opencv-python numpy pyserial Pillow pyinstaller face_recognition_models
pip install dlib-bin
pip install face_recognition --no-deps

echo.
echo Verification que tout est bien installe...
python -c "import cv2, face_recognition, numpy, PIL, pkg_resources; print('OK - tout est installe')"
if errorlevel 1 (
    echo ERREUR : une dependance manque encore. Regardez le message ci-dessus.
    pause
    exit /b 1
)

echo.
echo [2/3] Compilation de l'exe (sans console)...
pyinstaller --noconfirm --onefile --windowed --name FaceID --collect-all face_recognition_models --collect-all cv2 --hidden-import cv2 --hidden-import pkg_resources app.py

if not exist dist\FaceID.exe (
    echo ERREUR : la compilation a echoue. Regardez les messages ci-dessus.
    pause
    exit /b 1
)

echo.
echo [3/3] Creation de l'installeur (FaceID_Setup.exe)...

set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist %ISCC% set ISCC="C:\Program Files\Inno Setup 6\ISCC.exe"
if not exist %ISCC% set ISCC="C:\Program Files\Inno Setup 7\ISCC.exe"
if not exist %ISCC% set ISCC="C:\Program Files (x86)\Inno Setup 7\ISCC.exe"

if exist %ISCC% (
    %ISCC% installer.iss
    echo.
    echo TERMINE : installer_output\FaceID_Setup.exe est pret.
    echo Double-cliquez dessus pour installer FaceID comme un vrai logiciel.
) else (
    echo.
    echo Inno Setup n'est pas installe. Telechargez-le une seule fois ici :
    echo https://jrsoftware.org/isdl.php
    echo Puis relancez ce script : l'installeur sera genere automatiquement.
)

pause
