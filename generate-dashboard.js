const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'dashboard.html');
const FULL_HISTORY_FILE = path.join(DATA_DIR, 'android-full-history.json');
const MANUAL_REVIEWS_FILE = path.join(DATA_DIR, 'manual-coded-reviews.json');

function loadManualReviews() {
  if (!fs.existsSync(MANUAL_REVIEWS_FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(MANUAL_REVIEWS_FILE, 'utf-8'));
  return raw.reviews || [];
}

function loadDailyRuns() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('找不到 data 資料夾，請先跑過 scheduled-scrape.js 或 demo.js 至少一次。');
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => /^reviews-\d{4}-\d{2}-\d{2}\.json$/.test(f));

  return files.sort().map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
    const dateFromFilename = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
    return { date: dateFromFilename, ...raw };
  });
}

function loadFullHistory() {
  if (!fs.existsSync(FULL_HISTORY_FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(FULL_HISTORY_FILE, 'utf-8'));
  return raw.reviews || [];
}

function parseAndroidScore(score) {
  const n = Number(score);
  return Number.isFinite(n) ? n : null;
}

function parseIosScore(ratingLabel) {
  if (!ratingLabel) return null;
  const m = String(ratingLabel).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function parseIosDate(dateStr) {
  // App Store 頁面上的日期格式，實測過至少有三種樣式，都要能解析：
  // 1. YYYY/MM/DD  例如 2021/12/31（台灣商店較舊的評論常見這種）
  // 2. MM/DD/YYYY  例如 08/18/2026（美國商店測試時看到的格式）
  // 3. M月D日      例如 4月27日（台灣商店近期評論常省略年份，代表「今年」）
  if (!dateStr) return null;
  const trimmed = String(dateStr).trim();

  let m = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const [, year, month, day] = m;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, month, day, year] = m;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  m = trimmed.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m) {
    const [, month, day] = m;
    const year = new Date().getFullYear(); // 沒有年份 → 視為報表產出當下的年份
    return new Date(year, Number(month) - 1, Number(day));
  }

  return null;
}

function monthKey(date) {
  if (!date || isNaN(date)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// ===== 關鍵字比對分類規則（依你提供的「分類整理」圖表建立，順序與圖表一致） =====
// 注意：圖片本身只能看到分類名稱，看不到你原本每個分類實際比對的關鍵字，
// 以下關鍵字是依分類名稱合理推測的預設值，建議之後依實際評論內容調整。
const CATEGORY_RULES = [
  { key: '定車相關', keywords: ['預約', '預訂', '定車'] },
  { key: '取車相關', keywords: ['取車'] },
  { key: '還車相關', keywords: ['還車'] },
  { key: '客服', keywords: ['客服', '服務態度', '客服人員'] },
  { key: '審核', keywords: ['審核', '認證', '身分證', '駕照'] },
  { key: '付款', keywords: ['付款', '扣款', '收費', '刷卡', '發票', '退款'] },
  { key: '站點與車輛數', keywords: ['站點', '沒有車', '車輛數', '附近沒車'] },
  { key: '停權', keywords: ['停權', '封鎖', '禁用'] },
  { key: '基本資料', keywords: ['基本資料', '個人資料'] },
  { key: '系統', keywords: ['閃退', '當機', '系統錯誤', 'bug', '無法開啟', '登入不了'] },
  { key: '車輛設備', keywords: ['座椅', '充電', '冷氣', '車況'] },
  { key: '優惠碼/優惠券', keywords: ['優惠碼', '優惠券', '折扣碼'] },
  { key: '帳號', keywords: ['帳號', '註冊'] },
  { key: '車損拍照', keywords: ['車損', '刮傷'] },
  { key: '通知', keywords: ['通知', '推播'] },
  { key: '軟體更新', keywords: ['軟體更新', '版本更新'] },
  { key: 'icon設計', keywords: ['icon', '圖示'] },
  { key: '投保', keywords: ['保險', '投保', '理賠'] },
  { key: '搜尋', keywords: ['搜尋不到', '搜尋功能'] },
  { key: '更改密碼', keywords: ['改密碼', '忘記密碼'] },
  { key: '共同承租人', keywords: ['共同承租', '附駕'] },
];
const OTHER_CATEGORY = '其他';
const CATEGORY_ORDER = [...CATEGORY_RULES.map((r) => r.key), OTHER_CATEGORY];

function categorizeText(text) {
  if (!text) return [OTHER_CATEGORY];
  const matched = CATEGORY_RULES.filter((rule) => rule.keywords.some((kw) => text.includes(kw))).map((r) => r.key);
  return matched.length > 0 ? matched : [OTHER_CATEGORY];
}

function sentimentFromScore(score) {
  if (score === null) return 'negative';
  if (score <= 3) return 'negative'; // 3星以下都算負評
  return 'positive';
}

// ===== 意圖分類：抱怨/bug、功能請求、純稱讚（依關鍵字比對的粗略版本） =====
const INTENT_RULES = [
  { key: '抱怨/bug', keywords: ['閃退', '當機', '錯誤', 'bug', '無法', '失敗', '很爛', '很差', '糟糕', '爛透'] },
  { key: '功能請求', keywords: ['希望', '建議', '期待', '如果可以', '建議增加', '希望能', '可以增加', '應該要'] },
];
const INTENT_ORDER = ['抱怨/bug', '功能請求', '純稱讚', '一般'];

function classifyIntent(text, score) {
  if (!text) return score >= 4 ? '純稱讚' : '一般';
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) return rule.key;
  }
  if (score >= 4) return '純稱讚';
  return '一般';
}

// ===== 用戶旅程階段對照（把 21 個分類對應回使用流程的哪個階段） =====
const STAGE_MAP = {
  '預約前': ['定車相關', '審核'],
  '使用中': ['取車相關', '車輛設備', '系統', '站點與車輛數', 'icon設計', '搜尋', '通知', '軟體更新', '投保'],
  '結束後': ['還車相關', '付款', '車損拍照'],
  '帳號與其他': ['客服', '帳號', '更改密碼', '共同承租人', '優惠碼/優惠券', '停權', '基本資料', '其他'],
};
const STAGE_ORDER = Object.keys(STAGE_MAP);

function categoryToStage(category) {
  for (const stage of STAGE_ORDER) {
    if (STAGE_MAP[stage].includes(category)) return stage;
  }
  return '帳號與其他';
}

