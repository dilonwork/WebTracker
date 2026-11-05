# WebTracker

個人財務儀表板 + AI 網站監控工具：追蹤帳戶水位與股票部位、定時爬取你指定的網頁並用自架 LLM 依你的 prompt 做分析，結果都呈現在同一個手機友善的儀表板上。

![系統架構](docs/images/architecture.svg)

![股票帳戶：SEPA 體檢與股價告警](docs/images/stock-sepa.png)

## 功能

### 📊 財務儀表板（dashboard）
- 淨資產 Hero 卡＋面積走勢圖，指標可在淨資產／現金／投資之間切換
- 橫滑小卡、流動性橫幅、帳戶清單、近期待繳一覽
- **AI 診斷**：綜合帳戶水位、待繳現金需求與最新網站監控摘要，由 Ollama 生成建議

### 📝 水位維護（maintenance）
- 帳戶卡片點一下展開，大數字輸入框＋ ±1 萬／±10 萬快速鍵
- 每筆帳戶可單獨儲存；未儲存的帳戶顯示橘點提醒
- 點「總資產」卡可展開各類型分組（現金／定存／股票／外幣＋小計），點類型即篩選列表，再點一次取消；篩到股票時出現「📋 全部體檢」一鍵執行 SEPA
- **分級部位總覽**：第一級／第二級／試單／未分級／現金各佔總資產比例（條狀圖），第一級標 70% 上限、現金標 10% 目標，超標或不足直接標示提醒
- 有未儲存水位時底部浮出「N 項水位未儲存／全部儲存」列
- 新增帳戶彈窗（手機上為底部抽屜）
- 水位歷史去重：餘額沒變不寫入歷史（每小時股價更新在盤外價格不動時不會灌爆走勢圖）

### 📈 股票帳戶
- 股票代號、持有股數、**每股成本手動設定**
- **現價每小時整點從 Yahoo Finance 自動更新**，市值＝現價 × 股數
- 損益自動計算（帳戶列顯示損益 %，點開可見現價、成本總額、損益金額）
- **加碼買進**：輸入加碼股數與買進單價，後端自動重算加權平均成本；送出前即時預覽加碼後均價與總股數
- **賣出記錄**：輸入賣出股數與賣出單價，自動扣減股數並記錄實現損益；點開帳戶可見累計已實現損益與每筆賣出明細
- **股價提醒**：每檔股票可設停損價／目標價（股票計價幣別）；每小時更新時採邊緣觸發檢查，穿越即產生告警，帳戶列顯示 ⚠️ 徽章，點開可確認（知道了）
- **SEPA 每日體檢**：每天 14:00（Phoenix 時間，台美股皆收盤後）自動抓一年日線，計算 50/150/200 日線、10 週線、52 週高低，逐條檢查 8 條趨勢模板（第 8 條以相對大盤強弱為參考值）；每檔股票可設**持股分級**（第一級／第二級／試單），體檢區頂部的**行動建議**按分級給出（第一級：10 週線減半／200 日線出清；第二級・試單：破 50 日線出場；未分級：中性描述），為常駐狀態；規則告警（收盤破 50 日線／跌破 10 週線／跌破 200 日線／距成本 -7%／過熱 +20%）採邊緣觸發寫入告警系統；尚未體檢時可按「立即體檢」手動觸發

