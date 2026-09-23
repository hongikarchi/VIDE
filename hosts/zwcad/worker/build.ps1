param([string]$ZwcadDirectory='C:\Program Files\ZWSOFT\ZWCAD 2023')
$ErrorActionPreference='Stop'
& dotnet build (Join-Path $PSScriptRoot 'VIDE.Zwcad.Worker.csproj') --no-restore "-p:ZwcadDirectory=$ZwcadDirectory"
if($LASTEXITCODE -ne 0){throw 'ZWCAD worker compilation failed; restore the locked project dependencies first'}
