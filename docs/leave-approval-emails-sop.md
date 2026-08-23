# Leave approval emails — now live

**What's changed.** Deciding a leave application on the Monday **Payroll & Leave Applications** board now emails the person who applied. Approvals *and* declines. Nobody has to write that email any more.

**Live from:** 24 August 2026. **Applies to:** anyone who approves or declines leave — and to the office, because the applicant now hears back automatically.

**Nothing was sent for past applications.** On the first run the portal recorded the 16 applications already decided on the board and deliberately emailed none of them. Only decisions made from now on send anything.

---

## 1. What happens now

| | |
|---|---|
| **Trigger** | The **Leave Approved** column on an application is set to **Approved** or **Denied** |
| **Who gets it** | The person who applied |
| **How fast** | Within 15 minutes |
| **Copied in** | Ryan — and a reply from the applicant goes to Ryan too |
| **What's in it** | Leave type, start and end dates, total days, and what to do next |

**If it's approved**, the email tells them it's approved, lists the dates, and says payroll takes it from here — with a line asking them to speak to their manager if plans change or a detail looks wrong.

**If it's declined**, the email says the application wasn't approved on this occasion, **asks them not to take the leave**, and points them at their manager (or a reply, which reaches Ryan) to sort out other dates.

> **Declines are sent automatically too.** If you decline something you have already talked through face to face, that person will still receive the written note. That's deliberate — it means nothing gets lost — but it's worth knowing before you press it.

---

## 2. What you need to do differently

**Almost nothing. Decide leave where you always have** — on the application, in the **Leave Applications** group. The email looks after itself.

There is one rule worth committing to memory:

> ### Leave is approved on the application, not on a note.

The board is used for two different jobs. As well as leave applications, it carries the day-to-day notes — *"Kaleb left at 11am"*, *"Ollie O – sick"*, *"Public Holiday"*, *"Easter Monday – all staff"*, and the export row. Plenty of those are marked Approved as well.

**Those notes email nobody, on purpose.** Only an item that was in **Leave Applications** and had Approved (or Denied) pressed on it counts as a decision. If it were otherwise, staff would be getting "your leave application has been approved" for a note recording that they went home early — and everyone on the payroll for a public holiday.

So: if you want the person told, decide it on **their application**. A line typed straight into one of the payroll groups will never send anything, no matter what its status says.

**Changing your mind is fine.** Flipping an item from Approved to Denied (or back) counts as a new decision and sends the matching email once. Nobody gets the same email twice.

---

## 3. When we don't have someone's email address

Applications sent in through the Leave Request form carry the applicant's address. Rows keyed in by hand usually don't — so the portal falls back to a **staff directory** it keeps of names and addresses, including the short forms that get typed on the board ("Chris R", "Matt K", "Ollie O").

If it still can't work out an address, it **emails Ryan once** with the applicant's name and the leave dates, and sends nothing to anyone else. It never guesses.

**To fix one** — either of these works:

1. Fill in the **Email Address** column on the Monday item, **or**
2. Add the name to **Settings → Leave Notifications → Staff directory** in the portal, spelled exactly as it appears on the board.

Then leave it alone. The email goes out at the next 15-minute run. **Do not re-approve the application** — it's already approved, and re-pressing the status isn't what makes the email send.

---

## 4. The screen in the portal

**Settings → Leave Notifications** (admin login). It holds:

- **The on/off switch** and the HR address that's copied on everything and receives replies.
- **Waiting on an email address** — every decided application the portal couldn't place. This is the to-do list; clearing it clears itself.
- **Staff directory** — the names and addresses, editable. Add, edit or remove.
- **Recent decisions** — the last 100, showing who was emailed, at what address, and whether it worked. Rows marked *Pre-existing* are the historical ones that were deliberately never emailed.
- **Dry run** — works out who *would* be emailed and **sends nothing**. Use it after editing the directory to check your work.
- **Run now** — does it for real, rather than waiting for the next quarter-hour.

Every email that goes out is also noted on the Monday item itself, so the record sits where you're already looking.

---

## 5. Two things it refuses to do

Both look like faults and aren't:

- **A misspelt company address is not used.** One application on the board reads `justaustos…` instead of `justautos…`. Mail to that address vanishes — no bounce anyone would notice — and everybody would believe the applicant had been told. The portal treats it as no address at all and asks for a correction instead.
- **A name it can't pin to one person is left alone.** A bare *"Matt"* could be three people. A row named *"James, Kaleb, Graham, Dom and Tyronne"* isn't one person's application at all. Rather than pick, it reports the name as unresolved.

---

## 6. If something looks wrong

| What you see | What it usually is | What to do |
|---|---|---|
| Someone says they got nothing | Either the decision was made on a note rather than an application, or we have no address for them | Check **Settings → Leave Notifications**. If the person is under *Waiting on an email address*, add the address (§3). If they aren't listed at all, the decision was pressed on a note — decide it on their application. |
| Ryan gets "no email address for …" | That name isn't in the directory and the item has no address | Add either one (§3). It sends itself afterwards. You only get that notice once per application. |
| An email went to an old address | The board or the directory holds a stale address | The item's Email Address column wins over the directory — correct whichever is wrong. |
| You need it to stop | — | Turn the switch off in **Settings → Leave Notifications**. It stops immediately; nothing queues up behind it. |

---

## 7. Where to ask

Chris built and holds this. Ryan is the address on every email, so anything a staff member replies to lands with him.

---

*Reference for the technically minded: Monday board "Payroll & Leave Applications" (`5027074711`); the portal checks it every 15 minutes; every decision, address and send is logged in the portal. Full detail is in the Handover, §7.17, and the staff-facing routine is in the Standard Operating Procedures, §9a — both at Admin → Library.*
