# Treehouse CLI installer (Windows).
#   irm https://dl.trytree.house/install.ps1 | iex
$ErrorActionPreference = "Stop"

# SEA on Windows is built x64 only; arm64 runs it under emulation.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne "AMD64" -and $arch -ne "ARM64") {
  Write-Error "Unsupported architecture: $arch"
}
$target = "win32-x64"

# Public R2 download host (the repo is private, so GitHub release URLs 404 for
# anonymous downloads). Override with TREEHOUSE_DL_BASE.
$dlBase = if ($env:TREEHOUSE_DL_BASE) { $env:TREEHOUSE_DL_BASE } else { "https://dl.trytree.house" }
$base = "$dlBase/cli/latest"
$dest = if ($env:TREEHOUSE_BIN_DIR) { $env:TREEHOUSE_BIN_DIR } else { "$env:LOCALAPPDATA\Treehouse\bin" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$exe = Join-Path $dest "treehouse.exe"
$tmp = [IO.Path]::GetTempFileName()

Write-Host "Downloading treehouse ($target)…"
Invoke-WebRequest -Uri "$base/treehouse-$target.exe" -OutFile $tmp -UseBasicParsing

# Verify against published checksums (warn-and-continue if unavailable).
try {
  $sumsPath = "$tmp.sums"
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
  $line = (Get-Content $sumsPath | Where-Object { $_ -match "treehouse-$target\.exe$" } | Select-Object -First 1)
  if ($line) {
    $expected = ($line -split "\s+")[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
    if ($expected -ne $actual) {
      Remove-Item $tmp, $sumsPath -Force
      Write-Error "Checksum mismatch — aborting."
    }
  }
  Remove-Item $sumsPath -Force -ErrorAction SilentlyContinue
} catch {
  Write-Warning "Could not verify checksum (continuing): $_"
}

Move-Item -Force $tmp $exe
Write-Host "✓ Installed treehouse to $exe"

# Add the bin dir to the user PATH if it isn't already there.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dest", "User")
  Write-Host "  Added $dest to your PATH (restart your terminal to pick it up)."
}
Write-Host "  Get started:  treehouse login `$HOME\your-folder"
