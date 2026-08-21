const fs = require('fs');
const path = require('path');
const gplay = require('google-play-scraper');

// ===== 追蹤目標：格上 GoSmart =====
const ANDROID_APP_ID = 'com.carplus.goSmart';
const COUNTRY = 'tw';
const LANG = 'zh_tw';

// 想往回抓幾年
const YEARS_BACK = 3;

// 每頁之間停頓多久（毫秒），避免請求太密集被 Google 暫時封鎖
const DELAY_MS = 2000;

const OUT_FILE = path.join(__dirname, 'data', 'android-full-history.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllReviews() {
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - YEARS_BACK);

  const all = [];
  let nextToken = null;
  let page = 0;
  let reachedCutoff = false;

  console.log(`開始抓取，目標往回追溯到 ${cutoffDate.toISOString().slice(0, 10)}`);

  while (!reachedCutoff) {
    page++;
    const opts = {
      appId: ANDROID_APP_ID,
      lang: LANG,
      country: COUNTRY,
      sort: gplay.sort.NEWEST,
      num: 150, // 每頁盡量多拿一點，減少總請求次數
    };
    if (nextToken) opts.nextPaginationToken = nextToken;

    let result;
    try {
      result = await gplay.reviews(opts);
    } catch (e) {
      console.error(`第 ${page} 頁抓取失敗: ${e.message}`);
      break;
    }

    const batch = result.data || [];
    if (batch.length === 0) {
      console.log(`第 ${page} 頁沒有更多資料，停止。`);
      break;
    }

    all.push(...batch);

    const oldestInBatch = batch[batch.length - 1];
    const oldestDate = oldestInBatch.date ? new Date(oldestInBatch.date) : null;

    console.log(
      `第 ${page} 頁：抓到 ${batch.length} 則，累積 ${all.length} 則，最舊日期 ${oldestDate ? oldestDate.toISOString().slice(0, 10) : '未知'}`
    );

    if (oldestDate && oldestDate < cutoffDate) {
      reachedCutoff = true;
      console.log(`已經追溯到 ${YEARS_BACK} 年前，停止繼續翻頁。`);
      break;
    }

    nextToken = result.nextPaginationToken;
    if (!nextToken) {
      console.log('已經是最後一頁（沒有更多分頁 token），停止。');
      break;
    }

    await sleep(DELAY_MS);
  }

  return all;
}

async function main() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const reviews = await fetchAllReviews();

  // 依日期去重（同一則評論理論上 id 是唯一的）
  const seen = new Map();
  reviews.forEach((r) => {
    if (!seen.has(r.id)) seen.set(r.id, r);
  });
  const deduped = Array.from(seen.values());

  const payload = {
    fetched_at: new Date().toISOString(),
    app_id: ANDROID_APP_ID,
    total: deduped.length,
    reviews: deduped,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`\n完成！共 ${deduped.length} 則不重複評論，已存到 ${OUT_FILE}`);

  if (deduped.length > 0) {
    const dates = deduped.map((r) => new Date(r.date)).filter((d) => !isNaN(d));
    const oldest = new Date(Math.min(...dates));
    const newest = new Date(Math.max(...dates));
    console.log(`資料範圍：${oldest.toISOString().slice(0, 10)} ~ ${newest.toISOString().slice(0, 10)}`);
  }
}

main();
