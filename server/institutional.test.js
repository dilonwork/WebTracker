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

console.log(`\nAll ${n} institutional tests passed.`);
