const fs = require('fs');
const path = require('path');
const store = require('app-store-scraper');
const gplay = require('google-play-scraper');
const { chromium } = require('playwright');

// ===== 追蹤目標：格上 GoSmart =====
const IOS_APP_SLUG = '格上gosmart';
const IOS_APP_ID = '1522643905';
const ANDROID_APP_ID = 'com.carplus.goSmart';
const COUNTRY = 'tw';

const DATA_DIR = path.join(__dirname, 'data');

function timestamp() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchGooglePlay() {
  const result = await gplay.reviews({
    appId: ANDROID_APP_ID,
    lang: 'zh_tw',
    country: 'tw',
    sort: gplay.sort.NEWEST,
    num: 50,
  });
  return result.data;
}

function iosExtractReviewsFromPage() {
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

async function iosScrollToLoadMore(page) {
  function countReviewCards() {
    return document.querySelectorAll('[aria-labelledby^="review-"]').length;
  }

  let previousCount = 0;
  let stableRounds = 0;
  const MAX_ROUNDS = 30;
  const STABLE_THRESHOLD = 4;

  for (let round = 0; round < MAX_ROUNDS; round++) {
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

    const viewportHeight = page.viewportSize()?.height || 800;
    for (let step = 0; step < 6; step++) {
      await page.evaluate((h) => window.scrollBy(0, h * 0.8), viewportHeight);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(800);

    const currentCount = await page.evaluate(countReviewCards);
    if (currentCount === previousCount) {
      stableRounds++;
      if (stableRounds >= STABLE_THRESHOLD) break;
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;
  }
}

async function iosTrySwitchSortOrder(page) {
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

async function fetchAppStore() {
  // 加上 ?see-all=reviews，這會載入「查看全部評論」頁面，
  // 通常比首頁精選的那幾則多，但仍然有上限（不是完整歷史）。
  const url = `https://apps.apple.com/${COUNTRY}/app/${IOS_APP_SLUG}/id${IOS_APP_ID}?see-all=reviews`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 2000 },
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  await iosScrollToLoadMore(page);
  const firstPassReviews = await page.evaluate(iosExtractReviewsFromPage);

  const merged = new Map();
  firstPassReviews.forEach((r) => {
    merged.set(`${r.date}|${(r.body || '').slice(0, 80)}`, r);
  });

  const switchedOk = await iosTrySwitchSortOrder(page);
  if (switchedOk) {
    await iosScrollToLoadMore(page);
    const secondPass = await page.evaluate(iosExtractReviewsFromPage);
    secondPass.forEach((r) => {
      const key = `${r.date}|${(r.body || '').slice(0, 80)}`;
      if (!merged.has(key)) merged.set(key, r);
    });
  }

  await browser.close();
  return Array.from(merged.values());
}

async function run() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const runLog = [`[${timestamp()}] 開始排程抓取`];

  let androidReviews = [];
  try {
    androidReviews = await fetchGooglePlay();
    runLog.push(`Google Play: 抓到 ${androidReviews.length} 則`);
  } catch (e) {
    runLog.push(`Google Play 失敗: ${e.message}`);
  }

  let iosReviews = [];
  try {
    iosReviews = await fetchAppStore();
    runLog.push(`App Store: 抓到 ${iosReviews.length} 則`);
  } catch (e) {
    runLog.push(`App Store 失敗: ${e.message}`);
  }

  const outFile = path.join(DATA_DIR, `reviews-${todayStr()}.json`);
  const payload = {
    scraped_at: timestamp(),
    android: androidReviews,
    ios: iosReviews,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf-8');
  runLog.push(`已存檔: ${outFile}`);

  const logLine = runLog.join(' | ') + '\n';
  fs.appendFileSync(path.join(DATA_DIR, 'run-log.txt'), logLine);

  console.log(logLine);
}

run();
