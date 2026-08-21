const store = require('app-store-scraper');
const gplay = require('google-play-scraper');

// 這裡先用 Instagram 當範例 app，之後可以換成你想追蹤的 app
const IOS_APP_ID = 1522643905;          // App Store 的數字 id（格上 GoSmart）
const ANDROID_APP_ID = 'com.carplus.goSmart'; // Google Play 的 package name（格上 GoSmart）

async function fetchAppStoreReviews() {
  console.log('\n=== App Store (iOS) reviews ===\n');
  const reviews = await store.reviews({
    id: IOS_APP_ID,
    country: 'tw',      // 台灣商店
    page: 1,
    sort: store.sort.RECENT,
  });

  reviews.slice(0, 3).forEach((r, i) => {
    console.log(`--- Review ${i + 1} ---`);
    console.log('作者:', r.userName);
    console.log('星等:', r.score);
    console.log('版本:', r.version);
    console.log('日期:', r.updated);
    console.log('標題:', r.title);
    console.log('內文:', r.text.slice(0, 100) + '...');
    console.log();
  });

  console.log(`共取得 ${reviews.length} 則評論 (單次請求)`);
}

async function fetchGooglePlayReviews() {
  console.log('\n=== Google Play (Android) reviews ===\n');
  const result = await gplay.reviews({
    appId: ANDROID_APP_ID,
    lang: 'zh_tw',
    country: 'tw',
    sort: gplay.sort.NEWEST,
    num: 3,
  });

  result.data.forEach((r, i) => {
    console.log(`--- Review ${i + 1} ---`);
    console.log('作者:', r.userName);
    console.log('星等:', r.score);
    console.log('版本:', r.version);
    console.log('日期:', r.date);
    console.log('內文:', r.text.slice(0, 100) + '...');
    console.log();
  });

  console.log(`共取得 ${result.data.length} 則評論 (單次請求)`);
}

(async () => {
  try {
    await fetchAppStoreReviews();
  } catch (e) {
    console.error('App Store 抓取失敗:', e.message);
  }

  try {
    await fetchGooglePlayReviews();
  } catch (e) {
    console.error('Google Play 抓取失敗:', e.message);
  }
})();
