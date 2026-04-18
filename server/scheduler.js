const db = require('./database');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { analyzeContentWithGemini } = require('./gemini');

const activeTasks = {};
async function scrapeUrl(url) {
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const html = response.data;
    
    // Attempt to use cheerio to strip tags, fallback to string if cheerio crashes on old node
    try {
      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      return $.text().replace(/\s+/g, ' ').trim();
    } catch(e) {
      // Basic fallback regex strip
      return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                 .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                 .replace(/<[^>]+>/g, '')
                 .replace(/\s+/g, ' ')
                 .trim();
    }
  } catch (err) {
    console.error(`Failed to scrape ${url}:`, err.message);
    throw err;
  }
}

async function performCrawl(pageId, url, prompt) {
  console.log(`[CRAWL START] ID: ${pageId} | URL: ${url}`);
  try {
    const pageText = await scrapeUrl(url);
    const htmlLength = pageText.length;
    
    let llmResponse = "No prompt provided.";
    if (prompt && prompt.trim() !== '') {
       llmResponse = await analyzeContentWithGemini(pageText, prompt);
    }
    
    // Save to results
    db.run(
      `INSERT INTO results (page_id, html_length, llm_response) VALUES (?, ?, ?)`,
      [pageId, htmlLength, llmResponse],
      (err) => {
        if (err) console.error("Error saving result to DB:", err);
      }
    );

    // Update last_crawled
    db.run(`UPDATE pages SET last_crawled = CURRENT_TIMESTAMP WHERE id = ?`, [pageId]);
    console.log(`[CRAWL SUCCESS] ID: ${pageId} | Succeeded`);
    
    return { success: true, llmResponse };
  } catch (error) {
    console.error(`[CRAWL ERROR] ID: ${pageId}`, error.message);
    return { success: false, error: error.message };
  }
}

// Unschedule a specific page interval
function unschedulePage(pageId) {
  if (activeTasks[pageId]) {
    activeTasks[pageId].stop();
    delete activeTasks[pageId];
    console.log(`[SCHEDULER] Unmounted cron job for ID: ${pageId}`);
  }
}

// Schedule or reschedule a page
function schedulePage(pageId, url, prompt, cronExpression) {
  unschedulePage(pageId); // Clean up existing if present

  if (!cronExpression || cronExpression.trim() === '') return;
  
  if (!cron.validate(cronExpression)) {
    console.error(`[SCHEDULER] Invalid cron expression '${cronExpression}' for ID: ${pageId}`);
    return;
  }

  console.log(`[SCHEDULER] Mounted cron job for ID: ${pageId} | EXPR: ${cronExpression}`);
  activeTasks[pageId] = cron.schedule(cronExpression, () => {
    performCrawl(pageId, url, prompt);
  });
}

// Initialize all currently saved tasks on boot
function startScheduler() {
  db.all(`SELECT id, url, prompt, cron_expression FROM pages WHERE cron_expression IS NOT NULL`, (err, rows) => {
    if (err) return console.error('Scheduler DB Error:', err.message);
    
    rows.forEach(row => {
      schedulePage(row.id, row.url, row.prompt, row.cron_expression);
    });
  });
}

module.exports = { startScheduler, performCrawl, schedulePage, unschedulePage };
