param([string]$ZwcadDirectory='C:\Program Files\ZWSOFT\ZWCAD 2023')
# Builds the T-225 probe used by run.mjs into .vide/build/drawing-backflow (git-ignored).
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$out=Join-Path $root '.vide/build/drawing-backflow'
[IO.Directory]::CreateDirectory($out) | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:library /platform:x64 /codepage:65001 /reference:System.Web.Extensions.dll /reference:System.Core.dll `
  ('/reference:'+(Join-Path $ZwcadDirectory 'ZwManaged.dll')) ('/reference:'+(Join-Path $ZwcadDirectory 'ZwDatabaseMgd.dll')) `
  ('/out:'+(Join-Path $out 'VIDE.BackflowProbe.dll')) (Join-Path $PSScriptRoot 'BackflowProbe.cs')
if($LASTEXITCODE -ne 0){throw 'probe compilation failed'}
