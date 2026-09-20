param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$doc = $null
$reopened = $null
try {
    try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('ZWCAD.Application.2023') }
    catch { $app = New-Object -ComObject 'ZWCAD.Application.2023' }
    if ($request.mode -eq 'open') {
        $app.Documents.Open([string]$request.filename) | Out-Null
        $app.Visible = $true
        [Console]::WriteLine('{"opened":true}')
        exit 0
    }
    # Keep the document reference: never route writes through ActiveDocument.
    $doc = $app.Documents.Add()
    $doc.SetVariable('INSUNITS', 4) | Out-Null
    $created = @()
    foreach ($shape in $request.objects) {
        if ($shape.kind -ne 'polyline') { throw 'UNSUPPORTED_GEOMETRY' }
        $coordinates = [Collections.Generic.List[double]]::new()
        foreach ($point in $shape.points) {
            $coordinates.Add([double]$point[0] * 1000)
            $coordinates.Add([double]$point[1] * 1000)
        }
        $entity = $doc.ModelSpace.AddLightWeightPolyline($coordinates.ToArray())
        $entity.Elevation = [double]$shape.points[0][2] * 1000
        $first = $shape.points[0]; $last = $shape.points[$shape.points.Count - 1]
        $entity.Closed = ($first[0] -eq $last[0] -and $first[1] -eq $last[1])
        $created += @{ id=$shape.id; handle=$entity.Handle }
    }
    $doc.SaveAs([string]$request.filename) | Out-Null
    $doc.Close($false) | Out-Null
    $doc = $null
    $reopened = $app.Documents.Open([string]$request.filename)
    if ($reopened.GetVariable('INSUNITS') -ne 4) { throw 'UNIT_MISMATCH' }
    $scene = @()
    foreach ($item in $created) {
        $entity = $reopened.HandleToObject([string]$item.handle)
        $coordinates = $entity.Coordinates
        $line = [Collections.Generic.List[double]]::new()
        for ($i=0; $i -lt $coordinates.Length; $i+=2) {
            $line.Add([double]$coordinates[$i] / 1000)
            $line.Add([double]$coordinates[$i+1] / 1000)
            $line.Add([double]$entity.Elevation / 1000)
        }
        if ($entity.Closed -and $line.Count -ge 6 -and ($line[0] -ne $line[$line.Count-3] -or $line[1] -ne $line[$line.Count-2])) {
            $line.Add($line[0]); $line.Add($line[1]); $line.Add($line[2])
        }
        $area = $null
        if ($entity.Closed) { $area = [double]$entity.Area / 1000000 }
        $scene += @{id=$item.id;nativeId=$item.handle;nativeType='LWPolyline';line=$line.ToArray();vertices=@();indices=@();area=$area;volume=$null;valid=$true}
    }
    $result = @{scene=@($scene);verified=$true}
    [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 10))
} catch {
    [Console]::WriteLine((@{error='ZWCAD_EXECUTION_FAILED';detail=$_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
} finally {
    # Only documents explicitly created/opened by this invocation are closed. Never quit the app.
    if ($reopened) { try { $reopened.Close($false) | Out-Null } catch {} }
    if ($doc) { try { $doc.Close($false) | Out-Null } catch {} }
}