### 🤖 Agent 總開關與白名單
- **五個開關**：存在資料庫 `agent_settings`（不是環境變數），改了立即生效，不用重啟——總開關（關掉就壓過全部）、告警診斷（預設開）、每日健檢（預設開，正常不打擾）、批准動作執行（預設關，試點穩定後手動開）、對外通知（預設關，v1 只有站內告警）
- **告警診斷**：新告警產生時 agent 用 Ollama 寫一段短診斷附在告警旁邊；Ollama 連不上時診斷直接缺件、不編造，SEPA 資料日期對不上觸發日時標示資料過期、不出診斷，執行中開關被關掉時直接中止、不留半成品
- **每日健檢**：每天 14:30（Phoenix 時間）檢查資料庫、Ollama、SEPA 體檢新鮮度，結果寫入稽核紀錄，正常不打擾，Ollama 異常會明確標示
- **白名單動作**：人點一次、只做一次——確認告警、重跑 SEPA 體檢、單檔重抓 Yahoo 股價、單頁重跑爬取、產生 advisor 報告；執行開關關著時按鈕停用並講明原因，不排隊偷跑
- **C 級永遠禁止**：改停損／目標價／門檻、分級、成本、股數，靜音或刪除告警，改網址／prompt／排程，任何交易、改資料庫結構、重啟服務——server 端強制擋下，只寫稽核不執行；但總開關關掉不影響資料層：每小時 Yahoo 抓價、每天 14:00 SEPA 體檢、網站爬取照常寫資料
- **稽核軌跡**：每次 agent 動作一筆寫入 `agent_audit_log`（鳳凰城時間、動作類型、開關快照、輸入快照、模型、輸出摘要、批准來源、結果），前端只列最新 50 筆

### 🧾 近期待繳（demands）
- 未來現金需求的新增／刪除，含金額與到期日

### 🕷️ 網站監控（scraper）
- 追蹤任務的新增／編輯／刪除，可依分類（Finance / News / Others）分組
- 每個任務可設定 cron 表達式自動執行，也可手動觸發
- 爬取結果送交 Ollama 依自訂 prompt 分析
- 結果列表在手機上自動轉為卡片式呈現，含 AI 分析摘要預覽與相對時間；觸控按鈕 ≥ 44px、支援 iPhone 瀏海安全區

## 技術棧

| 層 | 技術 |
|---|---|
| 前端 | React 18 + TypeScript，Vite 5 |
| 後端 | Node.js + Express |
| 定時排程 | node-cron（定時爬取、每小時股票現價更新、每日 SEPA 體檢與 agent 健檢）|
| 資料庫 | PostgreSQL（`pg`，啟動時自動建表）|
| AI 分析 | Ollama（自架 LLM，見 `server/gemini.js`）|
| 股票現價 | Yahoo Finance 非官方 chart API（含 429/5xx 重試）|

## 快速開始

```bash
npm install
```

建立 `.env`（完整變數清單與說明見 `.env.example`）：

```bash
cp .env.example .env
```

必填：`DB_HOST`、`DB_ACCOUNT`、`DB_PASSWORD`（沒有預設值）；其他變數（`DB_NAME`、`OLLAMA_URL`、`OLLAMA_MODEL`、`BACKEND_PORT`、`FRONTEND_PORT`、`TZ`）都有預設值，可省略。注意：`.env` 已被 `.gitignore` 排除、不會進版控，內網 IP、帳號密碼等敏感資訊請只放在 `.env`。

啟動（前端 + 後端同時跑）：

```bash
npm run dev
```

前端：http://localhost:$FRONTEND_PORT，後端 API：http://localhost:$BACKEND_PORT（開發模式下前端經 `/api` 代理到後端）。也可以用 `./Startup.sh` 一鍵啟動（會先釋放 8080 / 8888 連接埠佔用再啟動）。

建置前端：

```bash
npm run build   # tsc + vite build，產出 dist/
```

## API 一覽

### 網站監控

| 方法 | 路徑 | 說明 |
| ---- | ---- | ---- |
| GET | `/api/pages` | 取得所有追蹤任務 |
| POST | `/api/pages` | 新增任務（`url` 必填，`cron_expression` 留空 = 僅手動）|
| PUT | `/api/pages/:id` | 更新任務 |
| DELETE | `/api/pages/:id` | 刪除任務 |
| POST | `/api/pages/:id/crawl` | 手動觸發一次爬取 |
| GET | `/api/results` | 取得分析結果（依爬取時間倒序）|

### 財務

