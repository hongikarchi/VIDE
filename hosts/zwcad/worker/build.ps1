param([string]$ZwcadDirectory='C:\Program Files\ZWSOFT\ZWCAD 2023')
$ErrorActionPreference='Stop'
$workspaceRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$outputDirectory=Join-Path $workspaceRoot '.vide/build/zwcad-worker'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$arguments=@('/nologo','/target:library','/platform:x64','/codepage:65001','/reference:System.Web.Extensions.dll',('/out:'+(Join-Path $outputDirectory 'VIDE.Zwcad.Worker.dll')))
foreach($name in @('ZwManaged.dll','ZwDatabaseMgd.dll')){
 $reference=(Resolve-Path -LiteralPath (Join-Path $ZwcadDirectory $name)).Path
 $arguments+=('/reference:'+$reference)
}
$arguments+=(Join-Path $PSScriptRoot 'InspectorCommand.cs')
$arguments+=(Join-Path $PSScriptRoot 'DwgReader.cs')
$arguments+=(Join-Path $PSScriptRoot 'DwgEditor.cs')
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'ZWCAD worker compilation failed'}
