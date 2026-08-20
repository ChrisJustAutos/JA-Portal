<#
    print-centre-check.ps1 — health check for the PORTAL-CENTRE print centre box.

    Exists because pasting multi-line commands into that box is unreliable (the
    console flattens newlines, and RDP clipboard redirection drops out). Pull the
    repo and run this instead.

        cd C:\ja\JA-Portal; git pull
        powershell -ExecutionPolicy Bypass -File agents\label-print-agent\tools\print-centre-check.ps1

    Switches:
        -FixNetworkProfile   set any Public profile to Private (needs elevation).
                             Ethernet defaults to Public, which breaks WSD discovery.
        -TestPages           fire a Windows test page at each configured printer.

    See docs/print-centre-thinkcentre-setup.md for the whole runbook.
#>
[CmdletBinding()]
param(
  [switch]$FixNetworkProfile,
  [switch]$FixDymoPort,
  [switch]$TestPages
)

$ErrorActionPreference = 'Continue'
$AgentDir = 'C:\ja\JA-Portal\agents\label-print-agent'
$Wanted   = @('Shipping Label Printer', 'FUJIFILM Apeos C325z/328df', 'Fujifilm Upstairs')
# office = letters + envelopes, upstairs = invoices / pick lists
$ExpectedUri = @{ 'FUJIFILM Apeos C325z/328df' = '192.168.0.176'; 'Fujifilm Upstairs' = '192.168.0.139' }

