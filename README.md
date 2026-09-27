# WebTracker

AI 驅動的網站監控與分析工具：定時爬取你指定的網頁，用 Gemini AI 依你的 prompt 做分析，並在儀表板上呈現結果。

## 功能

- **任務管理**：新增 / 編輯 / 複製 / 刪除追蹤任務，可依分類（Finance / News / Others）分組
- **定時爬取**：每個任務可設定 cron 表達式自動執行，也可手動觸發
- **AI 分析**：爬取結果送交 Gemini（`gemini-flash-latest`）依自訂 prompt 分析
- **統計總覽**：追蹤任務數、定時排程數、分析結果數、上次爬取時間一目了然
- **手機友善儀表板**：
  - 結果列表在手機上自動轉為卡片式呈現，含 AI 分析摘要預覽與相對時間（5 分鐘前）
  - 設定與結果視窗在手機上為底部滑出面板
  - 觸控按鈕 ≥ 44px、支援 iPhone 瀏海安全區

## 快速開始

```bash
npm install
```

建立 `.env` 並填入 Gemini API Key：

```
GEMINI_API_KEY=your_api_key_here
```

啟動（前端 + 後端同時跑）：

```bash
npm run dev
```

前端：http://localhost:5173，後端 API：http://localhost:3000（由 `server/index.js` 決定）

## 環境變數

| 變數 | 說明 |
| ---- | ---- |
| `GEMINI_API_KEY` | Google Gemini API Key（必填，否則分析會回傳錯誤） |

## API 一覽

| 方法 | 路徑 | 說明 |
| ---- | ---- | ---- |
| GET | `/api/pages` | 取得所有追蹤任務 |
| POST | `/api/pages` | 新增任務（`url` 必填，`cron_expression` 留空 = 僅手動） |
| PUT | `/api/pages/:id` | 更新任務 |
| DELETE | `/api/pages/:id` | 刪除任務 |
| POST | `/api/pages/:id/crawl` | 手動觸發一次爬取 |
| GET | `/api/results` | 取得分析結果（依爬取時間倒序） |

## 專案結構

```
├── src/               # React + Vite 前端（儀表板）
│   ├── App.tsx        # 主畫面：統計卡片、結果列表、任務設定
│   └── App.css        # 樣式（含手機版響應式）
├── server/
│   ├── index.js       # Express API
│   ├── database.js    # SQLite 存取
│   ├── scheduler.js   # node-cron 定時排程
│   └── gemini.js      # Gemini 分析呼叫
└── index.html
```

## 已知問題

- `npm run build` 目前會失敗：vite 2 無法解析 `react-markdown` v10 相依套件（`vfile`）的 Node `#imports` 語法，為既有問題，與功能開發無關。開發模式（`npm run dev`）不受影響。
