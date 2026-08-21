const { chromium } = require('playwright');

// ===== 設定這款 app 的資訊 =====
const APP_SLUG = '格上gosmart';       // App Store 網址裡 app 名稱那段（格上 GoSmart）
const APP_ID = '1522643905';         // App Store 數字 id
const COUNTRY = 'tw';               // 商店地區代碼（台灣商店）

async function scrapeAppStoreReviews() {
  const url = `https://apps.apple.com/${COUNTRY}/app/${APP_SLUG}/id${APP_ID}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  console.log(`前往頁面: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 頁面上的評論區塊需要等它渲染出來
  await page.waitForTimeout(3000);

  // 嘗試捲動到評論區，觸發 lazy load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(2000);

  // 每則評論卡片的 aria-labelledby 會以 "review-" 開頭。
  // App Store 頁面上同一則評論有時會被渲染成兩個獨立節點（一個有標題、一個沒有），
  // 所以先全部抓出來，再用「日期+內文」當作重複判斷依據，優先保留有標題的那筆。
  const reviews = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[aria-labelledby^="review-"]'));

    const raw = all.map((card) => {
      const titleEl = card.querySelector('h3');
      const dateEl = card.querySelector('time');
      const starEl = card.querySelector('[aria-label*="star" i], [aria-label*="顆星"]');
      const bodyEl = card.querySelector('blockquote, p');

      return {
        title: titleEl ? titleEl.innerText.trim() : null,
        date: dateEl ? dateEl.innerText.trim() : null,
        rating: starEl ? starEl.getAttribute('aria-label') : null,
        body: bodyEl ? bodyEl.innerText.trim() : null,
      };
    });

    const byKey = new Map();
    for (const r of raw) {
      if (!r.body) continue;
      const key = `${r.date}|${r.body.slice(0, 80)}`;
      const existing = byKey.get(key);
      // 沒看過這筆，或這筆有標題但先前存的沒有標題 → 更新/寫入
      if (!existing || (!existing.title && r.title)) {
        byKey.set(key, r);
      }
    }

    return Array.from(byKey.values());
  });

  await browser.close();
  return reviews;
}

(async () => {
  try {
    const reviews = await scrapeAppStoreReviews();
    console.log(`\n共抓到 ${reviews.length} 則評論卡片\n`);
    reviews.slice(0, 5).forEach((r, i) => {
      console.log(`--- Review ${i + 1} ---`);
      console.log('標題:', r.title);
      console.log('星等:', r.rating);
      console.log('日期:', r.date);
      console.log('內文:', r.body ? r.body.slice(0, 150) + '...' : null);
      console.log();
    });
  } catch (e) {
    console.error('抓取失敗:', e.message);
  }
})();
