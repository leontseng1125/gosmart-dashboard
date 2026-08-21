# Dashboard 使用說明

## 這個腳本做什麼
`generate-dashboard.js` 會讀取 `data/` 資料夾裡所有 `reviews-YYYY-MM-DD.json` 檔案，
彙整成一份靜態網頁報表 `dashboard.html`，裡面包含：

- Google Play / App Store 累積評論數與平均星等
- 每日平均評分趨勢折線圖
- 星等分佈長條圖（1~5 星各幾則）
- 近期 2 星以下負評清單（方便快速找出問題）

## 使用方式

在 review-scraper-demo 資料夾裡執行：

```
node generate-dashboard.js
```

跑完會產出 `dashboard.html`，用瀏覽器打開它（直接雙擊，或用 Chrome/Safari 開啟）就能看到報表。

## 建議用法

- 累積越多天的資料，趨勢圖越有意義。建議先讓 `scheduled-scrape.js` 排程跑個一兩週。
- 每次想看最新報表時，重新執行一次 `node generate-dashboard.js` 即可，
  它每次都是重新讀取 data 裡所有檔案並重新產出，不需要額外設定。
- 之後如果想要「每天自動產生報表」，也可以把這行加進同一個 cron 排程裡，
  緊接在 scheduled-scrape.js 後面執行。

## 已知限制

- 圖表需要連網（從 CDN 載入 Chart.js 這個繪圖套件），完全離線環境會看不到圖表。
- 負評清單目前只顯示前 30 則，避免報表過長。
