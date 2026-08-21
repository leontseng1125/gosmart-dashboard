# 評論爬蟲 Demo

## 使用方式

1. 安裝 Node.js (建議 v18 以上)
2. 在此資料夾執行:
   ```
   npm install
   node demo.js
   ```
3. 預設抓的是 Instagram 當範例 (iOS: 389801252, Android: com.instagram.android)
   要換成你自己想追蹤的 app,修改 demo.js 裡的:
   - `IOS_APP_ID`:去 App Store 網頁版該 app 頁面網址找數字 id (例如 apps.apple.com/tw/app/xxx/id389801252 裡的 389801252)
   - `ANDROID_APP_ID`:去 Google Play 網頁版該 app 頁面網址找 package name (例如 play.google.com/store/apps/details?id=com.instagram.android 裡的 com.instagram.android)

## 注意事項
- 別太頻繁呼叫,建議排程抓取(如每天一次)而非即時輪詢
- App Store RSS 通常只能拿到近期評論,無法翻到全部歷史
- Google Play 爬蟲可以翻頁拿較多筆數 (調整 num 參數)
