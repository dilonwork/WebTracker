require('dotenv').config();
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 1. Setup PostgreSQL client
const pgPool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_ACCOUNT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  port: 5432,
});

// 2. Setup SQLite client
const dbPath = path.resolve(__dirname, 'db.sqlite');
const sqliteDb = new sqlite3.Database(dbPath);

// Helper to wrap SQLite db.all in a Promise
const sqliteAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

async function migrate() {
  console.log('Starting migration from SQLite to PostgreSQL...');

  try {
    // Test PG connection
    await pgPool.query('SELECT NOW()');
    console.log('Successfully connected to PostgreSQL.');

    // Create tables in PostgreSQL if not exist
    console.log('Creating tables in PostgreSQL...');
    await pgPool.query(`
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

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
        html_length INTEGER,
        llm_response TEXT,
        crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('PostgreSQL tables ensured.');

    // Fetch pages from SQLite
    console.log('Reading pages from SQLite...');
    const pages = await sqliteAll('SELECT * FROM pages');
    console.log(`Found ${pages.length} pages in SQLite.`);

    // Insert pages into PostgreSQL
    for (const page of pages) {
      console.log(`Migrating page: ${page.name || page.url}`);
      await pgPool.query(
        `INSERT INTO pages (id, name, url, prompt, cron_expression, category, last_crawled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           url = EXCLUDED.url,
           prompt = EXCLUDED.prompt,
           cron_expression = EXCLUDED.cron_expression,
           category = EXCLUDED.category,
           last_crawled = EXCLUDED.last_crawled`,
        [
          page.id,
          page.name || '',
          page.url,
          page.prompt || '',
          page.cron_expression || null,
          page.category || 'Uncategorized',
          page.last_crawled ? new Date(page.last_crawled) : null
        ]
      );
    }

    // Fetch results from SQLite
    console.log('Reading results from SQLite...');
    const results = await sqliteAll('SELECT * FROM results');
    console.log(`Found ${results.length} results in SQLite.`);

    // Insert results into PostgreSQL
    for (const result of results) {
      console.log(`Migrating result ID: ${result.id}`);
      await pgPool.query(
        `INSERT INTO results (id, page_id, html_length, llm_response, crawled_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           page_id = EXCLUDED.page_id,
           html_length = EXCLUDED.html_length,
           llm_response = EXCLUDED.llm_response,
           crawled_at = EXCLUDED.crawled_at`,
        [
          result.id,
          result.page_id,
          result.html_length,
          result.llm_response,
          result.crawled_at ? new Date(result.crawled_at) : null
        ]
      );
    }

    // Reset sequences in PostgreSQL
    console.log('Resetting PostgreSQL SERIAL sequences...');
    await pgPool.query(`
      SELECT setval(pg_get_serial_sequence('pages', 'id'), COALESCE(MAX(id), 1)) FROM pages;
    `);
    await pgPool.query(`
      SELECT setval(pg_get_serial_sequence('results', 'id'), COALESCE(MAX(id), 1)) FROM results;
    `);

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    sqliteDb.close();
    await pgPool.end();
  }
}

migrate();
