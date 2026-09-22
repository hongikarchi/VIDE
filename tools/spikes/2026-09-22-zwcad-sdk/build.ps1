param([string]$ZwcadDirectory='C:\Program Files\ZWSOFT\ZWCAD 2023')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$workspaceRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$outputDirectory=Join-Path $workspaceRoot '.vide/build/zwcad-sdk-probe'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$references=@('ZwManaged.dll','ZwDatabaseMgd.dll') | ForEach-Object { (Resolve-Path -LiteralPath (Join-Path $ZwcadDirectory $_)).Path }
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$arguments=@('/nologo','/target:library','/platform:x64','/codepage:65001','/reference:System.Web.Extensions.dll',('/out:'+(Join-Path $outputDirectory 'VIDE.Zwcad.SdkProbe.dll')))
foreach($reference in $references){$arguments+=('/reference:'+$reference)}
$arguments+=(Join-Path $PSScriptRoot 'SdkProbe.cs')
$arguments+=(Join-Path $PSScriptRoot 'CodeProbe.cs')
$arguments+=(Join-Path $PSScriptRoot 'ChannelProbe.cs')
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'ZWCAD SDK probe compilation failed'}
$evidence=@{compiled=$true;runtimeTested=$false;references=@($references | ForEach-Object { @{name=[IO.Path]::GetFileName($_);assembly=[Reflection.AssemblyName]::GetAssemblyName($_).FullName} });output=(Join-Path $outputDirectory 'VIDE.Zwcad.SdkProbe.dll')}
$json=$evidence | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $outputDirectory 'build-result.json'),$json,[Text.UTF8Encoding]::new($false))
[Console]::WriteLine($json)
