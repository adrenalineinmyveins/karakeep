Add-Type -AssemblyName System.Drawing
$p = [System.Drawing.Bitmap]::FromFile('F:\karakeep\karakeep\apps\web\public\icons\logo-512.png')
$minX = 99999; $maxX = -1; $minY = 99999; $maxY = -1; $vis = 0
for ($x = 0; $x -lt $p.Width; $x++) {
  for ($y = 0; $y -lt $p.Height; $y++) {
    if ($p.GetPixel($x, $y).A -gt 8) {
      $vis++
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
Write-Output ("logo-512: visible={0} bbox=({1},{2})-({3},{4}) size={5}x{6}" -f $vis, $minX, $minY, $maxX, $maxY, ($maxX-$minX+1), ($maxY-$minY+1))
$center = $p.GetPixel(256, 256)
Write-Output ("center RGB({0},{1},{2}) A{3}" -f $center.R,$center.G,$center.B,$center.A)
$left = $p.GetPixel(30, 256)
$right = $p.GetPixel(480, 256)
Write-Output ("left RGB({0},{1},{2}) A{3}  right RGB({4},{5},{6}) A{7}" -f $left.R,$left.G,$left.B,$left.A,$right.R,$right.G,$right.B,$right.A)
$p.Dispose()

# same for logo-192 and logo-48
foreach ($s in @(192, 48)) {
  $p = [System.Drawing.Bitmap]::FromFile("F:\karakeep\karakeep\apps\web\public\icons\logo-$s.png")
  $minX = 99999; $maxX = -1; $minY = 99999; $maxY = -1
  for ($x = 0; $x -lt $p.Width; $x++) {
    for ($y = 0; $y -lt $p.Height; $y++) {
      if ($p.GetPixel($x, $y).A -gt 8) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  Write-Output ("logo-$s bbox=({0},{1})-({2},{3}) size={4}x{5}" -f $minX,$minY,$maxX,$maxY,($maxX-$minX+1),($maxY-$minY+1))
  $p.Dispose()
}
