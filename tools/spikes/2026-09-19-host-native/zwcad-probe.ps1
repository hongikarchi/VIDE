param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($root) | Out-Null
$report = [ordered]@{ host='zwcad'; checks=[ordered]@{}; success=$false }
$app = $null
$doc = $null
$reopened = $null
try {
    if (Get-Process -Name ZWCAD -ErrorAction SilentlyContinue) { throw 'Existing ZWCAD process: isolated probe refused.' }
    $app = New-Object -ComObject 'ZWCAD.Application.2023'
    $app.Visible = $false
    $report.version = $app.Version
    $doc = $app.Documents.Add()
    $doc.SetVariable('INSUNITS', 4)
    $original = $doc.ModelSpace.AddLightWeightPolyline([double[]]@(0,0,1000,0,1000,1000,0,0))
    $original.Closed = $true
    $original.Color = 3
    $originalHandle = $original.Handle
    $before = $original.Length
    $candidate = $original.Copy()
    $candidate.Move([double[]]@(0,0,0), [double[]]@(2000,0,0))
    $report.checks.candidate_created = ($doc.ModelSpace.Count -eq 2)
    $report.checks.original_preserved = ([Math]::Abs($original.Length - $before) -lt 0.00000001 -and $original.Color -eq 3)
    $candidate.Delete()
    $report.checks.candidate_discard = ($doc.ModelSpace.Count -eq 1 -and $doc.HandleToObject($originalHandle).Handle -eq $originalHandle)
    $original.Move([double[]]@(0,0,0), [double[]]@(0,2000,0))
    $coordinates = $original.Coordinates
    $report.checks.native_edit = ([Math]::Abs($coordinates[1] - 2000) -lt 0.00000001)
    $report.checks.attributes_preserved = ($original.Color -eq 3)
    $drawing = Join-Path $root 'zwcad-synthetic.dwg'
    $doc.SaveAs($drawing)
    $report.checks.save = (Test-Path -LiteralPath $drawing)
    $doc.Close($false)
    $doc = $null
    $reopened = $app.Documents.Open($drawing)
    $restored = $reopened.HandleToObject($originalHandle)
    $report.checks.reopen = ($null -ne $restored -and $restored.Color -eq 3)
    $report.checks.reopened_geometry = ([Math]::Abs($restored.Coordinates[1] - 2000) -lt 0.00000001)
    $report.checks.units = ($reopened.GetVariable('INSUNITS') -eq 4)
    $report.success = -not ($report.checks.Values -contains $false)
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($reopened) { try { $reopened.Close($false) } catch {} }
    if ($doc) { try { $doc.Close($false) } catch {} }
    if ($app) {
        try { if ($app.Documents.Count -eq 0) { $app.Quit() } } catch {}
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) | Out-Null
    }
    $result = $report | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $root 'zwcad-result.json'), $result, [Text.UTF8Encoding]::new($false))
    Write-Output $result
}
if (-not $report.success) { exit 1 }
