param(
  [ValidateSet('Release', 'Profile', 'Debug')]
  [string]$Mode = 'Release',
  [ValidateSet('android-arm64', 'android-x86_64')]
  [string]$Target = 'android-arm64',
  [switch]$Install,
  [string]$DeviceId,
  [switch]$SkipMuxBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'android-development.ps1')
. (Join-Path $PSScriptRoot 'android-signing.ps1')
. (Join-Path $PSScriptRoot 'android-version.ps1')
. (Join-Path $PSScriptRoot 'android-targets.ps1')
$buildTarget = Get-AndroidBuildTarget $Target
if ($Install -and [string]::IsNullOrWhiteSpace($DeviceId)) { throw '-Install requires an explicit -DeviceId.' }

Push-Location $repoRoot
$previousSdk = $env:ANDROID_HOME
$powerState = $null
try {
  if (!$env:ANDROID_HOME -and !$env:ANDROID_SDK_ROOT) {
    $env:ANDROID_HOME = Split-Path (Split-Path (Get-Command adb -ErrorAction Stop).Source)
  }
  if ($Install) {
    & adb -s $DeviceId get-state
    if ($LASTEXITCODE -ne 0) { throw 'The selected Android device is not available.' }
    $powerState = (& adb -s $DeviceId shell settings get global stay_on_while_plugged_in).Trim()
    & adb -s $DeviceId shell svc power stayon usb
    & adb -s $DeviceId shell input keyevent KEYCODE_WAKEUP
  }
  if (!$SkipMuxBuild) { & (Join-Path $PSScriptRoot 'build-download-mux.ps1') -Target $Target }
  $version = (Select-String -LiteralPath 'pubspec.yaml' -Pattern '^version:\s*(\S+)\s*$').Matches.Groups[1].Value
  $expectedCode = Get-AndroidVersionCode $version
  $buildMode = $Mode.ToLowerInvariant()
  $buildArgs = @('build', 'apk', "--$buildMode", '--target-platform', $buildTarget.FlutterPlatform, '--split-per-abi',
    '--target', 'lib/main.dart', $AndroidDevelopmentBuildArgument,
    "--dart-define=BILISAIL_RELEASE_VERSION=$version")
  # Flutter 3.47.6 also skips plugin-registrant regeneration with --no-pub.
  # Switching Profile/Debug to Release must remove dev-only native plugins.
  & flutter @buildArgs
  if ($LASTEXITCODE -ne 0) { throw 'Development APK build failed.' }

  $output = Join-Path $repoRoot "build/development/$Target"
  New-Item -ItemType Directory -Force -Path $output | Out-Null
  $packageName = "BiliSail-test-$($buildTarget.Architecture)-$buildMode.apk"
  $package = Join-Path $output $packageName
  Copy-Item -LiteralPath "build/app/outputs/flutter-apk/app-$($buildTarget.Abi)-$buildMode.apk" -Destination $package
  $identity = Confirm-AndroidDevelopmentApk $package $Mode
  if ($identity.VersionCode -ne $expectedCode -or $identity.VersionName -cne $version.Split('+')[0]) {
    throw 'Development APK version does not match pubspec.yaml.'
  }
  Confirm-AndroidApkNativeLibraries $package $Target -RequireAot:($Mode -ne 'Debug')
  $certificate = Confirm-AndroidApkSigning $package ([pscustomobject]@{ Signing = 'temporary-debug-key' })
  $pin = Join-Path $output 'signing-certificate.sha256'
  if ((Test-Path -LiteralPath $pin) -and (Get-Content -LiteralPath $pin -Raw).Trim() -cne $certificate) {
    throw 'Development signing identity changed. Preserve the old key and installed data.'
  }
  Set-Content -LiteralPath $pin -Value $certificate -Encoding utf8
  $sha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$package.sha256" -Value $sha256 -Encoding utf8
  [pscustomobject]@{
    PackageId = $identity.PackageId; DisplayName = $identity.DisplayName
    Version = $version; VersionCode = $identity.VersionCode; Mode = $Mode
    Target = $Target; Abi = $buildTarget.Abi
    Signing = 'local-development-debug-key'; CertificateSha256 = $certificate; Sha256 = $sha256
  } | ConvertTo-Json | Set-Content -LiteralPath "$package.json" -Encoding utf8
  if ($Install) {
    Install-AndroidDevelopmentApk $DeviceId $package $Mode
    & adb -s $DeviceId shell am start -n "$AndroidDevelopmentPackageId/dev.bilisail.bilisail.MainActivity"
    if ($LASTEXITCODE -ne 0) { throw 'Development APK installed but launch failed.' }
  }
  Write-Output "Development $Mode APK: $package"
} finally {
  if ($null -ne $powerState -and
      (& adb -s $DeviceId shell settings get global stay_on_while_plugged_in).Trim() -eq '2') {
    if ($powerState -eq 'null') { & adb -s $DeviceId shell settings delete global stay_on_while_plugged_in }
    else { & adb -s $DeviceId shell settings put global stay_on_while_plugged_in $powerState }
  }
  [Environment]::SetEnvironmentVariable('ANDROID_HOME', $previousSdk)
  Pop-Location
}