function buildDataset(dailyRuns, fullHistory, manualReviews) {
  const androidSeen = new Map();

  fullHistory.forEach((r) => {
    if (!r.id) return;
    if (!androidSeen.has(r.id)) {
      androidSeen.set(r.id, {
        ...r,
        score: parseAndroidScore(r.score),
        realDate: r.date ? new Date(r.date) : null,
      });
    }
  });

  dailyRuns.forEach((run) => {
    (run.android || []).forEach((r) => {
      const key = r.id || `${r.date}|${(r.text || '').slice(0, 50)}`;
      if (!androidSeen.has(key)) {
        androidSeen.set(key, {
          ...r,
          score: parseAndroidScore(r.score),
          realDate: r.date ? new Date(r.date) : null,
        });
      }
    });
  });

  const iosSeen = new Map();
  dailyRuns.forEach((run) => {
    (run.ios || []).forEach((r) => {
      const key = `${r.date}|${(r.body || '').slice(0, 50)}`;
      if (!iosSeen.has(key)) {
        iosSeen.set(key, {
          ...r,
          score: parseIosScore(r.rating),
          realDate: parseIosDate(r.date),
        });
      }
    });
  });

  const allAndroid = Array.from(androidSeen.values());
  const allIos = Array.from(iosSeen.values());

  // ===== 月趨勢彙整（用於評分 tab 的月平均） =====
  const monthlyMap = new Map();
  function addToMonth(realDate, score, platform) {
    const key = monthKey(realDate);
    if (!key || score === null) return;
    if (!monthlyMap.has(key)) monthlyMap.set(key, { android: [], ios: [] });
    monthlyMap.get(key)[platform].push(score);
  }
  allAndroid.forEach((r) => addToMonth(r.realDate, r.score, 'android'));
  allIos.forEach((r) => addToMonth(r.realDate, r.score, 'ios'));

  // 補齊「沒有任何評論的月份」，讓 monthKeys 是連續的日曆月份序列，
  // 這樣「近3個月」等按鈕代表的才是真正的 3 個日曆月，而不是「3 個曾經有評論的月份」
  // （後者在評論分佈不均勻時，範圍可能被拉得很長）。
  function fillContiguousMonths(sparseKeys) {
    if (sparseKeys.length === 0) return [];
    const sorted = [...sparseKeys].sort();
    const [startYear, startMonth] = sorted[0].split('-').map(Number);
    const [endYear, endMonth] = sorted[sorted.length - 1].split('-').map(Number);
    const result = [];
    let y = startYear, m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      result.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return result;
  }

  const monthKeys = fillContiguousMonths(Array.from(monthlyMap.keys()));
  const monthlyStats = monthKeys.map((key) => {
    const bucket = monthlyMap.get(key) || { android: [], ios: [] };
    const { android, ios } = bucket;
    return {
      month: key,
      androidAvg: android.length ? android.reduce((a, b) => a + b, 0) / android.length : null,
      iosAvg: ios.length ? ios.reduce((a, b) => a + b, 0) / ios.length : null,
      androidCount: android.length,
      iosCount: ios.length,
    };
  });

  const ratingDist = (list) => {
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    list.forEach((r) => {
      if (r.score === null) return;
      const s = Math.round(r.score);
      if (s >= 1 && s <= 5) dist[s]++;
    });
    return dist;
  };

  // ===== 扁平化的完整評論清單（供「評論」tab 使用：散佈圖 + 清單） =====
  const flatten = (list, platform) =>
    list
      .filter((r) => r.realDate && !isNaN(r.realDate) && r.score !== null)
      .map((r) => {
        const text = platform === 'android' ? r.text : r.body;
        const categories = categorizeText(text);
        const key = platform === 'android' && r.id
          ? `android:${r.id}`
          : `${platform}:${r.realDate.toISOString().slice(0, 10)}|${(text || '').slice(0, 50)}`;
        return {
          key,
          platform,
          score: r.score,
          date: r.realDate.toISOString().slice(0, 10),
          timestamp: r.realDate.getTime(),
          month: monthKey(r.realDate),
          text,
          title: r.title || null,
          userName: r.userName || null,
          version: platform === 'android' ? (r.version || null) : null, // iOS 抓取時未取得版本號
          sentiment: sentimentFromScore(r.score),
          categories,
          stages: [...new Set(categories.map(categoryToStage))],
          intent: classifyIntent(text, r.score),
        };
      });

  const allReviewsFlat = [...flatten(allAndroid, 'android'), ...flatten(allIos, 'ios')].sort(
    (a, b) => a.timestamp - b.timestamp
  );

  // ===== 手動編碼補充資料（例如研究論文的評論編碼表）=====
  // 這些評論通常沒有精確日期，因此：
  // - 有解析出日期的：正常參與時間相關統計（月趨勢圖、今年/本月/本週篩選）
  // - 沒有日期的：timestamp 設為 0，這樣「今年/本月/本週」篩選會自動排除它們（時間戳記太舊，
  //   不會 >= 篩選門檻），但「全部」範圍、回饋洞察、評論清單仍會包含它們；
  //   月份設為 null，月趨勢圖（散佈圖）會明確跳過，不會被誤判成落在第一個月份。
  const manualFlat = manualReviews.map((r, idx) => {
    const text = r.text || '';
    const categories = categorizeText(text);
    let timestamp = 0;
    let dateLabel = '- 手動截圖';
    let month = null;
    if (r.date) {
      const d = new Date(r.date);
      if (!isNaN(d)) {
        timestamp = d.getTime();
        dateLabel = d.toISOString().slice(0, 10) + '（約，手動補充）';
        month = monthKey(d);
      }
    }
    return {
      key: `manual:${r.id || idx}`,
      platform: r.platform,
      score: r.score,
      date: dateLabel,
      timestamp,
      month,
      text,
      title: r.title || null,
      userName: null,
      version: null,
      sentiment: sentimentFromScore(r.score),
      categories,
      stages: [...new Set(categories.map(categoryToStage))],
      intent: classifyIntent(text, r.score),
    };
  });

  const allReviewsFlatWithManual = [...allReviewsFlat, ...manualFlat];

  // ===== 情緒 × 類別 統計（關鍵字比對版本），並加總分數供「頻率×嚴重度矩陣」使用 =====
  function computeCategoryStats(reviews) {
    const stats = {};
    CATEGORY_ORDER.forEach((cat) => {
      stats[cat] = { positive: 0, neutral: 0, negative: 0, scoreSum: 0, count: 0 };
    });
    reviews.forEach((r) => {
      r.categories.forEach((cat) => {
        if (!stats[cat]) stats[cat] = { positive: 0, neutral: 0, negative: 0, scoreSum: 0, count: 0 };
        stats[cat][r.sentiment]++;
        stats[cat].scoreSum += r.score;
        stats[cat].count++;
      });
    });
    return stats;
  }

  // 依「產出報表當下」的時間，算出今年/本月/本週的起始時間點（本週以週一為第一天）
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const dayOfWeek = now.getDay(); // 0=週日 ... 6=週六
  const diffToMonday = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
  const weekStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  weekStartDate.setHours(0, 0, 0, 0);
  const weekStart = weekStartDate.getTime();

  const categoryStats = computeCategoryStats(allReviewsFlatWithManual); // 全部期間（含手動補充資料）
  const reviewsByRange = {
    all: allReviewsFlatWithManual,
    year: allReviewsFlatWithManual.filter((r) => r.timestamp >= yearStart),
    month: allReviewsFlatWithManual.filter((r) => r.timestamp >= monthStart),
    week: allReviewsFlatWithManual.filter((r) => r.timestamp >= weekStart),
  };
  const categoryStatsByRange = {
    all: categoryStats,
    year: computeCategoryStats(reviewsByRange.year),
    month: computeCategoryStats(reviewsByRange.month),
    week: computeCategoryStats(reviewsByRange.week),
  };

  function computeMatrix(stats) {
    return CATEGORY_ORDER.filter((cat) => stats[cat].count > 0).map((cat) => ({
      category: cat,
      count: stats[cat].count,
      avgScore: stats[cat].scoreSum / stats[cat].count,
    }));
  }
  const categoryMatrix = computeMatrix(categoryStats);
  const categoryMatrixByRange = {
    all: categoryMatrix,
    year: computeMatrix(categoryStatsByRange.year),
    month: computeMatrix(categoryStatsByRange.month),
    week: computeMatrix(categoryStatsByRange.week),
  };

  // ===== 意圖統計（抱怨/bug、功能請求、純稱讚、一般） =====
  function computeIntentStats(reviews) {
    const stats = {};
    INTENT_ORDER.forEach((key) => { stats[key] = 0; });
    reviews.forEach((r) => { stats[r.intent] = (stats[r.intent] || 0) + 1; });
    return stats;
  }
  const intentStats = computeIntentStats(allReviewsFlatWithManual);
  const intentStatsByRange = {
    all: intentStats,
    year: computeIntentStats(reviewsByRange.year),
    month: computeIntentStats(reviewsByRange.month),
    week: computeIntentStats(reviewsByRange.week),
  };

  // ===== 旅程階段統計（把類別彙整回四個使用階段） =====
  function computeStageStats(reviews) {
    const stats = {};
    STAGE_ORDER.forEach((stage) => {
      stats[stage] = { positive: 0, neutral: 0, negative: 0 };
    });
    reviews.forEach((r) => {
      r.stages.forEach((stage) => {
        stats[stage][r.sentiment]++;
      });
    });
    return stats;
  }
  const stageStats = computeStageStats(allReviewsFlatWithManual);
  const stageStatsByRange = {
    all: stageStats,
    year: computeStageStats(reviewsByRange.year),
    month: computeStageStats(reviewsByRange.month),
    week: computeStageStats(reviewsByRange.week),
  };

  // ===== 版本統計（僅 Android，因 iOS 目前抓取流程未取得版本號） =====
  const versionMap = new Map();
  allReviewsFlat
    .filter((r) => r.platform === 'android' && r.version)
    .forEach((r) => {
      if (!versionMap.has(r.version)) versionMap.set(r.version, { scores: [], latestTimestamp: 0 });
      const v = versionMap.get(r.version);
      v.scores.push(r.score);
      v.latestTimestamp = Math.max(v.latestTimestamp, r.timestamp);
    });
  const versionStats = Array.from(versionMap.entries())
    .map(([version, v]) => ({
      version,
      count: v.scores.length,
      avgScore: v.scores.reduce((a, b) => a + b, 0) / v.scores.length,
      latestTimestamp: v.latestTimestamp,
    }))
    .sort((a, b) => a.latestTimestamp - b.latestTimestamp);

  const otherCount = allReviewsFlatWithManual.filter((r) => r.categories.includes(OTHER_CATEGORY)).length;

  const overallRange = () => {
    if (allReviewsFlat.length === 0) return { earliest: '-', latest: '-' };
    return {
      earliest: allReviewsFlat[0].date,
      latest: allReviewsFlat[allReviewsFlat.length - 1].date,
    };
  };

  return {
    monthKeys,
    monthlyStats,
    androidDist: ratingDist(allAndroid),
    iosDist: ratingDist(allIos),
    androidTotal: allAndroid.length,
    iosTotal: allIos.length,
    androidAvgOverall: allAndroid.filter((r) => r.score !== null).length
      ? allAndroid.reduce((a, b) => a + (b.score || 0), 0) / allAndroid.filter((r) => r.score !== null).length
      : null,
    iosAvgOverall: allIos.filter((r) => r.score !== null).length
      ? allIos.reduce((a, b) => a + (b.score || 0), 0) / allIos.filter((r) => r.score !== null).length
      : null,
    allReviewsFlat: allReviewsFlatWithManual,
    reviewsByRange,
    categoryOrder: CATEGORY_ORDER,
    categoryStats,
    categoryStatsByRange,
    categoryMatrix,
    categoryMatrixByRange,
    intentOrder: INTENT_ORDER,
    intentStats,
    intentStatsByRange,
    stageOrder: STAGE_ORDER,
    stageStats,
    stageStatsByRange,
    versionStats,
    otherCount,
    dateRange: overallRange(),
    hasFullHistory: fullHistory.length > 0,
  };
}

