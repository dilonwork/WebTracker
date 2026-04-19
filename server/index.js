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
app.get('/api/pages', (req, res) => {
  db.all(`SELECT * FROM pages`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// API: Add a new page to track
app.post('/api/pages', (req, res) => {
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

  db.run(
    `INSERT INTO pages (name, url, prompt, cron_expression, category) VALUES (?, ?, ?, ?, ?)`,
    [name, url, prompt || "", cron_expression, category],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const newId = this.lastID;
      if (cron_expression) {
        schedulePage(newId, url, prompt, cron_expression);
      }
      res.json({ id: newId, name, url, prompt, cron_expression, category });
    }
  );
});

// API: Delete a page
app.delete('/api/pages/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM pages WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    unschedulePage(id);
    res.json({ success: true, changes: this.changes });
  });
});

// API: Update an existing page
app.put('/api/pages/:id', (req, res) => {
  const id = req.params.id;
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

  db.run(
    `UPDATE pages SET name = ?, url = ?, prompt = ?, cron_expression = ?, category = ? WHERE id = ?`,
    [name, url, prompt || "", cron_expression, category, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Page not found" });

      // Reschedule
      unschedulePage(id);
      if (cron_expression) {
        schedulePage(id, url, prompt, cron_expression);
      }
      res.json({ id, name, url, prompt, cron_expression, category });
    }
  );
});

// API: Manually trigger a crawl for a page
app.post('/api/pages/:id/crawl', (req, res) => {
  db.get(`SELECT * FROM pages WHERE id = ?`, [req.params.id], async (err, row) => {
    if (err || !row) return res.status(404).json({ error: "Page not found" });

    // Non-blocking kick off
    performCrawl(row.id, row.url, row.prompt);
    res.json({ success: true, message: "Crawl triggered manually." });
  });
});

// API: Get results history
app.get('/api/results', (req, res) => {
  db.all(`
    SELECT r.id, r.html_length, r.llm_response, r.crawled_at, p.url, p.name, p.prompt 
    FROM results r 
    JOIN pages p ON r.page_id = p.id 
    ORDER BY r.crawled_at DESC 
    LIMIT 100
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Server API listening on http://localhost:${PORT}`);
});
