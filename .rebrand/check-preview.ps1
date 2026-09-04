Add-Type -AssemblyName System.Drawing
$p = [System.Drawing.Bitmap]::FromFile('F:\karakeep\karakeep\.rebrand\preview-full.png')
Write-Output ("dims: {0}x{1}" -f $p.Width, $p.Height)
# mark region 0-150: count white pixels per vertical band to see structure
$bands = @{}
for ($x = 0; $x -lt 160; $x += 10) { $bands[$x] = 0 }
$whiteMark = 0
for ($x = 0; $x -lt 160; $x++) {
  for ($y = 0; $y -lt $p.Height; $y++) {
    $c = $p.GetPixel($x, $y)
    if ($c.R -gt 200 -and $c.G -gt 200 -and $c.B -gt 200) {
      $whiteMark++
      $band = [int]([Math]::Floor($x / 10) * 10)
      $bands[$band]++
    }
  }
}
Write-Output "mark region white pixels: $whiteMark"
foreach ($k in ($bands.Keys | Sort-Object)) { Write-Output ("  x{0}-{1}: {2}" -f $k, ($k+9), $bands[$k]) }
# text region 170+
$whiteText = 0
for ($x = 170; $x -lt $p.Width; $x++) {
  for ($y = 0; $y -lt $p.Height; $y++) {
    $c = $p.GetPixel($x, $y)
    if ($c.R -gt 200 -and $c.G -gt 200 -and $c.B -gt 200) { $whiteText++ }
  }
}
Write-Output "text region white pixels: $whiteText"
$p.Dispose()
