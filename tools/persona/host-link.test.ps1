# Self-test of the pure helpers of host-link.ps1 (no host, no engine). Prints PASS/FAIL lines and
# exits 1 on a failure. Run through node: node --test tools/persona/host-link.test.mjs
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'host-link.lib.ps1')
$failed = 0
function Check([string]$Name, [bool]$Ok) {
    if ($Ok) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name"; $script:failed++ }
}
function Throws([scriptblock]$Block, [string]$Like) {
    try { & $Block; return $false } catch { return $_.Exception.Message -like $Like }
}

$l = Split-LaunchUrl 'http://127.0.0.1:47821/#abc123'
Check 'launch origin' ($l.Origin -eq 'http://127.0.0.1:47821')
Check 'launch token' ($l.Token -eq 'abc123')
Check 'launch without token' (Throws { Split-LaunchUrl 'http://127.0.0.1:47821/' } '*token*')

Check 'copy under .vide' (Test-UnderVide 'C:\repo\.vide\loop\r3\small.3dm' 'C:\repo')
Check 'original outside .vide' (-not (Test-UnderVide 'C:\Users\me\Desktop\project.3dm' 'C:\repo'))
Check 'no .vide prefix trick' (-not (Test-UnderVide 'C:\repo\.videx\a.3dm' 'C:\repo'))
Check 'no .. escape' (-not (Test-UnderVide 'C:\repo\.vide\..\real.3dm' 'C:\repo'))

$projects = @(
    [pscustomobject]@{ id = 'p1'; name = '검증 루프 R1' },
    [pscustomobject]@{ id = 'p2'; name = '실사용 검증 20261007' },
    [pscustomobject]@{ id = 'p3'; name = '검증 루프 R1' }
)
Check 'project by name' ((Select-ProjectByName $projects[0..1] '검증 루프 R1').id -eq 'p1')
Check 'duplicate project names refused' (Throws { Select-ProjectByName $projects '검증 루프 R1' } '*2 projects*')
Check 'non-loop project refused' (Throws { Select-ProjectByName $projects '실사용 검증 20261007' } "*'검증 루프*")
Check 'non-loop project with -AnyProject' ((Select-ProjectByName $projects '실사용 검증 20261007' -AnyProject).id -eq 'p2')

$rhinoEntries = @('link:p1', 'link:66a46127')
Check 'rhino foreign entries' ((@(Get-ForeignLinkEntries $rhinoEntries 'p1') -join ',') -eq 'link:66a46127')
Check 'zwcad foreign entries' ((@(Get-ForeignLinkEntries @('p1', 'p2') 'p1') -join ',') -eq 'p2')
Check 'no entries' (@(Get-ForeignLinkEntries @() 'p1').Count -eq 0)

Check 'project dialog' ((Get-DialogKind 'VIDE에 연결 · small.3dm') -eq 'project')
Check 'choice dialog' ((Get-DialogKind 'VIDE 연결 · small.3dm') -eq 'choice')
Check 'error box' ((Get-DialogKind 'VIDE') -eq 'error')
Check 'other window' ($null -eq (Get-DialogKind 'Rhino 8 - small.3dm'))
Check 'closed reason' ((Get-ChoiceReason '이 프로젝트에 이 문서일 수 있는 닫힌 연결 파일이 있습니다. 어느 쪽으로 연결할까요?') -eq 'closed')
Check 'copy reason' ((Get-ChoiceReason '같은 연결 ID를 갖고 있습니다(파일 사본).') -eq 'copy')

$since = [DateTime]::Parse('2026-10-14T05:00:00Z').ToUniversalTime()
$doc = 'C:\repo\.vide\loop\r3\small.3dm'
$rows = @(
    [pscustomobject]@{ id = 'old'; host = 'rhino'; kind = 'host'; name = 'small.3dm'; path = $doc; connection = $null; lastSync = $null },
    [pscustomobject]@{ id = 'cad'; host = 'zwcad'; kind = 'host'; name = 'cad.dwg'; path = 'C:\repo\.vide\cad.dwg'; connection = @{ live = $true }; lastSync = $null }
)
Check 'closed row is not the link' ((Find-LinkedRow $rows 'rhino' $doc $since).State -eq 'waiting')
$rows += [pscustomobject]@{ id = 'new'; host = 'rhino'; kind = 'host'; name = 'small.3dm'; path = 'C:/repo/.vide/loop/r3/small.3dm'; connection = @{ live = $true }; lastSync = [pscustomobject]@{ requestId = 'q0'; at = '2026-10-14T04:59:00.000Z' } }
$found = Find-LinkedRow $rows 'rhino' $doc $since
Check 'linked row (slashes, case)' ($found.Row.id -eq 'new' -and $found.State -eq 'linked')
$rows[2].lastSync = [pscustomobject]@{ requestId = 'q1'; at = '2026-10-14T05:00:03.000Z' }
$found = Find-LinkedRow $rows 'rhino' $doc $since
Check 'first Sync after the link' ($found.State -eq 'synced' -and $found.Row.lastSync.requestId -eq 'q1')
$failedRow = [pscustomobject]@{ id = 'f'; host = 'zwcad'; kind = 'host'; name = 'cad.dwg'; path = 'C:\repo\.vide\cad.dwg'; connection = @{ live = $true }; lastSync = $null; lastError = 'HOST_RESULT_UNKNOWN' }
Check 'failed first Sync' ((Find-LinkedRow @($failedRow) 'zwcad' 'C:\repo\.vide\cad.dwg' $since).State -eq 'failed')

