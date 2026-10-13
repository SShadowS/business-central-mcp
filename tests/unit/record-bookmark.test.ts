import { describe, it, expect } from 'vitest';
import { decodeBookmark } from '../../src/protocol/record-bookmark.js';
import { readKeyFields } from '../../src/operations/target-descriptor.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

// Bookmarks captured read-only on cronus29 (scripts/probe-bookmark-decode.ts) with the row's visible key.
const CUSTOMERS: Array<[string, string]> = [
  ['15_EgAAAAJ7BTEAMAAwADAAMA', '10000'],
  ['15_EgAAAAJ7BTIAMAAwADAAMA', '20000'],
  ['15_EgAAAAJ7BTMAMAAwADAAMA', '30000'],
  ['15_EgAAAAJ7BTQAMAAwADAAMA', '40000'],
  ['15_EgAAAAJ7BTUAMAAwADAAMA', '50000'],
];
// Sales Orders list 9305: Sales Header key (Document Type = Order (1), No.).
const SALES_ORDERS: Array<[string, string]> = [
  ['1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA5', '101009'],
  ['1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMQAw', '101010'],
  ['1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMQAx', '101011'],
  ['1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMQAy', '101012'],
  ['1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMQAz', '101013'],
];

describe('decodeBookmark', () => {
  it.each(CUSTOMERS)('decodes Customer bookmark %s to table 18, No. %s', (bm, no) => {
    expect(decodeBookmark(bm)).toEqual({ tableNo: 18, values: [no] });
  });

  it.each(SALES_ORDERS)('decodes Sales Header bookmark %s to table 36, [Order, %s]', (bm, no) => {
    expect(decodeBookmark(bm)).toEqual({ tableNo: 36, values: ['1', no] });
  });

  it('decodes a Sales Line bookmark (Document Type, Document No., Line No. Integer)', () => {
    // Live: first line of Sales Order 101009 on page 42.
    expect(decodeBookmark('23_JQAAAACLAQAAAAJ7BjEAMAAxADAAMAA5AAAAAIcQJw')).toEqual({ tableNo: 37, values: ['1', '101009', '10000'] });
  });

  it('decodes Integer, Boolean, BigInteger, GUID and Text keys', () => {
    const b = Buffer.alloc(128);
    let p = b.writeInt32LE(5, 0);
    p = b.writeUInt16LE(34560, p); p = b.writeInt32LE(-7, p);
    p = b.writeUInt16LE(34048, p); p = b.writeInt32LE(1, p);
    p = b.writeUInt16LE(36096, p); p = b.writeBigInt64LE(9007199254740993n, p);
    p = b.writeUInt16LE(37120, p);
    p += Buffer.from('33221100554477668899aabbccddeeff', 'hex').copy(b, p);
    p = b.writeUInt16LE(31489, p); p += b.write('Ab', p, 'utf16le'); p += 2;
    p = b.writeUInt16LE(0, p);
    const bytes = b.subarray(0, p);
    const bm = `${bytes.length.toString(16)}_${bytes.toString('base64url')}`;
    expect(decodeBookmark(bm)).toEqual({ tableNo: 5, values: ['-7', 'true', '9007199254740993', '00112233-4455-6677-8899-aabbccddeeff', 'Ab'] });
  });

  it('rejects non-bookmarks, truncated data and key types it does not decode', () => {
    expect(decodeBookmark('BMK')).toBeUndefined();
    expect(decodeBookmark('DraftRecord1')).toBeUndefined();
    expect(decodeBookmark('4_EgAAAAJ7BTEAMAAwADAAMA')).toBeUndefined(); // data longer than declared length
    expect(decodeBookmark('8_EgAAAAJ7')).toBeUndefined(); // no terminator
    const date = Buffer.from([18, 0, 0, 0, 0x00, 0x2e, 1, 0, 0, 0, 0, 0]); // NavType.Date = 11776
    expect(decodeBookmark(`c_${date.toString('base64url')}`)).toBeUndefined();
  });
});

describe('readKeyFields from the record bookmark', () => {
  const salesOrder = (bookmark: string, sourceTableId = 36) => buildFormTree({
    t: 'lf', ServerId: 'F1', Caption: 'Sales Order', Bookmark: bookmark,
    Metadata: { id: 42, sourceTableId, primaryKeyIds: [1, 3] },
    Children: [{ t: 'sc', Caption: 'No.', TableFieldNo: 3, StringValue: '101009', Visible: false }],
  });

  it('fills a key field with no control from the bookmark, in key order', () => {
    expect(readKeyFields(salesOrder(SALES_ORDERS[0]![0]))).toEqual([
      { fieldNo: 1, caption: '', value: '1', source: 'bookmark' },
      { fieldNo: 3, caption: 'No.', value: '101009' },
    ]);
  });

  it("captions a control-less key field from the form's own filter columns, not a subpage's", () => {
    // Live cronus29 Sales Order 42: header filc "Sales Order" and lines filc both list field 1.
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', Caption: 'Sales Order', Bookmark: SALES_ORDERS[0]![0],
      Metadata: { id: 42, sourceTableId: 36, primaryKeyIds: [1, 3] },
      Children: [
        { t: 'filc', Caption: 'Lines', FilterColumns: [{ Id: '37_Sales Line.1', Caption: 'Line Doc Type' }] },
        { t: 'filc', Caption: 'Sales Order', FilterColumns: [
          { Id: '36_Sales Header.13631', Caption: 'Account Code' },
          { Id: '36_Sales Header.11', Caption: 'Your Reference' },
          { Id: '36_Sales Header.1', Caption: 'Document Type' },
        ] },
      ],
    });
    expect(readKeyFields(root)).toEqual([
      { fieldNo: 1, caption: 'Document Type', value: '1', source: 'bookmark' },
      { fieldNo: 3, caption: '', value: '101009', source: 'bookmark' },
    ]);
  });

  it('ignores a bookmark of another table or with the wrong key arity', () => {
    const controlOnly = [{ fieldNo: 3, caption: 'No.', value: '101009' }];
    expect(readKeyFields(salesOrder(SALES_ORDERS[0]![0], 37))).toEqual(controlOnly);
    expect(readKeyFields(salesOrder(CUSTOMERS[0]![0], 18))).toEqual(controlOnly);
  });
});
