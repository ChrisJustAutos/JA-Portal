# PBX worker change: click-to-dial (`mode='originate'`)

The portal's CRM now queues **click-to-dial** requests into the same
`call_monitor_events` table the `ja-ami-monitor` agent already drains for
Listen/Whisper/Barge (migration 098, applied). The portal UI is hidden behind
`NEXT_PUBLIC_CLICK_TO_DIAL=1` (Vercel env) — set it **after** this worker
change is deployed, so the old worker never sees an originate row.

## What the worker must do

Subscribe/claim exactly like spy requests, but branch on `mode`:

```text
row.mode === 'originate':
  claim:   UPDATE status='claimed', claimed_at=now()   (same optimistic claim)
  action:  AMI Originate
             Channel:  PJSIP/<row.actor_extension>     ← staff handset rings FIRST
             Exten:    <row.dial_number>               ← E.164, e.g. +61410599778
                       (strip the + / rewrite to your outbound dial-plan format,
                        e.g. 0410599778 into from-internal)
             Context:  from-internal                   ← or your outbound context
             Priority: 1
             CallerID: <workshop outbound CID>
             Async:    true
             Variable: ORIGINATE_REQ=<row.id>
  on OriginateResponse success (staff answered → customer dialling/bridged):
           UPDATE status='connected', completed_at=now(),
                  result_linkedid=<Linkedid of the originated call>   ← IMPORTANT
  on failure:
           UPDATE status='failed', completed_at=now(),
                  error = 'agent_busy' | 'no_answer' | 'busy' | 'congestion' | <reason text>
```

Notes:
- **`result_linkedid` matters**: the portal's linkage cron matches the CDR
  (`calls.linkedid`) to attach duration/recording to the CRM timeline. Grab
  the `Linkedid` from the Originate's channel events (e.g. a `Newchannel`/
  `OriginateResponse` correlated via the `ORIGINATE_REQ` channel variable).
  If it's hard to capture, leave it null — the cron falls back to matching
  ext + number + time window.
- Keep the existing TTL sweep covering originate rows (pending > 60s → the
  portal already marks them expired on next enqueue; the agent may too).
- Spy rows are unchanged (`mode` in listen/whisper/barge).
- New columns on `call_monitor_events`: `dial_number`, `contact_id`,
  `lead_id`, `result_linkedid`, `call_id` (cron-owned). The worker only
  reads `dial_number`/`actor_extension` and writes `result_linkedid`.

## Rollout

1. Deploy the updated worker on the FreePBX box (`ja-ami-monitor.service`).
2. Test from SQL: insert a row with your ext + your mobile, watch it claim →
   your handset rings → answer → mobile rings → bridged; row goes
   `connected` with a linkedid.
3. Set `NEXT_PUBLIC_CLICK_TO_DIAL=1` in Vercel env (production) + redeploy.
4. 📞 Call buttons appear on CRM lead/contact drawers (roles: admin/manager/
   sales via the new `use:phone` permission). Calls log to the contact
   timeline immediately; duration/recording attach within ~5 min of the CDR
   landing.
