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

async function fetchAppStore() {
  const url = `https://apps.apple.com/${COUNTRY}/app/${IOS_APP_SLUG}/id${IOS_APP_ID}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(2000);

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
      if (!existing || (!existing.title && r.title)) {
        byKey.set(key, r);
      }
    }
    return Array.from(byKey.values());
  });

  await browser.close();
  return reviews;
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
