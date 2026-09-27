import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
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

interface FinancialAccount {
  id: number;
  name: string;
  institution: string;
  type: 'asset' | 'liability';
  subtype: 'cash' | 'deposit' | 'stock' | 'currency' | 'loan' | 'mortgage';
  balance: number;
  currency: string;
  monthly_payment: number;
  interest_rate: number;
  updated_at: string;
}

interface CashDemand {
  id: number;
  description: string;
  amount: number;
  due_date: string;
  created_at: string;
}

interface AIReport {
  id: number;
  report_date: string;
  analysis: string;
  created_at: string;
}

const formatDateTime = (dateString: string) => {
  if (!dateString) return '';
  const cleanString = dateString.endsWith('Z') ? dateString : dateString + 'Z';
  const d = new Date(cleanString);
  if (isNaN(d.getTime())) return dateString;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'maintenance' | 'demands' | 'scraper'>('dashboard');

  // Database Data States
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [demands, setDemands] = useState<CashDemand[]>([]);
  const [reports, setReports] = useState<AIReport[]>([]);
  const [pages, setPages] = useState<TrackedPage[]>([]);
  const [results, setResults] = useState<CrawlResult[]>([]);
  const [historyRecords, setHistoryRecords] = useState<any[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);

  // Loading States
  const [isAdvisorLoading, setIsAdvisorLoading] = useState(false);
  // V1 minimal dashboard: hero chart shows one metric at a time
  const [heroMetric, setHeroMetric] = useState<'netWorth' | 'liquidCash' | 'investments'>('netWorth');

  const HERO_META = {
    netWorth: { label: '淨資產 NET WORTH', color: '#60a5fa' },
    liquidCash: { label: '流動現金 LIQUID CASH', color: '#34d399' },
    investments: { label: '投資部位 INVESTMENTS', color: '#fbbf24' },
  } as const;

  // Form States - Account Maintenance
  const [editBalances, setEditBalances] = useState<Record<number, number>>({});
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [accEditingId, setAccEditingId] = useState<number | null>(null);
  const [accName, setAccName] = useState('');
  const [accInstitution, setAccInstitution] = useState('');
  const [accType, setAccType] = useState<'asset' | 'liability'>('asset');
  const [accSubtype, setAccSubtype] = useState<'cash' | 'deposit' | 'stock' | 'currency' | 'loan' | 'mortgage'>('cash');
  const [accBalance, setAccBalance] = useState('');
  const [accCurrency, setAccCurrency] = useState('TWD');
  const [accMonthlyPayment, setAccMonthlyPayment] = useState('');
  const [accInterestRate, setAccInterestRate] = useState('');

  // Form States - Cash Demands
  const [demandDesc, setDemandDesc] = useState('');
  const [demandAmount, setDemandAmount] = useState('');
  const [demandDueDate, setDemandDueDate] = useState('');

  // Form States - Web Scraper Pages
  const [isScraperModalOpen, setIsScraperModalOpen] = useState(false);
  const [scrapEditingId, setScrapEditingId] = useState<number | null>(null);
  const [scrapUrl, setScrapUrl] = useState('');
  const [scrapName, setScrapName] = useState('');
  const [scrapPrompt, setScrapPrompt] = useState('');
  const [scrapCron, setScrapCron] = useState('');
  const [scrapCategory, setScrapCategory] = useState('Finance');
  const [selectedCrawlResult, setSelectedCrawlResult] = useState<CrawlResult | null>(null);
  const [scraperFilterTab, setScraperFilterTab] = useState<string>('');
  const [selectedScraperResult, setSelectedScraperResult] = useState<CrawlResult | null>(null);
  const [showScraperConfig, setShowScraperConfig] = useState(false);

  // Load all data
  const fetchAccounts = () => fetch('/api/financials/accounts').then(res => res.json()).then(data => {
    setAccounts(data);
    const balanceMap: Record<number, number> = {};
    data.forEach((acc: FinancialAccount) => {
      balanceMap[acc.id] = acc.balance;
    });
    setEditBalances(balanceMap);
  }).catch(console.error);

  const fetchDemands = () => fetch('/api/financials/demands').then(res => res.json()).then(setDemands).catch(console.error);
  const fetchReports = () => fetch('/api/financials/reports').then(res => res.json()).then(setReports).catch(console.error);
  const fetchPages = () => fetch('/api/pages').then(res => res.json()).then(setPages).catch(console.error);
  const fetchResults = () => fetch('/api/results').then(res => res.json()).then(setResults).catch(console.error);
  const fetchHistoryAll = () => fetch('/api/financials/history/all').then(res => res.json()).then(setHistoryRecords).catch(console.error);

  useEffect(() => {
    fetchAccounts();
    fetchDemands();
    fetchReports();
    fetchPages();
    fetchResults();
    fetchHistoryAll();

    const interval = setInterval(() => {
      fetchResults();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Compute history chart data
  useEffect(() => {
    if (historyRecords.length === 0) return;
    
    const dateMap: Record<string, any[]> = {};
    const accountTypeMap: Record<number, { type: string, subtype: string }> = {};

    historyRecords.forEach(r => {
      accountTypeMap[r.account_id] = { type: r.type, subtype: r.subtype };
      const dString = r.recorded_at;
      const cleanString = dString.endsWith('Z') ? dString : dString + 'Z';
      const dateObj = new Date(cleanString);
      const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
      
      if (!dateMap[dateKey]) dateMap[dateKey] = [];
      dateMap[dateKey].push(r);
    });

    const sortedDates = Object.keys(dateMap).sort();
    const finalChartData = [];
    const currentBalances: Record<number, number> = {};

    for (const date of sortedDates) {
      const records = dateMap[date];
      for (const r of records) {
        currentBalances[r.account_id] = Number(r.balance);
      }

      let netWorth = 0;
      let liquidCash = 0;
      let investments = 0;

      for (const accIdStr of Object.keys(currentBalances)) {
        const accId = parseInt(accIdStr, 10);
        const bal = currentBalances[accId];
        const { type, subtype } = accountTypeMap[accId];
        
        if (type === 'asset') netWorth += bal;
        if (type === 'liability') netWorth -= bal;
        if (type === 'asset' && (subtype === 'cash' || subtype === 'deposit')) liquidCash += bal;
        if (type === 'asset' && (subtype === 'stock' || subtype === 'currency')) investments += bal;
      }

      finalChartData.push({ date, netWorth, liquidCash, investments });
    }
    setChartData(finalChartData);
  }, [historyRecords]);

  // Compute stats
  const totalAssets = accounts.filter(a => a.type === 'asset').reduce((sum, a) => sum + Number(a.balance), 0);
  const totalLiabilities = accounts.filter(a => a.type === 'liability').reduce((sum, a) => sum + Number(a.balance), 0);
  const netWorth = totalAssets - totalLiabilities;

  const cashAssets = accounts.filter(a => a.type === 'asset' && a.subtype === 'cash').reduce((sum, a) => sum + Number(a.balance), 0);
  const depositAssets = accounts.filter(a => a.type === 'asset' && a.subtype === 'deposit').reduce((sum, a) => sum + Number(a.balance), 0);
  const stockAssets = accounts.filter(a => a.type === 'asset' && a.subtype === 'stock').reduce((sum, a) => sum + Number(a.balance), 0);
  const currencyAssets = accounts.filter(a => a.type === 'asset' && a.subtype === 'currency').reduce((sum, a) => sum + Number(a.balance), 0);
  
  const liquidCash = cashAssets + depositAssets;
  const totalMonthlyOutflow = accounts.filter(a => a.type === 'liability').reduce((sum, a) => sum + Number(a.monthly_payment), 0);
  const totalUpcomingDemands = demands.reduce((sum, d) => sum + Number(d.amount), 0);

  // ---- V1 minimal dashboard helpers ----
  const ACCT_STYLE: Record<string, { icon: string; bg: string }> = {
    cash: { icon: '🏦', bg: 'rgba(59,130,246,0.15)' },
    deposit: { icon: '💰', bg: 'rgba(16,185,129,0.15)' },
    stock: { icon: '📈', bg: 'rgba(245,158,11,0.15)' },
    currency: { icon: '💵', bg: 'rgba(139,92,246,0.15)' },
    loan: { icon: '💳', bg: 'rgba(239,68,68,0.15)' },
    mortgage: { icon: '🏠', bg: 'rgba(236,72,153,0.15)' },
  };

  const heroValue = heroMetric === 'netWorth' ? netWorth : heroMetric === 'liquidCash' ? liquidCash : (stockAssets + currencyAssets);

  const heroDelta = (() => {
    if (chartData.length < 2) return null;
    const first = Number(chartData[0][heroMetric]) || 0;
    const last = Number(chartData[chartData.length - 1][heroMetric]) || 0;
    if (!first) return null;
    const amt = last - first;
    return { amt, pct: (amt / Math.abs(first)) * 100, up: amt >= 0 };
  })();

  const v1Greeting = (() => {
    const h = new Date().getHours();
    if (h >= 5 && h < 11) return '早安';
    if (h >= 11 && h < 14) return '午安';
    if (h >= 14 && h < 18) return '下午好';
    return '晚上好';
  })();
  const v1DateStr = (() => {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
  })();

  const sortedDemands = [...demands].sort((a, b) => a.due_date.localeCompare(b.due_date));

  // Trigger AI Advisor
  const handleGenerateAdvisor = async () => {
    setIsAdvisorLoading(true);
    try {
      const res = await fetch('/api/financials/advisor', { method: 'POST' });
      if (res.ok) {
        await fetchReports();
        alert('AI 理財報告已成功生成！');
      } else {
        const errData = await res.json();
        alert('生成理財報告失敗：' + errData.error);
      }
    } catch (err: any) {
      alert('請求失敗：' + err.message);
    } finally {
      setIsAdvisorLoading(false);
    }
  };

  // Balance Batch Updates
  const handleSaveBalances = async () => {
    const balancePayload = Object.entries(editBalances).map(([id, balance]) => ({
      id: parseInt(id, 10),
      balance: Number(balance)
    }));
    try {
      const res = await fetch('/api/financials/accounts/batch/balances', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balances: balancePayload })
      });
      if (res.ok) {
        alert('資產部位餘額已成功更新！');
        fetchAccounts();
      } else {
        alert('更新失敗');
      }
    } catch (err: any) {
      alert('更新請求失敗: ' + err.message);
    }
  };

  // Account CRUD
  const handleOpenAccountModal = (acc?: FinancialAccount) => {
    if (acc) {
      setAccEditingId(acc.id);
      setAccName(acc.name);
      setAccInstitution(acc.institution);
      setAccType(acc.type);
      setAccSubtype(acc.subtype);
      setAccBalance(acc.balance.toString());
      setAccCurrency(acc.currency);
      setAccMonthlyPayment(acc.monthly_payment.toString());
      setAccInterestRate(acc.interest_rate.toString());
    } else {
      setAccEditingId(null);
      setAccName('');
      setAccInstitution('');
      setAccType('asset');
      setAccSubtype('cash');
      setAccBalance('0');
      setAccCurrency('TWD');
      setAccMonthlyPayment('0');
      setAccInterestRate('0');
    }
    setIsAccountModalOpen(true);
  };

  const handleSaveAccount = async () => {
    const payload = {
      name: accName,
      institution: accInstitution,
      type: accType,
      subtype: accSubtype,
      balance: Number(accBalance) || 0,
      currency: accCurrency,
      monthly_payment: Number(accMonthlyPayment) || 0,
      interest_rate: Number(accInterestRate) || 0
    };

    const method = accEditingId ? 'PUT' : 'POST';
    const endpoint = accEditingId ? `/api/financials/accounts/${accEditingId}` : '/api/financials/accounts';

    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      setIsAccountModalOpen(false);
      fetchAccounts();
    } else {
      const data = await res.json();
      alert('Error: ' + data.error);
    }
  };

  const handleDeleteAccount = async (id: number) => {
    if (window.confirm('確定要刪除此帳戶部位嗎？')) {
      await fetch(`/api/financials/accounts/${id}`, { method: 'DELETE' });
      fetchAccounts();
    }
  };

  // Demand CRUD
  const handleAddDemand = async () => {
    if (!demandDesc.trim() || !demandAmount || !demandDueDate) return;
    const res = await fetch('/api/financials/demands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: demandDesc.trim(),
        amount: Number(demandAmount),
        due_date: demandDueDate
      })
    });
    if (res.ok) {
      setDemandDesc('');
      setDemandAmount('');
      setDemandDueDate('');
      fetchDemands();
    } else {
      alert('新增失敗');
    }
  };

  const handleDeleteDemand = async (id: number) => {
    await fetch(`/api/financials/demands/${id}`, { method: 'DELETE' });
    fetchDemands();
  };

  // Scraper CRUD
  const handleOpenScraperModal = (page?: TrackedPage) => {
    if (page) {
      setScrapEditingId(page.id);
      setScrapUrl(page.url);
      setScrapName(page.name || '');
      setScrapPrompt(page.prompt);
      setScrapCron(page.cron_expression || '');
      setScrapCategory(page.category || 'Finance');
    } else {
      setScrapEditingId(null);
      setScrapUrl('');
      setScrapName('');
      setScrapPrompt('');
      setScrapCron('');
      setScrapCategory('Finance');
    }
    setIsScraperModalOpen(true);
  };

  const handleSaveScraper = async () => {
    if (!scrapUrl.trim()) return;
    const method = scrapEditingId ? 'PUT' : 'POST';
    const endpoint = scrapEditingId ? `/api/pages/${scrapEditingId}` : '/api/pages';

    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: scrapName.trim(),
        url: scrapUrl.trim(),
        prompt: scrapPrompt.trim(),
        cron_expression: scrapCron.trim(),
        category: scrapCategory.trim()
      })
    });

    if (res.ok) {
      setIsScraperModalOpen(false);
      fetchPages();
    } else {
      const data = await res.json();
      alert('Error: ' + data.error);
    }
  };

  const handleDeleteScraper = async (id: number) => {
    if (window.confirm('確定要刪除此追蹤網頁嗎？')) {
      await fetch(`/api/pages/${id}`, { method: 'DELETE' });
      fetchPages();
    }
  };

  const handleManualCrawl = async (id: number) => {
    await fetch(`/api/pages/${id}/crawl`, { method: 'POST' });
    alert('爬蟲工作已送出，請稍後查看分析結果！');
    setTimeout(fetchResults, 3000);
  };

  // Scraper results filter
  const scraperGroups = Array.from(new Set(results.map(r => r.name || r.url)));
  const scraperCurrentTab = scraperFilterTab && scraperGroups.includes(scraperFilterTab) 
    ? scraperFilterTab 
    : (scraperGroups.length > 0 ? scraperGroups[0] : '');
  const filteredScraperResults = results.filter(r => (r.name || r.url) === scraperCurrentTab);

  return (
    <div className="app-container">
      {/* Sidebar / Left Navigation */}
      <aside className="app-sidebar glass-panel">
        <div className="sidebar-logo">
          <span className="logo-icon">⚖️</span>
          <h2>AI 理財管理工具</h2>
        </div>
        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            📊 總覽與 AI 診斷
          </button>
          <button 
            className={`nav-item ${activeTab === 'maintenance' ? 'active' : ''}`}
            onClick={() => setActiveTab('maintenance')}
          >
            ⚙️ 帳戶水位維護
          </button>
          <button 
            className={`nav-item ${activeTab === 'demands' ? 'active' : ''}`}
            onClick={() => setActiveTab('demands')}
          >
            💧 每日現金需求
          </button>
          <button 
            className={`nav-item ${activeTab === 'scraper' ? 'active' : ''}`}
            onClick={() => setActiveTab('scraper')}
          >
            🔍 網頁追蹤監控
          </button>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="app-main-content">
        
        {/* TAB 1: DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div className="tab-pane animate-fade-in v1-dash">
            {/* 問候 */}
            <div className="v1-greet">{v1DateStr} · {v1Greeting}，Dylan</div>

            {/* Hero：主指標 + 走勢 */}
            <div className="v1-hero glass-panel">
              <span className="v1-label">{HERO_META[heroMetric].label}</span>
              <h2 className="v1-big num">${heroValue.toLocaleString('zh-TW')}</h2>
              {heroDelta && (
                <div>
                  <span className={`v1-delta ${heroDelta.up ? 'up' : 'down'}`}>
                    {heroDelta.up ? '▲' : '▼'} ${Math.abs(Math.round(heroDelta.amt)).toLocaleString('zh-TW')} ({heroDelta.up ? '+' : ''}{heroDelta.pct.toFixed(1)}%) 走勢區間
                  </span>
                </div>
              )}
              <div className="v1-chart">
                {chartData.length > 1 ? (
                  <ResponsiveContainer width="100%" height={140}>
                    <AreaChart data={chartData} margin={{ top: 10, right: 6, left: 6, bottom: 0 }}>
                      <defs>
                        <linearGradient id="v1HeroGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={HERO_META[heroMetric].color} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={HERO_META[heroMetric].color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={70}
                        tickFormatter={(d: string) => d.slice(5).replace('-', '/')}
                      />
                      <YAxis hide domain={['auto', 'auto']} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '10px', color: '#f8fafc', fontSize: 12 }}
                        formatter={(value) => [`$${Number(value).toLocaleString('zh-TW')}`, '']}
                        labelFormatter={(d) => String(d ?? '')}
                      />
                      <Area
                        type="monotone"
                        dataKey={heroMetric}
                        stroke={HERO_META[heroMetric].color}
                        strokeWidth={2.5}
                        fill="url(#v1HeroGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="v1-chart-empty">累積更多歷史資料後顯示走勢</div>
                )}
              </div>
              <div className="v1-seg">
                {(['netWorth', 'liquidCash', 'investments'] as const).map(m => (
                  <button key={m} className={heroMetric === m ? 'on' : ''} onClick={() => setHeroMetric(m)}>
                    {{ netWorth: '淨資產', liquidCash: '現金', investments: '投資' }[m]}
                  </button>
                ))}
              </div>
            </div>

            {/* 橫滑小卡 */}
            <div className="v1-stats">
              <div className="v1-stat glass-panel" onClick={() => setHeroMetric('liquidCash')}>
                <span className="v1-label">流動現金</span>
                <div className="v1-stat-v num">${liquidCash.toLocaleString('zh-TW')}</div>
                <span className="v1-stat-s">現金 + 定存</span>
              </div>
              <div className="v1-stat glass-panel" onClick={() => setHeroMetric('investments')}>
                <span className="v1-label">投資部位</span>
                <div className="v1-stat-v num">${(stockAssets + currencyAssets).toLocaleString('zh-TW')}</div>
                <span className="v1-stat-s">股票 + 外幣</span>
              </div>
              <div className="v1-stat glass-panel" onClick={() => setActiveTab('demands')}>
                <span className="v1-label">待繳需求</span>
                <div className="v1-stat-v num">${totalUpcomingDemands.toLocaleString('zh-TW')}</div>
                <span className="v1-stat-s">{demands.length} 筆待處理 ›</span>
              </div>
            </div>

            {/* 流動性狀態 */}
            <div className={`v1-banner ${liquidCash < totalUpcomingDemands ? 'warn' : 'ok'}`}>
              <span>{liquidCash < totalUpcomingDemands ? '⚠️' : '✅'}</span>
              <span>
                {liquidCash < totalUpcomingDemands
                  ? <><strong>流動性不足</strong>：現金水位低於未來開支需求 ${totalUpcomingDemands.toLocaleString('zh-TW')}</>
                  : <><strong>流動性充裕</strong>：現金水位可覆蓋未來開支需求</>}
              </span>
            </div>

            {/* 我的帳戶 */}
            <div className="v1-sec">
              <div className="v1-sec-h">
                <h3>我的帳戶</h3>
                <span onClick={() => setActiveTab('maintenance')}>全部 {accounts.length} ›</span>
              </div>
              {accounts.slice(0, 6).map(a => {
                const st = ACCT_STYLE[a.subtype] || ACCT_STYLE.cash;
                return (
                  <div key={a.id} className="v1-row glass-panel" onClick={() => setActiveTab('maintenance')}>
                    <div className="v1-ic" style={{ background: st.bg }}>{st.icon}</div>
                    <div>
                      <div className="v1-row-n">{a.name}</div>
                      <div className="v1-row-d">{a.institution}</div>
                    </div>
                    <div className="v1-row-b num">${Number(a.balance).toLocaleString('zh-TW')}</div>
                    <div className="v1-chev">›</div>
                  </div>
                );
              })}
              {accounts.length === 0 && <p className="no-data-hint">尚未建立任何帳戶。</p>}
            </div>

            {/* 近期待繳 */}
            <div className="v1-sec">
              <div className="v1-sec-h">
                <h3>近期待繳</h3>
                <span onClick={() => setActiveTab('demands')}>全部 ›</span>
              </div>
              {sortedDemands.slice(0, 4).map(d => (
                <div key={d.id} className="v1-bill" onClick={() => setActiveTab('demands')}>
                  <span className="v1-dot" />
                  <span className="v1-bill-n">{d.description}</span>
                  <span className="v1-bill-amt num">${Number(d.amount).toLocaleString('zh-TW')}</span>
                  <span className="v1-bill-due">{d.due_date.substring(0, 10).slice(5).replace('-', '/')}</span>
                </div>
              ))}
              {demands.length === 0 && <p className="no-data-hint">目前無登記未來開支需求。</p>}
            </div>

            {/* AI 診斷（收合） */}
            <div className="v1-sec">
              <div className="v1-sec-h">
                <h3>⚡ AI 理財診斷</h3>
                <button
                  className="btn btn-primary btn-spark v1-gen-btn"
                  onClick={handleGenerateAdvisor}
                  disabled={isAdvisorLoading}
                >
                  {isAdvisorLoading ? '分析中...' : '生成建議'}
                </button>
              </div>
              {reports.length > 0 ? (
                <details className="v1-details glass-panel">
                  <summary>最新報告 · {formatDateTime(reports[0].created_at)}</summary>
                  <div className="markdown-body select-text">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {reports[0].analysis}
                    </ReactMarkdown>
                  </div>
                </details>
              ) : (
                <p className="no-data-hint">尚無診斷報告，點擊「生成建議」讓 AI 分析您的財務水位。</p>
              )}
              {reports.length > 1 && (
                <details className="v1-details glass-panel">
                  <summary>歷史紀錄（{reports.length - 1}）</summary>
                  {reports.slice(1, 6).map(rep => (
                    <details key={rep.id} className="v1-details-inner">
                      <summary>{formatDateTime(rep.created_at)}</summary>
                      <div className="markdown-body select-text">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {rep.analysis}
                        </ReactMarkdown>
                      </div>
                    </details>
                  ))}
                </details>
              )}
            </div>
          </div>
        )}


        {/* TAB 2: MAINTENANCE */}
        {activeTab === 'maintenance' && (
          <div className="tab-pane animate-fade-in">
            <header className="content-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h1>各部位帳戶與水位維護</h1>
                <p>每週更新各銀行、證券與貸款部位的最新水位，確保財務數據的準確性。</p>
              </div>
              <button className="btn btn-secondary" onClick={() => handleOpenAccountModal()}>
                ➕ 新增帳戶部位
              </button>
            </header>

            <div className="glass-panel">
              <h3>💵 每週水位快速調整 (維護調整各部位水位)</h3>
              
              {/* Desktop Account Table */}
              <div className="accounts-maintenance-table-wrapper desktop-only-view">
                <table className="maintenance-table">
                  <thead>
                    <tr>
                      <th>部位名稱</th>
                      <th>機構</th>
                      <th>類型 / 子類別</th>
                      <th>利率</th>
                      <th>每月償付</th>
                      <th style={{ width: '220px' }}>目前水位餘額 (TWD)</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map(acc => (
                      <tr key={acc.id} className={acc.type === 'liability' ? 'row-liability' : 'row-asset'}>
                        <td>
                          <strong>{acc.name}</strong>
                          {acc.currency !== 'TWD' && <span className="currency-badge">{acc.currency}</span>}
                        </td>
                        <td>{acc.institution}</td>
                        <td>
                          <span className={`badge-type ${acc.type}`}>
                            {acc.type === 'asset' ? '資產' : '負債'}
                          </span>
                          <span className="badge-subtype">
                            {acc.subtype}
                          </span>
                        </td>
                        <td>{acc.interest_rate > 0 ? `${acc.interest_rate}%` : '-'}</td>
                        <td>{acc.monthly_payment > 0 ? `$${acc.monthly_payment.toLocaleString()}` : '-'}</td>
                        <td>
                          <div className="balance-input-wrapper">
                            <span>$</span>
                            <input 
                              type="number"
                              className="balance-input-field"
                              value={editBalances[acc.id] !== undefined ? editBalances[acc.id] : acc.balance}
                              onChange={(e) => {
                                setEditBalances({
                                  ...editBalances,
                                  [acc.id]: Number(e.target.value)
                                });
                              }}
                            />
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn-sm btn-secondary" onClick={() => handleOpenAccountModal(acc)}>
                              ✏️
                            </button>
                            <button className="btn-sm btn-danger" onClick={() => handleDeleteAccount(acc.id)}>
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Account Cards */}
              <div className="mobile-only-view" style={{ marginTop: '1rem' }}>
                {accounts.map(acc => (
                  <div key={acc.id} className={`mobile-acc-card ${acc.type}`}>
                    <div className="mobile-acc-card-header">
                      <div>
                        <span className="mobile-acc-name">{acc.name}</span>
                        {acc.currency !== 'TWD' && <span className="currency-badge">{acc.currency}</span>}
                      </div>
                      <div className="mobile-acc-actions">
                        <button className="btn-sm btn-secondary" onClick={() => handleOpenAccountModal(acc)}>✏️</button>
                        <button className="btn-sm btn-danger" onClick={() => handleDeleteAccount(acc.id)}>✕</button>
                      </div>
                    </div>
                    <div className="mobile-acc-card-body">
                      <div className="mobile-acc-meta">
                        <span>機構: {acc.institution}</span>
                        <span>類別: {acc.type === 'asset' ? '資產' : '負債'} ({acc.subtype})</span>
                        {acc.interest_rate > 0 && <span>年利: {acc.interest_rate}%</span>}
                        {acc.monthly_payment > 0 && <span>月償: ${acc.monthly_payment.toLocaleString()}</span>}
                      </div>
                      <div className="mobile-acc-balance-row">
                        <label>餘額水位:</label>
                        <div className="balance-input-wrapper">
                          <span>$</span>
                          <input 
                            type="number"
                            className="balance-input-field"
                            value={editBalances[acc.id] !== undefined ? editBalances[acc.id] : acc.balance}
                            onChange={(e) => {
                              setEditBalances({
                                ...editBalances,
                                  [acc.id]: Number(e.target.value)
                              });
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={handleSaveBalances} style={{ padding: '0.75rem 2rem' }}>
                  💾 儲存部位水位更新
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CASH DEMANDS */}
        {activeTab === 'demands' && (
          <div className="tab-pane animate-fade-in">
            <header className="content-header">
              <h1>每日現金支出需求登記</h1>
              <p>登記未來需要支出的資金與開銷，以供 AI 計算流動性儲備與回檔水位的安全預警。</p>
            </header>

            <div className="dashboard-section-split">
              {/* Form to add cash demand */}
              <div className="section-col glass-panel" style={{ flex: 1 }}>
                <h3>➕ 登記未來開支需求</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                  <div className="form-group">
                    <label>支出項目 / 用途說明</label>
                    <input 
                      type="text" 
                      placeholder="例如：交納牌照稅、買筆電、定存轉出需求" 
                      className="url-input" 
                      value={demandDesc} 
                      onChange={e => setDemandDesc(e.target.value)} 
                    />
                  </div>
                  <div className="form-group">
                    <label>預計需求金額 (TWD)</label>
                    <input 
                      type="number" 
                      placeholder="金額" 
                      className="url-input" 
                      value={demandAmount} 
                      onChange={e => setDemandAmount(e.target.value)} 
                    />
                  </div>
                  <div className="form-group">
                    <label>預計需求日期</label>
                    <input 
                      type="date" 
                      className="url-input" 
                      value={demandDueDate} 
                      onChange={e => setDemandDueDate(e.target.value)} 
                    />
                  </div>
                  <button className="btn btn-primary" onClick={handleAddDemand} style={{ marginTop: '0.5rem' }}>
                    ✅ 新增開支需求
                  </button>
                </div>
              </div>

              {/* List of cash demands */}
              <div className="section-col glass-panel" style={{ flex: 2 }}>
                <h3>📋 已登記開支需求列表</h3>
                {demands.length > 0 ? (
                  <>
                    {/* Desktop Table View */}
                    <div className="demands-list-wrapper desktop-only-view" style={{ marginTop: '1rem' }}>
                       <table className="maintenance-table">
                         <thead>
                           <tr>
                             <th>支出項目</th>
                             <th>金額 (TWD)</th>
                             <th>預計日期</th>
                             <th style={{ width: '80px' }}>操作</th>
                           </tr>
                         </thead>
                         <tbody>
                           {demands.map(d => (
                             <tr key={d.id}>
                               <td><strong>{d.description}</strong></td>
                               <td>${d.amount.toLocaleString()}</td>
                               <td>{d.due_date.substring(0, 10)}</td>
                               <td>
                                 <button className="btn-sm btn-danger" onClick={() => handleDeleteDemand(d.id)}>
                                   刪除
                                 </button>
                               </td>
                             </tr>
                           ))}
                         </tbody>
                       </table>
                    </div>

                    {/* Mobile Cards View */}
                    <div className="mobile-only-view" style={{ marginTop: '1rem' }}>
                      <div className="mobile-demands-list">
                        {demands.map(d => (
                          <div key={d.id} className="mobile-demand-card">
                            <div className="demand-card-header">
                              <strong>{d.description}</strong>
                              <button className="btn-sm btn-danger" onClick={() => handleDeleteDemand(d.id)}>刪除</button>
                            </div>
                            <div className="demand-card-body">
                              <span>金額: ${d.amount.toLocaleString()} TWD</span>
                              <span>日期: {d.due_date.substring(0, 10)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '3rem', opacity: 0.5 }}>
                    <p>目前無任何登記的未來開支需求。在左側表單登記以啟動流動性分析預警。</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: WEB SCRAPER */}
        {activeTab === 'scraper' && (
          <div className="tab-pane animate-fade-in">
            <header className="content-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h1>網頁追蹤分析工具</h1>
                <p>原「AI 工具分析」。在此處配置並排程對外幣、股市等行情進行爬取，提供 AI 理財顧問行情上下文。</p>
              </div>
              <button 
                className={`btn ${showScraperConfig ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setShowScraperConfig(!showScraperConfig)}
              >
                {showScraperConfig ? '✕ 關閉監控設定' : '⚙️ 監控排程設定'}
              </button>
            </header>

            {/* Monitoring Targets Table */}
            {showScraperConfig && (
              <div className="glass-panel" style={{ marginBottom: '2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                  <h3 style={{ margin: 0 }}>🔍 監控目標與排程設定 ({pages.length})</h3>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleOpenScraperModal()}>
                    ➕ 新增監控目標
                  </button>
                </div>
                {pages.length > 0 ? (
                  <>
                    {/* Desktop Scraper Table */}
                    <div className="accounts-maintenance-table-wrapper desktop-only-view">
                      <table className="maintenance-table">
                        <thead>
                          <tr>
                            <th>目標項目</th>
                            <th>目標網址</th>
                            <th>排程表達式</th>
                            <th>分類</th>
                            <th style={{ width: '260px', textAlign: 'right' }}>操作項目</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pages.map(p => (
                            <tr key={p.id}>
                              <td><strong>{p.name || '未命名'}</strong></td>
                              <td style={{ fontSize: '0.8rem', opacity: 0.7, wordBreak: 'break-all', maxWidth: '300px' }}>{p.url}</td>
                              <td><span className="badge-subtype">{p.cron_expression || '僅手動觸發'}</span></td>
                              <td><span className="badge-subtype">{p.category}</span></td>
                              <td style={{ textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                                  <button className="btn-sm btn-primary" onClick={() => handleManualCrawl(p.id)}>⚡ 立即執行</button>
                                  <button className="btn-sm btn-secondary" onClick={() => handleOpenScraperModal(p)}>✏️ 編輯</button>
                                  <button className="btn-sm btn-danger" onClick={() => handleDeleteScraper(p.id)}>✕ 刪除</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile Scraper Cards */}
                    <div className="mobile-only-view">
                      <div className="mobile-scraper-list">
                        {pages.map(p => (
                          <div key={p.id} className="mobile-scraper-card">
                            <div className="scraper-card-header">
                              <strong>{p.name || '未命名'}</strong>
                              <span className="badge-subtype">{p.category}</span>
                            </div>
                            <div className="scraper-card-body">
                              <span className="scraper-url-label">網址: {p.url}</span>
                              <span className="scraper-cron-label">排程: {p.cron_expression || '僅手動觸發'}</span>
                            </div>
                            <div className="scraper-card-actions">
                              <button className="btn-sm btn-primary" onClick={() => handleManualCrawl(p.id)}>⚡ 立即執行</button>
                              <button className="btn-sm btn-secondary" onClick={() => handleOpenScraperModal(p)}>✏️ 編輯</button>
                              <button className="btn-sm btn-danger" onClick={() => handleDeleteScraper(p.id)}>✕ 刪除</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="no-data-hint">目前尚無配置網頁監控目標。請點擊右上角按鈕新增監控網址與分析目標。</p>
                )}
              </div>
            )}

            {/* Run Logs and Live Preview (List-Detail Pane) */}
            <div className="scraper-preview-section">
              <div className="glass-panel scraper-list-panel">
                <h3>📜 歷史分析紀錄版本</h3>
                {results.length > 0 ? (
                  <>
                    {/* Category / Target Filter Tabs */}
                    <div className="tabs-container filter-tabs" style={{ marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {scraperGroups.map(g => (
                        <button 
                          key={g} 
                          className={`filter-tab ${scraperCurrentTab === g ? 'active' : ''}`}
                          onClick={() => {
                            setScraperFilterTab(g);
                            // Auto-select the first result of the filtered group
                            const groupResults = results.filter(r => (r.name || r.url) === g);
                            if (groupResults.length > 0) {
                              setSelectedScraperResult(groupResults[0]);
                            }
                          }}
                          style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                    
                    <div className="scraper-run-list">
                      {filteredScraperResults.map(r => {
                        const isSelected = selectedScraperResult 
                          ? selectedScraperResult.id === r.id 
                          : (filteredScraperResults[0]?.id === r.id);
                        return (
                          <div 
                            key={r.id} 
                            className={`scraper-run-item ${isSelected ? 'active' : ''}`}
                            onClick={() => setSelectedScraperResult(r)}
                          >
                            <div className="run-item-title">{r.name || r.url}</div>
                            <div className="run-item-time">⏱️ {formatDateTime(r.crawled_at)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <p className="no-data-hint">無爬取紀錄</p>
                )}
              </div>

              <div className="glass-panel scraper-detail-panel" style={{ flex: 2 }}>
                <h3>✨ AI 趨勢分析預覽</h3>
                {(() => {
                  const activeResult = selectedScraperResult || (filteredScraperResults.length > 0 ? filteredScraperResults[0] : null);
                  return activeResult ? (
                    <div className="scraper-detail-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="scraper-detail-header" style={{ marginBottom: '1.25rem', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.75rem' }}>
                        <h4 style={{ fontSize: '1.1rem', color: 'white', marginBottom: '0.25rem' }}>
                          {activeResult.name || activeResult.url}
                        </h4>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          網址: <a href={activeResult.url} target="_blank" rel="noreferrer" style={{ color: '#818cf8', textDecoration: 'none' }}>{activeResult.url}</a> | 爬取時間: {formatDateTime(activeResult.crawled_at)}
                        </span>
                      </div>
                      <div className="markdown-body select-text" style={{ flex: 1, maxHeight: '500px', overflowY: 'auto', paddingRight: '0.5rem' }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {activeResult.llm_response}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : (
                    <div className="no-selected-hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: 'var(--text-secondary)' }}>
                      <p>目前尚無爬取趨勢資料。請在上方立即執行爬蟲觸發分析。</p>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

      </main>

      {/* MODAL: ACCOUNT FORM */}
      {isAccountModalOpen && (
        <div className="modal-overlay" onClick={() => setIsAccountModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsAccountModalOpen(false)}>✕</button>
            <h2>{accEditingId ? '編輯帳戶部位' : '新增帳戶部位'}</h2>
            
            <div className="form-grid" style={{ marginTop: '1.5rem' }}>
              <div className="form-group">
                <label>部位名稱</label>
                <input 
                  type="text" 
                  className="url-input" 
                  value={accName} 
                  onChange={e => setAccName(e.target.value)} 
                  placeholder="例如：國泰台幣活存、台積電股票庫存"
                />
              </div>
              <div className="form-group">
                <label>金融機構</label>
                <input 
                  type="text" 
                  className="url-input" 
                  value={accInstitution} 
                  onChange={e => setAccInstitution(e.target.value)} 
                  placeholder="例如：國泰世華、富邦證券"
                />
              </div>
              
              <div className="form-group">
                <label>部位別 (Type)</label>
                <select 
                  className="url-input select-input" 
                  value={accType} 
                  onChange={e => setAccType(e.target.value as 'asset' | 'liability')}
                >
                  <option value="asset">資產 (Asset)</option>
                  <option value="liability">負債 (Liability)</option>
                </select>
              </div>

              <div className="form-group">
                <label>子類別 (Subtype)</label>
                <select 
                  className="url-input select-input" 
                  value={accSubtype} 
                  onChange={e => setAccSubtype(e.target.value as any)}
                >
                  {accType === 'asset' ? (
                    <>
                      <option value="cash">現金活存 (Cash)</option>
                      <option value="deposit">定期存款 (Deposit)</option>
                      <option value="stock">股票部位 (Stock)</option>
                      <option value="currency">外幣美金 (Currency)</option>
                    </>
                  ) : (
                    <>
                      <option value="loan">信用貸款 (Loan)</option>
                      <option value="mortgage">房屋貸款 (Mortgage)</option>
                    </>
                  )}
                </select>
              </div>

              <div className="form-group">
                <label>目前餘額水位 (本幣幣別)</label>
                <input 
                  type="number" 
                  className="url-input" 
                  value={accBalance} 
                  onChange={e => setAccBalance(e.target.value)} 
                />
              </div>

              <div className="form-group">
                <label>幣別 (Currency)</label>
                <select 
                  className="url-input select-input" 
                  value={accCurrency} 
                  onChange={e => setAccCurrency(e.target.value)}
                >
                  <option value="TWD">TWD</option>
                  <option value="USD">USD</option>
                </select>
              </div>

              <div className="form-group">
                <label>利率 / 年息 (%)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  className="url-input" 
                  value={accInterestRate} 
                  onChange={e => setAccInterestRate(e.target.value)} 
                />
              </div>

              {accType === 'liability' && (
                <div className="form-group">
                  <label>每月償還本息金額 (TWD)</label>
                  <input 
                    type="number" 
                    className="url-input" 
                    value={accMonthlyPayment} 
                    onChange={e => setAccMonthlyPayment(e.target.value)} 
                  />
                </div>
              )}
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setIsAccountModalOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveAccount}>儲存</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: SCRAPER FORM */}
      {isScraperModalOpen && (
        <div className="modal-overlay" onClick={() => setIsScraperModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsScraperModalOpen(false)}>✕</button>
            <h2>{scrapEditingId ? '編輯網頁追蹤任務' : '新增網頁追蹤任務'}</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', marginTop: '1.5rem' }}>
              <div className="form-group">
                <label>追蹤項目名稱</label>
                <input 
                  type="text" 
                  placeholder="例如：股票-台積電、美金匯率" 
                  className="url-input" 
                  value={scrapName} 
                  onChange={e => setScrapName(e.target.value)} 
                />
              </div>
              <div className="form-group">
                <label>目標網頁網址 (URL)</label>
                <input 
                  type="text" 
                  placeholder="https://example.com" 
                  className="url-input" 
                  value={scrapUrl} 
                  onChange={e => setScrapUrl(e.target.value)} 
                />
              </div>
              <div className="form-group">
                <label>Cron 排程表達式 (留空代表僅手動觸發)</label>
                <input 
                  type="text" 
                  placeholder="例如每日早上10點: 0 10 * * *" 
                  className="url-input" 
                  value={scrapCron} 
                  onChange={e => setScrapCron(e.target.value)} 
                />
              </div>
              <div className="form-group">
                <label>分類群組</label>
                <select 
                  className="url-input select-input" 
                  value={scrapCategory} 
                  onChange={e => setScrapCategory(e.target.value)}
                >
                  <option value="Finance">Finance</option>
                  <option value="News">News</option>
                  <option value="Others">Others</option>
                </select>
              </div>
              <div className="form-group">
                <label>AI 分析摘要指令 (Prompt)</label>
                <textarea 
                  placeholder="分析網頁文字，分析趨勢與買入建議..." 
                  className="url-input textarea-input" 
                  value={scrapPrompt} 
                  onChange={e => setScrapPrompt(e.target.value)} 
                  rows={3}
                />
              </div>
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setIsScraperModalOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveScraper}>儲存任務</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: SCRAP RESULT VIEW */}
      {selectedCrawlResult && (
        <div className="modal-overlay" onClick={() => setSelectedCrawlResult(null)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedCrawlResult(null)}>✕</button>
            <h2>趨勢分析詳情</h2>
            <div className="meta-bar">
              <span className="badge">🔗 {selectedCrawlResult.name ? `${selectedCrawlResult.name} (${selectedCrawlResult.url})` : selectedCrawlResult.url}</span>
              <span className="badge">⏱️ {formatDateTime(selectedCrawlResult.crawled_at)}</span>
            </div>
            <div className="markdown-body select-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selectedCrawlResult.llm_response}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
