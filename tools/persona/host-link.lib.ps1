# Pure helpers of host-link.ps1 (PLAN-51 T-286). No host, no network, no UI: dot-sourced by
# host-link.ps1 and tested by host-link.test.ps1 (node --test tools/persona/host-link.test.mjs).
# Windows PowerShell 5.1. Saved as UTF-8 with BOM so the Korean literals read right in 5.1.

# The engine's launch link `http://127.0.0.1:47821/#<token>` → origin and token.
function Split-LaunchUrl([string]$Launch) {
    $uri = [Uri]$Launch
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) { throw "Launch is not an http url: $Launch" }
    $token = $uri.Fragment.TrimStart('#')
    if (-not $token) { throw 'Launch has no #token' }
    [pscustomobject]@{ Origin = $uri.GetLeftPart([UriPartial]::Authority); Token = $token }
}

# Whether a document path is a copy under the repository's .vide folder (AI.md §8: hosts open
# copies only, never the person's originals).
function Test-UnderVide([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $vide = [IO.Path]::GetFullPath((Join-Path $Root '.vide')).TrimEnd('\') + '\'
    return $full.StartsWith($vide, [StringComparison]::OrdinalIgnoreCase)
}

# The one project with exactly this name; only '검증 루프 …' projects unless -AnyProject.
function Select-ProjectByName($Projects, [string]$Name, [switch]$AnyProject) {
    $found = @($Projects | Where-Object { $_.name -eq $Name })
    if ($found.Count -eq 0) { throw "No project named '$Name'" }
    if ($found.Count -gt 1) { throw "$($found.Count) projects are named '$Name'; rename one" }
    if (-not $AnyProject -and -not $Name.StartsWith('검증 루프')) {
        throw "Only dedicated projects named '검증 루프 …' are linked (got '$Name'; -AnyProject on a dev engine)"
    }
    return $found[0]
}

# Link ids a document stores for OTHER projects (ADR-030). Rhino entries are document user text
# names in section VIDE ('link:<projectId>'); ZWCAD entries are the keys of the VIDE_LINKS
# dictionary ('<projectId>'). A stored id of another project makes that project's link follow this
# window as soon as the document is attached (round 2: '실사용 검증 20261007' Link ab63a9e0).
function Get-ForeignLinkEntries($Entries, [string]$ProjectId) {
    @($Entries | Where-Object { $_ } | Where-Object {
            $key = if ($_.StartsWith('link:')) { $_.Substring(5) } else { $_ }
            $key -ne $ProjectId
        })
}

# Which VIDE dialog a host window is, by its title: the project pick ('VIDE에 연결 · <doc>'), the
# link choice ('VIDE 연결 · <doc>', SPEC-01.11 1), a VIDE error box ('VIDE'), or $null.
function Get-DialogKind([string]$Title) {
    if ($Title.StartsWith('VIDE에 연결 · ')) { return 'project' }
    if ($Title.StartsWith('VIDE 연결 · ')) { return 'choice' }
    if ($Title -eq 'VIDE') { return 'error' }
    return $null
}

# The reason of a link-choice dialog from its text: 'closed' (a closed link file may be this one)
# or 'copy' (another window holds the same stored link id).
function Get-ChoiceReason([string]$Text) {
    if ($Text -like '*파일 사본*') { return 'copy' }
    if ($Text -like '*닫힌 연결 파일이 있습니다*') { return 'closed' }
    return 'unknown'
}

function ConvertTo-ComparablePath([string]$Path) {
    if (-not $Path) { return '' }
    return ($Path -replace '/', '\').TrimEnd('\').ToLowerInvariant()
}

# The project's link row of this document once its first Sync after $Since finished: a host row
# of $HostName with an open connection and the document's path (or file name). Returns
# @{ Row; State = 'waiting'|'linked'|'synced'|'failed' }.
function Find-LinkedRow($Rows, [string]$HostName, [string]$DocumentPath, [DateTime]$Since) {
    $want = ConvertTo-ComparablePath $DocumentPath
    $leaf = [IO.Path]::GetFileName($DocumentPath).ToLowerInvariant()
    $hits = @($Rows | Where-Object {
            $_.host -eq $HostName -and $_.kind -ne 'file' -and $_.connection -and (
                (ConvertTo-ComparablePath ([string]$_.path)) -eq $want -or ([string]$_.name).ToLowerInvariant() -eq $leaf)
        })
    if ($hits.Count -eq 0) { return @{ Row = $null; State = 'waiting' } }
    $row = $hits[0]
    $props = $row.PSObject.Properties.Name
    if ($props -contains 'lastSync' -and $row.lastSync -and $row.lastSync.at) {
        $at = [DateTime]::Parse([string]$row.lastSync.at, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($at -ge $Since.ToUniversalTime()) { return @{ Row = $row; State = 'synced' } }
    }
    if ($props -contains 'lastError' -and $row.lastError) { return @{ Row = $row; State = 'failed' } }
    return @{ Row = $row; State = 'linked' }
}

# The fields of a link row that change when another window takes it over (path, window, name).
function Get-LinkFingerprint($Row) {
    $c = if ($Row.PSObject.Properties.Name -contains 'connection') { $Row.connection } else { $null }
    $updated = if ($Row.PSObject.Properties.Name -contains 'updatedAt') { $Row.updatedAt } else { '' }
    return '{0}|{1}|{2}|{3}|{4}' -f $Row.path, $Row.name, $Row.instance, $Row.documentId, $updated
}

# Rows of other projects that changed or appeared between two snapshots
# (@{ <projectId> = @(rows) }): the T-286 check '다른 프로젝트 Link 변경 0'.
function Compare-LinkSnapshots($Before, $After) {
    $changes = @()
    foreach ($projectId in $After.Keys) {
        $old = @{}
        if ($Before.ContainsKey($projectId)) { foreach ($row in $Before[$projectId]) { $old[$row.id] = Get-LinkFingerprint $row } }
        foreach ($row in $After[$projectId]) {
            $now = Get-LinkFingerprint $row
            if (-not $old.ContainsKey($row.id)) { $changes += [pscustomobject]@{ project = $projectId; link = $row.id; change = 'added'; path = $row.path } }
            elseif ($old[$row.id] -ne $now) { $changes += [pscustomobject]@{ project = $projectId; link = $row.id; change = 'changed'; path = $row.path } }
        }
    }
    return $changes   # callers wrap it in @()
}

# The IronPython/Python 3 script Rhino runs before _VIDELink (host-link.ps1 chains them in
# /runscript): reports the document's stored link entries and, with $Strip, deletes the entries of
# other projects from the open document (in memory; host-link never saves).
function New-RhinoCheckScript([string]$ReportPath, [string]$ProjectId, [bool]$Strip) {
    $report = $ReportPath -replace '\\', '/'
    $flag = if ($Strip) { 'True' } else { 'False' }
    return @"
import Rhino, json, os
doc = Rhino.RhinoDoc.ActiveDoc
out = {'path': doc.Path if doc else None, 'entries': [], 'removed': []}
try:
    names = list(doc.Strings.GetEntryNames('VIDE') or []) if doc else []
    out['entries'] = [n for n in names if n.startswith('link:')]
    if ${flag}:
        for n in out['entries']:
            if n != 'link:$ProjectId':
                doc.Strings.Delete('VIDE', n)
                out['removed'].append(n)
except Exception as error:
    out['error'] = str(error)
with open('$report' + '.tmp', 'w') as f:
    json.dump(out, f)
os.rename('$report' + '.tmp', '$report')
"@
}