function renderHtml(dataset) {
  const dataJson = JSON.stringify(dataset);

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>格上 GoSmart 評論追蹤 Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-zoom/2.0.1/chartjs-plugin-zoom.min.js"></script>
<style>
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --border: #2a2e38;
    --text: #e8e9ed;
    --muted: #9aa0ac;
    --android: #3ddc84;
    --ios: #7c9fff;
    --neg: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "PingFang TC", "Noto Sans TC", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 32px;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 4px;
    background: linear-gradient(90deg, #00DDFF, #0BA3EF);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    display: inline-block;
  }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: repeat(2, 1fr); }
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
  }
  .card .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 600; }
  .card .value.android { color: var(--android); }
  .card .value.ios { color: var(--ios); }
  .card .value.new-count { color: var(--neg); }

  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 14px;
    font-weight: 500;
    padding: 10px 18px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-family: inherit;
  }
  .tab-btn.active {
    color: var(--text);
    border-bottom-color: #7c9fff;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .chart-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
  }
  .chart-card h2 { font-size: 14px; margin: 0 0 16px; color: var(--muted); font-weight: 500; }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 720px) {
    .two-col { grid-template-columns: 1fr; }
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.android { background: rgba(61,220,132,0.15); color: var(--android); }
  .badge.ios { background: rgba(124,159,255,0.15); color: var(--ios); }
  .score-neg { color: var(--neg); font-weight: 600; white-space: nowrap; }
  .score-pos { color: var(--text); font-weight: 600; white-space: nowrap; }
  .review-text { color: var(--text); }
  .review-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .note { color: var(--muted); font-size: 12px; margin-top: 8px; }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .toggle-group {
    display: flex;
    background: #0f1115;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .toggle-btn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 12px;
    padding: 7px 14px;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .toggle-btn.active {
    background: #2a2e38;
    color: var(--text);
  }
  .scatter-nav {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .nav-btn {
    background: #2a2e38;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }
  .nav-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .select-input {
    background: #0f1115;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    padding: 7px 10px;
    border-radius: 8px;
    font-family: inherit;
  }
  .status-select {
    min-width: 88px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .search-input-inline {
    background: #0f1115;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    padding: 7px 12px;
    border-radius: 8px;
    font-family: inherit;
    box-sizing: border-box;
    width: 140px;
  }
  .search-input-inline::placeholder { color: var(--muted); }
  .search-input-inline:focus {
    outline: none;
    border-color: #7c9fff;
  }

  .chart-container { position: relative; width: 100%; height: 280px; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { min-width: 480px; }

  /* ===== 手機 / 窄螢幕適配 ===== */
  @media (max-width: 640px) {
    body { padding: 16px; }
    h1 { font-size: 18px; }
    .subtitle { font-size: 11px; margin-bottom: 18px; }
    .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 18px; }
    .card { padding: 12px 14px; }
    .card .label { font-size: 11px; }
    .card .value { font-size: 20px; }
    .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap; }
    .tab-btn { padding: 9px 12px; font-size: 13px; white-space: nowrap; }
    .chart-card { padding: 14px; margin-bottom: 16px; }
    .chart-card h2 { font-size: 13px; margin-bottom: 12px; }
    .chart-container { height: 220px; }
    .list-header { flex-direction: column; align-items: flex-start; gap: 10px; }
    .list-header > div { width: 100%; flex-wrap: wrap; }
    .toggle-group { flex-wrap: wrap; }
    .toggle-btn { font-size: 11px; padding: 6px 10px; }
    .scatter-nav { flex-wrap: wrap; }
    .scatter-nav .note { width: 100%; order: 3; }
    #btnResetZoom { margin-left: 0 !important; }
    .select-input { width: 100%; }
    .search-input-inline { width: 100%; }
    th, td { padding: 8px 6px; font-size: 12px; }
  }

  /* Chart.js tooltip 客製外觀由 canvas 內部繪製處理，此區塊為 fallback（若瀏覽器不支援 external tooltip 就不需要） */

  /* ===== 點擊圖表資料點時滑出的評論抽屜 ===== */
  .drawer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 100;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .drawer-overlay.open {
    opacity: 1;
    pointer-events: auto;
  }
  .review-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 100%);
    background: var(--card);
    border-left: 1px solid var(--border);
    z-index: 101;
    transform: translateX(100%);
    transition: transform 0.25s ease;
    display: flex;
    flex-direction: column;
  }
  .review-drawer.open { transform: translateX(0); }
  .drawer-header {
    padding: 18px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .drawer-header h3 { margin: 0 0 4px; font-size: 15px; }
  .drawer-header .drawer-subtitle { color: var(--muted); font-size: 12px; }
  .drawer-close {
    background: #2a2e38;
    border: none;
    color: var(--text);
    width: 28px;
    height: 28px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    flex-shrink: 0;
  }
  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 20px 20px;
  }
  .drawer-review-item {
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }
  .drawer-review-item:last-child { border-bottom: none; }
  .drawer-review-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .drawer-review-text { font-size: 13px; line-height: 1.6; }

  @media (max-width: 640px) {
    .review-drawer {
      top: auto;
      left: 0;
      right: 0;
      width: auto;
      height: min(75vh, 100%);
      border-left: none;
      border-top: 1px solid var(--border);
      border-radius: 16px 16px 0 0;
      transform: translateY(100%);
    }
    .review-drawer.open { transform: translateY(0); }
  }
</style>
</head>
<body>
  <div class="drawer-overlay" id="drawerOverlay"></div>
  <div class="review-drawer" id="reviewDrawer">
    <div class="drawer-header">
      <div>
        <h3 id="drawerTitle">評論內容</h3>
        <div class="drawer-subtitle" id="drawerSubtitle"></div>
      </div>
      <button class="drawer-close" id="drawerCloseBtn">✕</button>
    </div>
    <div class="drawer-body" id="drawerBody"></div>
  </div>

  <h1>格上 GoSmart 評論追蹤 Dashboard</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="grid" id="summaryCards"></div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="comments">評論</button>
    <button class="tab-btn" data-tab="sentiment">回饋洞察</button>
    <button class="tab-btn" data-tab="version">版本</button>
    <button class="tab-btn" data-tab="ratings">評分</button>
  </div>

  <div class="tab-panel active" id="tab-comments">
    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">每月評論趨勢（每個點代表一則實際評論，滑鼠移到點上可看內容）</h2>
        <div class="toggle-group" id="rangeToggleGroup">
          <button class="toggle-btn" data-range="3">近3個月</button>
          <button class="toggle-btn active" data-range="6">近6個月</button>
          <button class="toggle-btn" data-range="12">近1年</button>
          <button class="toggle-btn" data-range="all">全部</button>
          <button class="toggle-btn" id="btnResetZoom">重置縮放</button>
        </div>
      </div>
      <div class="scatter-nav">
        <span class="note" id="scatterRangeNote" style="margin:0"></span>
      </div>
      <div class="chart-container">
        <canvas id="commentScatterChart" height="110"></canvas>
      </div>
      <div class="note">用上方按鈕控制縮放程度（近3個月／近6個月／近1年／全部）；按住滑鼠左右拖曳（或觸控板左右滑動）來移動檢視區間，查看更早或更晚的資料。</div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">評論清單</h2>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" id="reviewSearchInput" class="search-input-inline" placeholder="搜尋關鍵字...">
          <div class="toggle-group" id="platformToggleGroup">
            <button class="toggle-btn active" data-platform="all">全部</button>
            <button class="toggle-btn" data-platform="android">Android</button>
            <button class="toggle-btn" data-platform="ios">iOS</button>
          </div>
          <div class="toggle-group">
            <button class="toggle-btn active" id="btnShowNegative">近期負評（3星以下）</button>
            <button class="toggle-btn" id="btnShowAll">所有評價</button>
          </div>
        </div>
      </div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th><th>處理進度</th></tr>
        </thead>
        <tbody id="reviewTableBody"></tbody>
      </table>
      </div>
      <div class="note" id="reviewListNote"></div>
      <button class="nav-btn" id="btnLoadMoreReviews" style="margin-top:10px;">載入更多評論</button>
    </div>
  </div>

  <div class="tab-panel" id="tab-ratings">
    <div class="chart-card">
      <h2>每月平均評分趨勢</h2>
      <div class="chart-container">
        <canvas id="trendChart" height="90"></canvas>
      </div>
      <div class="note">iOS 目前僅涵蓋近期資料（App Store 網頁無法回溯完整歷史），Android 已涵蓋完整歷史（如已執行過 android-full-history.js）。</div>
    </div>

    <div class="two-col">
      <div class="chart-card">
        <h2>Google Play 星等分佈</h2>
        <div class="chart-container">
        <canvas id="androidDistChart" height="180"></canvas>
      </div>
      </div>
      <div class="chart-card">
        <h2>App Store 星等分佈</h2>
        <div class="chart-container">
        <canvas id="iosDistChart" height="180"></canvas>
      </div>
      </div>
    </div>
  </div>

  <div class="tab-panel" id="tab-sentiment">
    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">情緒與類別分析（依關鍵字比對，可能一則評論同時符合多個類別）</h2>
        <div class="toggle-group" id="categoryTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="categoryChart" height="100"></canvas>
      </div>
      <div class="note">分類依你提供的分類架構建立（定車相關／取車相關／還車相關／客服／審核／付款／站點與車輛數／停權／基本資料／系統／車輛設備／優惠碼/優惠券／帳號／車損拍照／通知／軟體更新／icon設計／投保／搜尋／更改密碼／共同承租人），皆未符合則歸入「其他」。情緒判斷以星等為代理指標（1-3星負面、4-5星正面）。上方按鈕可切換統計的時間範圍（全部/今年/本月/本週）；點擊長條圖任一區塊，或用下方篩選器，可查看該分類/情緒的實際評論。</div>
      <div class="note" id="otherCategoryNote" style="color:#ffb84d;"></div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">頻率 × 嚴重度矩陣（每個點是一個分類；越靠右代表提到次數越多，越靠下代表平均星等越低）</h2>
        <div class="toggle-group" id="matrixTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="matrixChart" height="110"></canvas>
      </div>
      <div class="note">右下角（高頻率、低星等）是最優先該處理的痛點；左下角則是次數雖少、但每次都很嚴重的「地雷」類別，也值得留意。</div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">意圖分佈（抱怨/bug、功能請求、純稱讚、一般，依關鍵字粗略判斷）</h2>
        <div class="toggle-group" id="intentTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="intentChart" height="90"></canvas>
      </div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">用戶旅程階段檢視</h2>
        <div class="toggle-group" id="stageTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="chart-container">
        <canvas id="stageChart" height="100"></canvas>
      </div>
      <div class="note">依分類對應回使用流程階段：預約前（定車相關/審核）、使用中（取車相關/車輛設備/系統/站點與車輛數/icon設計/搜尋/通知/軟體更新/投保）、結束後（還車相關/付款/車損拍照）、帳號與其他（客服/帳號/更改密碼/共同承租人/優惠碼/停權/基本資料/其他）。</div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">分類細節檢視</h2>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="categorySelect" class="select-input"></select>
          <select id="intentSelect" class="select-input">
            <option value="all">全部意圖</option>
          </select>
          <div class="toggle-group" id="sentimentToggleGroup">
            <button class="toggle-btn active" data-sentiment="all">全部</button>
            <button class="toggle-btn" data-sentiment="positive">正面</button>
            <button class="toggle-btn" data-sentiment="negative">負面</button>
          </div>
        </div>
      </div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th></tr>
        </thead>
        <tbody id="categoryDetailTableBody"></tbody>
      </table>
      </div>
      <div class="note" id="categoryDetailNote"></div>
    </div>
  </div>

  <div class="tab-panel" id="tab-version">
    <div class="chart-card">
      <h2>各版本平均評分與評論數（僅 Google Play，App Store 抓取流程目前未取得版本號）</h2>
      <div class="chart-container">
        <canvas id="versionChart" height="100"></canvas>
      </div>
      <div class="note">若某個版本後評分明顯下滑，通常代表該次改版造成體驗劣化，可以回頭比對該版本的更新內容。滑鼠移到長條上可看該版本的則數與平均星等。</div>
    </div>
  </div>

  <script>
    const dataset = ${dataJson};

    // 註冊縮放/平移外掛（不同版本的 UMD 建置可能掛在不同全域變數名稱下，都嘗試看看）
    const zoomPluginRef = window.ChartZoom || window['chartjs-plugin-zoom'] || window.zoomPlugin;
    if (zoomPluginRef && window.Chart) {
      Chart.register(zoomPluginRef);
    } else {
      console.warn('縮放/平移外掛未成功載入，圖表的滾輪縮放與拖曳平移功能可能無法使用（不影響其他功能）。');
    }

    // ===== 點擊圖表資料點時滑出的評論抽屜 =====
    const drawerOverlay = document.getElementById('drawerOverlay');
    const reviewDrawer = document.getElementById('reviewDrawer');
    const drawerTitle = document.getElementById('drawerTitle');
    const drawerSubtitle = document.getElementById('drawerSubtitle');
    const drawerBody = document.getElementById('drawerBody');

    function renderDrawerReview(r) {
      const platformLabel = r.platform === 'android' ? 'Android' : 'iOS';
      return '<div class="drawer-review-item">' +
        '<div class="drawer-review-meta">' +
          '<span class="badge ' + r.platform + '">' + platformLabel + '</span>' +
          '<span>' + r.date + '</span>' +
          '<span class="' + (r.score <= 3 ? 'score-neg' : 'score-pos') + '">' + r.score + ' ★</span>' +
          (r.version ? '<span>版本 ' + r.version + '</span>' : '') +
        '</div>' +
        (r.title ? '<div class="drawer-review-text"><b>' + r.title + '</b></div>' : '') +
        '<div class="drawer-review-text">' + (r.text || '') + '</div>' +
        (r.userName ? '<div class="review-meta">' + r.userName + '</div>' : '') +
      '</div>';
    }

    function openReviewDrawer(title, subtitle, reviews) {
      drawerTitle.textContent = title;
      drawerSubtitle.textContent = subtitle;
      const sorted = [...reviews].sort((a, b) => b.timestamp - a.timestamp);
      if (sorted.length === 0) {
        drawerBody.innerHTML = '<div style="color:#9aa0ac; padding:20px 0;">這個條件下目前沒有符合的評論。</div>';
      } else {
        drawerBody.innerHTML = sorted.map(renderDrawerReview).join('');
      }
      drawerOverlay.classList.add('open');
      reviewDrawer.classList.add('open');
    }

    function closeReviewDrawer() {
      drawerOverlay.classList.remove('open');
      reviewDrawer.classList.remove('open');
    }

    drawerOverlay.addEventListener('click', closeReviewDrawer);
    document.getElementById('drawerCloseBtn').addEventListener('click', closeReviewDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeReviewDrawer();
    });

    // 各圖表目前選取的時間範圍（點擊資料點時，依這個範圍去撈取對應的評論清單）
    let activeCategoryRange = 'all';
    let activeMatrixRange = 'all';
    let activeIntentRange = 'all';
    let activeStageRange = 'all';


    document.getElementById('subtitle').textContent =
      '資料期間：' + dataset.dateRange.earliest + ' ~ ' + dataset.dateRange.latest +
      '　（產出時間：' + new Date().toLocaleString('zh-TW') + '）' +
      (dataset.hasFullHistory ? '　｜ 已整合 Android 完整歷史資料' : '') +
      (dataset.newReviewsCount.isFirstRun
        ? '　｜ 首次產出，尚無比對基準'
        : '　｜ 與上次產出相比新增 ' + dataset.newReviewsCount.total + ' 則評論');

    const summaryEl = document.getElementById('summaryCards');
    const cards = [
      { label: 'Google Play 累積評論數', value: dataset.androidTotal, cls: 'android', decimals: 0 },
      { label: 'Google Play 平均星等', value: dataset.androidAvgOverall, cls: 'android', decimals: 2 },
      { label: 'Google Play 新評論數', value: dataset.newReviewsCount.android, cls: 'new-count', decimals: 0 },
      { label: 'App Store 累積評論數', value: dataset.iosTotal, cls: 'ios', decimals: 0 },
      { label: 'App Store 平均星等', value: dataset.iosAvgOverall, cls: 'ios', decimals: 2 },
      { label: 'App Store 新評論數', value: dataset.newReviewsCount.ios, cls: 'new-count', decimals: 0 },
    ];
    summaryEl.innerHTML = cards.map(c => {
      const isZeroNewCount = c.cls === 'new-count' && c.value === 0;
      const style = isZeroNewCount ? ' style="opacity:0.2"' : '';
      // 沒有有效數值時（例如尚無評分資料），直接顯示 "-"，不套用計數動畫
      if (c.value === null || c.value === undefined || isNaN(c.value)) {
        return '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + c.cls + '"' + style + '>-</div></div>';
      }
      const initialText = c.decimals > 0 ? (0).toFixed(c.decimals) : '0';
      return '<div class="card"><div class="label">' + c.label + '</div>' +
        '<div class="value ' + c.cls + '"' + style + ' data-count-target="' + c.value + '" data-count-decimals="' + c.decimals + '">' + initialText + '</div></div>';
    }).join('');

    // ===== 頂部卡片數字：滾動進入畫面時，從 0 跑到目標值（只觸發一次） =====
    function animateCountUp(el, target, decimals, duration) {
      const startTime = performance.now();
      function frame(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out（前快後慢）
        const current = target * eased;
        el.textContent = decimals > 0 ? current.toFixed(decimals) : Math.round(current).toLocaleString();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          el.textContent = decimals > 0 ? target.toFixed(decimals) : target.toLocaleString();
        }
      }
      requestAnimationFrame(frame);
    }

    const countTargets = summaryEl.querySelectorAll('[data-count-target]');
    if (countTargets.length > 0 && 'IntersectionObserver' in window) {
      const countObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            countTargets.forEach(el => {
              const target = parseFloat(el.dataset.countTarget);
              const decimals = parseInt(el.dataset.countDecimals, 10) || 0;
              animateCountUp(el, target, decimals, 1600);
            });
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.3 });
      countObserver.observe(summaryEl);
    } else {
      // 瀏覽器不支援 IntersectionObserver 時，直接顯示最終數值，不做動畫
      countTargets.forEach(el => {
        const target = parseFloat(el.dataset.countTarget);
        const decimals = parseInt(el.dataset.countDecimals, 10) || 0;
        el.textContent = decimals > 0 ? target.toFixed(decimals) : target.toLocaleString();
      });
    }

    // ===== Tab 切換 =====
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    // ===== 情緒分析 tab：情緒 × 類別 統計圖 =====
    const sentimentLabelMap = { positive: '正面', neutral: '中性', negative: '負面' };
    const sentimentOrder = ['positive', 'neutral', 'negative'];

    document.getElementById('otherCategoryNote').textContent =
      '目前有 ' + dataset.otherCount + ' 則評論未命中任何關鍵字、歸類為「其他」，建議定期檢視這個分類，找出尚未涵蓋的新興問題。';

    const categoryChartInstance = new Chart(document.getElementById('categoryChart'), {
      type: 'bar',
      data: {
        labels: dataset.categoryOrder,
        datasets: [
          {
            label: '正面',
            data: dataset.categoryOrder.map(c => dataset.categoryStatsByRange.all[c].positive),
            backgroundColor: '#3ddc84',
            sentimentKey: 'positive',
          },
          {
            label: '負面',
            data: dataset.categoryOrder.map(c => dataset.categoryStatsByRange.all[c].negative),
            backgroundColor: '#ff6b6b',
            sentimentKey: 'negative',
          },
        ],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        scales: {
          x: { stacked: true, ticks: { color: '#9aa0ac' }, grid: { display: false } },
          y: { stacked: true, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
        },
        plugins: { legend: { labels: { color: '#e8e9ed' } } },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const el = elements[0];
          const category = dataset.categoryOrder[el.index];
          const sentimentKey = categoryChartInstance.data.datasets[el.datasetIndex].sentimentKey;
          categorySelect.value = category;
          setSentimentFilter(sentimentKey);
          const sourceList = dataset.reviewsByRange[activeCategoryRange];
          const matched = sourceList.filter(r => r.categories.includes(category) && r.sentiment === sentimentKey);
          openReviewDrawer(
            category,
            sentimentLabelMap[sentimentKey] + '　共 ' + matched.length + ' 則',
            matched
          );
        },
      },
    });

    // ===== 情緒與類別分析：時間範圍切換（全部/今年/本月/本週） =====
    document.querySelectorAll('#categoryTimeRangeToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#categoryTimeRangeToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const range = btn.dataset.timeRange;
        activeCategoryRange = range;
        const stats = dataset.categoryStatsByRange[range];
        categoryChartInstance.data.datasets[0].data = dataset.categoryOrder.map(c => stats[c].positive);
        categoryChartInstance.data.datasets[1].data = dataset.categoryOrder.map(c => stats[c].negative);
        categoryChartInstance.update();
      });
    });

    // ===== 情緒分析 tab：頻率 × 嚴重度矩陣 =====
    function matrixPointColor(avgScore) {
      return avgScore <= 3 ? '#ff6b6b' : '#3ddc84';
    }

    const matrixChartInstance = new Chart(document.getElementById('matrixChart'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: '分類',
          data: dataset.categoryMatrixByRange.all.map(m => ({ x: m.count, y: m.avgScore, category: m.category })),
          backgroundColor: dataset.categoryMatrixByRange.all.map(m => matrixPointColor(m.avgScore)),
          pointRadius: 7,
          pointHoverRadius: 9,
        }],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: { title: { display: true, text: '被提及次數', color: '#9aa0ac' }, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
          y: { min: 0.5, max: 5.5, title: { display: true, text: '平均星等', color: '#9aa0ac' }, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: () => '',
              label: (ctx) => ctx.raw.category + '　' + ctx.raw.x + ' 則　平均 ' + ctx.raw.y.toFixed(2) + ' ★',
            },
            backgroundColor: '#1f232c', borderColor: '#2a2e38', borderWidth: 1, titleColor: '#e8e9ed', bodyColor: '#e8e9ed', padding: 10,
          },
        },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const point = matrixChartInstance.data.datasets[0].data[elements[0].index];
          categorySelect.value = point.category;
          setSentimentFilter('all');
          const sourceList = dataset.reviewsByRange[activeMatrixRange];
          const matched = sourceList.filter(r => r.categories.includes(point.category));
          openReviewDrawer(
            point.category,
            '共 ' + matched.length + ' 則　平均 ' + point.y.toFixed(2) + ' ★',
            matched
          );
        },
      },
    });

    document.querySelectorAll('#matrixTimeRangeToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#matrixTimeRangeToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeMatrixRange = btn.dataset.timeRange;
        const matrix = dataset.categoryMatrixByRange[activeMatrixRange];
        matrixChartInstance.data.datasets[0].data = matrix.map(m => ({ x: m.count, y: m.avgScore, category: m.category }));
        matrixChartInstance.data.datasets[0].backgroundColor = matrix.map(m => matrixPointColor(m.avgScore));
        matrixChartInstance.update();
      });
    });

    // ===== 情緒分析 tab：意圖分佈 =====
    const intentChartInstance = new Chart(document.getElementById('intentChart'), {
      type: 'bar',
      data: {
        labels: dataset.intentOrder,
        datasets: [{
          data: dataset.intentOrder.map(k => dataset.intentStatsByRange.all[k] || 0),
          backgroundColor: ['#ff6b6b', '#7c9fff', '#3ddc84', '#5b6272'],
        }],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
          y: { ticks: { color: '#9aa0ac' }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const intentKey = dataset.intentOrder[elements[0].index];
          const sourceList = dataset.reviewsByRange[activeIntentRange];
          const matched = sourceList.filter(r => r.intent === intentKey);
          openReviewDrawer(intentKey, '共 ' + matched.length + ' 則', matched);
        },
      },
    });

    document.querySelectorAll('#intentTimeRangeToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#intentTimeRangeToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeIntentRange = btn.dataset.timeRange;
        const stats = dataset.intentStatsByRange[activeIntentRange];
        intentChartInstance.data.datasets[0].data = dataset.intentOrder.map(k => stats[k] || 0);
        intentChartInstance.update();
      });
    });

    // ===== 情緒分析 tab：用戶旅程階段檢視 =====
    const stageChartInstance = new Chart(document.getElementById('stageChart'), {
      type: 'bar',
      data: {
        labels: dataset.stageOrder,
        datasets: [
          { label: '正面', data: dataset.stageOrder.map(s => dataset.stageStatsByRange.all[s].positive), backgroundColor: '#3ddc84', sentimentKey: 'positive' },
          { label: '負面', data: dataset.stageOrder.map(s => dataset.stageStatsByRange.all[s].negative), backgroundColor: '#ff6b6b', sentimentKey: 'negative' },
        ],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        scales: {
          x: { stacked: true, ticks: { color: '#9aa0ac' }, grid: { display: false } },
          y: { stacked: true, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
        },
        plugins: { legend: { labels: { color: '#e8e9ed' } } },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const el = elements[0];
          const stage = dataset.stageOrder[el.index];
          const sentimentKey = stageChartInstance.data.datasets[el.datasetIndex].sentimentKey;
          const sourceList = dataset.reviewsByRange[activeStageRange];
          const matched = sourceList.filter(r => r.stages.includes(stage) && r.sentiment === sentimentKey);
          openReviewDrawer(stage, sentimentLabelMap[sentimentKey] + '　共 ' + matched.length + ' 則', matched);
        },
      },
    });

    document.querySelectorAll('#stageTimeRangeToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#stageTimeRangeToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeStageRange = btn.dataset.timeRange;
        const stats = dataset.stageStatsByRange[activeStageRange];
        stageChartInstance.data.datasets[0].data = dataset.stageOrder.map(s => stats[s].positive);
        stageChartInstance.data.datasets[1].data = dataset.stageOrder.map(s => stats[s].negative);
        stageChartInstance.update();
      });
    });


    // ===== 情緒分析 tab：版本圖（放在「版本」tab） =====
    if (dataset.versionStats.length > 0) {
      new Chart(document.getElementById('versionChart'), {
        type: 'bar',
        data: {
          labels: dataset.versionStats.map(v => v.version),
          datasets: [
            {
              type: 'line',
              label: '平均星等',
              data: dataset.versionStats.map(v => v.avgScore),
              borderColor: '#7c9fff',
              backgroundColor: 'rgba(124,159,255,0.1)',
              yAxisID: 'y1',
              tension: 0.3,
            },
            {
              type: 'bar',
              label: '評論則數',
              data: dataset.versionStats.map(v => v.count),
              backgroundColor: 'rgba(61,220,132,0.5)',
              yAxisID: 'y',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { ticks: { color: '#9aa0ac', maxRotation: 60, minRotation: 45 }, grid: { display: false } },
            y: { position: 'left', title: { display: true, text: '則數', color: '#9aa0ac' }, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
            y1: { position: 'right', min: 0, max: 5, title: { display: true, text: '平均星等', color: '#9aa0ac' }, ticks: { color: '#9aa0ac' }, grid: { display: false } },
          },
          plugins: { legend: { labels: { color: '#e8e9ed' } } },
          onClick: (evt, elements) => {
            if (!elements.length) return;
            const version = dataset.versionStats[elements[0].index].version;
            const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === version);
            openReviewDrawer('版本 ' + version, '共 ' + matched.length + ' 則', matched);
          },
        },
      });
    } else {
      document.getElementById('versionChart').replaceWith(
        Object.assign(document.createElement('div'), { className: 'note', textContent: '目前沒有可用的版本資料。' })
      );
    }

    // ===== 情緒分析 tab：分類細節檢視 =====
    const categorySelect = document.getElementById('categorySelect');
    categorySelect.innerHTML = dataset.categoryOrder.map(c => '<option value="' + c + '">' + c + '</option>').join('');

    const intentSelect = document.getElementById('intentSelect');
    dataset.intentOrder.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      intentSelect.appendChild(opt);
    });

    let currentDetailSentiment = 'all';

    function setSentimentFilter(key) {
      currentDetailSentiment = key;
      document.querySelectorAll('#sentimentToggleGroup .toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.sentiment === key);
      });
      renderCategoryDetail();
    }

    function renderCategoryDetail() {
      const category = categorySelect.value;
      const intentFilter = intentSelect.value;
      let list = dataset.allReviewsFlat.filter(r => r.categories.includes(category));
      if (currentDetailSentiment !== 'all') {
        list = list.filter(r => r.sentiment === currentDetailSentiment);
      }
      if (intentFilter !== 'all') {
        list = list.filter(r => r.intent === intentFilter);
      }
      list = [...list].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

      const tbody = document.getElementById('categoryDetailTableBody');
      const noteEl = document.getElementById('categoryDetailNote');

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:#9aa0ac">目前沒有符合條件的評論</td></tr>';
      } else {
        tbody.innerHTML = list.map(r => \`
          <tr>
            <td><span class="badge \${r.platform}">\${r.platform === 'android' ? 'Android' : 'iOS'}</span></td>
            <td>\${r.date}</td>
            <td class="\${r.score <= 3 ? 'score-neg' : 'score-pos'}">\${r.score} ★</td>
            <td>
              \${r.title ? '<div class="review-text"><b>' + r.title + '</b></div>' : ''}
              <div class="review-text">\${(r.text || '').slice(0, 200)}</div>
              <div class="review-meta">\${r.userName || ''}\${r.version ? '　版本 ' + r.version : ''}</div>
            </td>
          </tr>
        \`).join('');
      }
      noteEl.textContent = '「' + category + '」分類，最多顯示 50 則（依日期排序）。';
    }

    categorySelect.addEventListener('change', renderCategoryDetail);
    intentSelect.addEventListener('change', renderCategoryDetail);
    document.querySelectorAll('#sentimentToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => setSentimentFilter(btn.dataset.sentiment));
    });

    renderCategoryDetail();

    // ===== 評論 tab：散佈圖（每個點 = 一則評論） =====
    const monthKeys = dataset.monthKeys;
    function monthToIndex(m) {
      const idx = monthKeys.indexOf(m);
      return idx === -1 ? 0 : idx;
    }

    function buildScatterPoints(platform, minIndex, maxIndex) {
      const list = dataset.allReviewsFlat.filter(r => {
        if (r.month === null || r.month === undefined) return false; // 沒有日期的手動補充資料不畫進時間軸圖表
        if (!monthKeys.includes(r.month)) return false; // 日期落在目前資料範圍之外（例如手動補充資料早於爬蟲涵蓋期間），同樣跳過避免誤判成第一個月
        const idx = monthToIndex(r.month);
        return r.platform === platform && idx >= minIndex && idx <= maxIndex;
      });
      // 同月份多筆評論加上小幅隨機水平偏移，避免點完全疊在一起
      const jitterMap = {};
      return list.map(r => {
        const baseX = monthToIndex(r.month);
        jitterMap[r.month] = (jitterMap[r.month] || 0) + 1;
        const jitter = ((jitterMap[r.month] % 9) - 4) * 0.05;
        return {
          x: baseX + jitter,
          y: r.score,
          review: r,
        };
      });
    }

    const scatterTooltipCallback = {
      title: () => '',
      label: (ctx) => {
        const r = ctx.raw.review;
        const platformLabel = r.platform === 'android' ? 'Google Play' : 'App Store';
        const lines = [
          platformLabel + '　' + r.date + '　' + r.score + ' ★',
        ];
        if (r.title) lines.push('「' + r.title + '」');
        const text = (r.text || '').slice(0, 120);
        // 每 24 字斷行，避免資訊泡泡單行過長
        for (let i = 0; i < text.length; i += 24) {
          lines.push(text.slice(i, i + 24));
        }
        if (r.userName) lines.push('— ' + r.userName);
        return lines;
      },
    };

    let scatterChart = null;
    let currentWindowSize = 6; // 月數，或 'all'
    let currentWindowStart = 0;

    function clampWindowStart(size, start) {
      if (size === 'all') return 0;
      const maxStart = Math.max(0, monthKeys.length - size);
      return Math.min(Math.max(0, start), maxStart);
    }

    function renderScatterChart() {
      const size = currentWindowSize;
      const minIndex = size === 'all' ? 0 : clampWindowStart(size, currentWindowStart);
      const maxIndex = size === 'all' ? monthKeys.length - 1 : Math.min(minIndex + size - 1, monthKeys.length - 1);

      const androidPoints = buildScatterPoints('android', minIndex, maxIndex);
      const iosPoints = buildScatterPoints('ios', minIndex, maxIndex);
      const totalPoints = androidPoints.length + iosPoints.length;

      // 點越多，畫面越擁擠 → 自動縮小點的大小與不透明度，減少視覺混亂
      let pointRadius = 4, pointAlpha = 0.75;
      if (totalPoints > 400) { pointRadius = 2; pointAlpha = 0.45; }
      else if (totalPoints > 150) { pointRadius = 3; pointAlpha = 0.6; }

      const noteEl = document.getElementById('scatterRangeNote');
      const rangeLabel = size === 'all' ? '全部期間' : (monthKeys[minIndex] + ' ~ ' + monthKeys[maxIndex]);
      noteEl.textContent = '目前顯示 ' + totalPoints + ' 則評論（' + rangeLabel + '）';

      if (scatterChart) {
        scatterChart.destroy();
      }

      scatterChart = new Chart(document.getElementById('commentScatterChart'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Google Play',
              data: androidPoints,
              backgroundColor: 'rgba(61,220,132,' + pointAlpha + ')',
              pointRadius,
              pointHoverRadius: pointRadius + 3,
            },
            {
              label: 'App Store',
              data: iosPoints,
              backgroundColor: 'rgba(124,159,255,' + (pointAlpha + 0.05) + ')',
              pointRadius,
              pointHoverRadius: pointRadius + 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          scales: {
            y: {
              min: 0.5, max: 5.5,
              ticks: { color: '#9aa0ac', stepSize: 1 },
              grid: { color: '#2a2e38' },
              title: { display: true, text: '星等', color: '#9aa0ac' },
            },
            x: {
              min: minIndex - 0.5,
              max: maxIndex + 0.5,
              ticks: {
                color: '#9aa0ac',
                stepSize: 1,
                maxRotation: 60,
                minRotation: 45,
                callback: (val) => monthKeys[Math.round(val)] || '',
              },
              grid: { color: '#2a2e38' },
            },
          },
          plugins: {
            legend: { labels: { color: '#e8e9ed' } },
            tooltip: {
              callbacks: scatterTooltipCallback,
              backgroundColor: '#1f232c',
              borderColor: '#2a2e38',
              borderWidth: 1,
              titleColor: '#e8e9ed',
              bodyColor: '#e8e9ed',
              padding: 10,
            },
            zoom: {
              pan: { enabled: true, mode: 'x' },
              zoom: {
                wheel: { enabled: false },
                pinch: { enabled: false },
                mode: 'x',
              },
              limits: {
                // 邊界固定為「全部月份」的範圍，不能跟目前視窗一樣，
                // 否則拖曳/縮放會完全動不了（這是先前版本的臭蟲）。
                x: { min: -0.5, max: monthKeys.length - 0.5 },
              },
            },
          },
        },
      });
    }

    document.querySelectorAll('#rangeToggleGroup .toggle-btn[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#rangeToggleGroup .toggle-btn[data-range]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentWindowSize = btn.dataset.range === 'all' ? 'all' : Number(btn.dataset.range);
        currentWindowStart = currentWindowSize === 'all' ? 0 : Math.max(0, monthKeys.length - currentWindowSize);
        renderScatterChart();
      });
    });

    document.getElementById('btnResetZoom').addEventListener('click', () => {
      if (scatterChart && scatterChart.resetZoom) scatterChart.resetZoom();
    });

    currentWindowStart = Math.max(0, monthKeys.length - currentWindowSize);
    renderScatterChart(); // 預設顯示近 6 個月

    // ===== 評論 tab：清單（負評 / 全部 切換 + 平台篩選 + 分頁載入 + 處理進度標籤） =====
    const tbody = document.getElementById('reviewTableBody');
    const noteEl = document.getElementById('reviewListNote');
    const btnNegative = document.getElementById('btnShowNegative');
    const btnAll = document.getElementById('btnShowAll');
    const searchInput = document.getElementById('reviewSearchInput');
    const btnLoadMore = document.getElementById('btnLoadMoreReviews');

    let currentReviewMode = 'negative';
    let currentPlatform = 'all';
    let visibleCount = 30;
    const PAGE_SIZE = 30;

    // ===== 處理進度標籤：存在瀏覽器的 localStorage 裡（只存在這台電腦/這個瀏覽器，不會同步給其他人） =====
    const STATUS_OPTIONS = ['尚未處理', '處理中', '已解決', '已回報', '不處理'];
    const STATUS_COLORS = {
      '尚未處理': { bg: '#3a3d45', text: '#e8e9ed' },
      '處理中': { bg: '#4a3d1f', text: '#ffc966' },
      '已解決': { bg: '#1f4a34', text: '#4ade8f' },
      '已回報': { bg: '#2a3a52', text: '#7fb0ff' },
      '不處理': { bg: '#2a2e38', text: '#7a7f8a' },
    };
    const STATUS_STORAGE_PREFIX = 'gosmart-review-status:';

    function applyStatusColor(selectEl, value) {
      const c = STATUS_COLORS[value] || STATUS_COLORS[STATUS_OPTIONS[0]];
      selectEl.style.backgroundColor = c.bg;
      selectEl.style.color = c.text;
      selectEl.style.borderColor = c.bg;
    }

    function getReviewStatus(key) {
      try {
        return localStorage.getItem(STATUS_STORAGE_PREFIX + key) || STATUS_OPTIONS[0];
      } catch (e) {
        return STATUS_OPTIONS[0];
      }
    }

    function setReviewStatus(key, value) {
      try {
        localStorage.setItem(STATUS_STORAGE_PREFIX + key, value);
      } catch (e) {
        // 瀏覽器不支援或被封鎖時，靜默失敗即可，不影響其他功能
      }
    }

    function renderReviewTable() {
      let sortedDesc = [...dataset.allReviewsFlat].sort((a, b) => b.timestamp - a.timestamp);

      if (currentPlatform !== 'all') {
        sortedDesc = sortedDesc.filter(r => r.platform === currentPlatform);
      }

      const platformLabel = currentPlatform === 'all' ? '' : (currentPlatform === 'android' ? '（僅 Android）' : '（僅 iOS）');

      if (currentReviewMode === 'negative') {
        sortedDesc = sortedDesc.filter(r => r.score <= 3);
      }

      const keyword = searchInput.value.trim().toLowerCase();
      if (keyword) {
        sortedDesc = sortedDesc.filter(r => {
          const haystack = ((r.title || '') + ' ' + (r.text || '') + ' ' + (r.userName || '')).toLowerCase();
          return haystack.includes(keyword);
        });
      }

      const total = sortedDesc.length;
      const list = sortedDesc.slice(0, visibleCount);

      let note;
      if (keyword) {
        note = '搜尋「' + searchInput.value.trim() + '」，符合 ' + total + ' 則' + platformLabel + '，目前顯示 ' + list.length + ' 則。';
      } else if (currentReviewMode === 'negative') {
        note = '3 星以下的評論' + platformLabel + '，共 ' + total + ' 則，目前顯示 ' + list.length + ' 則。';
      } else {
        note = '所有評價' + platformLabel + '，共 ' + total + ' 則，目前顯示 ' + list.length + ' 則。';
      }

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#9aa0ac">目前沒有符合條件的評論</td></tr>';
      } else {
        tbody.innerHTML = list.map(r => \`
          <tr>
            <td><span class="badge \${r.platform}">\${r.platform === 'android' ? 'Android' : 'iOS'}</span></td>
            <td>\${r.date}</td>
            <td class="\${r.score <= 3 ? 'score-neg' : 'score-pos'}">\${r.score} ★</td>
            <td>
              \${r.title ? '<div class="review-text"><b>' + r.title + '</b></div>' : ''}
              <div class="review-text">\${(r.text || '').slice(0, 200)}</div>
              <div class="review-meta">\${r.userName || ''}</div>
            </td>
            <td>
              <select class="select-input status-select" data-review-key="\${r.key}">
                \${STATUS_OPTIONS.map(opt => '<option value="' + opt + '"' + (getReviewStatus(r.key) === opt ? ' selected' : '') + '>' + opt + '</option>').join('')}
              </select>
            </td>
          </tr>
        \`).join('');
      }
      noteEl.textContent = note;

      // 依目前選擇的狀態套用對應顏色（每次重建 tbody 後都要重新套用一次）
      tbody.querySelectorAll('.status-select').forEach(sel => {
        applyStatusColor(sel, sel.value);
      });

      if (visibleCount >= total) {
        btnLoadMore.style.display = 'none';
      } else {
        btnLoadMore.style.display = '';
        btnLoadMore.textContent = '載入更多評論（還有 ' + (total - visibleCount) + ' 則）';
      }
    }

    function resetPaginationAndRender() {
      visibleCount = PAGE_SIZE;
      renderReviewTable();
    }

    // 用事件委派監聽狀態下拉選單的變更，因為每次 render 都會整個重建 tbody 內容
    tbody.addEventListener('change', (e) => {
      if (e.target.classList.contains('status-select')) {
        setReviewStatus(e.target.dataset.reviewKey, e.target.value);
        applyStatusColor(e.target, e.target.value);
      }
    });

    btnLoadMore.addEventListener('click', () => {
      visibleCount += PAGE_SIZE;
      renderReviewTable();
    });

    btnNegative.addEventListener('click', () => {
      btnNegative.classList.add('active');
      btnAll.classList.remove('active');
      currentReviewMode = 'negative';
      resetPaginationAndRender();
    });
    btnAll.addEventListener('click', () => {
      btnAll.classList.add('active');
      btnNegative.classList.remove('active');
      currentReviewMode = 'all';
      resetPaginationAndRender();
    });

    document.querySelectorAll('#platformToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#platformToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPlatform = btn.dataset.platform;
        resetPaginationAndRender();
      });
    });

    searchInput.addEventListener('input', resetPaginationAndRender);

    renderReviewTable();

    // ===== 評分 tab：月平均趨勢 + 星等分佈 =====
    new Chart(document.getElementById('trendChart'), {
      type: 'line',
      data: {
        labels: dataset.monthlyStats.map(d => d.month),
        datasets: [
          {
            label: 'Google Play 平均星等',
            data: dataset.monthlyStats.map(d => d.androidAvg),
            borderColor: '#3ddc84',
            backgroundColor: 'rgba(61,220,132,0.1)',
            tension: 0.3,
            spanGaps: true,
          },
          {
            label: 'App Store 平均星等',
            data: dataset.monthlyStats.map(d => d.iosAvg),
            borderColor: '#7c9fff',
            backgroundColor: 'rgba(124,159,255,0.1)',
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 5, ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
          x: { ticks: { color: '#9aa0ac', maxRotation: 60, minRotation: 45 }, grid: { color: '#2a2e38' } },
        },
        plugins: { legend: { labels: { color: '#e8e9ed' } } },
      },
    });

    function distChart(canvasId, dist, color) {
      new Chart(document.getElementById(canvasId), {
        type: 'bar',
        data: {
          labels: ['1星', '2星', '3星', '4星', '5星'],
          datasets: [{
            data: [dist[1], dist[2], dist[3], dist[4], dist[5]],
            backgroundColor: color,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
            x: { ticks: { color: '#9aa0ac' }, grid: { display: false } },
          },
          plugins: { legend: { display: false } },
        },
      });
    }
    distChart('androidDistChart', dataset.androidDist, '#3ddc84');
    distChart('iosDistChart', dataset.iosDist, '#7c9fff');
  </script>
</body>
</html>`;
}

const SNAPSHOT_FILE = path.join(DATA_DIR, 'dashboard-snapshot.json');

function loadPreviousSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    return new Set(raw.keys || []);
  } catch (e) {
    return null;
  }
}

