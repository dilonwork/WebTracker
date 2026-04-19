const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Configured pages to track
  db.run(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      url TEXT NOT NULL UNIQUE,
      prompt TEXT,
      cron_expression TEXT,
      category TEXT DEFAULT 'Uncategorized',
      last_crawled DATETIME
    )
  `);

  // Schema migration: Add name column if it doesn't exist
  db.run("ALTER TABLE pages ADD COLUMN name TEXT DEFAULT ''", (err) => {
    // Expected to error if column already exists; safe to ignore
  });

  // History of Gemini analysis results
  db.run(`
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER,
      html_length INTEGER,
      llm_response TEXT,
      crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);
});

module.exports = db;