| 方法 | 路徑 | 說明 |
| ---- | ---- | ---- |
| GET / POST | `/api/financials/accounts` | 帳戶清單／新增帳戶 |
| PUT / DELETE | `/api/financials/accounts/:id` | 更新／刪除帳戶 |
| PUT | `/api/financials/accounts/batch/balances` | 批次儲存水位 |
| POST | `/api/financials/accounts/:id/add-shares` | 加碼買進（加權平均成本重算）|
| POST | `/api/financials/accounts/:id/sell-shares` | 賣出（扣減股數＋記錄實現損益）|
| GET | `/api/financials/accounts/:id/realized` | 單一帳戶實現損益明細與累計 |
| GET | `/api/financials/accounts/:id/alerts` | 單一帳戶股價告警記錄 |
| POST | `/api/financials/alerts/:id/acknowledge` | 確認（已讀）一則股價告警 |
| POST | `/api/financials/sepa/check` | 手動觸發 SEPA 每日體檢 |
| GET | `/api/financials/accounts/:id/sepa` | 單一帳戶最新 SEPA 體檢結果 |
| POST | `/api/financials/stocks/refresh` | 手動觸發股票現價更新 |
| GET | `/api/financials/accounts/:id/history` | 單一帳戶水位歷史 |
| GET | `/api/financials/history/all` | 全帳戶水位歷史（走勢圖用）|
| GET / POST / DELETE | `/api/financials/demands` | 近期待繳清單／新增／刪除 |
| GET | `/api/financials/reports` | AI 診斷報告 |
| POST | `/api/financials/advisor` | 產生一次 AI 財務診斷 |

### Agent 總開關與白名單

| 方法 | 路徑 | 說明 |
| ---- | ---- | ---- |
| GET / PUT | `/api/agent/settings` | 五個開關查詢／更新（只接受已知 key、布林值）|
| GET | `/api/agent/audit` | 稽核紀錄（最新 50 筆）|
| POST | `/api/agent/actions` | 執行白名單動作（`type` 限五種；C 級回 403、執行開關關著回 409）|
| POST | `/api/agent/health-check` | 手動觸發一次每日健檢 |

## 專案結構

```
├── src/               # React + Vite 前端
│   ├── App.tsx        # 主畫面：儀表板／水位維護／近期待繳／網站監控四個分頁
│   ├── main.tsx
│   └── App.css / index.css
├── server/
│   ├── index.js       # Express API
│   ├── database.js    # PostgreSQL 存取（pg，啟動時自動建表）
│   ├── scheduler.js   # node-cron：定時爬取＋每小時整點股票現價更新＋每日 SEPA 體檢與 agent 健檢
│   ├── stock.js       # Yahoo Finance 現價抓取（含重試）
│   ├── gemini.js      # Ollama AI 分析呼叫（分析＋財務診斷）
│   ├── agent.js       # Agent 總開關與白名單：開關、診斷、健檢、通知閘門、白名單執行、C 級阻擋、稽核
│   ├── agent.test.js  # Agent 單元測試（假 DB＋假 Ollama，`node server/agent.test.js`）
│   └── migrate.js     # 資料庫遷移
├── docs/images/       # 架構圖
├── Startup.sh         # 一鍵啟動腳本
└── index.html
```

## 備註

- AI 分析與 AI 診斷需要能連線到 `.env` 指定的 Ollama 服務；連不上時相關功能會回傳錯誤訊息。
- Agent 開關預設：總開關開、告警診斷開、每日健檢開、批准動作執行關、對外通知關；開關存資料庫，改了立即生效。執行開關關著時，白名單按鈕（確認告警、重跑 SEPA 體檢、單檔重抓股價、單頁重跑爬取、產生 advisor 報告）會停用並講明原因。
- 股票現價依賴 Yahoo Finance 非官方 API，程式內建 429 / 5xx 重試，但仍可能受限流影響。
- 後端預設時區為 `America/Phoenix`（可用 `TZ` 環境變數覆寫）。
