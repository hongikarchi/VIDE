# 수동 확인 전용 (PLAN-26 T-091): PC 프로그램 셸의 탐색기형 폴더 선택 창(src/desktop/shell/FolderPicker.cs)을
# 실제로 띄운다. 무인 실행 금지 — 바탕화면에 창이 뜬다. 인자 없이 실행하면 컴파일만 확인한다.
# 출력·창 제목은 영어로 둔다(Windows PowerShell 5.1은 BOM 없는 UTF-8 스크립트를 ANSI로 읽는다).
#   powershell -ExecutionPolicy Bypass -File tests/integration/manual-folder-picker.ps1           # 컴파일만
#   powershell -STA -ExecutionPolicy Bypass -File tests/integration/manual-folder-picker.ps1 -Open # 창 열기
# 사람이 확인할 것: 왼쪽에 즐겨찾기(빠른 액세스)·주소 표시줄이 보이는지, 한글 폴더 경로가 그대로 찍히는지,
# 취소하면 '(cancelled)'인지, 다른 드라이브·연결된 네트워크 드라이브를 고르면 그 경로가 그대로 찍히는지.
param([switch]$Open)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\src\desktop\shell\FolderPicker.cs'
Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 $source) -Language CSharp
if (-not $Open) {
    'FolderPicker compiled. Run with -Open to show the real dialog.'
    return
}
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'Needs an STA thread: run with powershell -STA.'
}
$path = [Vide.Desktop.FolderPicker]::Pick([IntPtr]::Zero, 'VIDE project folder (manual check)')
if ($null -eq $path) { '(cancelled)' } else { "Chosen: $path" }
