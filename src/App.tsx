import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';

interface TrackedPage {
  id: number;
  name?: string;
  url: string;
  prompt: string;
  cron_expression: string;
  category: string;
  last_crawled?: string;
}

interface CrawlResult {
  id: number;
  html_length: number;
  llm_response: string;
  crawled_at: string;
  name?: string;
  url: string;
  prompt: string;
}

const formatDateTime = (dateString: string) => {
  const d = new Date(dateString + "Z");
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function App() {
  const [pages, setPages] = useState<TrackedPage[]>([]);
  const [results, setResults] = useState<CrawlResult[]>([]);

  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newCron, setNewCron] = useState(''); // empty means manual
  const [newCategory, setNewCategory] = useState('Others'); // Grouping category

  const [selectedResult, setSelectedResult] = useState<CrawlResult | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');

  const groups = Array.from(new Set(results.map(r => r.name || r.url)));
  const currentTab = activeTab && groups.includes(activeTab) ? activeTab : (groups.length > 0 ? groups[0] : '');
  const filteredResults = results.filter(r => (r.name || r.url) === currentTab);

  const fetchPages = () => fetch('/api/pages').then(res => res.json()).then(setPages).catch(console.error);
  const fetchResults = () => fetch('/api/results').then(res => res.json()).then(setResults).catch(console.error);

  useEffect(() => {
    fetchPages();
    fetchResults();

    // Poll results every 10 seconds
    const interval = setInterval(fetchResults, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCancelEdit = () => {
    setNewUrl('');
    setNewName('');
    setNewPrompt('');
    setNewCron('');
    setNewCategory('Others');
    setEditingTaskId(null);
  };

  const handleEditTask = (p: TrackedPage) => {
    setNewUrl(p.url);
    setNewName(p.name || '');
    setNewPrompt(p.prompt);
    setNewCron(p.cron_expression || '');
    setNewCategory(p.category || 'Others');
    setEditingTaskId(p.id);
  };

  const handleCopyTask = (p: TrackedPage) => {
    setNewUrl(p.url);
    setNewName(p.name || '');
    setNewPrompt(p.prompt);
    setNewCron(p.cron_expression || '');
    setNewCategory(p.category || 'Others');
    setEditingTaskId(null);
  };

  const handleSavePage = async () => {
    if (!newUrl.trim()) return;

    const method = editingTaskId ? 'PUT' : 'POST';
    const endpoint = editingTaskId ? `/api/pages/${editingTaskId}` : '/api/pages';

    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName.trim(),
        url: newUrl.trim(),
        prompt: newPrompt.trim(),
        cron_expression: newCron.trim(),
        category: newCategory.trim() || 'Uncategorized'
      })
    });

    if (!res.ok) {
      const data = await res.json();
      alert("Error: " + data.error);
      return;
    }

    handleCancelEdit();
    fetchPages();
  };

  const handleRemovePage = async (id: number) => {
    await fetch(`/api/pages/${id}`, { method: 'DELETE' });
    fetchPages();
  };

  const handleManualCrawl = async (id: number) => {
    await fetch(`/api/pages/${id}/crawl`, { method: 'POST' });
    alert("Crawl Triggered!");
    setTimeout(fetchResults, 3000); // Check back soon for result
  };

  return (
    <div className="app-container">
      <main className="dashboard-hero glass-panel animate-fade-in">
        <h1 className="header-title">AI 分析工具</h1>
        <p className="header-subtitle">Intelligent web scraping and analysis powered by Gen AI.</p>

        <div className="header-actions" style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'center', gap: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => setIsConfigOpen(true)}>
            ⚙️ Task Settings
          </button>
        </div>

        {/* Analysis Results Table */}
        <div className="results-panel glass-panel">
          <h3> AI Analysis Result</h3>
          {results.length === 0 ? (
            <p className="no-data">No results yet. Start tracking to see LLM output.</p>
          ) : (
            <>
              <div className="tabs-container filter-tabs">
                {groups.map(g => (
                  <button 
                    key={g} 
                    className={`filter-tab ${currentTab === g ? 'active' : ''}`}
                    onClick={() => setActiveTab(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="result-cards-container">
                {filteredResults.map(r => (
                  <div className="result-card" key={r.id}>
                    <div className="result-card-header">
                      <div className="result-card-title" title={r.name || r.url}>
                        <span className="icon">📄</span>
                        <span className="name">{r.name || r.url}</span>
                      </div>
                      <div className="result-card-time">
                        <span className="icon">🕒</span>
                        {formatDateTime(r.crawled_at)}
                      </div>
                    </div>
                    <div className="result-card-footer">
                      <button className="btn btn-primary btn-view" onClick={() => setSelectedResult(r)}>
                        ✨ View AI Analysis
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      {/* Config Modal Overlay */}
      {isConfigOpen && (
        <div className="modal-overlay" onClick={() => setIsConfigOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsConfigOpen(false)}>✕</button>
            <h2 style={{ marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Task Configuration</h2>

            <div className="input-section configuration-panel">
              <h3 style={{ marginTop: 0 }}>{editingTaskId ? 'Edit Task' : 'Configure New Task'}</h3>
              <div className="input-group">
                <input
                  type="text"
                  placeholder="Task Name (Optional)"
                  className="url-input"
                  style={{ flex: 1 }}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Target URL (e.g., https://example.com)"
                  className="url-input"
                  style={{ flex: 2 }}
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
              </div>
              <div className="input-group">
                <input
                  type="text"
                  placeholder="Cron (e.g. */5 * * * *, empty = manual)"
                  className="url-input"
                  style={{ flex: 1 }}
                  value={newCron}
                  onChange={(e) => setNewCron(e.target.value)}
                  title="Leave empty for manual trigger only"
                />
              </div>
              <div className="input-group">
                <select
                  className="url-input"
                  style={{ flex: 1, appearance: 'auto', backgroundColor: '#1a1a2e', color: 'white' }}
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                >
                  <option value="Finance">Finance</option>
                  <option value="News">News</option>
                  <option value="Others">Others</option>
                </select>
              </div>
              <textarea
                placeholder="Analysis Prompt (e.g., Extract the main topic of this page)"
                className="url-input textarea-input"
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                rows={2}
              />
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleSavePage}
                  disabled={!newUrl.trim()}
                >
                  {editingTaskId ? 'Update Task' : 'Add Task'}
                </button>
                {editingTaskId && (
                  <button className="btn btn-secondary" onClick={handleCancelEdit}>
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {pages.length > 0 && (
              <div className="tracked-pages-list" style={{ marginTop: '2rem', padding: 0 }}>
                <h3>Active Schedules:</h3>

                {Object.entries(pages.reduce((acc, p) => {
                  const cat = p.category || 'Uncategorized';
                  acc[cat] = acc[cat] || [];
                  acc[cat].push(p);
                  return acc;
                }, {} as Record<string, TrackedPage[]>)).map(([groupCat, groupPages]) => (
                  <div key={groupCat} className="category-group" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <h4 className="category-title">{groupCat}</h4>
                    <ul>
                      {groupPages.map((p) => (
                        <li key={p.id} className="page-item detailed-item">
                          <div className="item-details">
                            <span className="url">{p.name ? <strong>{p.name}</strong> : p.url}</span>
                            {p.name && <span className="meta" style={{ fontSize: '0.8rem', opacity: 0.7, marginLeft: '0.5rem' }}>{p.url}</span>}
                            <span className="meta" style={{ display: 'block', marginTop: '4px' }}>Schedule: {p.cron_expression || 'Manual'}</span>
                            {p.prompt && <span className="prompt-preview">"{p.prompt}"</span>}
                          </div>
                          <div className="item-actions">
                            <button className="btn btn-secondary btn-sm" onClick={() => handleEditTask(p)} title="Edit">✏️</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleCopyTask(p)} title="Copy">📋</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleManualCrawl(p.id)}>Trigger</button>
                            <button className="btn-icon" onClick={() => handleRemovePage(p.id)}>✕</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Markdown Modal Overlay */}
      {selectedResult && (
        <div className="modal-overlay" onClick={() => setSelectedResult(null)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedResult(null)}>✕</button>
            <h2>Analysis Result</h2>
            <div className="meta-bar">
              <span className="badge">🔗 {selectedResult.name ? `${selectedResult.name} (${selectedResult.url})` : selectedResult.url}</span>
              <span className="badge">⏱️ {new Date(selectedResult.crawled_at + "Z").toLocaleString()}</span>
            </div>
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedResult.llm_response}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
