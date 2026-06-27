require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./database');
const cron = require('node-cron');
const { startScheduler, performCrawl, schedulePage, unschedulePage } = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json());

// Start background task
startScheduler();

// API: Get all pages
app.get('/api/pages', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM pages ORDER BY id ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Add a new page to track
app.post('/api/pages', async (req, res) => {
  try {
    let { name, url, prompt, cron_expression, category } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    if (!category || category.trim() === '') {
      category = 'Uncategorized';
    }
    if (!name) name = '';

    if (cron_expression && cron_expression.trim() !== '') {
      if (!cron.validate(cron_expression)) {
        return res.status(400).json({ error: "Invalid Cron Expression provided" });
      }
    } else {
      cron_expression = null; // empty string becomes null
    }

    const { rows } = await db.query(
      `INSERT INTO pages (name, url, prompt, cron_expression, category) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, url, prompt || "", cron_expression, category]
    );

    const newId = rows[0].id;
    if (cron_expression) {
      schedulePage(newId, url, prompt, cron_expression);
    }
    res.json({ id: newId, name, url, prompt, cron_expression, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete a page
app.delete('/api/pages/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await db.query(`DELETE FROM pages WHERE id = $1`, [id]);
    unschedulePage(id);
    res.json({ success: true, changes: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Update an existing page
app.put('/api/pages/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    let { name, url, prompt, cron_expression, category } = req.body;

    if (!url) return res.status(400).json({ error: "URL is required" });
    if (!category || category.trim() === '') category = 'Uncategorized';
    if (!name) name = '';

    if (cron_expression && cron_expression.trim() !== '') {
      if (!cron.validate(cron_expression)) {
        return res.status(400).json({ error: "Invalid Cron Expression provided" });
      }
    } else {
      cron_expression = null; // empty string becomes null
    }

    const { rowCount } = await db.query(
      `UPDATE pages SET name = $1, url = $2, prompt = $3, cron_expression = $4, category = $5 WHERE id = $6`,
      [name, url, prompt || "", cron_expression, category, id]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Page not found" });

    // Reschedule
    unschedulePage(id);
    if (cron_expression) {
      schedulePage(id, url, prompt, cron_expression);
    }
    res.json({ id, name, url, prompt, cron_expression, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Manually trigger a crawl for a page
app.post('/api/pages/:id/crawl', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(`SELECT * FROM pages WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Page not found" });

    const row = rows[0];
    // Non-blocking kick off
    performCrawl(row.id, row.url, row.prompt);
    res.json({ success: true, message: "Crawl triggered manually." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get results history
app.get('/api/results', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.html_length, r.llm_response, r.crawled_at, p.url, p.name, p.prompt 
      FROM results r 
      JOIN pages p ON r.page_id = p.id 
      ORDER BY r.crawled_at DESC 
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Financial Management API Endpoints ---

// 1. Get all financial accounts
app.get('/api/financials/accounts', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM fin_accounts ORDER BY type ASC, subtype ASC, id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Add a new account
app.post('/api/financials/accounts', async (req, res) => {
  try {
    const { name, institution, type, subtype, balance, currency, monthly_payment, interest_rate } = req.body;
    if (!name || !type || !subtype) {
      return res.status(400).json({ error: "Name, type, and subtype are required." });
    }
    const { rows } = await db.query(
      `INSERT INTO fin_accounts (name, institution, type, subtype, balance, currency, monthly_payment, interest_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [name, institution || '', type, subtype, balance || 0, currency || 'TWD', monthly_payment || 0, interest_rate || 0]
    );
    res.json({ id: rows[0].id, name, institution, type, subtype, balance, currency, monthly_payment, interest_rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update an existing account
app.put('/api/financials/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, institution, type, subtype, balance, currency, monthly_payment, interest_rate } = req.body;
    const { rowCount } = await db.query(
      `UPDATE fin_accounts 
       SET name = $1, institution = $2, type = $3, subtype = $4, balance = $5, currency = $6, monthly_payment = $7, interest_rate = $8
       WHERE id = $9`,
      [name, institution, type, subtype, balance, currency, monthly_payment, interest_rate, id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Account not found" });
    res.json({ id, name, institution, type, subtype, balance, currency, monthly_payment, interest_rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Batch update account balances (Weekly Maintenance)
app.put('/api/financials/accounts/batch/balances', async (req, res) => {
  try {
    const { balances } = req.body; // Expects an array: [{ id: 1, balance: 120000 }, ...]
    if (!Array.isArray(balances)) {
      return res.status(400).json({ error: "balances must be an array" });
    }
    for (const item of balances) {
      await db.query('UPDATE fin_accounts SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [item.balance, item.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Delete an account
app.delete('/api/financials/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.query('DELETE FROM fin_accounts WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get cash demands
app.get('/api/financials/demands', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM fin_cash_demands ORDER BY due_date ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Add cash demand
app.post('/api/financials/demands', async (req, res) => {
  try {
    const { description, amount, due_date } = req.body;
    if (!description || !amount || !due_date) {
      return res.status(400).json({ error: "Description, amount, and due date are required." });
    }
    const { rows } = await db.query(
      'INSERT INTO fin_cash_demands (description, amount, due_date) VALUES ($1, $2, $3) RETURNING id',
      [description, amount, due_date]
    );
    res.json({ id: rows[0].id, description, amount, due_date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Delete cash demand
app.delete('/api/financials/demands/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.query('DELETE FROM fin_cash_demands WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Get AI Reports history
app.get('/api/financials/reports', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM fin_ai_reports ORDER BY created_at DESC LIMIT 50');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Trigger Gemini AI Advisor analysis
app.post('/api/financials/advisor', async (req, res) => {
  try {
    // 10a. Fetch current financial accounts
    const { rows: accounts } = await db.query('SELECT * FROM fin_accounts');
    // 10b. Fetch future cash demands
    const { rows: demands } = await db.query('SELECT * FROM fin_cash_demands');
    // 10c. Fetch latest crawled summaries from Web Tracker for market context
    const { rows: marketContexts } = await db.query(`
      SELECT r.crawled_at, r.llm_response, p.name, p.url 
      FROM results r 
      JOIN pages p ON r.page_id = p.id
      ORDER BY r.crawled_at DESC
      LIMIT 10
    `);

    // 10d. Invoke Gemini
    const { analyzeFinancialPortfolio } = require('./gemini');
    const advice = await analyzeFinancialPortfolio({ accounts, demands }, marketContexts);

    // 10e. Log to database
    await db.query('INSERT INTO fin_ai_reports (analysis) VALUES ($1)', [advice]);

    res.json({ analysis: advice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.BACKEND_PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server API listening on http://localhost:${PORT}`);
});
