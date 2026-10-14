<#
.SYNOPSIS
Opens a .vide/ copy in Rhino 8 or ZWCAD 2023 and links it to a VIDE project unattended
(PLAN-51 T-286). Prints one JSON object (link id, timings) on stdout; logs go to stderr.

.DESCRIPTION
Rhino:  Rhino.exe /nosplash /runscript="_-RunPythonScript (check.py) _VIDELink" <document>.
        check.py reports the document's stored VIDE link entries (ADR-030, user text section
        'VIDE', 'link:<projectId>'); then the VIDE project dialog ('VIDE에 연결 · <doc>') is driven
        through UI Automation: the project is selected by name and [Link] pressed. The optional
        second dialog ('… 닫힌 연결 파일이 있습니다' or the copy case) gets '새 연결 파일로 추가' + [연결].
ZWCAD:  ZWCAD.exe <document>; missing XREF/SHX prompts get '무시하고 계속'; the drawing's VIDE_LINKS
        dictionary is read over COM (ZWCAD.Application.2023); ZWCAD is brought to the front and
        VIDECADLink is sent over COM from a separate process (SendCommand blocks while the modal
        dialog is open); the same dialogs are driven.
Then GET /api/v1/projects/<id>/links is polled until the document's row has finished its first Sync.

Refuses (exit 2) when: the document is not under <repo>\.vide\, the same host already runs (the
person may be working), the project is not named '검증 루프 …' (unless -AnyProject), or the
document stores a link id of ANOTHER project (unless -StripLinkId, which deletes those entries in
the open document only; the file is never saved). Exit 3: linked, but a link row of another
project changed meanwhile (round-2 contamination; report it, the person decides).

-Close closes a host this script launched (state.json: pid + start time) without saving.

.EXAMPLE
powershell -NoProfile -File tools\persona\host-link.ps1 -Host rhino -Document .vide\loop\r3\small.3dm -Project '검증 루프 R1' -Launch 'http://127.0.0.1:47821/#<token>'
powershell -NoProfile -File tools\persona\host-link.ps1 -Close -Host rhino
#>
[CmdletBinding(DefaultParameterSetName = 'Link')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Link')]
    [Parameter(ParameterSetName = 'Close')]
    [Alias('Host')]
    [ValidateSet('rhino', 'zwcad')]
    [string]$HostApp,
    [Parameter(Mandatory = $true, ParameterSetName = 'Link')][string]$Document,
    [Parameter(Mandatory = $true, ParameterSetName = 'Link')][string]$Project,
    [Parameter(Mandatory = $true, ParameterSetName = 'Link')][string]$Launch,
    [Parameter(ParameterSetName = 'Link')][switch]$Visible,
    [Parameter(ParameterSetName = 'Link')][switch]$StripLinkId,
    [Parameter(ParameterSetName = 'Link')][switch]$AnyProject,
    [Parameter(ParameterSetName = 'Link')][switch]$SkipOtherProjects,
    [Parameter(ParameterSetName = 'Link')][int]$DialogTimeoutSec = 240,
    [Parameter(ParameterSetName = 'Link')][int]$SyncTimeoutSec = 600,
    [Parameter(ParameterSetName = 'Link')][string]$OutDir,
    [Parameter(Mandatory = $true, ParameterSetName = 'Close')][switch]$Close,
    [Parameter(ParameterSetName = 'Close')][string]$State
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
. (Join-Path $here 'host-link.lib.ps1')

$exe = @{
    rhino = Join-Path $env:ProgramFiles 'Rhino 8\System\Rhino.exe'
    zwcad = Join-Path $env:ProgramFiles 'ZWSOFT\ZWCAD 2023\ZWCAD.exe'
}
$image = @{ rhino = 'Rhino'; zwcad = 'ZWCAD' }
function Log([string]$Line) { [Console]::Error.WriteLine(('[{0:HH:mm:ss}] {1}' -f (Get-Date), $Line)) }
function Emit($Value, [int]$Code) { $Value | ConvertTo-Json -Depth 8 -Compress | Write-Output; exit $Code }
# Any unexpected error still prints one JSON object (the launched host, if any, stays open).
trap {
    $out = if (Get-Variable result -Scope Script -ErrorAction SilentlyContinue) { $script:result } else { [ordered]@{ ok = $false } }
    $out.reason = 'error: ' + $_.Exception.Message
    Log $_.ScriptStackTrace
    Emit $out 1
}

# --- -Close --------------------------------------------------------------------------------------
if ($Close) {
    if (-not $State) {
        $pattern = if ($HostApp) { "*-$HostApp" } else { '*' }
        $latest = Get-ChildItem (Join-Path $root '.vide\persona\host-link') -Directory -Filter $pattern -ErrorAction SilentlyContinue |
            Sort-Object Name | Select-Object -Last 1
        if (-not $latest) { Emit @{ ok = $false; reason = 'no host-link state found' } 1 }
        $State = Join-Path $latest.FullName 'state.json'
    }
    $saved = Get-Content -Raw -Encoding UTF8 $State | ConvertFrom-Json
    $process = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
    # Only the process this script launched: same pid AND same start time (a pid can be reused).
    if (-not $process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $saved.startTime) {
        Emit @{ ok = $true; closed = $false; reason = 'already closed'; pid = $saved.pid } 0
    }
    Stop-Process -Id $saved.pid -Force   # a .vide copy: nothing is saved
    Start-Sleep -Milliseconds 1500
    $left = @(Get-Process -Name $image[$saved.host] -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $saved.pid })
    Emit @{ ok = ($left.Count -eq 0); closed = $true; pid = $saved.pid; host = $saved.host; document = $saved.document } 0
}

