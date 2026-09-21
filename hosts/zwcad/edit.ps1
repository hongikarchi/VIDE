param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$doc=$null
try {
    $app=[Runtime.InteropServices.Marshal]::GetActiveObject('ZWCAD.Application.2023')
    # This path is a new private copy, never the source or ActiveDocument.
    $doc=$app.Documents.Open([string]$request.filename,$false)
    if($doc.ReadOnly -or $doc.GetVariable('INSUNITS') -ne 4 -or $doc.Groups.Count -ne 0 -or $doc.ModelSpace.Count -ne $request.objects.Count){throw 'UNSUPPORTED_DWG_EDIT'}
    $edits=@()
    foreach($shape in $request.objects){
        $entity=$doc.HandleToObject([string]$shape.nativeId)
        if($entity.ObjectName -ne 'AcDbPolyline' -or $entity.HasExtensionDictionary -or $doc.Layers.Item($entity.Layer).Lock){throw 'UNSUPPORTED_DWG_EDIT'}
        $normal=$entity.Normal
        if($normal[0] -ne 0 -or $normal[1] -ne 0 -or $normal[2] -ne 1 -or $entity.Thickness -ne 0){throw 'UNSUPPORTED_DWG_EDIT'}
        $types=$null;$values=$null;$entity.GetXData('',[ref]$types,[ref]$values)
        if($types.Count){throw 'UNSUPPORTED_DWG_EDIT'}
        for($i=0;$i -lt $entity.Coordinates.Length/2;$i++){
            $start=0.0;$end=0.0;$entity.GetWidth($i,[ref]$start,[ref]$end)
            if($entity.GetBulge($i) -ne 0 -or $start -ne 0 -or $end -ne 0){throw 'UNSUPPORTED_DWG_EDIT'}
        }
        $coordinates=[Collections.Generic.List[double]]::new()
        $count=$shape.points.Count;$first=$shape.points[0];$last=$shape.points[-1]
        $closed=($first[0] -eq $last[0] -and $first[1] -eq $last[1])
        $limit=$count;if($closed){$limit--}
        for($i=0;$i -lt $limit;$i++){$coordinates.Add([double]$shape.points[$i][0]*1000);$coordinates.Add([double]$shape.points[$i][1]*1000)}
        $edits+=@{entity=$entity;coordinates=$coordinates.ToArray();closed=$closed;elevation=[double]$first[2]*1000}
    }
    # Finish validation for the whole copy before changing any geometry.
    foreach($edit in $edits){$edit.entity.Coordinates=$edit.coordinates;$edit.entity.Closed=$edit.closed;$edit.entity.Elevation=$edit.elevation;$edit.entity.Update() | Out-Null}
    $doc.Save() | Out-Null
    [Console]::WriteLine('{"saved":true}')
}catch{
    [Console]::WriteLine('{"error":"UNSUPPORTED_DWG_EDIT"}');exit 1
}finally{if($doc){try{$doc.Close($false) | Out-Null}catch{}}}
