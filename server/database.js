require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_ACCOUNT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  port: 5432,
});

// Auto-create tables if they don't exist
const initDb = async () => {
  try {
    // Existing Web Tracker tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        name TEXT DEFAULT '',
        url TEXT NOT NULL UNIQUE,
        prompt TEXT,
        cron_expression TEXT,
        category TEXT DEFAULT 'Uncategorized',
        last_crawled TIMESTAMP WITH TIME ZONE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
        html_length INTEGER,
        llm_response TEXT,
        crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // New Financial Tracker tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_accounts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        institution TEXT NOT NULL,
        type TEXT NOT NULL, -- 'asset' | 'liability'
        subtype TEXT NOT NULL, -- 'cash' | 'deposit' | 'stock' | 'currency' | 'loan' | 'mortgage'
        balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
        currency VARCHAR(3) DEFAULT 'TWD',
        monthly_payment NUMERIC(15, 2) DEFAULT 0.00,
        interest_rate NUMERIC(5, 2) DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_cash_demands (
        id SERIAL PRIMARY KEY,
        description TEXT NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        due_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_ai_reports (
        id SERIAL PRIMARY KEY,
        report_date DATE NOT NULL DEFAULT CURRENT_DATE,
        analysis TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_account_history (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES fin_accounts(id) ON DELETE CASCADE,
        balance NUMERIC(15, 2) NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('PostgreSQL database tables initialized.');

    // Seed default accounts if empty
    const { rows } = await pool.query('SELECT COUNT(*) FROM fin_accounts');
    if (parseInt(rows[0].count, 10) === 0) {
      console.log('Seeding default financial accounts...');
      const seedAccounts = [
        ['國泰台幣活存', '國泰世華', 'asset', 'cash', 150000.00, 'TWD', 0.00, 0.50],
        ['台新定存帳戶', '台新銀行', 'asset', 'deposit', 500000.00, 'TWD', 0.00, 1.60],
        ['台股證券庫存', '富邦證券', 'asset', 'stock', 1200000.00, 'TWD', 0.00, 0.00],
        ['玉山美金存摺', '玉山銀行', 'asset', 'currency', 300000.00, 'USD', 0.00, 3.80],
        ['信用貸款', 'Line Bank', 'liability', 'loan', 400000.00, 'TWD', 8500.00, 2.20],
        ['房屋貸款', '土地銀行', 'liability', 'mortgage', 8000000.00, 'TWD', 32000.00, 2.06]
      ];

      for (const acc of seedAccounts) {
        const { rows: insertedAccounts } = await pool.query(
          `INSERT INTO fin_accounts (name, institution, type, subtype, balance, currency, monthly_payment, interest_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          acc
        );
        
        // Record initial history
        await pool.query(
          `INSERT INTO fin_account_history (account_id, balance) VALUES ($1, $2)`,
          [insertedAccounts[0].id, acc[4]]
        );
      }
      console.log('Default financial accounts seeded successfully.');
    }

  } catch (err) {
    console.error('Error initializing PostgreSQL database tables:', err);
  }
};

initDb();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
