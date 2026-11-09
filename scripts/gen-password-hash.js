// 產生 WebTracker 登入用的密碼雜湊與 session 簽名密鑰。
// 用法：
//   node scripts/gen-password-hash.js --generate
//     隨機產生一組 20 字元密碼＋WEBTRACKER_PASSWORD_HASH＋WEBTRACKER_AUTH_SECRET，
//     印出來後把兩行貼進 VM 的 .env（密碼本身另外記好，用來登入）。
//   node scripts/gen-password-hash.js "你的密碼"
//     只印 WEBTRACKER_PASSWORD_HASH（密碼以參數傳入會留在 shell history，建議用 --generate）。
// 雜湊格式：scrypt:<salt hex>:<hash hex>；只把雜湊放 .env，密碼絕不寫進檔案或 repo。
const crypto = require('crypto');
const { hashPassword } = require('../server/auth');

function randomPassword(length = 20) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function main() {
  const arg = process.argv[2];
  if (arg === '--generate') {
    const password = randomPassword(20);
    const secret = crypto.randomBytes(32).toString('hex');
    console.log('密碼（登入用，請記好，不要寫進 repo）：');
    console.log(password);
    console.log('');
    console.log('貼進 .env（VM 上）：');
    console.log(`WEBTRACKER_PASSWORD_HASH=${hashPassword(password)}`);
    console.log(`WEBTRACKER_AUTH_SECRET=${secret}`);
    return;
  }
  if (arg) {
    console.log(`WEBTRACKER_PASSWORD_HASH=${hashPassword(arg)}`);
    return;
  }
  console.error('用法：node scripts/gen-password-hash.js --generate');
  console.error('　或：node scripts/gen-password-hash.js "你的密碼"');
  process.exit(1);
}

main();
