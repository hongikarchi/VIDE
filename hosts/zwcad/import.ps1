param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$doc=$null
try {
    try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject('ZWCAD.Application.2023')}
    catch {$app=New-Object -ComObject 'ZWCAD.Application.2023'}
    # The caller copied uploaded bytes to its own unique artifact. Read that copy only.
    $doc=$app.Documents.Open([string]$request.filename,$true)
    $units=[int]$doc.GetVariable('INSUNITS')
    $factor=switch ($units) {4 {0.001} 5 {0.01} 6 {1.0} 1 {0.0254} 2 {0.3048} default {throw 'UNKNOWN_UNITS'}}
    if($doc.ModelSpace.Count -gt 500){throw 'IMPORT_LIMIT'}
    $scene=@();$objects=@();$unsupported=@()
    foreach($entity in $doc.ModelSpace){
        if($entity.ObjectName -ne 'AcDbPolyline'){$unsupported+=$entity.ObjectName;continue}
        $normal=$entity.Normal
        if([Math]::Abs($normal[0]) -gt 1e-10 -or [Math]::Abs($normal[1]) -gt 1e-10 -or [Math]::Abs($normal[2]-1) -gt 1e-10){$unsupported+='non-XY polyline';continue}
        $coordinates=$entity.Coordinates
        if($coordinates.Length -lt 4 -or $coordinates.Length -gt 2000){throw 'IMPORT_LIMIT'}
        $curved=$false
        for($i=0;$i -lt $coordinates.Length/2;$i++){if([Math]::Abs($entity.GetBulge($i)) -gt 1e-12){$curved=$true}}
        if($curved){$unsupported+='bulge polyline';continue}
        $points=@();$line=[Collections.Generic.List[double]]::new()
        for($i=0;$i -lt $coordinates.Length;$i+=2){
            $point=@(([double]$coordinates[$i]*$factor),([double]$coordinates[$i+1]*$factor),([double]$entity.Elevation*$factor))
            if(@($point | Where-Object { ([double]::IsNaN($_) -or [double]::IsInfinity($_)) -or [Math]::Abs($_) -gt 100000 }).Count){throw 'IMPORT_LIMIT'}
            $points+=,@($point);foreach($value in $point){$line.Add($value)}
        }
        if($entity.Closed -and ($points[0][0] -ne $points[-1][0] -or $points[0][1] -ne $points[-1][1])){$points+=,@($points[0]);foreach($value in $points[0]){$line.Add($value)}}
        $id='cad-'+[string]$entity.Handle;$layer=[string]$entity.Layer;$name=$layer+' / '+[string]$entity.Handle
        $area=$null;if($entity.Closed){$area=[double]$entity.Area*$factor*$factor}
        $objects+=@{id=$id;nativeId=[string]$entity.Handle;kind='polyline';name=$name;points=@($points)}
        $scene+=@{id=$id;nativeId=[string]$entity.Handle;nativeType='LWPolyline';line=$line.ToArray();vertices=@();indices=@();area=$area;volume=$null;length=[double]$entity.Length*$factor;layer64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($layer));color=[int]$entity.Color;valid=$true}
    }
    if($unsupported.Count){throw 'UNSUPPORTED_DWG_CONTENT'}
    if(-not $objects.Count){throw 'EMPTY_DWG'}
    [Console]::WriteLine((@{objects=@($objects);scene=@($scene);verified=$true;referenceOnly=$true;scope='model-space';sourceUnits=$units} | ConvertTo-Json -Compress -Depth 15))
}catch{
    $code=$_.Exception.Message
    if($code -notin @('UNKNOWN_UNITS','IMPORT_LIMIT','UNSUPPORTED_DWG_CONTENT','EMPTY_DWG')){$code='ZWCAD_EXECUTION_FAILED'}
    [Console]::WriteLine((@{error=$code} | ConvertTo-Json -Compress));exit 1
}finally{if($doc){try{$doc.Close($false) | Out-Null}catch{}}}
