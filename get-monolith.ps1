# Download pre-built monolith binary from GitHub releases (linux x86_64)
Set-Location $PSScriptRoot
$O = @()
$Url = "https://github.com/Y2Z/monolith/releases/download/v2.8.1/monolith-2.8.1-x86_64-unknown-linux-musl.gz"
$Out = ".docker-ctx\monolith.gz"
try {
  Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing -TimeoutSec 120
  $O += "downloaded $Out size=$((Get-Item $Out).Length)"
  # Decompress
  $Gz = [System.IO.File]::OpenRead("$PSScriptRoot\$Out")
  $Dec = [System.IO.Compression.GzipStream]::new($Gz, [System.IO.Compression.CompressionMode]::Decompress)
  $OutFile = [System.IO.File]::Create("$PSScriptRoot\.docker-ctx\monolith")
  $Dec.CopyTo($OutFile)
  $OutFile.Close(); $Dec.Close(); $Gz.Close()
  $O += "decompressed to .docker-ctx\monolith size=$((Get-Item '.docker-ctx\monolith').Length)"
  # Make executable (will be handled in Dockerfile with chmod)
} catch {
  $O += "FAILED: $_"
  # Try alternative: use cargo install on host if rust is available
  $Cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if ($Cargo) {
    $O += "trying cargo install monolith..."
    cargo install monolith --locked 2>&1 | ForEach-Object { $O += $_ }
  } else {
    $O += "no cargo on host either"
  }
}
$O | Set-Content -Encoding ascii .tmp-mono.txt
"MONO_DONE" | Add-Content -Encoding ascii .tmp-mono.txt