$a = [pscustomobject]@{ id = 'ab63a9e0'; path = 'C:\work\cad.dwg'; name = 'cad.dwg'; instance = '1:2'; documentId = 3; updatedAt = '2026-10-07T01:00:00Z' }
$b = [pscustomobject]@{ id = 'ab63a9e0'; path = 'C:\repo\.vide\loop\r2\cad\cad.dwg'; name = 'cad.dwg'; instance = '1:2'; documentId = 3; updatedAt = '2026-10-09T05:50:31Z' }
$changes = @(Compare-LinkSnapshots @{ p2 = @($a) } @{ p2 = @($b) })
Check 'other project link changed' (@($changes).Count -eq 1 -and $changes[0].change -eq 'changed' -and $changes[0].project -eq 'p2')
Check 'nothing changed' (@(Compare-LinkSnapshots @{ p2 = @($a) } @{ p2 = @($a) }).Count -eq 0)
Check 'row added' (@(Compare-LinkSnapshots @{ p2 = @() } @{ p2 = @($a) })[0].change -eq 'added')

$py = New-RhinoCheckScript 'C:\repo\.vide\x\stored-links.json' 'p1' $true
Check 'check script path' ($py -like "*C:/repo/.vide/x/stored-links.json*")
Check 'check script strips other projects only' ($py -like "*if True:*" -and $py -like "*if n != 'link:p1':*")
Check 'check script without strip' ((New-RhinoCheckScript 'a.json' 'p1' $false) -like '*if False:*')

# T-292: the first Sync's ms comes from the engine log's `sync` line, found by request id.
$logLines = @(
    '{"at":"2026-10-14T05:00:01.000Z","event":"sync-begin","request":"bb1e9031-x"}',
    'not json',
    '{"at":"2026-10-14T05:00:02.400Z","v":"0.2.34","event":"sync","request":"other","ms":9,"hostMs":1}',
    '{"at":"2026-10-14T05:00:02.410Z","v":"0.2.34","event":"sync","request":"bb1e9031-x","projectId":"p1","host":"rhino","state":"succeeded","ms":1408,"hostMs":634,"objects":3045}'
)
$entry = Find-SyncLogEntry $logLines 'bb1e9031-x'
Check 'sync log ms' ($entry.ms -eq 1408 -and $entry.hostMs -eq 634 -and $entry.objects -eq 3045 -and $entry.state -eq 'succeeded')
Check 'sync log missing' ($null -eq (Find-SyncLogEntry $logLines 'nope'))
Check 'sync log empty' ($null -eq (Find-SyncLogEntry @() 'bb1e9031-x'))
$engines = @(
    @{ Dir = 'C:\Users\me\AppData\Local\VIDE'; Port = 47821; LaunchUrl = 'http://127.0.0.1:47821/#t' },
    @{ Dir = 'C:\repo\.vide\dev-data'; Port = 47831; LaunchUrl = 'http://localhost:52010/#t' }
)
Check 'logs by launch origin (loopback names)' ((Select-EngineLogsDir 'http://127.0.0.1:52010' $engines) -eq 'C:\repo\.vide\dev-data\logs')
Check 'logs by port' ((Select-EngineLogsDir 'http://localhost:47821' @(@{ Dir = 'C:\v'; Port = 47821; LaunchUrl = $null })) -eq 'C:\v\logs')
Check 'logs unknown engine' ($null -eq (Select-EngineLogsDir 'http://127.0.0.1:40000' $engines))

# The main script parses (PowerShell 5.1 parser) and has its parameters.
$tokens = $null; $errors = $null
$main = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'host-link.ps1'
[void][System.Management.Automation.Language.Parser]::ParseFile($main, [ref]$tokens, [ref]$errors)
Check 'host-link.ps1 parses' ($errors.Count -eq 0)
$names = (Get-Command $main).Parameters.Keys
Check 'parameters' (@(@('HostApp', 'Document', 'Project', 'Launch', 'Visible', 'Close', 'StripLinkId', 'Logs') | Where-Object { $names -notcontains $_ }).Count -eq 0)
Check 'Host alias' ((Get-Command $main).Parameters['HostApp'].Aliases -contains 'Host')

if ($failed) { Write-Output "$failed failed"; exit 1 }
Write-Output 'all passed'
