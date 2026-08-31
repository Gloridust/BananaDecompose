'use client'

// A minimal store-only ZIP writer.
//
// No dependency, because there is nothing to gain from one here: every heavy
// payload in a diagnostic bundle is a PNG or JPEG, which is already compressed.
// Deflating them again buys a percent or two for a compression implementation's
// worth of code and risk.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type ZipEntry = { path: string; data: Uint8Array }

/** MS-DOS packed date/time, which is all the ZIP header has room for. */
function dosStamp(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function buildZip(entries: ZipEntry[], now = new Date()): Blob {
  const { time, date } = dosStamp(now)
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // UTF-8 filename flag
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local, entry.data)
    centrals.push(central)
    offset += local.length + size
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return new Blob([...locals, ...centrals, end] as BlobPart[], { type: 'application/zip' })
}

export function textEntry(path: string, text: string): ZipEntry {
  return { path, data: new TextEncoder().encode(text) }
}

/** Decode a data: URI into raw bytes without a round trip through the network. */
export function dataUriToBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  if (comma === -1) throw new Error('Not a data URI')
  const meta = uri.slice(0, comma)
  const body = uri.slice(comma + 1)

  if (!meta.includes(';base64')) {
    return new TextEncoder().encode(decodeURIComponent(body))
  }
  const binary = atob(body)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Short stable hash, so a name that loses characters stays distinct. */
function shortHash(input: string) {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).slice(0, 5)
}

/**
 * ASCII-only, filesystem-safe, and stable across exports.
 *
 * Non-ASCII names are dropped rather than encoded: the archive is structurally
 * fine with UTF-8 paths, but macOS `unzip` refuses them outright ("Illegal byte
 * sequence") and Windows Explorer mangles them — and a bundle nobody can open is
 * worse than one with terse names. The readable label lives in meta.json.
 * Whatever gets stripped is replaced by a hash of the original, so two different
 * Chinese labels never collapse onto one directory.
 */
export function safeName(input: string, fallback = 'item') {
  const ascii = input
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

  const lostCharacters = ascii.length < input.replace(/\s+/g, '-').length
  if (!ascii) return `${fallback}-${shortHash(input)}`
  return lostCharacters ? `${ascii}-${shortHash(input)}` : ascii
}

/**
 * Read back the central directory of an archive we just wrote.
 *
 * Used by the self-test: building a zip that no tool can open is a failure mode
 * with no symptom until someone else tries to unpack it, so the bundle is parsed
 * back and its CRCs re-checked before anyone relies on it.
 */
export async function listZip(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)

  // The end record is last, but may be followed by a comment, so scan backwards.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('找不到 ZIP 结束记录')

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries: { path: string; size: number; crcOk: boolean }[] = []

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error(`第 ${i} 条中央目录记录损坏`)
    const crc = view.getUint32(offset + 16, true)
    const size = view.getUint32(offset + 24, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))

    // Walk into the local header and re-check the payload against its stored CRC.
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = bytes.subarray(dataStart, dataStart + size)
    entries.push({ path, size, crcOk: crc32(data) === crc })

    offset += 46 + nameLen + extraLen + commentLen
  }

  return { entries, totalBytes: bytes.length }
}
