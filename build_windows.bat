@echo off
pip install pyinstaller face_recognition_models

echo === Etape 1 : build de test (avec console, pour voir les erreurs) ===
pyinstaller --noconfirm --onefile --name FaceID_debug --collect-all face_recognition_models --collect-all cv2 app.py

echo.
echo Lancez dist\FaceID_debug.exe : si une fenetre console s'ouvre avec une erreur, corrigez-la avant l'etape 2.
pause

echo === Etape 2 : build final sans console ===
pyinstaller --noconfirm --onefile --windowed --name FaceID --collect-all face_recognition_models --collect-all cv2 app.py

echo.
echo L'executable final est dans dist\FaceID.exe
pause
