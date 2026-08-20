# Print Centre PC — Lenovo ThinkCentre setup runbook

Purpose: make the ThinkCentre the always-on box that runs the **label-print-agent**
(labels, invoices, letters, envelopes, pick lists) and any future server-side local
actions, replacing the agent that runs on Chris's MSI laptop.

**Why:** the agent on the laptop *claims* jobs even when the laptop is off the office
network, then fails after 3 attempts — prints die silently. (17–18 Aug 2026: 15
letter+envelope pairs + a pick list.)

Run the steps in order. Every step ends with a **VERIFY** you can paste back.

> **Deployment note:** the box is being commissioned on **Wi-Fi** (`192.168.0.113`,
> Intel AX201) and will be **moved to the comms room onto Ethernet** (I219-LM). After
> the move: take a **DHCP reservation** for it, then **re-verify every printer queue
> with a test print** — changing interface re-binds WSD, and a stale WSD binding is
> the silent-failure mode (jobs mark `done` at SumatraPDF handoff while nothing
> prints). NIC power management is already disabled on all three adapters.
>
> **The wired profile will default to `Public`.** WSD discovery and printing need it
> **Private** — the Wi-Fi profile ("Just Autos Workshop") was Public out of the box and
> Add-device found nothing until it was flipped. After plugging in Ethernet:
> `Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private`.
> The four discovery services (`FDResPub`, `fdPHost`, `SSDPSRV`, `upnphost`) are set to
> **Automatic** — they shipped as `Manual`, which is a good way for WSD to come back
> half-alive after an unattended reboot.

> **Terminal gotcha on this box:** pasting a multi-line block into the console
> collapses the newlines onto one line, so multi-line scripts break (a bare
> `function` becomes a command). Keep pasted commands to a single `;`-terminated
> line, or write them to a `.ps1` and run the file.

---

## Status — 2026-08-20

Commissioned on the ThinkCentre `11T300A1AU`, host **`PORTAL-CENTRE`**, account
`Admin-JustAutos`, Win 11 Pro b26200, 16 GB RAM, ~886 GB free.

| Item | State |
|---|---|
| Never sleep / hibernate / disk spin-down | done |
| NIC power management disabled (all 3 adapters) | done |
| RDP enabled + firewall rule | done |
| Tailscale | done — `portal-centre` = **100.72.189.95**; **key expiry disabled** |
| RDP over tailnet verified from MSI | done — `100.72.189.95:3389` OK, 5 ms direct |
| Git | done — 2.55.0.3 |
| Node | done — **v22.23.2** (pinned; not 24) |
| Network profile Private + discovery services Automatic | done |
| Printers: `Shipping Label Printer`, `FUJIFILM Apeos C325z/328df`, `Fujifilm Upstairs` | done — all 3 test-printed |
| Repo clone `C:\ja\JA-Portal` + `npm install` + `.env` | done |
| Agent smoke test | done — `realtime: SUBSCRIBED`, heartbeat landed |
| Startup supervisor VBS | done — `%APPDATA%\...\Startup\JA-Label-Agent.vbs` |
| Auto-login | done — Sysinternals **Autologon**, `AzureAD\admin-justautos` (LSA secret, no cleartext) |
| BIOS → After Power Loss → Power On | done |
| Cold-boot test (unattended login + agent up) | done — `agent_host=Portal-Centre` 27 s after boot, keyboard untouched |
| Ethernet (currently Wi-Fi `192.168.0.113`) | **TODO** — on move to comms room |
| DHCP reservation | **TODO** — on move to comms room |
| Live print test (real letter) | done — 19 Aug letter + DL envelope, 1st attempt, **physically verified out of the office Apeos** |
| Retire MSI Startup entry | **TODO** — only after a few days of overlap |

### Identity / login

The box is **Entra-joined**: the console account is `azuread\admin-justautos`
(UPN `admin@justautosmechanical.com.au`), whose profile is `C:\Users\Admin-JustAutos` —
so the Startup folder under that profile is the correct one.

Auto-login is **not** done with registry `DefaultPassword`: Windows generally ignores it
for Entra/Microsoft accounts, and it stores the admin password in cleartext. Use
Sysinternals **Autologon** (`https://download.sysinternals.com/files/AutoLogon.zip` —
capital L; `Autologon.zip` 404s) with Username `admin-justautos`, Domain `AzureAD`.
It writes an LSA secret, so `AutoAdminLogon=1` with `DefaultPassword` **absent** is the
correct end state.

