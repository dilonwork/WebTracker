const axios = require('axios');

async function analyzeContentWithGemini(contextHtml, promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in .env!");
    return "Error: GEMINI_API_KEY is missing.";
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
  const contentToAnalyze = contextHtml.length > 25000 ? contextHtml.substring(0, 25000) + '... (truncated)' : contextHtml;

  try {
    const payload = {
      contents: [
        {
          parts: [
            { text: `You are an AI Web Scraper Analyzer. You will be provided with some webpage text, and a prompt of what the user wants to extract or analyze from it. \n\nUser's Prompt: ${promptText}\n\nWebpage Text:\n${contentToAnalyze}` }
          ]
        }
      ]
    };

    const response = await axios.post(endpoint, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data && response.data.candidates && response.data.candidates.length > 0) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      return "No content returned from Gemini.";
    }
  } catch (error) {
    console.error("Gemini API Error:", (error.response && error.response.data) || error.message);
    return `Error: ${error.message}`;
  }
}

async function analyzeFinancialPortfolio(portfolioData, marketContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in .env!");
    return "Error: GEMINI_API_KEY is missing.";
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  // Format portfolio accounts
  const accountsText = portfolioData.accounts.map(acc => {
    return `- ${acc.name} (${acc.institution}): 類別=${acc.type}, 子類別=${acc.subtype}, 餘額/水位=${acc.balance} ${acc.currency}, 每月還款=${acc.monthly_payment}, 利率=${acc.interest_rate}%`;
  }).join('\n');

  // Format cash demands
  const demandsText = portfolioData.demands.map(d => {
    return `- ${d.description}: 金額=${d.amount} TWD, 預計支出日期=${d.due_date}`;
  }).join('\n');

  // Format latest web tracking crawler insights
  const marketText = marketContext.length > 0 
    ? marketContext.map(m => `* 網頁追蹤項目 [${m.name}] (${m.url}):\n  爬取時間: ${m.crawled_at}\n  趨勢分析: ${m.llm_response}`).join('\n\n')
    : "無（尚未爬取股票或匯率相關資訊）";

  const systemPrompt = `你是一位專業的個人 AI 理財規劃顧問與資產配置專家。
請針對使用者的「資產負債部位水位」、「未來現金支出需求」以及「外部監控的股市與外幣趨勢資訊」，進行全面的理財診斷與投資配置分析。

以下是使用者的財務狀況數據：

### 1. 帳戶與部位餘額 (Asset & Liability Water Levels)
${accountsText}

### 2. 未來現金支出需求 (Upcoming Cash Demands)
${demandsText}

### 3. 外部股市與匯率監控趨勢 (Web Scraped Market Context)
${marketText}

請使用繁體中文（Traditional Chinese），為使用者生成一份專業、具體且易讀的「AI 週度理財建議報告」。報告應包含以下結構：

1. 📊 **資產負債總覽與健康診斷**
   - 分析淨資產狀況（總資產 vs 總負債）。
   - 診斷資產配置比例是否合理（如：現金、定存、股票、美金的佔比）。
   
2. 💧 **現金流與流動性安全分析**
   - 針對未來的現金需求與每月固定貸款還款，分析目前的活期現金水位是否足夠應付。
   - 計算流動性安全預估，若有潛在資金缺口，給予明確的預警與準備建議。

3. 📈 **股票、美金與現金部位調整建議 (核心主題)**
   - 結合「外部股市與匯率監控趨勢」與使用者的「現金充裕度」，評估使用者是否應該：
     a) 調整/減少投資（防守策略，保留現金）
     b) 維持現狀
     c) 放大投資（擴大股票或美金部位）
   - 請給出具體的原因與指標依據。

4. 📋 **本週理財行動清單**
   - 給出 2-4 個本週具體可執行的步驟（例如：將部分定存轉活存以支應即將到來的支出、逢低分批購入美金、加碼特定股票等）。
`;

  try {
    const payload = {
      contents: [
        {
          parts: [
            { text: systemPrompt }
          ]
        }
      ]
    };

    const response = await axios.post(endpoint, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data && response.data.candidates && response.data.candidates.length > 0) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      return "無法生成理財分析報告。";
    }
  } catch (error) {
    console.error("Gemini Advisor API Error:", (error.response && error.response.data) || error.message);
    return `理財診斷執行失敗: ${error.message}`;
  }
}

module.exports = {
  analyzeContentWithGemini,
  analyzeFinancialPortfolio
};
