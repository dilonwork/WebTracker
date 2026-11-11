// 三大法人模組單元測試（不需 DB、不需連線；用真實 T86 列驗證解析）
// 執行：node server/institutional.test.js
const assert = require('assert');
const { parseNum, parseT86Row, twDateStr } = require('./institutional');

let n = 0;
function check(name, fn) {
  fn();
  n++;
  console.log(`✓ ${name}`);
}

// parseNum：千分位逗號、負數、空值
check('parseNum  strips commas', () => {
  assert.strictEqual(parseNum('16,641,830'), 16641830);
  assert.strictEqual(parseNum('-8,181,770'), -8181770);
  assert.strictEqual(parseNum('0'), 0);
  assert.strictEqual(parseNum(''), null);
  assert.strictEqual(parseNum(null), null);
  assert.strictEqual(parseNum(undefined), null);
});

// parseT86Row：台積電 2026/11/10 真實列
check('parseT86Row 2330 2026/11/10', () => {
  const row = ['2330', '台積電 ', '16,641,830', '24,823,600', '-8,181,770',
    '0', '0', '0', '5,672,600', '38,265', '5,634,335', '-766,472',
    '57,400', '575,660', '-518,260', '174,514', '422,726', '-248,212', '-3,313,907'];
  const p = parseT86Row(row);
  assert.strictEqual(p.code, '2330');
  assert.strictEqual(p.foreign, -8181770);
  assert.strictEqual(p.trust, 5634335);
  assert.strictEqual(p.dealer, -766472);
  assert.strictEqual(p.total, -3313907);
  // 三者相加 = 三大法人合計
  assert.strictEqual(p.foreign + p.trust + p.dealer, p.total);
});

// parseT86Row：0050 2026/11/10（投信買進 8,952,000、賣出 0）
check('parseT86Row 0050 2026/11/10', () => {
  const row = ['0050', '元大台灣50 ', '41,050,491', '40,844,010', '206,481',
    '0', '0', '0', '8,952,000', '0', '8,952,000', '-24,720,295',
    '0', '0', '0', '0', '0', '0', '-15,561,814'];
  const p = parseT86Row(row);
  assert.strictEqual(p.code, '0050');
  assert.strictEqual(p.foreign, 206481);
  assert.strictEqual(p.trust, 8952000);
  assert.strictEqual(p.dealer, -24720295);
  assert.strictEqual(p.total, -15561814);
  assert.strictEqual(p.foreign + p.trust + p.dealer, p.total);
});

// parseT86Row：欄位不足回 null
check('parseT86Row rejects short rows', () => {
  assert.strictEqual(parseT86Row(['2330', '台積電']), null);
  assert.strictEqual(parseT86Row(null), null);
  assert.strictEqual(parseT86Row('2330'), null);
});

// twDateStr：台北時區（UTC+8，無日光節約）
check('twDateStr uses Asia/Taipei', () => {
  // 2026-11-10 12:00 UTC = 台北 20:00 同日
  assert.strictEqual(twDateStr(new Date('2026-11-10T12:00:00Z')), '20261110');
  // 2026-11-10 16:30 UTC = 台北 11/11 00:30
  assert.strictEqual(twDateStr(new Date('2026-11-10T16:30:00Z')), '20261111');
  // 2026-11-10 00:30 UTC = 台北 08:30 同日
  assert.strictEqual(twDateStr(new Date('2026-11-10T00:30:00Z')), '20261110');
});

// 金額換算：股數 × 收盤價 / 1e8（億元），與 mockup 驗算一致
check('amount conversion matches mockup (2330 11/10)', () => {
  const amt = (shares, close) => (shares * close) / 1e8;
  assert.ok(Math.abs(amt(-8181770, 2285) - (-186.95)) < 0.01);
  assert.ok(Math.abs(amt(5634335, 2285) - 128.74) < 0.01);
  assert.ok(Math.abs(amt(-3313907, 2285) - (-75.72)) < 0.01);
});

// fetchAndStoreDay：只補缺、不重抓；force 才重抓（假 DB，不需 PostgreSQL）
// 2026/11/10 為交易日（T86 有資料）；假 DB 的 upsert 只計數、不寫入
const { fetchAndStoreDay } = require('./institutional');
function fakeDb(storedIds) {
  const calls = { check: 0, upsert: 0, upsertedIds: [] };
  return {
    calls,
    query: async (sql, params) => {
      if (sql.includes('SELECT account_id')) {
        calls.check++;
        return { rows: storedIds.map((id) => ({ account_id: id })) };
      }
      if (sql.includes('INSERT INTO fin_institutional_flow')) {
        calls.upsert++;
        calls.upsertedIds.push(params[0]);
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql.slice(0, 60));
    },
  };
}
const ACCOUNTS = [
  { id: 3, code: '2330' },
  { id: 5, code: '0050' },
];
const CLOSES = { '2330': { '2026-11-10': 2285 }, '0050': { '2026-11-10': 97.45 } };

(async () => {
  // 兩帳戶都有該日資料 -> skipped，不抓 T86、不寫入
  {
    const db = fakeDb([3, 5]);
    const r = await fetchAndStoreDay(db, ACCOUNTS, CLOSES, '2026-11-10');
    assert.strictEqual(r, 'skipped');
    assert.strictEqual(db.calls.upsert, 0);
    n++;
    console.log('✓ fetchAndStoreDay skips fully-covered day');
  }
  // 只有 2330 有，0050 缺 -> 只補 0050（抓一次 T86、只寫一筆）
  {
    const db = fakeDb([3]);
    const r = await fetchAndStoreDay(db, ACCOUNTS, CLOSES, '2026-11-10');
    assert.strictEqual(r, 'stored');
    assert.strictEqual(db.calls.upsert, 1);
    assert.deepStrictEqual(db.calls.upsertedIds, [5]);
    n++;
    console.log('✓ fetchAndStoreDay fills only the missing account');
  }
  // force=true：兩帳戶都有仍重抓重寫
  {
    const db = fakeDb([3, 5]);
    const r = await fetchAndStoreDay(db, ACCOUNTS, CLOSES, '2026-11-10', true);
    assert.strictEqual(r, 'stored');
    assert.strictEqual(db.calls.upsert, 2);
    assert.deepStrictEqual(db.calls.upsertedIds.sort(), [3, 5]);
    n++;
    console.log('✓ fetchAndStoreDay force re-fetches everything');
  }
  console.log(`\nAll ${n} institutional tests passed.`);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
