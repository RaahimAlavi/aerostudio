$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Root
$OutDir = Join-Path $ProjectRoot "public\downloads"
$FinalApk = Join-Path $OutDir "aero-remote.apk"

$SdkDir = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$BuildTools = Join-Path $SdkDir "build-tools\34.0.0"
$AndroidJar = Join-Path $SdkDir "platforms\android-34\android.jar"

$JavaHome = "C:\Program Files\Java\jdk-17"
if (-not (Test-Path $JavaHome)) {
    throw "JDK 17 not found at $JavaHome"
}
$env:JAVA_HOME = $JavaHome
$env:PATH = "$JavaHome\bin;$env:PATH"

$Aapt2 = Join-Path $BuildTools "aapt2.exe"
$D8 = Join-Path $BuildTools "d8.bat"
$ZipAlign = Join-Path $BuildTools "zipalign.exe"
$ApkSigner = Join-Path $BuildTools "apksigner.bat"
$Javac = Join-Path $JavaHome "bin\javac.exe"
$Jar = Join-Path $JavaHome "bin\jar.exe"
$Keytool = Join-Path $JavaHome "bin\keytool.exe"

foreach ($tool in @($Aapt2, $D8, $ZipAlign, $ApkSigner, $AndroidJar, $Javac, $Jar, $Keytool)) {
    if (-not (Test-Path $tool)) {
        throw "Required build tool missing: $tool"
    }
}

$BuildDir = Join-Path $Root "build"
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path `
    $BuildDir, `
    (Join-Path $BuildDir "gen"), `
    (Join-Path $BuildDir "classes"), `
    (Join-Path $BuildDir "dex"), `
    $OutDir | Out-Null

Write-Host "[1/6] Compiling Android resources with aapt2..."
& $Aapt2 compile --dir (Join-Path $Root "res") -o (Join-Path $BuildDir "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[2/6] Linking resources & AndroidManifest.xml..."
$UnalignedApk = Join-Path $BuildDir "unaligned.apk"
& $Aapt2 link `
    -o $UnalignedApk `
    -I $AndroidJar `
    --manifest (Join-Path $Root "AndroidManifest.xml") `
    --java (Join-Path $BuildDir "gen") `
    --min-sdk-version 26 `
    --target-sdk-version 34 `
    --version-code 3 `
    --version-name "1.2.0" `
    (Join-Path $BuildDir "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "[3/6] Compiling Java sources..."
$JavaFiles = @(
    Get-ChildItem -Path (Join-Path $Root "src") -Recurse -Filter "*.java" | Select-Object -ExpandProperty FullName
)
$GenFiles = @(
    Get-ChildItem -Path (Join-Path $BuildDir "gen") -Recurse -Filter "*.java" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
)
$AllJava = $JavaFiles + $GenFiles
& $Javac -source 11 -target 11 -encoding UTF-8 -classpath $AndroidJar -d (Join-Path $BuildDir "classes") @AllJava
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "[4/6] Dexing bytecode with d8..."
$ClassFiles = @(
    Get-ChildItem -Path (Join-Path $BuildDir "classes") -Recurse -Filter "*.class" | Select-Object -ExpandProperty FullName
)
& $D8 --release --min-api 26 --lib $AndroidJar --output (Join-Path $BuildDir "dex") @ClassFiles
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "[5/6] Packaging classes.dex & aligning APK..."
& $Jar uf $UnalignedApk -C (Join-Path $BuildDir "dex") "classes.dex"
if ($LASTEXITCODE -ne 0) { throw "jar packaging failed" }

$AlignedApk = Join-Path $BuildDir "aligned.apk"
& $ZipAlign -f -p 4 $UnalignedApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "[6/6] Signing & verifying APK..."
$Keystore = Join-Path $Root "aero-release.keystore"
if (-not (Test-Path $Keystore)) {
    & $Keytool -genkeypair `
        -v `
        -keystore $Keystore `
        -alias aero `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -storepass "aero240hz" `
        -keypass "aero240hz" `
        -dname "CN=AERO Studio, OU=Motion, O=AERO, L=Studio, ST=Local, C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

& $ApkSigner sign `
    --ks $Keystore `
    --ks-key-alias aero `
    --ks-pass "pass:aero240hz" `
    --key-pass "pass:aero240hz" `
    --out $FinalApk `
    $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }

& $ApkSigner verify --verbose $FinalApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$SizeKb = [Math]::Round((Get-Item $FinalApk).Length / 1KB, 1)
Write-Host ""
Write-Host "SUCCESS: Built signed APK -> $FinalApk ($SizeKb KB)"
