param([string]$ZwcadDirectory='C:\Program Files\ZWSOFT\ZWCAD 2023')
# Builds the ZWCAD command used by dwg.mjs into .vide/build/knowledge-dwg (git-ignored).
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
$out=Join-Path $root '.vide/build/knowledge-dwg'
[IO.Directory]::CreateDirectory($out) | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:library /platform:x64 /codepage:65001 `
  ('/reference:'+(Join-Path $ZwcadDirectory 'ZwManaged.dll')) ('/reference:'+(Join-Path $ZwcadDirectory 'ZwDatabaseMgd.dll')) `
  ('/out:'+(Join-Path $out 'VIDE.KnowledgeDwg.dll')) (Join-Path $PSScriptRoot 'KnowledgeDwg.cs')
if($LASTEXITCODE -ne 0){throw 'knowledge DWG command compilation failed'}