# --- engine API (HttpClient: UTF-8 bodies, session cookie, Origin) -------------------------------
Add-Type -AssemblyName System.Net.Http
$launchParts = Split-LaunchUrl $Launch
$origin = $launchParts.Origin
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.CookieContainer = New-Object System.Net.CookieContainer
$http = New-Object System.Net.Http.HttpClient($handler)
$http.BaseAddress = [Uri]$origin
$http.Timeout = [TimeSpan]::FromSeconds(60)
[void]$http.DefaultRequestHeaders.TryAddWithoutValidation('Origin', $origin)
function Api([string]$Path, $Body) {
    if ($null -eq $Body) { $reply = $http.GetAsync('/api/v1' + $Path).GetAwaiter().GetResult() }
    else {
        $json = $Body | ConvertTo-Json -Compress -Depth 6
        $content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json')
        $reply = $http.PostAsync('/api/v1' + $Path, $content).GetAwaiter().GetResult()
    }
    $text = [Text.Encoding]::UTF8.GetString($reply.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    if (-not $reply.IsSuccessStatusCode) { throw "$Path`: $([int]$reply.StatusCode) $text" }
    # Windows PowerShell 5.1 ConvertFrom-Json emits a JSON array as ONE pipeline object; returning
    # it through a variable unrolls it so @(Api …) holds the rows, not a single array (round 3).
    if ($text) { $parsed = $text | ConvertFrom-Json; return $parsed } else { return $null }
}
function ProjectLinks([string]$Id) { @(Api "/projects/$([Uri]::EscapeDataString($Id))/links" $null) }

# --- UI Automation --------------------------------------------------------------------------------
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace HostLink -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendMessageText(IntPtr h, uint msg, IntPtr w, System.Text.StringBuilder l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
'@
$UIA = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Bring-Front([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return }
    [HostLink.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # ALT: lets this process set the foreground
    [HostLink.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][HostLink.Native]::ShowWindow($Handle, 9)               # SW_RESTORE
    [void][HostLink.Native]::SetForegroundWindow($Handle)
}
# Top-level windows of the process and their direct child windows (WPF/Eto owned dialogs).
function Get-HostWindows([int]$ProcessId) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, $ProcessId)
    $top = @($UIA::RootElement.FindAll($Tree::Children, $condition))
    $windowType = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $CT::Window)
    $nested = foreach ($w in $top) { @($w.FindAll($Tree::Children, $windowType)) }
    return @($top) + @($nested)
}
function Find-All($Element, $Type) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $Type)
    return @($Element.FindAll($Tree::Descendants, $condition))
}
# Text elements, plus WinForms labels that reach UI Automation only as STATIC Panes (ZWCAD, round 3).
function Get-Texts($Element) {
    $labels = @(Find-All $Element $CT::Pane | Where-Object { $_.Current.ClassName -like '*STATIC*' })
    @(@(Find-All $Element $CT::Text) + $labels | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' '
}
# Press/select an element: Invoke, then SelectionItem, then Toggle, else a mouse click.
function Use-Element($Element) {
    # A WinForms ListBox row found through Win32 (ZWCAD dialogs, see Find-ProjectItem): select it and
    # send LBN_SELCHANGE to the parent, which WinForms reflects as SelectedIndexChanged.
    if ($Element -is [pscustomobject] -and $Element.Kind -eq 'listbox-row') {
        [void][HostLink.Native]::SendMessage($Element.Handle, 0x0186, [IntPtr]$Element.Index, [IntPtr]::Zero)   # LB_SETCURSEL
        $wparam = [IntPtr](([int][HostLink.Native]::GetDlgCtrlID($Element.Handle)) -bor (1 -shl 16))           # LBN_SELCHANGE
        [void][HostLink.Native]::SendMessage([HostLink.Native]::GetParent($Element.Handle), 0x0111, $wparam, $Element.Handle)
        return
    }
    # A WinForms button/radio button that UI Automation shows only as a Pane: BM_CLICK, posted so a
    # modal handler behind it does not block this script.
    $handle = [IntPtr]$Element.Current.NativeWindowHandle
    if ($Element.Current.ControlType -eq $CT::Pane -and $handle -ne [IntPtr]::Zero -and $Element.Current.ClassName -like '*BUTTON*') {
        [void][HostLink.Native]::PostMessage($handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        return
    }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); return }
    $point = $Element.GetClickablePoint()
    [void][HostLink.Native]::SetCursorPos([int]$point.X, [int]$point.Y)
    [HostLink.Native]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [HostLink.Native]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
}
# ZWCAD's WinForms dialogs reach UI Automation only as Panes (round 3): a Pane of a Win32 BUTTON
# class (buttons and radio buttons) with the same name counts too.
function Find-Button($Window, [string]$Like) {
    $hit = Find-All $Window $CT::Button | Where-Object { $_.Current.Name -like $Like } | Select-Object -First 1
    if ($hit) { return $hit }
    Find-All $Window $CT::Pane | Where-Object { $_.Current.ClassName -like '*BUTTON*' -and $_.Current.Name -like $Like } | Select-Object -First 1
}
# A list item whose own name or inner text is the project name (Eto on WPF may name items by type).
function Find-ProjectItem($Window, [string]$Name) {
    foreach ($item in (Find-All $Window $CT::ListItem)) {
        if ($item.Current.Name -eq $Name) { return $item }
        if ((Get-Texts $item) -eq $Name) { return $item }
    }
    # WinForms ListBox shown as a Pane (ZWCAD): read its rows over Win32 (LB_GETCOUNT/LB_GETTEXT).
    foreach ($box in (Find-All $Window $CT::Pane | Where-Object { $_.Current.ClassName -like '*LISTBOX*' })) {
        $handle = [IntPtr]$box.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        $count = [int][HostLink.Native]::SendMessage($handle, 0x018B, [IntPtr]::Zero, [IntPtr]::Zero)
        for ($i = 0; $i -lt $count; $i++) {
            $length = [int][HostLink.Native]::SendMessage($handle, 0x018A, [IntPtr]$i, [IntPtr]::Zero)
            if ($length -lt 0) { continue }
            $text = New-Object System.Text.StringBuilder ($length + 1)
            [void][HostLink.Native]::SendMessageText($handle, 0x0189, [IntPtr]$i, $text)
            if ($text.ToString() -eq $Name) { return [pscustomobject]@{ Kind = 'listbox-row'; Handle = $handle; Index = $i } }
        }
    }
    return $null
}

