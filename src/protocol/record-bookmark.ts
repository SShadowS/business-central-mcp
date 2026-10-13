/**
 * Decodes a BC record bookmark into its table number and primary-key values.
 *
 * A record's bookmark is its serialized RecordId (decompiled
 * `NsDataAccess.Bookmark` / `NavForm.Bookmark` = `Record.ALRecordId.GetBytes()`),
 * written to the wire by `ByteArrayHelper.ToUrlSafeString`:
 * `<byte length, hex>_<url-safe base64 of the bytes, trailing zero bytes trimmed>`.
 * The bytes (`NavRecordId.CreateByteArrayFromValues`, read back by
 * `CreateNavValuesFromBytes`) are int32 LE table no, then per key field in key
 * order a uint16 LE `NavType` tag and the value, then a uint16 0 terminator.
 * Verified live on cronus29: Customer `15_EgAAAAJ7BTEAMAAwADAAMA` = table 18,
 * Code "10000"; Sales Header `1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA5` = table 36,
 * Option 1 (Order), Code "101009".
 */

// NavType tags (decompiled Microsoft.Dynamics.Nav.Types/NavType.cs).
const CODE = 31490, TEXT = 31489, INTEGER = 34560, OPTION = 35584, BIGINTEGER = 36096, BOOLEAN = 34048, GUID = 37120;

export interface DecodedBookmark {
  tableNo: number;
  /** Key values in key order: Code/Text as text, Option as its ordinal, Boolean as 'true'/'false', GUID lowercase. */
  values: string[];
}

/**
 * undefined when the string is not a url-safe bookmark or holds a key type not
 * decoded here (Date, Time, DateTime, Duration, Decimal, Byte, OEM text, nested RecordId, ...).
 */
// ponytail: only the key types seen in standard tables; add a type here when a page's key needs it.
export function decodeBookmark(bookmark: string): DecodedBookmark | undefined {
  const m = /^([0-9A-Fa-f]+)_([A-Za-z0-9_-]+)$/.exec(bookmark);
  if (!m) return undefined;
  const bytes = Buffer.alloc(parseInt(m[1]!, 16));
  const data = Buffer.from(m[2]!, 'base64url');
  if (data.length > bytes.length || bytes.length < 6) return undefined;
  data.copy(bytes);

  const tableNo = bytes.readInt32LE(0);
  const values: string[] = [];
  let p = 4;
  while (p + 2 <= bytes.length) {
    const type = bytes.readUInt16LE(p);
    p += 2;
    if (type === 0) return { tableNo, values };
    switch (type) {
      case CODE:
      case TEXT: {
        // Code carries a leading alpha-index byte; both end at a UTF-16 NUL.
        const start = type === CODE ? p + 1 : p;
        let end = start;
        while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end += 2;
        if (end + 1 >= bytes.length) return undefined;
        values.push(bytes.toString('utf16le', start, end));
        p = end + 2;
        break;
      }
      case INTEGER:
      case OPTION:
        if (p + 4 > bytes.length) return undefined;
        values.push(String(bytes.readInt32LE(p)));
        p += 4;
        break;
      case BOOLEAN:
        if (p + 4 > bytes.length) return undefined;
        values.push(String(bytes[p] !== 0));
        p += 4;
        break;
      case BIGINTEGER:
        if (p + 8 > bytes.length) return undefined;
        values.push(String(bytes.readBigInt64LE(p)));
        p += 8;
        break;
      case GUID: {
        if (p + 16 > bytes.length) return undefined;
        // .NET Guid.ToByteArray layout: first three groups little-endian.
        const b = bytes.subarray(p, p + 16);
        const h = (i: number, n: number, rev: boolean) => {
          const s = Buffer.from(b.subarray(i, i + n));
          return (rev ? s.reverse() : s).toString('hex');
        };
        values.push(`${h(0, 4, true)}-${h(4, 2, true)}-${h(6, 2, true)}-${h(8, 2, false)}-${h(10, 6, false)}`);
        p += 16;
        break;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}
