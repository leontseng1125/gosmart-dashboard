# App Store Playwright 爬蟲

## 為什麼需要這個
Apple 舊版的評論 RSS API (`itunes.apple.com/.../rss/customerreviews`) 在 2026 年中之後
對所有 app 都回傳空結果，目前唯一能穩定抓到評論文字的方式，是像瀏覽器一樣把
App Store 網頁實際渲染出來，再讀取畫面上的內容。Playwright 就是用來做這件事的工具。

## 安裝步驟

在 review-scraper-demo 資料夾裡，執行：

```
npm install playwright
npx playwright install chromium
```

第二行會下載一份無頭版 Chrome 瀏覽器，第一次跑可能要花 1-2 分鐘。

## 執行

```
node appstore-playwright.js
```

## 換成你想追蹤的 app

打開 appstore-playwright.js，修改最上面三個變數：

- `APP_SLUG`：App Store 網址裡 app 名稱那段，例如
  `https://apps.apple.com/us/app/instagram/id389801252` 裡的 `instagram`
- `APP_ID`：網址裡 id 後面那串數字
- `COUNTRY`：商店地區代碼，例如 `tw`、`us`、`jp`

## 已知限制

- App Store 首頁預設只會顯示少數幾則精選評論，不一定是完整清單。
  如果抓到的則數太少，可以把網址改成加上 `?see-all=reviews`
  （例如 `.../id389801252?see-all=reviews`），這樣頁面會載入更完整的評論列表。
- Apple 隨時可能調整網頁的 HTML 結構，屆時抓取的 CSS selector 可能需要更新。
- 建議排程頻率不要太高（例如每天 1-2 次），避免被暫時封鎖。