# --- preflight -----------------------------------------------------------------------------------
$started = Get-Date
$documentPath = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($Document)) { $Document } else { Join-Path $root $Document }))
$result = [ordered]@{
    ok = $false; host = $HostApp; document = $documentPath; project = $null; pid = $null
    storedLinkEntries = @(); strippedLinkEntries = @(); choice = $null; linkId = $null; firstSync = $null
    timings = [ordered]@{}; otherProjectLinksChanged = @(); state = $null; reason = $null
}
if (-not (Test-Path -LiteralPath $documentPath)) { $result.reason = "no document $documentPath"; Emit $result 2 }
if (-not (Test-UnderVide $documentPath $root)) { $result.reason = "not a .vide copy: $documentPath (AI.md §8)"; Emit $result 2 }
if (Get-Process -Name $image[$HostApp] -ErrorAction SilentlyContinue) {
    $result.reason = "a $($image[$HostApp]) is running; the person may be working"; Emit $result 2
}
if (-not (Test-Path -LiteralPath $exe[$HostApp])) { $result.reason = "no $($exe[$HostApp])"; Emit $result 2 }

$session = Api '/session' @{ token = $launchParts.Token }
$projects = @(Api '/projects' $null)
try { $target = Select-ProjectByName $projects $Project -AnyProject:$AnyProject }
catch { $result.reason = $_.Exception.Message; Emit $result 2 }
$result.project = [ordered]@{ id = $target.id; name = $target.name }
$before = @{}
if (-not $SkipOtherProjects) { foreach ($p in $projects) { if ($p.id -ne $target.id) { $before[$p.id] = ProjectLinks $p.id } } }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$run = if ($OutDir) { $OutDir } else { Join-Path $root ".vide\persona\host-link\$stamp-$HostApp" }
New-Item -ItemType Directory -Force -Path $run | Out-Null
$statePath = Join-Path $run 'state.json'
$result.state = $statePath

