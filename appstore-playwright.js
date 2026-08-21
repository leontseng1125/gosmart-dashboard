const { chromium } = require('playwright');

// ===== 設定這款 app 的資訊 =====
const APP_SLUG = '格上gosmart';       // App Store 網址裡 app 名稱那段（格上 GoSmart）
const APP_ID = '1522643905';         // App Store 數字 id
const COUNTRY = 'tw';               // 商店地區代碼（台灣商店）

function extractReviewsFromPage() {
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
    if (!existing || (!existing.title && r.title)) {
      byKey.set(key, r);
    }
  }
  return Array.from(byKey.values());
}

async function scrollToLoadMore(page) {
  function countReviewCards() {
    return document.querySelectorAll('[aria-labelledby^="review-"]').length;
  }

  let previousCount = 0;
  let stableRounds = 0;
  const MAX_ROUNDS = 30;
  const STABLE_THRESHOLD = 4; // 稍微拉高，避免太早判定「已到底」

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 嘗試找「顯示更多評論」這類按鈕並點擊
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const moreBtn = buttons.find((b) => {
        const t = (b.innerText || '').trim();
        return /更多評論|顯示更多|More Reviews|See More|載入更多/i.test(t);
      });
      if (moreBtn) {
        moreBtn.click();
        return true;
      }
      return false;
    });
    if (clicked) await page.waitForTimeout(1500);

    // 用「小步伐、多次」的方式捲動，比一次跳到底更接近真人使用情境，
    // 較有機會觸發以「捲動事件」為基礎的 lazy load 機制。
    const viewportHeight = page.viewportSize()?.height || 800;
    for (let step = 0; step < 6; step++) {
      await page.evaluate((h) => window.scrollBy(0, h * 0.8), viewportHeight);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(800);

    const currentCount = await page.evaluate(countReviewCards);
    if (currentCount === previousCount) {
      stableRounds++;
      if (stableRounds >= STABLE_THRESHOLD) {
        console.log(`連續 ${STABLE_THRESHOLD} 輪沒有新評論載入，停止捲動（共捲動 ${round + 1} 輪）。`);
        break;
      }
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;
  }
}

async function trySwitchSortOrder(page) {
  // 嘗試找排序選單並切換到另一種排序方式（最新／最相關），
  // 這是比較不確定的嘗試：如果頁面上根本沒有這個選單，就直接跳過，不影響其他流程。
  try {
    const opened = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      const sortBtn = candidates.find((b) => {
        const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
        return /排序|Sort|Most Recent|Most Helpful|最相關|最新/i.test(label);
      });
      if (sortBtn) {
        sortBtn.click();
        return true;
      }
      return false;
    });

    if (!opened) return false;
    await page.waitForTimeout(800);

    // 選單打開後，嘗試點擊「跟目前不同」的選項
    const switched = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="option"], li, button'));
      const target = options.find((o) => {
        const t = (o.innerText || '').trim();
        return /最相關|Most Helpful|Helpful/i.test(t);
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (switched) {
      await page.waitForTimeout(2000);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function scrapeAppStoreReviews() {
  const url = `https://apps.apple.com/${COUNTRY}/app/${APP_SLUG}/id${APP_ID}?see-all=reviews`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 2000 },
  });

  console.log(`前往頁面: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('開始捲動載入（排序方式一）...');
  await scrollToLoadMore(page);
  const firstPassReviews = await page.evaluate(extractReviewsFromPage);
  console.log(`排序方式一：抓到 ${firstPassReviews.length} 則`);

  const merged = new Map();
  firstPassReviews.forEach((r) => {
    merged.set(`${r.date}|${(r.body || '').slice(0, 80)}`, r);
  });

  console.log('嘗試切換排序方式，看能不能抓到更多不同的評論...');
  const switchedOk = await trySwitchSortOrder(page);
  if (switchedOk) {
    console.log('排序已切換，重新捲動載入（排序方式二）...');
    await scrollToLoadMore(page);
    const secondPass = await page.evaluate(extractReviewsFromPage);
    let newCount = 0;
    secondPass.forEach((r) => {
      const key = `${r.date}|${(r.body || '').slice(0, 80)}`;
      if (!merged.has(key)) {
        merged.set(key, r);
        newCount++;
      }
    });
    console.log(`排序方式二：額外新增 ${newCount} 則不重複的評論`);
  } else {
    console.log('找不到可切換的排序選單，跳過這個嘗試（不影響已抓到的資料）。');
  }

  await browser.close();
  return Array.from(merged.values());
}

(async () => {
  try {
    const reviews = await scrapeAppStoreReviews();
    console.log(`\n最終共抓到 ${reviews.length} 則不重複評論卡片\n`);
    reviews.slice(0, 5).forEach((r, i) => {
      console.log(`--- Review ${i + 1} ---`);
      console.log('標題:', r.title);
      console.log('星等:', r.rating);
      console.log('日期:', r.date);
      console.log('內文:', r.body ? r.body.slice(0, 150) + '...' : null);
      console.log();
    });
    if (reviews.length > 5) {
      console.log(`...還有 ${reviews.length - 5} 則未列出（已全部存入回傳結果）`);
    }
  } catch (e) {
    console.error('抓取失敗:', e.message);
  }
})();
