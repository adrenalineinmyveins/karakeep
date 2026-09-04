Add-Type -AssemblyName System.Drawing
function Check($path, $label) {
  $p = [System.Drawing.Bitmap]::FromFile($path)
  $visible = 0
  $nonWhite = 0
  for ($x = 0; $x -lt $p.Width; $x += [Math]::Max(1, [int]($p.Width / 32))) {
    for ($y = 0; $y -lt $p.Height; $y += [Math]::Max(1, [int]($p.Height / 32))) {
      $c = $p.GetPixel($x, $y)
      if ($c.A -gt 8) { $visible++ }
      if ($c.A -gt 8 -and -not ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245)) { $nonWhite++ }
    }
  }
  Write-Output ("{0}: {1}x{2} visible={3} nonWhite={4}" -f $label, $p.Width, $p.Height, $visible, $nonWhite)
  $p.Dispose()
}
$R = 'F:\karakeep\karakeep'
Check "$R\apps\web\public\icons\logo-16.png" 'logo-16'
Check "$R\apps\web\public\icons\logo-512.png" 'logo-512'
Check "$R\apps\web\app\apple-icon.png" 'apple-icon'
Check "$R\apps\browser-extension\public\logo-16-darkmode.png" 'logo-16-dark'
Check "$R\apps\browser-extension\public\logo-full.png" 'ext-logo-full'
Check "$R\apps\browser-extension\public\logo-full-white.png" 'ext-logo-full-white'
Check "$R\apps\mobile\assets\icon.png" 'mobile-icon'
Check "$R\apps\mobile\assets\icon-tinted.png" 'mobile-icon-tinted'
Check "$R\apps\mobile\assets\adaptive-icon.png" 'mobile-adaptive'
Check "$R\apps\mobile\assets\splash.png" 'mobile-splash'
Check "$R\apps\mobile\assets\splash-white.png" 'mobile-splash-dark'
Check "$R\apps\desktop\src-tauri\app-icon.png" 'desktop-appicon'

# sample gradient corners of mobile icon
$p = [System.Drawing.Bitmap]::FromFile("$R\apps\mobile\assets\icon.png")
$c1 = $p.GetPixel(20, 900)
$c2 = $p.GetPixel(980, 60)
Write-Output ("mobile-icon gradient: bottomleft=RGB({0},{1},{2}) topright=RGB({3},{4},{5})" -f $c1.R,$c1.G,$c1.B,$c2.R,$c2.G,$c2.B)
$p.Dispose()

# wordmark text present in logo-full (dark pixels in right half)
$p = [System.Drawing.Bitmap]::FromFile("$R\apps\browser-extension\public\logo-full.png")
$dark = 0
for ($x = 250; $x -lt 700; $x += 4) {
  for ($y = 40; $y -lt 160; $y += 4) {
    $c = $p.GetPixel($x, $y)
    if ($c.A -gt 8 -and $c.R -lt 120 -and $c.G -lt 120 -and $c.B -lt 130) { $dark++ }
  }
}
Write-Output "logo-full dark text pixels (right half): $dark"
$p.Dispose()
