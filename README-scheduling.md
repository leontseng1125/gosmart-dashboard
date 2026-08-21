# 設定每日自動排程 (Mac / cron)

## 這個腳本做什麼
`scheduled-scrape.js` 會把 Google Play + App Store 兩邊的評論各抓一次，
存成一個帶日期的 JSON 檔案在 `data/` 資料夾裡（例如 `data/reviews-2026-08-21.json`），
並在 `data/run-log.txt` 記錄每次執行的結果，方便之後回頭檢查有沒有跑成功。

## 第一步：先手動跑一次，確認正常

```
node scheduled-scrape.js
```

跑完後檢查 `data/` 資料夾裡有沒有出現 JSON 檔案，打開看看內容是否正確。

## 第二步：找到 node 的完整路徑

排程系統 (cron) 不會自動載入你平常終端機的環境設定，所以需要給它 node 的完整路徑。
執行：

```
which node
```

會印出類似：
```
/usr/local/bin/node
```
或
```
/opt/homebrew/bin/node
```
把這個路徑記下來，等一下會用到。

## 第三步：確認這個專案資料夾的完整路徑

執行：
```
pwd
```
會印出類似：
```
/Users/leon.tseng/Desktop/review-scraper-demo
```
這個路徑等一下也要用到。

## 第四步：設定 cron 排程

執行：
```
crontab -e
```

第一次執行可能會問你要用哪個文字編輯器，選 nano 通常最簡單（照畫面指示操作）。

在打開的編輯畫面最下面加上這一行（把路徑換成你剛才記下來的）：

```
0 9 * * * cd /Users/leon.tseng/Desktop/review-scraper-demo && /usr/local/bin/node scheduled-scrape.js >> data/cron.log 2>&1
```

這行的意思是「每天早上 9 點，切換到專案資料夾，執行腳本，並把輸出記錄到 cron.log」。

時間格式是「分 時 日 月 星期」，幾個常用範例：
- `0 9 * * *` → 每天早上 9:00
- `0 9,21 * * *` → 每天早上 9:00 和晚上 21:00 各跑一次
- `0 9 * * 1` → 每週一早上 9:00

存檔離開（nano 的話按 `Ctrl+O` 存檔、`Enter` 確認、`Ctrl+X` 離開）。

## 第五步：確認排程有設定成功

```
crontab -l
```

會列出你剛才加的那一行，代表設定成功。

## 注意事項

- **電腦要保持開機**：cron 是系統層級排程，如果當下電腦是睡眠或關機狀態，排程就不會執行（Mac 睡眠時 cron 不會觸發）。
- 如果之後想暫停排程，執行 `crontab -e`，把那一行刪掉或在最前面加 `#` 註解掉。
- 換想追蹤的 app 時，記得同時修改 `scheduled-scrape.js` 最上面的 app 設定。
