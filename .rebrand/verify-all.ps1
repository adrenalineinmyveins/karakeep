Add-Type -AssemblyName System.Drawing
# Verify: expected dims + content bbox coverage for all rendered assets.
# rows: path, expW, expH, minCoverage (bbox area / total area; 0 = skip coverage e.g. splash mostly empty)
$rows = @(
  @('apps\web\public\icons\logo-16.png',16,16,0.85),
  @('apps\web\public\icons\logo-48.png',48,48,0.85),
  @('apps\web\public\icons\logo-128.png',128,128,0.85),
  @('apps\web\public\icons\logo-192.png',192,192,0.85),
  @('apps\web\public\icons\logo-512.png',512,512,0.85),
  @('apps\web\app\icon.png',512,512,0.85),
  @('apps\web\app\apple-icon.png',180,180,0.85),
  @('apps\browser-extension\public\logo-16.png',16,16,0.85),
  @('apps\browser-extension\public\logo-48.png',48,48,0.85),
  @('apps\browser-extension\public\logo-128.png',128,128,0.85),
  @('apps\browser-extension\public\logo.png',512,512,0.85),
  @('apps\browser-extension\public\logo-16-darkmode.png',16,16,0.2),
  @('apps\browser-extension\public\logo-48-darkmode.png',48,48,0.2),
  @('apps\browser-extension\public\logo-128-darkmode.png',128,128,0.2),
  @('apps\browser-extension\public\logo-full.png',700,200,0),
  @('apps\browser-extension\public\logo-full-white.png',700,200,0),
  @('apps\mobile\assets\icon.png',1024,1024,0.85),
  @('apps\mobile\assets\icon-tinted.png',1024,1024,0.85),
  @('apps\mobile\assets\adaptive-icon.png',1024,1024,0.03),
  @('apps\mobile\assets\splash.png',1024,2048,0),
  @('apps\mobile\assets\splash-white.png',1024,2048,0),
  @('apps\desktop\src-tauri\app-icon.png',1024,1024,0.85),
  @('apps\desktop\src-tauri\icons\icon.png',512,512,0.85),
  @('apps\desktop\src-tauri\icons\32x32.png',32,32,0.85),
  @('apps\desktop\src-tauri\icons\64x64.png',64,64,0.85),
  @('apps\desktop\src-tauri\icons\128x128.png',128,128,0.85),
  @('apps\desktop\src-tauri\icons\128x128@2x.png',256,256,0.85),
  @('apps\desktop\src-tauri\icons\Square30x30Logo.png',30,30,0.85),
  @('apps\desktop\src-tauri\icons\Square44x44Logo.png',44,44,0.85),
  @('apps\desktop\src-tauri\icons\Square70x70Logo.png',70,70,0.85),
  @('apps\desktop\src-tauri\icons\Square71x71Logo.png',71,71,0.85),
  @('apps\desktop\src-tauri\icons\Square89x89Logo.png',89,89,0.85),
  @('apps\desktop\src-tauri\icons\Square107x107Logo.png',107,107,0.85),
  @('apps\desktop\src-tauri\icons\Square142x142Logo.png',142,142,0.85),
  @('apps\desktop\src-tauri\icons\Square150x150Logo.png',150,150,0.85),
  @('apps\desktop\src-tauri\icons\Square284x284Logo.png',284,284,0.85),
  @('apps\desktop\src-tauri\icons\Square310x310Logo.png',310,310,0.85),
  @('apps\desktop\src-tauri\icons\StoreLogo.png',50,50,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-mdpi\ic_launcher.png',48,48,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-mdpi\ic_launcher_round.png',48,48,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-hdpi\ic_launcher.png',72,72,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-hdpi\ic_launcher_round.png',72,72,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xhdpi\ic_launcher.png',96,96,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xhdpi\ic_launcher_round.png',96,96,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxhdpi\ic_launcher.png',144,144,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxhdpi\ic_launcher_round.png',144,144,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxxhdpi\ic_launcher.png',192,192,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxxhdpi\ic_launcher_round.png',192,192,0.85),
  @('apps\desktop\src-tauri\icons\android\mipmap-mdpi\ic_launcher_foreground.png',108,108,0),
  @('apps\desktop\src-tauri\icons\android\mipmap-hdpi\ic_launcher_foreground.png',162,162,0),
  @('apps\desktop\src-tauri\icons\android\mipmap-xhdpi\ic_launcher_foreground.png',216,216,0),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxhdpi\ic_launcher_foreground.png',324,324,0),
  @('apps\desktop\src-tauri\icons\android\mipmap-xxxhdpi\ic_launcher_foreground.png',432,432,0),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-20x20@1x.png',20,20,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-20x20@2x.png',40,40,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-20x20@3x.png',60,60,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-29x29@1x.png',29,29,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-29x29@2x.png',58,58,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-29x29@3x.png',87,87,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-40x40@1x.png',40,40,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-40x40@2x.png',80,80,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-40x40@2x-1.png',80,80,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-40x40@3x.png',120,120,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-60x60@2x.png',120,120,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-60x60@3x.png',180,180,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-76x76@1x.png',76,76,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-76x76@2x.png',152,152,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-83.5x83.5@2x.png',167,167,0.85),
  @('apps\desktop\src-tauri\icons\ios\AppIcon-512@2x.png',1024,1024,0.85),
  @('.rebrand\tmp-32.png',32,32,0.85),
  @('.rebrand\tmp-48.png',48,48,0.85)
)
$bad = 0
foreach ($r in $rows) {
  $full = Join-Path 'F:\karakeep\karakeep' $r[0]
  if (-not (Test-Path $full)) { Write-Output "MISSING $($r[0])"; $bad++; continue }
  $p = [System.Drawing.Bitmap]::FromFile($full)
  $dimOk = ($p.Width -eq $r[1]) -and ($p.Height -eq $r[2])
  $covOk = $true
  if ($r[3] -gt 0) {
    $minX = 99999; $maxX = -1; $minY = 99999; $maxY = -1
    $step = [Math]::Max(1, [int]($p.Width / 64))
    for ($x = 0; $x -lt $p.Width; $x += $step) {
      for ($y = 0; $y -lt $p.Height; $y += $step) {
        if ($p.GetPixel($x, $y).A -gt 8) {
          if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
          if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
        }
      }
    }
    if ($maxX -lt 0) { $covOk = $false }
    else {
      $cov = (($maxX - $minX + 1.0) * ($maxY - $minY + 1.0)) / ($p.Width * $p.Height)
      $covOk = ($cov -ge $r[3])
    }
  }
  if (-not ($dimOk -and $covOk)) { Write-Output ("BAD  {0}  dims={1}x{2} (want {3}x{4}) dimOk={5} covOk={6}" -f $r[0], $p.Width, $p.Height, $r[1], $r[2], $dimOk, $covOk); $bad++ }
  $p.Dispose()
}
Write-Output "==== Bad: $bad / $($rows.Count) ===="
