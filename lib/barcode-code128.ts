// lib/barcode-code128.ts
// Pure Code 128 (Code Set B) encoder — no external dependency. Turns a string
// into a list of bar/space widths (in modules) so a renderer (PDF or HTML) can
// draw the barcode. Code Set B covers all printable ASCII (space … ~), which is
// everything a part SKU/barcode realistically contains.

// Standard Code 128 element-width patterns, indexed by symbol value 0..106.
// Each entry is 6 module widths (bar,space,bar,space,bar,space); index 106 (Stop)
// has the extra terminating bar (7 elements).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const STOP = 106

export interface BarcodeBar { width: number; on: boolean }
export interface EncodedBarcode {
  bars: BarcodeBar[]   // alternating bars/spaces, first is a bar
  modules: number      // total module width (sum of bar widths)
  value: string        // the (sanitised) human-readable value encoded
}

// Keep only printable ASCII (32..126); anything else becomes '?' so the symbol
// stays valid Code Set B.
function sanitise(raw: string): string {
  let out = ''
  for (const ch of String(raw)) {
    const c = ch.charCodeAt(0)
    out += c >= 32 && c <= 126 ? ch : '?'
  }
  return out || '?'
}

export function encodeCode128(raw: string): EncodedBarcode {
  const value = sanitise(raw)
  const codes: number[] = [START_B]
  let checksum = START_B
  for (let i = 0; i < value.length; i++) {
    const v = value.charCodeAt(i) - 32   // Code Set B value
    codes.push(v)
    checksum += v * (i + 1)
  }
  codes.push(checksum % 103)
  codes.push(STOP)

  const bars: BarcodeBar[] = []
  let modules = 0
  for (const code of codes) {
    const pat = PATTERNS[code]
    for (let i = 0; i < pat.length; i++) {
      const width = parseInt(pat[i], 10)
      const on = i % 2 === 0   // even index = bar, odd = space
      bars.push({ width, on })
      modules += width
    }
  }
  return { bars, modules, value }
}