function Head($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Bad ($m) { Write-Host "  FAIL  $m" -ForegroundColor Red }

$elevated = (New-Object Security.Principal.WindowsPrincipal(
              [Security.Principal.WindowsIdentity]::GetCurrent())
            ).IsInRole('Administrators')

Head "Box"
Write-Host ("  host={0}  user={1}  elevated={2}  node={3}" -f `
  $env:COMPUTERNAME, $env:USERNAME, $elevated,
  (& { try { (& node -v) } catch { 'not on PATH' } }))

Head "Network"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } |
  ForEach-Object { Write-Host ("  {0,-14} {1}" -f $_.InterfaceAlias, $_.IPAddress) }

foreach ($p in Get-NetConnectionProfile) {
  if ($p.NetworkCategory -eq 'Public') {
    if ($FixNetworkProfile -and $elevated) {
      try {
        Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
        Ok "$($p.InterfaceAlias) ($($p.Name)) was Public -> set Private"
      } catch { Bad "$($p.InterfaceAlias) is Public and could not be changed: $($_.Exception.Message)" }
    } else {
      Bad "$($p.InterfaceAlias) ($($p.Name)) is PUBLIC - WSD discovery/printing will fail. Re-run elevated with -FixNetworkProfile"
    }
  } else {
    Ok "$($p.InterfaceAlias) ($($p.Name)) = $($p.NetworkCategory)"
  }
}

Head "Discovery services"
foreach ($s in 'FDResPub','fdPHost','SSDPSRV','upnphost') {
  $svc = Get-Service $s -ErrorAction SilentlyContinue
  if (-not $svc)                      { Bad  "$s missing" }
  elseif ($svc.Status -ne 'Running')  { Warn "$s is $($svc.Status) (StartType $($svc.StartType))" }
  elseif ($svc.StartType -ne 'Automatic') { Warn "$s Running but StartType=$($svc.StartType) - may not survive a reboot" }
  else                                { Ok   "$s Running/Automatic" }
}

Head "Printers"
$installed = @(Get-Printer | Select-Object -ExpandProperty Name)
foreach ($w in $Wanted) {
  if ($installed -contains $w) { Ok "$w" } else { Bad "$w NOT INSTALLED" }
}
$extra = $installed | Where-Object { $Wanted -notcontains $_ }
if ($extra) { Write-Host "  (also installed: $($extra -join ', '))" -ForegroundColor DarkGray }

Head "WSD bindings"
# The (Copy 1) suffix is NOT a reliable indicator of which physical unit is which -
# read the device URI. A fe80:: binding is the silent-death mode: Windows reports the
# printer Normal while every job sits Error,Complete.
$mapped = @{}
Get-PnpDevice -Class PrintQueue -ErrorAction SilentlyContinue | ForEach-Object {
  $uri = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -ErrorAction SilentlyContinue |
          Where-Object KeyName -eq 'DEVPKEY_Device_LocationInfo').Data
  if ($uri -match '^https?://') { $mapped[$_.FriendlyName] = $uri }
}
if (-not $mapped.Count) { Warn "no WSD device URIs readable" }
# Only the devices behind OUR queues matter. Other printers on the LAN (Epson etc.)
# routinely sit on fe80:: bindings and are none of our business - listing them as
# failures would train you to ignore this report.
foreach ($k in $mapped.Keys) {
  $uri = $mapped[$k]
  $relevant = ($k -match 'Apeos|Fujifilm|DYMO|Shipping') -or
              ($ExpectedUri.Values | Where-Object { $uri -match [regex]::Escape($_) })
  if (-not $relevant)          { Write-Host "  ....  $k -> $uri" -ForegroundColor DarkGray }
  elseif ($uri -match 'fe80|\[') { Bad "$k -> $uri  (IPv6 link-local! force re-discovery - see runbook)" }
  else                         { Ok  "$k -> $uri" }
}
foreach ($name in $ExpectedUri.Keys) {
  $ip = $ExpectedUri[$name]
  $hit = $mapped.GetEnumerator() | Where-Object { $_.Value -match [regex]::Escape($ip) }
  if (-not $hit)                    { Warn "no device found at $ip (expected for '$name')" }
  elseif ($hit.Key -ne $name)       { Warn "$ip is device '$($hit.Key)' - confirm the QUEUE named '$name' points at it" }
}

Head "DYMO label printer"
# The port is bound to the mDNS name DYMOLW5XL30234cE.local rather than a raw IP, so it
# survives a DHCP change - but only while mDNS resolves. If resolution dies on this
# interface the queue silently goes nowhere. -FixDymoPort repoints it at the IP.
$dymoHost = 'DYMOLW5XL30234cE.local'
$dymoIp   = '192.168.0.138'
$resolved = try { ([Net.Dns]::GetHostAddresses($dymoHost)).IPAddressToString -join ',' } catch { $null }
if ($resolved) { Ok "mDNS $dymoHost -> $resolved" }
else           { Bad "mDNS $dymoHost does NOT resolve - the port cannot reach the printer. Re-run elevated with -FixDymoPort" }

$tcp = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $r = $c.BeginConnect($dymoIp, 9100, $null, $null)
  if ($r.AsyncWaitHandle.WaitOne(1500)) { $c.EndConnect($r); $tcp = $true }
  $c.Close()
} catch { }
if ($tcp) { Ok "${dymoIp}:9100 reachable" } else { Bad "${dymoIp}:9100 unreachable - printer off, asleep, or a different subnet" }

$dymoQ = Get-Printer 'Shipping Label Printer' -ErrorAction SilentlyContinue
if ($dymoQ) {
  $port = Get-PrinterPort -Name $dymoQ.PortName -ErrorAction SilentlyContinue
  Write-Host ("  queue status={0}  port={1}  host={2}" -f $dymoQ.PrinterStatus, $dymoQ.PortName, $port.PrinterHostAddress)
  $jobs = @(Get-PrintJob -PrinterName $dymoQ.Name -ErrorAction SilentlyContinue)
  if ($jobs) { foreach ($j in $jobs) { Warn "queued job $($j.Id) '$($j.DocumentName)' = $($j.JobStatus)" } }
  else       { Ok "no jobs queued" }

  if ($FixDymoPort -and $elevated) {
    try {
      Set-PrinterPort -Name $dymoQ.PortName -PrinterHostAddress $dymoIp -ErrorAction Stop
      Ok "port repointed to $dymoIp"
    } catch { Bad "could not repoint port: $($_.Exception.Message)" }
  } elseif ($FixDymoPort) { Bad "-FixDymoPort needs an elevated shell" }
} else { Bad "queue 'Shipping Label Printer' not found" }
Write-Host "  NOTE: a Windows test page is a full-page document - a 5XL on 4x6 labels may" -ForegroundColor DarkGray
Write-Host "  swallow or reject it. Nothing printing here is NOT proof the queue is broken;" -ForegroundColor DarkGray
Write-Host "  requeue a real label job to test properly." -ForegroundColor DarkGray

Head "Stuck spooler jobs"
$stuck = foreach ($w in $Wanted) {
  Get-PrintJob -PrinterName $w -ErrorAction SilentlyContinue |
    Where-Object { $_.JobStatus -match 'Error|Blocked|Offline|PaperOut' }
}
if ($stuck) {
  foreach ($j in $stuck) { Bad "$($j.PrinterName) job $($j.Id) '$($j.DocumentName)' = $($j.JobStatus)" }
  Write-Host "  The agent marks jobs done at SumatraPDF handoff, so the DB will say 'done' anyway." -ForegroundColor DarkGray
} else { Ok "no jobs in an error state" }

Head "Agent"
$node = Get-Process node    -ErrorAction SilentlyContinue
$wsc  = Get-Process wscript -ErrorAction SilentlyContinue
if     (-not $node)            { Bad  "no node process - agent is DOWN" }
elseif ($node.Count -gt 1)     { Warn "$($node.Count) node processes (duplicate agents)" }
else                           { Ok   "node pid $($node.Id) since $($node.StartTime)" }
if     (-not $wsc)             { Warn "no wscript supervisor - agent will not restart if it exits" }
elseif ($wsc.Count -gt 1)      { Warn "$($wsc.Count) wscript supervisors (duplicates)" }
else                           { Ok   "supervisor pid $($wsc.Id)" }

$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\JA-Label-Agent.vbs'
if (Test-Path $startup) { Ok "startup entry present" } else { Bad "startup entry MISSING - agent will not start after a reboot" }

$log = Join-Path $AgentDir 'agent.log'
if (Test-Path $log) {
  Write-Host "  --- agent.log (last 8) ---" -ForegroundColor DarkGray
  Get-Content $log -Tail 8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else { Warn "no agent.log at $log" }

if ($TestPages) {
  Head "Test pages"
  foreach ($w in $Wanted) {
    $p = Get-CimInstance Win32_Printer -Filter "Name='$($w -replace "'","''")'" -ErrorAction SilentlyContinue
    if ($p) {
      try { Invoke-CimMethod -InputObject $p -MethodName PrintTestPage -ErrorAction Stop | Out-Null; Ok "sent -> $w" }
      catch { Bad "could not send to ${w}: $($_.Exception.Message)" }
    } else { Bad "$w not found" }
  }
  Write-Host "  Now check the paper: office Apeos = letters/envelopes, upstairs = invoices." -ForegroundColor DarkGray
}

Write-Host ""
