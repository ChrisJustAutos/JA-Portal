/**
 * scripts/test-ap-cross-company.ts
 *
 * Exercises the matching brain of the cross-company duplicate check
 * (lib/ap-cross-company) without touching MYOB.
 *
 *   npx tsx scripts/test-ap-cross-company.ts
 *
 * The check has two halves. This tests the half that decides "is this the same
 * supplier / the same invoice number?" — the half that actually determines
 * whether the JMACX double-up gets flagged. The other half (does MYOB return
 * the documents at all) can only be answered against the live files, which is
 * what /api/ap/cross-company-check is for.
 *
 * Two kinds of case matter equally:
 *   MATCH   — it must catch the real double-up
 *   NO MATCH— it must NOT cry wolf. A duplicate check that flags everything
 *             gets ignored, and then it protects nothing.
 */

import { supplierLooksSame, sameNumberLoose } from '../lib/ap-cross-company'

let pass = 0, fail = 0
const failures: string[] = []

function check(label: string, got: boolean, want: boolean) {
  if (got === want) { pass++; return }
  fail++
  failures.push(`${label}\n      expected ${want ? 'MATCH' : 'NO MATCH'}, got ${got ? 'MATCH' : 'NO MATCH'}`)
}

function supplier(a: string, b: string, want: boolean) {
  check(`supplier: "${a}"  vs  "${b}"`, supplierLooksSame(a, b), want)
}
function number_(a: string, b: string, want: boolean) {
  check(`number:   "${a}"  vs  "${b}"`, sameNumberLoose(a, b), want)
}

console.log('\n── Supplier names ─────────────────────────────────────────\n')

// The case that started this. The two company files spell it differently and
// the UIDs are unrelated, so the name is all there is to go on.
supplier('JMACX', 'JMACX Pty Ltd', true)
supplier('JMACX PTY LTD', 'jmacx', true)
supplier('J.M.A.C.X.', 'JMACX Pty Ltd', true)
supplier('JMACX  Pty. Ltd.', 'JMACX Pty Ltd', true)

// Real suppliers off the AP run, spelt as each file happens to hold them.
supplier('BOC Limited', 'BOC', true)
supplier('Repco', 'Repco Auto Parts Pty Ltd', true)
supplier('Capricorn Society Limited', 'Capricorn Society', true)
supplier('Just Autos Wholesale Pty Ltd', 'JUST AUTOS WHOLESALE', true)

// Must NOT match — different businesses that read similarly.
supplier('JMACX', 'JM Auto Electrical', false)
supplier('BOC', 'BOC Gases Australia', true)   // same business, different file
supplier('Repco', 'Burson Auto Parts', false)
supplier('Total Tools', 'Total Fasteners', false)
supplier('Bridgestone', 'Bridgeport Machines', false)
supplier('', 'JMACX', false)                    // nothing to anchor on
supplier('Pty Ltd', 'JMACX Pty Ltd', false)     // noise words alone must not match

console.log('\n── Supplier invoice numbers ───────────────────────────────\n')

// The strong signal. Same number, punctuated differently by each entry.
number_('JM-88213', 'JM88213', true)
number_('jm 88213', 'JM-88213', true)
number_('INV-4042510973', 'INV 4042510973', true)

// OCR confusions the AP reader actually makes.
number_('JM-882I3', 'JM-88213', true)           // I read as 1... canonicalises both ways
number_('4O42510973', '4042510973', true)       // letter O for zero

// A padded or prefixed number against the bare digits — same invoice.
number_('INV-0000004512', '0000004512', true)

// Must NOT match.
number_('JM-88213', 'JM-88214', false)          // adjacent invoices
number_('4512', 'INV-004512', false)            // too few digits to trust a suffix
number_('', '4042510973', false)
number_('JM-88213', '', false)

console.log('\n──────────────────────────────────────────────────────────\n')
if (failures.length) {
  console.log('FAILURES:\n')
  failures.forEach(f => console.log('  ✗ ' + f + '\n'))
}
console.log(`${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
