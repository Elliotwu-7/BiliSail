function Get-AndroidBuildTarget {
  param([Parameter(Mandatory)][ValidateSet('android-arm64', 'android-x86_64')][string]$Target)
  if ($Target -eq 'android-x86_64') {
    return [pscustomobject]@{ Target = $Target; FlutterPlatform = 'android-x64'; Abi = 'x86_64'; Architecture = 'x86_64' }
  }
  return [pscustomobject]@{ Target = $Target; FlutterPlatform = 'android-arm64'; Abi = 'arm64-v8a'; Architecture = 'arm64' }
}

function Confirm-AndroidApkNativeLibraries {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidateSet('android-arm64', 'android-x86_64')][string]$Target,
    [switch]$RequireAot
  )
  $buildTarget = Get-AndroidBuildTarget $Target
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $abis = @($archive.Entries.FullName | Where-Object { $_ -match '^lib/[^/]+/' } |
      ForEach-Object { $_.Split('/')[1] } | Sort-Object -Unique)
    if ($abis.Count -ne 1 -or $abis[0] -cne $buildTarget.Abi) {
      throw "APK must contain only the $($buildTarget.Abi) ABI."
    }
    foreach ($library in @('libflutter.so', 'libmpv.so', 'libbili_mux.so')) {
      if (!$archive.GetEntry("lib/$($buildTarget.Abi)/$library")) {
        throw "APK is missing $($buildTarget.Abi)/$library."
      }
    }
    if ($RequireAot -and
        (!$archive.GetEntry("lib/$($buildTarget.Abi)/libapp.so") -or $archive.GetEntry('assets/flutter_assets/kernel_blob.bin'))) {
      throw 'Release APK must contain an AOT application without a debug kernel.'
    }
  } finally { $archive.Dispose() }
}