function saveSnapshot(keys) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), keys }, null, 2), 'utf-8');
}

function main() {
  const dailyRuns = loadDailyRuns();
  const fullHistory = loadFullHistory();
  const manualReviews = loadManualReviews();

  if (dailyRuns.length === 0 && fullHistory.length === 0 && manualReviews.length === 0) {
    console.error('沒有任何資料可以產生報表，請先跑過 scheduled-scrape.js 或 android-full-history.js。');
    process.exit(1);
  }

  const dataset = buildDataset(dailyRuns, fullHistory, manualReviews);

  // ===== 跟上一次產出報表時的快照比對，找出這次新增的評論 =====
  const previousKeys = loadPreviousSnapshot();
  const currentKeys = dataset.allReviewsFlat.map((r) => r.key);
  const isFirstRun = previousKeys === null;

  let newReviews = [];
  if (!isFirstRun) {
    newReviews = dataset.allReviewsFlat.filter((r) => !previousKeys.has(r.key));
  }
  dataset.newReviewsCount = {
    android: newReviews.filter((r) => r.platform === 'android').length,
    ios: newReviews.filter((r) => r.platform === 'ios').length,
    total: newReviews.length,
    isFirstRun,
  };
  dataset.newReviewsSample = [...newReviews].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

  saveSnapshot(currentKeys);

  const html = renderHtml(dataset);
  fs.writeFileSync(OUT_FILE, html, 'utf-8');
  console.log(`Dashboard 已產出：${OUT_FILE}`);
  console.log(
    `資料範圍 ${dataset.dateRange.earliest} ~ ${dataset.dateRange.latest}，Google Play 累積 ${dataset.androidTotal} 則、App Store 累積 ${dataset.iosTotal} 則`
  );
  if (isFirstRun) {
    console.log('提示：這是第一次產出報表，已建立比對快照，下次執行時就能顯示新增的評論。');
  } else {
    console.log(`與上次產出報表相比：新增 ${dataset.newReviewsCount.total} 則評論（Google Play ${dataset.newReviewsCount.android}、App Store ${dataset.newReviewsCount.ios}）`);
  }
  if (!fullHistory.length) {
    console.log('提示：尚未偵測到 data/android-full-history.json，目前 Android 趨勢僅包含每日排程累積的資料。');
  }
}

main();
