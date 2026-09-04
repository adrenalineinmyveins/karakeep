Add-Type -AssemblyName System.Drawing
foreach ($f in @('F:\karakeep\karakeep\apps\web\app\favicon.ico','F:\karakeep\karakeep\apps\desktop\src-tauri\icons\icon.ico')) {
  $ico = New-Object System.Drawing.Icon($f)
  Write-Output ("{0}: default {1}x{2}, size {3} bytes" -f (Split-Path $f -Leaf), $ico.Size.Width, $ico.Size.Height, (Get-Item $f).Length)
  $ico.Dispose()
}
