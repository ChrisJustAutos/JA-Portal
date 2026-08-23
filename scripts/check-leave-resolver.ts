// scripts/check-leave-resolver.ts
// Exercises the real matcher from lib/leave-decision-emails.ts against the names
// that actually sit on the "Payroll & Leave Applications" board, using the
// seeded leave_staff_directory (migrations 197 + 198) as the lookup table.
// No network, no DB, no email — pure resolution, run with:
//   npx tsx scripts/check-leave-resolver.ts
import { matchDirectory, resolveAddress, isSuspectAddress } from '../lib/leave-decision-emails'
import type { DirectoryEntry, LeaveItem } from '../lib/leave-decision-emails'

// The directory as seeded (name, email) — key is derived the same way the API does.
const SEED: Array<[string, string]> = [
  ['Christopher Russell', 'chris@justautosmechanical.com.au'], ['Chris Russell', 'chris@justautosmechanical.com.au'], ['Chris R', 'chris@justautosmechanical.com.au'],
  ['Morgan Wickham', 'morgan@justautosmechanical.com.au'], ['Morgan', 'morgan@justautosmechanical.com.au'],
  ['Ryan Doodson', 'ryan@justautosmechanical.com.au'], ['Ryan D', 'ryan@justautosmechanical.com.au'], ['Ryan', 'ryan@justautosmechanical.com.au'],
  ['James Wilson', 'james@justautosmechanical.com.au'], ['James', 'james@justautosmechanical.com.au'], ['James W', 'james@justautosmechanical.com.au'],
  ['Tyronne Wright', 'tyronne@justautosmechanical.com.au'], ['Tyronne W', 'tyronne@justautosmechanical.com.au'], ['Tyronne', 'tyronne@justautosmechanical.com.au'],
  ['Matt Smith', 'tuning@justautosmechanical.com.au'], ['Matt S', 'tuning@justautosmechanical.com.au'],
  ['Matt Huddy', 'matt.h@justautosmechanical.com.au'], ['Matt H', 'matt.h@justautosmechanical.com.au'],
  ['Laura Smith', 'laura.d.smith4@gmail.com'], ['Laura', 'laura.d.smith4@gmail.com'],
  ['Caylum Flack', 'caylum@justautosmechanical.com.au'], ['Caylum', 'caylum@justautosmechanical.com.au'], ['Caylum F', 'caylum@justautosmechanical.com.au'],
  ['Kaleb Rowe', 'kaleb@justautosmechanical.com.au'], ['Kaleb', 'kaleb@justautosmechanical.com.au'], ['Kaleb Row', 'kaleb@justautosmechanical.com.au'],
  ['Sam Perry', 'sam@justautosmechanical.com.au'], ['Sam', 'sam@justautosmechanical.com.au'], ['Sam P', 'sam@justautosmechanical.com.au'],
  ['Dom Simpson', 'dom@justautosmechanical.com.au'], ['Dom', 'dom@justautosmechanical.com.au'],
  ['Terry Evans', 'terry@justautosmechanical.com.au'], ['Terry', 'terry@justautosmechanical.com.au'],
  ['Graham Roy', 'graham@justautosmechanical.com.au'], ['Graham', 'graham@justautosmechanical.com.au'], ['Graham Douglas Roy', 'graham@justautosmechanical.com.au'],
  ['Micheal Murphy', 'micheal@justautosmechanical.com.au'], ['Micheal', 'micheal@justautosmechanical.com.au'],
  ['Jarred', 'jarred@justautosmechanical.com.au'],
  ['Matthew Karger', 'matthew.karger@hotmail.com'], ['Matt Karger', 'matthew.karger@hotmail.com'], ['Matt K', 'matthew.karger@hotmail.com'],
  ['Oliver Olsson', 'dodgymechanic@gmail.com'], ['Ollie O', 'dodgymechanic@gmail.com'], ['Olli O', 'dodgymechanic@gmail.com'], ['Oliver O', 'dodgymechanic@gmail.com'],
  ['Jye Lumley', 'jye.lumley@gmail.com'], ['Jye L', 'jye.lumley@gmail.com'],
  ['Damien McInnes', 'damienmcinnes@yahoo.com'], ['Damien M', 'damienmcinnes@yahoo.com'], ['Damo M', 'damienmcinnes@yahoo.com'],
  ['Ethan Haas', 'ethanhaas@outlook.com.au'], ['Ethan H', 'ethanhaas@outlook.com.au'],
  ['Amanda van Heerden', 'amanda@justautosmechanical.com.au'], ['Amanda VH', 'amanda@justautosmechanical.com.au'], ['Amanda', 'amanda@justautosmechanical.com.au'],
  ['Robert Carlile', 'bobbiecarlile64@gmail.com'], ['Rob Carlile', 'bobbiecarlile64@gmail.com'],
  ['Josh Taylor', 'joshtaylor_@hotmail.com'],
  ["Callan O'Malley", 'callan.omalley@hotmail.com'], ['Callan OMalley', 'callan.omalley@hotmail.com'], ['Callan O', 'callan.omalley@hotmail.com'], ['Callan', 'callan.omalley@hotmail.com'],
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const DIR: DirectoryEntry[] = SEED.map(([name, email]) => ({ match_name: name, match_key: norm(name), email }))

const item = (name: string, columnEmail: string | null = null): LeaveItem => ({
  id: '0', name, url: '', groupId: 'group_mkqz6qh6', group: 'Upcoming Leave - Approved',
  decision: 'approved', columnEmail, start: null, end: null, days: null, classification: null, department: null,
})

// Every name currently on the application path, plus the awkward ones from the
// payroll groups (those never email, but the matcher shouldn't misfire if one is
// ever moved across).
const CASES: Array<[string, string | null, string]> = [
  ['Dom Simpson', 'dom@justautosmechanical.com.au', 'column'],
  ['Ryan D', '', 'directory'],
  ['Morgan', 'morgan@justautosmechanical.com.au', 'column'],
  ["Callan O'Malley", 'callan.omalley@hotmail.com', 'column'],
  ['Caylum Flack', 'caylumf@hotmail.com', 'column'],
  ['Kaleb Rowe', '', 'directory'],
  ['Callan O', '', 'directory'],
  ['Dom Simpson Sick', '', 'directory'],
  ['Kaleb Rowe off sick today', '', 'directory'],
  ['Matt K - 0.5day', '', 'directory'],
  ['Kaleb Row', '', 'directory'],
  ['Chris R', '', 'directory'],
  ['Tyronne W', '', 'directory'],
  ['Jye L - Left at 13:30', '', 'directory'],
  ['Amanda vH', '', 'directory'],
  ['Jarred', 'jarred@justaustosmechanical.com.au', 'directory'],   // typo domain -> falls through
  ['Matt H', '', 'directory'],
  ['Matt', '', 'UNRESOLVED'],                                      // ambiguous Huddy/Smith/Karger
  ['Dan O', '', 'UNRESOLVED'],
  ['Matt Ashley', '', 'UNRESOLVED'],
  ['Public Holiday', '', 'UNRESOLVED'],
  ['James, Kaleb, Graham, Dom and Tyronne', '', 'UNRESOLVED'],
  ['Good Friday - All staff', '', 'UNRESOLVED'],
  ['TIME OFF/ OVERTIME EXPORT', '', 'UNRESOLVED'],
]

let pass = 0, fail = 0
for (const [name, colEmail, expect] of CASES) {
  const r = resolveAddress(item(name, colEmail), DIR)
  const got = r ? r.source : 'UNRESOLVED'
  const ok = got === expect
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(40)} -> ${(r?.email || '(none)').padEnd(36)} [${got}]${ok ? '' : `  expected ${expect}`}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
console.log('typo check:', isSuspectAddress('jarred@justaustosmechanical.com.au'), '(true = caught)',
  '| real:', isSuspectAddress('dom@justautosmechanical.com.au'), '(false = fine)',
  '| personal:', isSuspectAddress('caylumf@hotmail.com'), '(false = fine)')
console.log('lone-first-name guard:', matchDirectory('Matt', DIR)?.email ?? 'unresolved (correct)')
process.exit(fail ? 1 : 0)
