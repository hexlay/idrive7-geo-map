<#
 recon.ps1 - one read-only recon run on the head unit, from Windows: copies nav-recon.sh and ivi-list to the unit,
 runs nav-recon.sh once, brings its report back to the PC and checks it arrived whole. Changes nothing on the unit
 but its own folder in /var/tmp/nav-recon. Needs only Windows' own OpenSSH client and the SSH key from the
 idrive7-8-ssh-root tool (as push-to-car.ps1).

   .\recon.ps1 check    -Key <...\data\enrollments\<VIN>\id_rsa> [-Ip 169.254.36.47]
       connects, says what the unit is and how much room /var/tmp has; copies and runs nothing
   .\recon.ps1 base     -Key <...>     the home screen, the BMW map closed, CarPlay off
   .\recon.ps1 stocknav -Key <...>     the BMW map open, opened from the NAV icon in the left menu bar
   .\recon.ps1 cluster  -Key <...>     the cluster on its map view (the BMW map projected there: blank in Georgia is
                                       fine), the central screen on the home screen as in base
   .\recon.ps1 carplay  -Key <...>     2021+ firmware only: CarPlay guiding, its map in the cluster, the HUD on
   .\recon.ps1 clean    -Key <...>     removes /var/tmp/nav-recon from the unit (the reports are on the PC)
   options: -Sniff 30 (s of network capture, 0: none), -Sample 10 (s of CPU), -Out <folder> (default: ..\..\captures)

 The reports hold the car's signal catalog and, with -Sniff, network traffic that can carry its position: they go
 to captures\ (kept out of git). Blocked script? powershell -ExecutionPolicy Bypass -File .\recon.ps1 check -Key ...
#>
param(
    [Parameter(Position = 0)][ValidateSet('check', 'base', 'stocknav', 'cluster', 'carplay', 'clean')][string]$Cmd = 'check',
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Ip = '169.254.36.47',
    [int]$Port = 22,
    [ValidateRange(0, 300)][int]$Sniff = 30,
    [ValidateRange(1, 120)][int]$Sample = 10,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Out) { $Out = Join-Path $here '..\..\captures' }
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
foreach ($c in 'ssh', 'tar') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c not found (Windows 10/11 ship both; ssh: Settings > Apps > Optional features > OpenSSH Client)" } }
$Key = (Resolve-Path $Key).Path
$remote = '/var/tmp/nav-recon'
# the one ivi-list binary that goes to a car (built from kit/renderd/tools/ivi-list.c, read only: make in-test-ivi-list)
$IVI_LIST_SHA256 = '3ebf8667bee3d594c9a4d3dea19a161fd3cbe4eb8fc7ca379c2fba54dc7d7d32'

# the same options as push-to-car.ps1: the car's host key changes with every flash, so it is never pinned
$opts = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL',
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
    '-o', 'LogLevel=ERROR', '-p', $Port, '-i', $Key, "root@$Ip")
function Remote([string]$cmd) {
    & ssh @opts "LC_ALL=C; $cmd"
    if ($LASTEXITCODE -ne 0) { throw "on the unit: exit $LASTEXITCODE ($cmd)" }
}
# bytes through ssh (stdin -> the unit, or the unit's stdout -> a file): byte for byte, no PowerShell text pipe
function Pipe([string]$cmd, [string]$inFile, [string]$outFile) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command ssh).Source
    $psi.Arguments = (($opts | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ') + ' "LC_ALL=C; ' + $cmd + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = [bool]$inFile
    $psi.RedirectStandardOutput = [bool]$outFile
    # .NET opens ssh's stdin with the console's input encoding: UTF-8 with a BOM on many PCs, which puts 3 bytes
    # (ef bb bf) in front of the file and breaks it. Without a BOM while ssh starts, the bytes go as they are.
    $enc = [Console]::InputEncoding
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; $p = [System.Diagnostics.Process]::Start($psi) }
    finally { [Console]::InputEncoding = $enc }
    if ($inFile) { $s = [System.IO.File]::OpenRead($inFile); try { $s.CopyTo($p.StandardInput.BaseStream) } finally { $s.Close(); $p.StandardInput.Close() } }
    if ($outFile) { $o = [System.IO.File]::Create($outFile); try { $p.StandardOutput.BaseStream.CopyTo($o) } finally { $o.Close() } }
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "ssh exit $($p.ExitCode) ($cmd)" }
}