### Install gotchas hit on this box

- `winget install --id tailscale.tailscale` → **`No package found`**. Use the MSI:
  `https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi`.
- `msiexec` from a user-profile `%TEMP%` returned **1603**; writing to `C:\` root gave
  **Access denied / 1622**. Stage installers in **`C:\Windows\Temp`** instead
  (admin-writable, SYSTEM-readable).
- `winget install OpenJS.NodeJS.LTS` would install **Node 24** now that 24 is LTS.
  Pin 22 by resolving the MSI from `https://nodejs.org/dist/index.json`.
- `Start-Process msiexec -Wait -PassThru` often reports a **blank ExitCode** — verify
  by `Test-Path` on the installed binary instead.
- The console **flattens pasted newlines**, so only single `;`-terminated lines are
  safe. Confirm you are in the elevated window (`ADMIN True`) before each block; two
  commands were lost to running in a non-elevated one.

---

## Constants

| Thing | Value |
|---|---|
| Repo | `https://github.com/ChrisJustAutos/JA-Portal` (agent lives at `agents/label-print-agent`) |
| Node | **22 LTS** — NOT 24 (`pdf-to-printer` can't list printers on 24: `wmic` is gone, so the Settings printer dropdown breaks) |
| DYMO 5XL | host `DYMOLW5XL30234cE.local` / `192.168.0.138`, raw TCP **9100**, DYMO Connect driver, printer name **`Shipping Label Printer`** |
| Apeos (office) | `192.168.0.176`, MAC `1c-7d-22-62-7b-e6`, host `ff1c7d22627be6.local`, install via **WSD**, name **`FUJIFILM Apeos C325z/328df`** |
| Apeos (upstairs) | `192.168.0.139`, WSD, rename to **`Fujifilm Upstairs`** |
| Box | ThinkCentre `11T300A1AU`, host **`PORTAL-CENTRE`**, Win 11 Pro b26200, account **`Admin-JustAutos`** |
| Supabase | project `qtiscbvhlvdvafwtdtcd` — `.env` needs `SUPABASE_URL` + service-role key |

### Printer routing (from `print_agent_settings`; DB wins over `.env`)

| kind | printer | bin |
|---|---|---|
| `label` | *(DB null → `.env` `DYMO_PRINTER_NAME`)* `Shipping Label Printer` | — |
| `letter` | `FUJIFILM Apeos C325z/328df` | `Tray 1` (A4) |
| `envelope` | `FUJIFILM Apeos C325z/328df` | `Manual feed` (= bypass tray, DL) |
| `invoice` | `Fujifilm Upstairs` | *(default)* |

**CRITICAL — install the office Apeos over WSD, never raw TCP/9100.** The queue uses
the Microsoft IPP Class Driver and the tray selection travels as an **IPP job
attribute**; a raw 9100 port prints fine but *silently drops the bin*, so every DL
envelope comes out of Tray 1 on A4.

---

## Step 0 — Probe the box

Gather: Windows **edition** (Pro required to host RDP), build, IP, whether the three
printers are reachable, whether Node / git / Tailscale are already present.

---

## Step 1 — Windows basics

Run PowerShell **as Administrator**.

The box is a ThinkCentre **11T300A1AU**, already named **`PORTAL-CENTRE`**, running
**Windows 11 Pro build 26200** (64-bit, 16 GB RAM, ~886 GB free) under the local
account **`Admin-JustAutos`**. No rename needed.

Everything below needs an **elevated** shell — `Start-Process powershell -Verb RunAs`.

```powershell
# Never sleep, never hibernate, never spin down disks
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off

# Don't let NIC power-saving drop the network
Get-NetAdapter | ForEach-Object { Disable-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue }
```

**Manual, in BIOS** (F1 on ThinkCentres): `After Power Loss → Power On`, so the box
comes back by itself after an outage.

**Auto-login** — headless box, and the agent runs in the *interactive user session*,
so the machine must reach the desktop unattended. Use `netplwiz`, or:

```powershell
$k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $k AutoAdminLogon '1'
Set-ItemProperty $k DefaultUserName 'Admin-JustAutos'
Set-ItemProperty $k DefaultPassword '<password>'   # cleartext; box is physically in the office
```

**VERIFY:** `powercfg /query SCHEME_CURRENT SUB_SLEEP` shows AC standby = 0.

---

## Step 2 — Tailscale (remote access from anywhere)

```powershell
winget install --id tailscale.tailscale -e --accept-source-agreements --accept-package-agreements
& 'C:\Program Files\Tailscale\tailscale.exe' up
```

Log in as **chris@** — same tailnet as the FreePBX box (`100.82.97.46`) and the MSI
(`100.95.154.32`).

**Then in the Tailscale admin console (manual, easy to forget):**

- **Disable key expiry** on this node — otherwise remote access dies silently in ~6 months.
- Give it a stable machine name.

**VERIFY:** `tailscale status` lists the new node, and the MSI's `tailscale status`
sees it too.

---

## Step 3 — RDP

Requires Windows **Pro**. If the probe says Home: upgrade the licence, or use
RustDesk / Chrome Remote Desktop instead.

```powershell
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' fDenyTSConnections 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
```

> **RDP GOTCHA:** the agent runs from the Startup VBS in the interactive user session.
> Always **Disconnect** an RDP session — never **Sign out**, which kills the agent.
> (Running it as an NSSM service is the upgrade path, but WSD printing from a service
> session is quirky, so session-based stays for now.)

**VERIFY:** RDP in from the MSI over the Tailscale IP, then *disconnect*.

---

## Step 4 — Node 22 LTS + git

```powershell
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements
winget install --id Git.Git -e --accept-package-agreements
```

**VERIFY:** in a **new** shell, `node -v` prints `v22.x` and `git --version` works.

---

## Step 5 — Printers

### DYMO 5XL → `Shipping Label Printer`

Fully scriptable — Standard TCP/IP port, no WSD involved. Install the driver:

```powershell
winget install --id DYMO.DYMOConnect -e --accept-source-agreements --accept-package-agreements
```

DYMO Connect may auto-create the queue (on the MSI it appeared already named
`Shipping Label Printer`, taken from the device's own configured name) — but on
PORTAL-CENTRE it did **not**, and it also did not register the print driver: it only
stages the INFs under `C:\Program Files (x86)\DYMO\DYMO Connect\Drivers\`. Register
the driver from the store first, or `Add-Printer` fails with *"The specified driver
does not exist"*:

```powershell
Add-PrinterDriver -Name 'DYMO LabelWriter 5XL'
```

(If even that fails, install the staged INF explicitly:
`pnputil /add-driver 'C:\Program Files (x86)\DYMO\DYMO Connect\Drivers\LW5xx\DYMO_LW5xx.inf' /install`.)

Then create the queue:

```powershell
$h='192.168.0.138'; try { if([Net.Dns]::GetHostAddresses('DYMOLW5XL30234cE.local')) { $h='DYMOLW5XL30234cE.local' } } catch {}
Add-PrinterPort -Name "DYMO 5XL on $h" -PrinterHostAddress $h -PortNumber 9100 -ErrorAction SilentlyContinue
Add-Printer -Name 'Shipping Label Printer' -DriverName 'DYMO LabelWriter 5XL' -PortName "DYMO 5XL on $h"
```

`DYMOLW5XL30234cE.local` **resolves via mDNS** on this box, so the port uses the
hostname rather than a hardcoded `192.168.0.138` — survives a DHCP change.

Reference from the MSI: driver `DYMO LabelWriter 5XL`, port
`DYMO Label Writer 5XL on DYMOLW5XL30234cE.local` (Standard TCP/IP, host
`DYMOLW5XL30234cE.local`, 9100). Note the MSI's queue has **no explicit PaperSize** —
SumatraPDF handles sizing via `PRINT_SCALE=fit`, so leave the driver defaults alone.

**Priority note:** the DYMO only serves `kind='label'` (B2B freight labels). Letters,
envelopes, invoices and pick lists all go to the Apeos units — those are the kinds
that have actually been failing. Get the Apeos queues + supervisor working first; the
MSI keeps printing labels in the meantime since both agents share the queue.

The DYMO cannot pull from the cloud itself — no cloud client, and it can't render a
PDF over raw 9100 — so a LAN bridge PC is mandatory for this printer.

### Office Apeos → `FUJIFILM Apeos C325z/328df`

Add printer → let Windows discover it over **WSD** (it advertises via mDNS as
`ff1c7d22627be6.local` / `192.168.0.176`). Accept the Microsoft IPP Class Driver.
Confirm the queue name is exactly `FUJIFILM Apeos C325z/328df`.

Check the driver exposes the bins the DB expects:

```powershell
Get-PrinterProperty -PrinterName 'FUJIFILM Apeos C325z/328df' |
  Where-Object { $_.PropertyName -match 'Bin|Tray|InputSlot' }
```

Must include `Tray 1` and `Manual feed`. Load DL envelopes in the bypass tray and set
the bypass paper size to DL **on the printer's own panel** — it refuses the size
otherwise.

### Upstairs Apeos → `Fujifilm Upstairs`

Discover the second unit at `192.168.0.139` over WSD. Windows will name it
`FUJIFILM Apeos C325z/328df (Copy 1)` — rename it:

```powershell
Rename-Printer -Name 'FUJIFILM Apeos C325z/328df (Copy 1)' -NewName 'Fujifilm Upstairs'
```

**Telling the two identical Apeos units apart.** Both report the same model name, so
the queue name alone is useless. WSD device URIs are exposed as PnP properties — this
maps each discovered print device to its address:

```powershell
Get-PnpDevice -Class PrintQueue -EA SilentlyContinue | ForEach-Object {
  $d = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -EA SilentlyContinue |
        Where-Object { $_.Data -match '^https?://' }).Data -join ' '
  if ($d) { "$($_.FriendlyName) -> $d" }
}
```

`192.168.0.176` = office = letters + envelopes. `192.168.0.139` = upstairs =
invoices / pick lists.

If that returns nothing (it did on a freshly-added queue), read the property directly —
this is the reliable form:

```powershell
Get-PnpDevice -Class PrintQueue | Where-Object { $_.FriendlyName -match 'FUJIFILM' } | ForEach-Object {
  $u = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -EA SilentlyContinue |
        Where-Object KeyName -eq 'DEVPKEY_Device_LocationInfo').Data
  "$($_.FriendlyName) -> $u"
}
```

> **NEVER infer which unit is which from the `(Copy 1)` suffix.** Discovery order is
> not stable. On the MSI, `(Copy 1)` was the **upstairs** unit (`.139`); on
> PORTAL-CENTRE, `(Copy 1)` was the **office** unit (`.176`) — exactly reversed. Get it
> backwards and letters print upstairs while invoices print in the office, with **no
> error anywhere**, because the agent reports success at spooler handoff.

On PORTAL-CENTRE the queues therefore had to be swapped, upstairs first to free the
name:

```powershell
Rename-Printer -Name 'FUJIFILM Apeos C325z/328df' -NewName 'Fujifilm Upstairs'
Rename-Printer -Name 'FUJIFILM Apeos C325z/328df (Copy 1)' -NewName 'FUJIFILM Apeos C325z/328df'
```

> **Insist on an IPv4 URI.** On the MSI the Epson shows
> `http://[fe80::6a55:d4ff:fe9b:2c4c%10]:80/WSD/DEVICE` — a WSD binding to an **IPv6
> link-local** address. That is precisely the binding that died overnight and made
> every letter vanish while Windows still reported the printer "Normal". If a newly
> added queue maps to a `fe80::` URI, force re-discovery (`pnputil /remove-device` the
> IPP PnP device, let mDNS/WSD re-find it) until it binds to the IPv4 address.

