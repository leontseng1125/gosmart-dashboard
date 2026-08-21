const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===== 設定這款 app 的資訊 =====
const APP_SLUG = '格上gosmart';
const APP_ID = '1522643905';
const COUNTRY = 'tw';

const OUT_FILE = path.join(__dirname, 'network-inspect-result.json');

async function inspectNetwork() {
  const url = `https://apps.apple.com/${COUNTRY}/app/${APP_SLUG}/id${APP_ID}?see-all=reviews`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 2000 },
  });

  const captured = [];

  // 監聽所有網路回應，篩選出「看起來像是評論資料」的請求
  page.on('response', async (response) => {
    try {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      // 只關注 JSON 回應，而且網址或內容有機會跟評論相關
      const looksRelevant =
        contentType.includes('json') &&
        (/review/i.test(reqUrl) || /amp-api/i.test(reqUrl) || /customerReviews/i.test(reqUrl));

      if (!looksRelevant) return;

      let bodySnippet = null;
      try {
        const text = await response.text();
        bodySnippet = text.slice(0, 2000); // 只取前 2000 字，避免檔案過大
      } catch (e) {
        bodySnippet = `(無法讀取內容: ${e.message})`;
      }

      captured.push({
        url: reqUrl,
        status: response.status(),
        requestHeaders: response.request().headers(),
        contentType,
        bodySnippet,
      });

      console.log(`捕捉到可能相關的請求: ${reqUrl}`);
    } catch (e) {
      // 忽略單一請求的錯誤，不中斷整體流程
    }
  });

  console.log(`前往頁面: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('開始捲動，觀察捲動過程中會不會觸發新的資料請求...');
  const viewportHeight = page.viewportSize()?.height || 800;
  for (let i = 0; i < 15; i++) {
    await page.evaluate((h) => window.scrollBy(0, h * 0.8), viewportHeight);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(2000);
  await browser.close();

  fs.writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2), 'utf-8');
  console.log(`\n共捕捉到 ${captured.length} 筆可能相關的請求，已存到 ${OUT_FILE}`);

  if (captured.length === 0) {
    console.log('沒有捕捉到任何看起來像評論資料的 JSON 請求。');
    console.log('這代表這個頁面很可能是「伺服器端直接渲染 HTML」，沒有另外呼叫 JSON API，');
    console.log('也就是說我們目前用 Playwright 讀取渲染後 HTML 的做法，已經是最直接的方式了。');
  } else {
    console.log('\n請把 network-inspect-result.json 這個檔案內容貼給 Claude，一起看看能不能從這些請求裡找到可以直接呼叫的資料介面。');
  }
}

inspectNetwork().catch((e) => {
  console.error('執行失敗:', e.message);
});
