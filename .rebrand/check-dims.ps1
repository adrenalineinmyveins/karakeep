Add-Type -AssemblyName System.Drawing
$targets = Get-ChildItem `
  'F:\karakeep\karakeep\apps\web\public\icons\logo-*.png',`
  'F:\karakeep\karakeep\apps\web\app\icon.png',`
  'F:\karakeep\karakeep\apps\web\app\apple-icon.png',`
  'F:\karakeep\karakeep\apps\browser-extension\public\logo*.png',`
  'F:\karakeep\karakeep\apps\mobile\assets\*.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\app-icon.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\icon.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\32x32.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\Square*.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\StoreLogo.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\android\mipmap-xxxhdpi\*.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\ios\AppIcon-60x60@3x.png',`
  'F:\karakeep\karakeep\apps\desktop\src-tauri\icons\ios\AppIcon-512@2x.png',`
  'F:\karakeep\karakeep\.rebrand\tmp-*.png'
foreach ($t in $targets) {
  $p = [System.Drawing.Bitmap]::FromFile($t.FullName)
  Write-Output ("{0} = {1}x{2}" -f $t.FullName.Replace('F:\karakeep\karakeep\',''), $p.Width, $p.Height)
  $p.Dispose()
}