To identify which physical unit is on a raw port, send `@PJL INFO ID` to tcp/9100.

**VERIFY:** a Windows test page out of each of the three, from the right physical
device.

```powershell
Get-Printer | Select-Object Name, DriverName, PortName | Format-Table -AutoSize
```

---

## Step 6 — The agent

```powershell
mkdir C:\ja
cd C:\ja
git clone https://github.com/ChrisJustAutos/JA-Portal.git
cd C:\ja\JA-Portal\agents\label-print-agent
npm install
```

Create `.env` — copy the values from the MSI's `agents/label-print-agent/.env`; the
service-role key is not in git:

```
SUPABASE_URL=https://qtiscbvhlvdvafwtdtcd.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
DYMO_PRINTER_NAME=Shipping Label Printer
LABEL_BUCKET=b2b-shipping-labels
POLL_MS=30000
MAX_ATTEMPTS=3
PRINT_SCALE=fit
INVOICE_PRINTER_NAME=Fujifilm Upstairs
```

Foreground smoke test:

```powershell
node index.js
```

Expect `realtime: SUBSCRIBED` and **no** `WARNING: printer "Shipping Label Printer"
not found`. Then Ctrl-C.

**VERIFY:** in the portal, **Settings → Workshop → Thank-you letters → Printers &
trays** shows the agent online with `agent_host` = this box's hostname, and the
dropdown lists its printers.

