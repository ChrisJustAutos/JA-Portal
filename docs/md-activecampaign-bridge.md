# Bridging Mechanics Desk and ActiveCampaign

**What changed on 4 September 2026, why it was needed, and how the two systems talk to each other now.**

---

## 1. In one paragraph

Mechanics Desk is where quotes are written. ActiveCampaign is where the sales pipeline and marketing live. Until today the connection between them was one-directional and lossy: a quote email created or updated a deal, and after that the two systems drifted apart with nothing to reconcile them. Deals never closed, half the pipeline sat in an archive nobody was looking at, and nothing on a deal recorded where it had come from. Today's work closes that loop: every deal now says where it originated, invoices in MYOB close deals as **Quote Won**, silence closes them as **Quote Lost**, and the two halves of the pipeline have been put back in one place. The live pipeline went from a reported **$21.2M to $27.2M** — none of it new business, all of it work that was already ours and invisible.

---

## 2. What was in place before

### 2.1 Pipeline A — the quote email watcher

Live since **29 April 2026**, replacing a Zapier zap that did the same job.

Microsoft Graph webhooks watch the five sales reps' mailboxes. When Mechanics Desk emails a quote PDF, the portal:

1. Reads the attachment (`performance-estimate*.pdf`) and extracts quote number, value, customer and vehicle
2. Finds or creates the **ActiveCampaign contact**
3. Creates a new **deal**, or updates an existing open one from the last 30 days
4. Creates or updates the matching **Monday.com** board item

That much worked, and still does. Everything below is what sat *around* it.

### 2.2 The gaps

| Gap | What it meant |
|---|---|
| **No deal ever closed** | Nothing marked a deal Won or Lost. The pipeline only ever grew. |
| **No record of origin** | Nothing on a deal said whether it came from Mechanics Desk or an online enquiry. Origin could only be guessed from the shape of the deal's title. |
| **A found deal kept its stage** | When a quote went out against an existing deal, the deal stayed at *Quote Required* — a stage that means "no quote yet". |
| **Three pipelines, one of them wrong** | Make and Zapier were still creating enquiry deals in the **"Old Quotes" archive** rather than the live pipeline. |
| **Detail lived in free text** | Vehicle and rego existed only inside the deal title, where nothing can filter or group by them and a rep can edit them away. |

### 2.3 The three ActiveCampaign pipelines

| ID | Name | Deals | Role |
|---|---|---|---|
| 4 | Quote Stages | 5,535 | Legacy, built 2020. Untouched. |
| 5 | Old Quotes | ~33,000 | Archive, single stage. **Was still receiving live quotes.** |
| 6 | New Quote Pipeline | 1,902 → **2,956** | The live one: Quote Required → Sent → Won → Lost |

---

## 3. What was built today

### 3.1 Provenance — every deal says where it came from

Deals now carry four custom fields, and the contact carries a **Mechanics Desk** tag:

- **Source** — `Mechanics Desk`
- **MD Quote Number**
- **Vehicle**
- **Rego**

The tag is what an ActiveCampaign automation can trigger on; the fields are what a report filters by. They are written on both new quotes and repeat quotes, so older deals get marked as they are touched.

**Backfilled onto 2,177 existing deals**, so history is queryable too, not just what happens next.

### 3.2 Quote Won — from a real invoice

A quote is only *won* when the work is invoiced, so that is the trigger. Two routes, strongest first:

**Route 1 — MYOB, matched by customer email.** A finalised Mechanics Desk invoice is pushed to MYOB, and a MYOB customer card carries an email address. ActiveCampaign contacts are keyed on email, so this is an identity match rather than a guess:

```
MYOB invoice → customer card → email → AC contact → their open deal → Quote Won
```

Of 101 invoices in a typical week, **80 carry an email on the card** — so this route covers roughly four fifths of them.

**Route 2 — Mechanics Desk, for the rest.** Where the MYOB card has no email, the portal walks MD's own keys instead:

```
deal → quote number → md_quotes → md_invoices, matched on MD customer id + rego
```

Guarded three ways: the invoice must fall after the quote, within 180 days, and be worth between **0.5× and 3×** the quote. The ceiling matters — without it, invoices at 35×, 83× and 230× the quote were being matched, which is a different job on the same vehicle, not the quoted work.

### 3.3 Quote Lost — silence, measured properly

A deal untouched for **90 days** closes as Quote Lost. The clock runs from **last activity**, not from when the quote went out, so a deal a rep worked last week is safe and adding a note resets it.

