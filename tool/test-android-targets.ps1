$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-targets.ps1')
$checks = 0
$work = Join-Path ([System.IO.Path]::GetTempPath()) "bilisail-android-targets-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work | Out-Null

function New-TestApk([string[]]$Entries) {
  $path = Join-Path $work "$([guid]::NewGuid()).apk"
  $archive = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
  try { foreach ($entry in $Entries) { $null = $archive.CreateEntry($entry) } }
  finally { $archive.Dispose() }
  return $path
}

function Assert-ApkRejected([string[]]$Entries, [string]$Target, [switch]$RequireAot) {
  $rejected = $false
  try { Confirm-AndroidApkNativeLibraries (New-TestApk $Entries) $Target -RequireAot:$RequireAot }
  catch { $rejected = $true }
  if (!$rejected) { throw "Invalid $Target APK was accepted: $($Entries -join ', ')" }
  $script:checks++
}

try {
  foreach ($target in @('android-arm64', 'android-x86_64')) {
    $mapping = Get-AndroidBuildTarget $target
    $expectedPlatform = if ($target -eq 'android-arm64') { 'android-arm64' } else { 'android-x64' }
    $expectedAbi = if ($target -eq 'android-arm64') { 'arm64-v8a' } else { 'x86_64' }
    if ($mapping.FlutterPlatform -cne $expectedPlatform -or $mapping.Abi -cne $expectedAbi) {
      throw "Incorrect target mapping for $target."
    }
    $checks++
    $entries = @('libflutter.so', 'libmpv.so', 'libbili_mux.so', 'libapp.so') |
      ForEach-Object { "lib/$expectedAbi/$_" }
    Confirm-AndroidApkNativeLibraries (New-TestApk $entries) $target -RequireAot
    $checks++
    $debug = @($entries | Where-Object { $_ -notlike '*/libapp.so' }) + 'assets/flutter_assets/kernel_blob.bin'
    Confirm-AndroidApkNativeLibraries (New-TestApk $debug) $target
    $checks++
    Assert-ApkRejected $debug $target -RequireAot
    Assert-ApkRejected ($entries + 'assets/flutter_assets/kernel_blob.bin') $target -RequireAot
    Assert-ApkRejected ($entries + 'lib/armeabi-v7a/libflutter.so') $target
    foreach ($library in @('libflutter.so', 'libmpv.so', 'libbili_mux.so', 'libapp.so')) {
      Assert-ApkRejected @($entries | Where-Object { $_ -cne "lib/$expectedAbi/$library" }) $target -RequireAot
    }
    $otherTarget = if ($target -eq 'android-arm64') { 'android-x86_64' } else { 'android-arm64' }
    Assert-ApkRejected $entries $otherTarget -RequireAot
    Assert-ApkRejected @('assets/flutter_assets/AssetManifest.bin') $target
  }
  Write-Output "Android ABI and native packaging checks passed: $checks"
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