# --- launch --------------------------------------------------------------------------------------
$checkReport = Join-Path $run 'stored-links.json'
if ($HostApp -eq 'rhino') {
    $py = Join-Path $run 'check.py'
    [IO.File]::WriteAllText($py, (New-RhinoCheckScript $checkReport $target.id $StripLinkId.IsPresent), (New-Object Text.UTF8Encoding($false)))
    $arguments = "/nosplash /runscript=`"_-RunPythonScript ($py) _VIDELink`" `"$documentPath`""
} else {
    $arguments = "`"$documentPath`""
}
$process = Start-Process -FilePath $exe[$HostApp] -ArgumentList $arguments -PassThru
$launchState = [ordered]@{ pid = $process.Id; startTime = $process.StartTime.ToUniversalTime().ToString('o'); host = $HostApp; document = $documentPath }
[IO.File]::WriteAllText($statePath, ($launchState | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$result.pid = $process.Id
Log "$HostApp pid $($process.Id) ← $documentPath"

# A failure leaves the host open for a look (close it with -Close); a refusal before anything was
# linked (-CloseHost) closes it at once without saving.
function Fail([string]$Reason, [int]$Code = 1, [switch]$CloseHost) {
    $result.reason = $Reason
    $result.timings.totalMs = [int]((Get-Date) - $started).TotalMilliseconds
    if ($CloseHost) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Log "REFUSED $Reason (closed $HostApp pid $($process.Id) without saving)"
    } else { Log "FAIL $Reason (the host stays open: -Close -State $statePath)" }
    Emit $result $Code
}
function MainHandle { $process.Refresh(); return $process.MainWindowHandle }
function Elapsed { [int]((Get-Date) - $started).TotalMilliseconds }

# --- stored link ids (ADR-030) -------------------------------------------------------------------
$deadline = (Get-Date).AddSeconds($DialogTimeoutSec)
if ($HostApp -eq 'rhino') {
    while (-not (Test-Path -LiteralPath $checkReport)) {
        if ((Get-Date) -gt $deadline) { Fail 'Rhino did not run the stored-link check (plugin or Python missing?)' }
        Start-Sleep -Milliseconds 500
    }
    $check = Get-Content -Raw -Encoding UTF8 $checkReport | ConvertFrom-Json
    $entries = @($check.entries); $removed = @($check.removed)
    if ($check.PSObject.Properties.Name -contains 'error') { Fail "stored-link check: $($check.error)" }
    # /runscript must have run on the opened copy, not on an empty start document.
    if ((ConvertTo-ComparablePath ([string]$check.path)) -ne (ConvertTo-ComparablePath $documentPath)) {
        Fail "Rhino ran the check on '$($check.path)', not the copy" 1 -CloseHost
    }
} else {
    # Missing XREF/SHX prompts first; then COM sees the opened drawing.
    $app = $null; $doc = $null
    while (-not $doc) {
        if ((Get-Date) -gt $deadline) { Fail 'ZWCAD did not open the drawing (COM)' }
        foreach ($w in (Get-HostWindows $process.Id)) {
            $ignore = Find-Button $w '*무시하고 계속*'
            if ($ignore) { Log "prompt '$($w.Current.Name)': 무시하고 계속"; Use-Element $ignore }
        }
        try {
            $app = [Runtime.InteropServices.Marshal]::GetActiveObject('ZWCAD.Application.2023')
            if ($app.Documents.Count -gt 0 -and (ConvertTo-ComparablePath $app.ActiveDocument.FullName) -eq (ConvertTo-ComparablePath $documentPath)) { $doc = $app.ActiveDocument }
        } catch { }
        if (-not $doc) { Start-Sleep -Milliseconds 1000 }
    }
    $entries = @(); $removed = @()
    $dict = $null
    try { $dict = $doc.Dictionaries.Item('VIDE_LINKS') } catch { }   # none: nothing stored
    if ($dict) {
        try { foreach ($o in $dict) { $entries += [string]$dict.GetName($o) } }
        catch { for ($i = 0; $i -lt $dict.Count; $i++) { $entries += [string]$dict.GetName($dict.Item($i)) } }
        if ($entries.Count -lt $dict.Count) { Fail "VIDE_LINKS has $($dict.Count) entries, read $($entries.Count)" 2 -CloseHost }
    }
    if ($StripLinkId) {
        foreach ($key in (Get-ForeignLinkEntries $entries $target.id)) { $dict.Remove($key) | Out-Null; $removed += $key }
    }
}
$result.storedLinkEntries = $entries
$result.strippedLinkEntries = $removed
$result.timings.openMs = Elapsed
$foreign = @(Get-ForeignLinkEntries $entries $target.id | Where-Object { $removed -notcontains $_ })
if ($foreign.Count) {
    Fail ("the document stores link ids of other projects ($($foreign -join ', ')); linking would move their links " +
        '(round 2). Copy from a source without them, or pass -StripLinkId. See tools/persona/strip-link-id.md') 2 -CloseHost
}

# --- dialogs -------------------------------------------------------------------------------------
if ($HostApp -eq 'zwcad') {
    Bring-Front (MainHandle)
    # SendCommand blocks while the modal dialog is open: send it from another process.
    $send = "`$a=[Runtime.InteropServices.Marshal]::GetActiveObject('ZWCAD.Application.2023'); `$a.ActiveDocument.SendCommand('VIDECADLink ')"
    Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $send | Out-Null
}
$picked = $false; $chose = $false; $linkedAt = $null; $sinceLink = (Get-Date).ToUniversalTime()
$fronted = [DateTime]::MinValue
while ($true) {
    if ((Get-Date) -gt $deadline) {
        $titles = (Get-HostWindows $process.Id | ForEach-Object { $_.Current.Name }) -join ' | '
        Fail "dialog timeout ($DialogTimeoutSec s); windows: $titles"
    }
    $windows = @(Get-HostWindows $process.Id)
    # The VIDE dialog shows once the host is in front (round 2, ZWCAD). Not every poll: the ALT tap
    # of Bring-Front must not keep toggling the host's menu.
    $dialogShown = @($windows | Where-Object { Get-DialogKind $_.Current.Name }).Count -gt 0
    if (-not $picked -and -not $dialogShown -and ((Get-Date) - $fronted).TotalSeconds -gt 5) { Bring-Front (MainHandle); $fronted = Get-Date }
    foreach ($w in $windows) {
        $title = $w.Current.Name
        switch (Get-DialogKind $title) {
            'project' {
                if ($picked) { break }
                $item = Find-ProjectItem $w $Project
                $link = Find-Button $w 'Link'
                if ($item -and $link) {
                    Use-Element $item
                    Start-Sleep -Milliseconds 300
                    $sinceLink = (Get-Date).ToUniversalTime()
                    Use-Element $link
                    $picked = $true
                    $result.timings.projectDialogMs = Elapsed
                    Log "project dialog: '$Project' → Link"
                }
            }
            'choice' {
                if ($chose) { break }
                $text = Get-Texts $w
                $new = Find-All $w $CT::RadioButton | Where-Object { $_.Current.Name -eq '새 연결 파일로 추가' } | Select-Object -First 1
                if (-not $new) { $new = Find-Button $w '새 연결 파일로 추가' }   # WinForms radio as a Pane (ZWCAD)
                $ok = Find-Button $w '연결'
                if ($new -and $ok) {
                    Use-Element $new
                    Start-Sleep -Milliseconds 300
                    Use-Element $ok
                    $chose = $true
                    $result.choice = [ordered]@{ reason = (Get-ChoiceReason $text); picked = 'new' }
                    $result.timings.choiceDialogMs = Elapsed
                    Log "choice dialog ($($result.choice.reason)): 새 연결 파일로 추가"
                }
            }
            'error' { Fail "VIDE: $(Get-Texts $w)" }
            default {
                $ignore = Find-Button $w '*무시하고 계속*'
                if ($ignore) { Log "prompt '$title': 무시하고 계속"; Use-Element $ignore }
            }
        }
    }
    if ($picked) {
        $found = Find-LinkedRow (ProjectLinks $target.id) $HostApp $documentPath $sinceLink
        if ($found.Row) { $linkedAt = Get-Date; $result.linkId = $found.Row.id; break }
    }
    Start-Sleep -Milliseconds 700
}
$result.timings.linkedMs = Elapsed
Log "linked $($result.linkId)"

# --- first Sync ----------------------------------------------------------------------------------
$syncDeadline = (Get-Date).AddSeconds($SyncTimeoutSec)
while ($true) {
    $found = Find-LinkedRow (ProjectLinks $target.id) $HostApp $documentPath $sinceLink
    if ($found.State -eq 'synced') {
        $result.firstSync = [ordered]@{ requestId = $found.Row.lastSync.requestId; at = $found.Row.lastSync.at; ms = [int]((Get-Date) - $linkedAt).TotalMilliseconds }
        break
    }
    if ($found.State -eq 'failed') { Fail "first Sync failed: $($found.Row.lastError)" }
    if ((Get-Date) -gt $syncDeadline) { Fail "first Sync not finished in $SyncTimeoutSec s" }
    Start-Sleep -Seconds 2
}
$result.timings.firstSyncMs = Elapsed
if (-not $Visible) { [void][HostLink.Native]::ShowWindow((MainHandle), 6) }   # SW_MINIMIZE

# --- other projects (T-286: 다른 프로젝트 Link 변경 0) -----------------------------------------
$code = 0
if (-not $SkipOtherProjects) {
    $after = @{}
    foreach ($p in $projects) { if ($p.id -ne $target.id) { $after[$p.id] = ProjectLinks $p.id } }
    $result.otherProjectLinksChanged = @(Compare-LinkSnapshots $before $after)
    if (@($result.otherProjectLinksChanged).Count) { $code = 3; Log 'WARNING: link rows of other projects changed; the person decides whether to revert' }
}
$result.ok = ($code -eq 0)
$result.timings.totalMs = Elapsed
Emit $result $code