Deals already sitting at Won or Lost are left alone, and anything the Won passes claim is excluded first — a deal invoiced on day 100 is booked as the win it is, rather than closed for going quiet.

### 3.4 The archive migration

The largest single finding. **1,052 open, quoted deals worth $13,141,263** were sitting in the "Old Quotes" archive, because the Make and Zapier form automations were still writing there after the new pipeline was built. Pipeline A found those deals — its contact lookup is not pipeline-filtered — appended the quote number and updated them *in place*, leaving live work in an archive.

All 1,052 were moved into the live pipeline at **Quote Sent**, each with a note recording where it came from. Nothing else was changed: not the value, the owner, the title, or the status. Won and Lost remain the nightly sweep's decision, made on its own evidence.

**Deliberately not moved:** ~14,000 unquoted enquiries worth $0 going back to 2024. Quoted deals appear in the archive only from April 2026, which gives a clean boundary — everything older is genuine archive material.

### 3.5 A found deal now advances to Quote Sent

Previously the stage was left alone when a quote went out against an existing deal, on the reasoning that a rep may have moved it deliberately. That holds at Quote Sent or beyond; it does not hold at *Quote Required*, which means no quote has gone out.

**464 quoted deals worth $6,050,518** were stranded there. The rule is now narrow and deliberate: **Quote Required → Quote Sent only.** A deal at any other stage is somewhere because somebody put it there, and is never overridden.

---

## 4. Where the pipeline landed

| | Before | After |
|---|---|---|
| Deals in the live pipeline | 1,902 | **2,956** |
| Value at Quote Sent | $21,234,371 | **$27,185,654** |
| Quoted deals stranded at Quote Required | 464 | **0** |
| Deals carrying a Source marker | 0 | **2,177** |
| Deals carrying a Rego field | 0 | **1,369** |

**None of the $6M increase is new business.** It is work that already existed, in an archive or in the wrong column.

### Where the work actually comes from

Measured across 2,183 quoted deals, from the record of what Pipeline A did rather than inferred:

| Origin | Deals | Share |
|---|---|---|
| Online enquiry, quoted later | 1,399 | **64%** |
| Walk-in or phone, quote written first | 784 | **36%** |

Stable between 33% and 42% every month since April. Average deal value is near-identical either way, so neither channel brings bigger jobs — there is simply twice as much of the online one.

---

## 5. How it runs now

**`/api/cron/ac-deal-sweep` — 18:40 UTC daily (04:40 Brisbane)**, seventy minutes after the Mechanics Desk overnight pull, so it reasons about fresh data.

Three passes in order — Won from MYOB, Won from MD, then Lost.

### Turning it on and off

**Settings → Connections → Integrations → "AC deal sweep — arming"**

| Setting | Effect |
|---|---|
| `AC_SWEEP_MYOB_WON_LIVE` | Arms the MYOB Won pass |
| `AC_SWEEP_WON_LIVE` | Arms the Mechanics Desk fallback |
| `AC_SWEEP_LOST_LIVE` | Arms the 90-day Lost pass |
| `AC_SWEEP_ENABLED` | Set to `false` to stop everything |

Each pass is a **dry run** until its flag reads exactly `true`. These live in the portal rather than in Vercel deliberately: closing deals has no bulk undo, and a switch that needs a code deploy is not an emergency stop. Changes take effect within thirty seconds.

**To read the numbers without changing anything**, open `/api/cron/ac-deal-sweep?verbose=1` while signed in as an admin. A session login is always forced dry, whatever the flags say.

Every deal the sweep touches gets a note explaining exactly why — which invoice matched, how it was matched, and how long it had been idle. A wrong decision is always explainable rather than mysterious.

---

## 6. What to watch

- **A wave of Lost around late November.** Most migrated deals were touched in late August, so their 90-day clocks expire together.
- **The 353 "Quote Required - Sent" placeholders.** Identical junk deals created by the retired Zapier zap between January and April. They will be swept to Lost — correct, but it will make the Lost count look large.
- **Won will under-report at first.** It fires on invoicing, and Mechanics Desk usually stops at "job created" without advancing the quote. Expect fewer wins recorded than actually happened.
- **Roughly 41% of MD quotes carry no rego**, and another 12% say "TBA". Those are treated as no rego at all. It is the single biggest limit on the Mechanics Desk fallback route.
- **One unexplained deal.** Deal 42611 carried Pipeline A's own title format but was found in the archive — worth knowing whether something is moving deals out of the live pipeline.

---

*Compiled 4 September 2026. Technical detail — every endpoint, table and API trap behind the above — is in the Full Handover Document, §5.8.*