Write-Host "Connecting to the head unit ($Ip)..."
# remote commands: single quotes only (Windows PowerShell 5.1 mangles double quotes in a native program's argument)
Remote 'echo unit: $(hostname 2>/dev/null) $(uname -r 2>/dev/null), up $(cut -d. -f1 /proc/uptime) s; df -m /var/tmp | awk ''NR==2 {print $4}'' | sed ''s|^|room in /var/tmp, MB: |''; awk ''/^MemAvailable:/ {print int($2 / 1024)}'' /proc/meminfo | sed ''s|^|memory available, MB: |'''

if ($Cmd -eq 'check') { Write-Host 'check: connected; nothing copied or run.'; exit 0 }
if ($Cmd -eq 'clean') { Remote "rm -rf $remote && echo 'removed $remote'"; exit 0 }

# room for a report: the catalog copy, the capture (capped at ~40 MB), the archive of it (nav-recon.sh checks again)
Remote "free=`$(df -m /var/tmp | awk 'NR==2 {print `$4}'); [ `$free -ge 300 ] || { echo only `$free MB in /var/tmp - stopping, needs 300; exit 3; }"

# the kit: nav-recon.sh and ivi-list, with their checksums, unpacked in its own folder
$kit = Join-Path ([System.IO.Path]::GetTempPath()) ('nav-recon-kit-' + [guid]::NewGuid().ToString('N') + '.tar')
try {
    foreach ($f in 'nav-recon.sh', 'ivi-list') { if (-not (Test-Path (Join-Path $here $f))) { throw "$f not found next to this script" } }
    # only the known read-only ivi-list, and nav-recon.sh with Unix line endings (sh on the car fails on CR)
    if ((Get-FileHash -Algorithm SHA256 (Join-Path $here 'ivi-list')).Hash.ToLower() -ne $IVI_LIST_SHA256) { throw 'ivi-list is not the known read-only build: stopping' }
    if ([System.IO.File]::ReadAllBytes((Join-Path $here 'nav-recon.sh')) -contains 13) { throw 'nav-recon.sh has Windows line endings (CR): check it out again with git (.gitattributes keeps it LF)' }
    $sums = Join-Path $here 'RECON_SUMS'
    $lines = foreach ($f in 'nav-recon.sh', 'ivi-list') { (Get-FileHash -Algorithm MD5 (Join-Path $here $f)).Hash.ToLower() + '  ' + $f }
    [System.IO.File]::WriteAllText($sums, ($lines -join "`n") + "`n")
    & tar -cf $kit -C $here nav-recon.sh ivi-list RECON_SUMS
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
    Remove-Item $sums
    Write-Host 'Copying nav-recon.sh and ivi-list...'
    Pipe "mkdir -p $remote && cd $remote && tar xf - && md5sum -c RECON_SUMS >/dev/null && chmod 755 ivi-list && echo 'kit copied + verified'" $kit ''
} finally { if (Test-Path $kit) { Remove-Item $kit } }

# the run (read only: nav-recon.sh writes into its own report folder); the console shows its progress
Write-Host "Running nav-recon.sh ($Cmd, network capture $Sniff s, CPU $Sample s): keep the car as it is meanwhile..."
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "nav-recon-$Cmd-$stamp"
# its progress lines and any refusal ("nav-recon: ...") are shown, and its exit status is kept: a refusal stops here
Remote "cd $remote && LABEL=$Cmd SNIFF=$Sniff SAMPLE=$Sample OUT=$remote/$name sh nav-recon.sh > $remote/$name.log 2>&1; rc=`$?; grep -E '^(\[nav-recon\]|nav-recon:)' $remote/$name.log; rm -f $remote/$name.log; exit `$rc"

# back to the PC, checked
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$local = Join-Path (Resolve-Path $Out).Path "$name.tar.gz"
Write-Host "Copying the report to $local ..."
Pipe "cat $remote/$name.tar.gz" '' $local
$want = (& ssh @opts "md5sum $remote/$name.tar.gz" | Out-String).Split(' ')[0].Trim()
$got = (Get-FileHash -Algorithm MD5 $local).Hash.ToLower()
if ($want -ne $got) { throw "the report did not arrive whole (md5 $got, the unit's $want): run it again" }
Remote "rm -rf $remote/$name $remote/$name.tar.gz"
Write-Host ("done: $local (" + [math]::Round((Get-Item $local).Length / 1MB, 1) + " MB, checked); removed from the unit")