> Multi-PC is supported (migration 051 `claimed_at`): run this **in parallel** with
> the MSI agent for a few days. The atomic claim guarantees exactly-once printing, and
> a job stranded mid-print auto-reclaims after `STALE_PRINTING_MS` (2 min).
> `agent_host` / `available_printers` is last-writer-wins between the two agents —
> cosmetic only.

---

## Step 7 — Auto-start

`run-agent-hidden.vbs` in the repo is itself the supervisor loop: it relaunches
`node index.js` ~15s after any exit, and it `cd`s to **its own folder**. So the copy
that lives in the Startup folder must set the directory explicitly instead. Create
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JA-Label-Agent.vbs`:

```vbscript
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\ja\JA-Portal\agents\label-print-agent"
Do
  sh.Run "cmd /c node index.js >> agent.log 2>&1", 0, True
  sh.Run "cmd /c echo restart after exit >> agent.log", 0, True
  WScript.Sleep 15000
Loop
```

> Executing a `.cmd` file from `wscript` is **blocked** on these PCs while inline
> `sh.Run` commands are not — that's why the loop is inline VBS and not a batch file.

**VERIFY:** reboot; don't log in manually (auto-login should land on the desktop);
then `agent.log` has a fresh startup line and `print_agent_settings.agent_last_seen`
is within a minute.

---

## Step 8 — Live print test

Reprint a recent letter from **/workshop/letters → History → Reprint**, or requeue a
job by hand:

```sql
update label_print_jobs
   set status='pending', attempts=0, error=null, claimed_at=null
 where id = '<job id>';
