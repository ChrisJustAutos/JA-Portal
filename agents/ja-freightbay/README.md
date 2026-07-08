# ja-freightbay — Freight Bay alert bridge

When a person crosses the line at the freight bay **during business hours**, this
service (1) rings a dedicated Yealink handset and plays a "freight bay alert"
recording, and (2) posts *"📦 Parts dropped off at Freight Bay"* to Slack with a
JPEG snapshot from the NVR.

Runs as a systemd service on the **FreePBX sync host** (the box beside Asterisk
that already runs `ja-cdr-sync` / `ja-transcribe`) — it's already on the LAN with
the NVR and Asterisk. **Zero npm dependencies at runtime** (all Node built-ins;
`dotenv` is optional convenience), so it runs with just Node 18+.

```
Freight Bay camera (NVR ch D24)
        │  line-crossing (VCA)
        ▼
NVR ISAPI alertStream ──subscribe──► ja-freightbay (this service)
                                       ├─► Asterisk call file → ring Yealink → play recording
                                       └─► Slack chat + JPEG snapshot upload
```

## How it works

- **Trigger** — subscribes to the NVR's long-lived multipart `alertStream`
  (`/ISAPI/Event/notification/alertStream`, HTTP Digest auth), parses each
  `EventNotificationAlert` document, and acts when `eventType` is
  `linedetection` (or `fielddetection` for intrusion) **and** the channel is the
  freight bay (D24 → channelID `2401`). Auto-reconnects on drop.
- **Business-hours gate + debounce** live in the service (single source of
  truth): only fires Mon–Fri 07:00–17:00 `Australia/Perth` (all configurable),
  max one alert per 120s.
- **Ring** — drops an Asterisk call file into the spool dir (no AMI creds
  needed), dialling the Yealink into the `freight-bay-alert` dialplan context
  which plays the recording twice.
- **Slack** — grabs a JPEG from the NVR (`/ISAPI/Streaming/channels/2401/picture`)
  and posts it via the current external-upload flow
  (`files.getUploadURLExternal` → PUT bytes → `files.completeUploadExternal`).
  If the snapshot fails it still posts the text so the alert is never silent.

## Deploy

```bash
# On the sync host:
sudo mkdir -p /opt/ja-freightbay
sudo cp -r index.js package.json /opt/ja-freightbay/
cd /opt/ja-freightbay
cp /path/to/.env.example .env && sudo nano .env    # fill in secrets (see below)
npm install                                         # only pulls dotenv (optional)

# Asterisk dialplan + recording (one-time):
#  1. FreePBX → Admin → System Recordings → Add → name it "freight-bay-alert"
#     (record from a handset or upload a WAV). Produces custom/freight-bay-alert.
#  2. Append extensions_custom.conf.snippet to /etc/asterisk/extensions_custom.conf
sudo asterisk -rx "dialplan reload"

# systemd:
sudo cp ja-freightbay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ja-freightbay
journalctl -u ja-freightbay -f
```

## Verify (in build-task order)

```bash
node index.js --probe          # log every NVR event, take NO actions.
                               # Walk the bay; confirm eventType + channelID.
                               # If the channel isn't 2401, set NVR_CHANNEL_ID.
node index.js --test-ring      # drop a call file now → the Yealink should ring
node index.js --test-snapshot  # pull a JPEG from the NVR → /tmp/fb-test-*.jpg
node index.js --test-slack     # snapshot + post to the Slack channel
node index.js --once           # run the full alert action once (ignores hours/cooldown? no — respects them)
```

`--probe` is the key first step: Hikvision channel numbering is usually
`D-number * 100 + 1` (so **D24 = 2401**), but confirm it against real events
before trusting the filter.

## Connections checklist (what Chris must supply → `.env`)

| Env | What | Where |
|-----|------|-------|
| `NVR_USER` / `NVR_PASS` | admin or a dedicated ISAPI user | NVR web UI → User Management (host `192.168.0.199`, ch **D24**) |
| `NVR_CHANNEL_ID` | ISAPI channel id for D24 (default `2401`) | confirm with `--probe` |
| `ALERT_EXTENSION` | the freight-bay Yealink's extension | FreePBX → Extensions |
| — | `freight-bay-alert` system recording | FreePBX → System Recordings |
| `SLACK_BOT_TOKEN` | `xoxb-…` with `chat:write` + `files:write` | Slack app → OAuth & Permissions |
| `SLACK_CHANNEL_ID` | target channel `C…` | channel → View details |
| `BUSINESS_TZ` / `BUSINESS_DAYS` / `BUSINESS_START` / `BUSINESS_END` | **confirm** — assumed `Australia/Perth`, Mon–Fri 07:00–17:00 | Chris |

Also enable **Line Crossing Detection** on the freight-bay camera:
NVR web UI → `Configuration → VCA → Line Crossing`, target = human, draw the line
across the bay entrance. Tick "notify surveillance centre" too so the NVR records
the event clip (needed for the phase-2 MP4).

## Phase 2 (not built yet)

- **MP4 clip** instead of a still: after ~20s, `POST /ISAPI/ContentMgmt/search`
  for D24 over `[event−5s, event+20s]`, `GET /ISAPI/ContentMgmt/download`, upload
  the same way. Snapshot-only first because the still is instant and reliable;
  the MP4 depends on the NVR having flushed the recording.
- **Auto-answer on speaker** — Yealink paging via `Alert-Info: Auto Answer` so
  the handset blasts the message hands-free. Base build is "ring + play".
- **Escalation** — switch the call file to AMI/ARI if you want
  unanswered-call retry logic.

## Notes / decisions baked in

- **Call file over AMI** — no AMI credential setup; the service writes to the
  spool dir directly (runs as `asterisk` so files are owned correctly).
- **Business-hours gate in the service**, not just the camera arming schedule,
  so it changes without touching the NVR.
- **Snapshot first, clip later** — a JPEG at event time is instant; the MP4 pull
  depends on NVR flush.
- **Bot token, not the Claude Slack connector** — this runs unattended.