```

The agent drains pending on its next poll — no restart needed. Watch `agent.log`.

> The agent marks a job `done` at **SumatraPDF handoff**, not at physical print, so
> the DB can lie. Confirm with `Get-PrintJob -PrinterName '<name>'` and with paper.

---

## Step 9 — Retire the MSI agent

Only after the ThinkCentre has printed live jobs successfully for a few days:

```powershell
# on the MSI
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\JA-Label-Agent.vbs"
Get-Process node | Where-Object { $_.Path -like '*label-print-agent*' } | Stop-Process
```

---

## RDP to an Entra-joined box — what actually worked

RDP to PORTAL-CENTRE fails with **"The logon attempt failed"** for every username form
(`AzureAD\admin@justautosmechanical.com.au`, plain UPN) when the client is not joined to
the same tenant. CredSSP pre-authentication cannot satisfy Entra from an unjoined
client. `enablerdsaadauth:i:1` (Entra web sign-in) does not help either — on an
unjoined client mstsc drops out of NLA negotiation and you get error **`0xb09`**
("your computer does not support NLA").

The working combination — authenticate at the **remote logon screen** instead of
pre-authenticating, which is the same Windows UI that accepts the Entra account at the
console:

**On the host** (elevated):

```powershell
$k='HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
Set-ItemProperty $k SecurityLayer 1        # negotiate; 2 = TLS required, refuses CredSSP-less clients
Set-ItemProperty $k UserAuthentication 0   # NLA off
Restart-Service TermService -Force
```

**Both** settings are required — with `SecurityLayer 2` the host still refuses even with
NLA off, which produces *"authentication is not enabled and the remote computer requires
that authentication be enabled"*. Check
`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\UserAuthentication` is
empty; if Intune enforces it, local changes revert and this route is dead.

**On the client**, an `.rdp` with:

```
full address:s:100.72.189.95
enablecredsspsupport:i:0
authentication level:i:0
```

(`PORTAL-CENTRE-fallback.rdp` on Chris's laptop Desktop.)

> **Security posture:** NLA off means the logon screen is reachable without
> pre-authentication. Acceptable **only** because 3389 is reachable solely over the
> tailnet — no port forwarding, firewall rules scoped to it. If that ever changes, set
> `UserAuthentication 1` and `SecurityLayer 2` back.

> **RDP must sign in as `admin-justautos`** — the same account that auto-logs in. Windows
> Pro is single-session, so connecting as any other identity displaces that session and
> **kills the print agent**. This is also why a local account "just for RDP" is not an
> option. Always leave by **Disconnect**, never **Sign out**.

## Health check script

Pasting long commands into this box is unreliable — the console flattens newlines and
RDP clipboard redirection drops out (fix that with `taskkill /f /im rdpclip.exe` then
`rdpclip`). So the checks live in the repo instead:

```
cd C:\ja\JA-Portal; git pull
powershell -ExecutionPolicy Bypass -File agents\label-print-agent\tools\print-centre-check.ps1
```

Reports: network profiles (flagging any `Public`), the four discovery services, the
three required printer queues, WSD device URIs (failing any `fe80::` link-local binding
on a queue we care about), spooler jobs stuck in an error state, agent + supervisor
processes, the Startup entry, and the last 8 log lines.

- `-FixNetworkProfile` — set any Public profile to Private (needs elevation). Use this
  after the Ethernet move.
- `-TestPages` — fire a Windows test page at each of the three printers.

## Headless operation (comms room)

The box runs with **no monitor, keyboard or mouse**. Two facts make that safe:

- **Tailscale runs as a Windows service** (`Tailscale`, Running/Automatic, SYSTEM), so
  the tailnet is up at boot **before any login**. If Autologon ever fails, the box is
  still reachable at `100.72.189.95` — this is the safety net.
- The **Remote Desktop firewall rules are scoped `Any`**, so they apply on a `Public`
  profile too. That matters because a newly-plugged Ethernet profile defaults to Public;
  without this you would be locked out with no screen to fix it from.

**Leave Wi-Fi enabled and connected after the move.** Its profile is already Private, so
it is a guaranteed second route in. Costs nothing.

**Before unplugging the monitor**, dry-run the headless cycle while you can still see
the screen: RDP in, `Restart-Computer` from *inside* the RDP session, and confirm the
box comes back and reconnects unattended.

**In the BIOS while the screen is attached:** disable any *halt on POST error* /
*require keyboard* option. Headless, you would never see the message.

### Move sequence

1. Shut down, relocate, plug in Ethernet (leave Wi-Fi alone), power on.
2. RDP to `100.72.189.95`.
3. `Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private`
4. One test page per queue — the interface change re-binds WSD, and a stale binding is
   the silent killer.
5. DHCP reservation on the router.

## Known failure modes (all seen in production)

| Symptom | Cause | Fix |
|---|---|---|
| Jobs `failed` after 3 attempts, nothing prints | agent running on a PC off the office network — the laptop problem this box solves | requeue: `status='pending', attempts=0, error=null, claimed_at=null` |
| Jobs `done` in DB, nothing on paper | agent marks done at spooler handoff; the WSD port binding died (pointed at a dead IPv6 link-local address) | `Get-PrintJob` shows `Error, Complete`; `pnputil /remove-device` the IPP PnP device to force mDNS/WSD re-discovery, which refreshes the binding |
| Envelopes print A4 out of Tray 1 | queue added as raw TCP/9100 — silently drops the IPP `bin` attribute | reinstall the queue over **WSD** |
| Job goes to the *old* printer right after a config change | agent caches `print_agent_settings` ~30s | wait 30s+ after changing printers before queueing |
| Settings printer dropdown won't refresh | `pdf-to-printer` can't list printers on Node 24 (`wmic` removed) | stay on Node 22 LTS |
| Remote access dead after ~6 months | Tailscale node key expired | disable key expiry in the admin console |
| Agent gone after remoting in | RDP **Sign out** killed the user session | always **Disconnect** |

## Still open (not in scope today)

- **Print-failure Slack watchdog** — verify Windows job *completion* (not just
  spooler handoff) and alert Slack on `Error` / `failed`. Every outage so far has been
  silent. This box is its natural home.
