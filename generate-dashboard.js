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
  //
  // 去重：手動資料跟爬蟲資料可能觀察到同一則評論（例如評論當時還留在商店上，剛好被爬蟲也抓到）。
  // 用「去除空白後的文字內容 + 平台」比對，跟已經爬到的資料完全相同的手動項目會被自動排除，
  // 避免同一則評論被算兩次。
  function normalizeForDedup(t) {
    return (t || '').replace(/\s+/g, '').trim();
  }
  const scrapedTextsByPlatform = {
    android: new Set(allReviewsFlat.filter((r) => r.platform === 'android').map((r) => normalizeForDedup(r.text))),
    ios: new Set(allReviewsFlat.filter((r) => r.platform === 'ios').map((r) => normalizeForDedup(r.text))),
  };
  const manualDedupSkipped = [];
  const manualReviewsDeduped = manualReviews.filter((r) => {
    const norm = normalizeForDedup(r.text);
    const isDupe = norm && scrapedTextsByPlatform[r.platform] && scrapedTextsByPlatform[r.platform].has(norm);
    if (isDupe) manualDedupSkipped.push(r);
    return !isDupe;
  });
  if (manualDedupSkipped.length > 0) {
    console.log(
      `提示：手動補充資料中有 ${manualDedupSkipped.length} 則跟爬蟲資料文字內容完全相同，已自動排除避免重複計算（${manualDedupSkipped
        .map((r) => r.id)
        .join(', ')}）。`
    );
  }

  const manualFlat = manualReviewsDeduped.map((r, idx) => {
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
      if (!versionMap.has(r.version)) versionMap.set(r.version, { scores: [], latestTimestamp: 0, reviews: [] });
      const v = versionMap.get(r.version);
      v.scores.push(r.score);
      v.latestTimestamp = Math.max(v.latestTimestamp, r.timestamp);
      v.reviews.push(r);
    });
  const versionStats = Array.from(versionMap.entries())
    .map(([version, v]) => ({
      version,
      count: v.scores.length,
      avgScore: v.scores.reduce((a, b) => a + b, 0) / v.scores.length,
      latestTimestamp: v.latestTimestamp,
      reviews: v.reviews,
    }))
    .sort((a, b) => a.latestTimestamp - b.latestTimestamp);

  // ===== 自動摘要（一）：版本異常警告 =====
  // 規則式偵測，不是語意理解：比對「這個版本」跟「上一個版本」的平均星等落差，
  // 落差夠大（>= 0.6 星）且這個版本至少有 3 則評論才視為有意義的訊號，
  // 同時列出這個版本裡最常見的負評分類，當作「疑似原因」的提示。
  const VERSION_MIN_COUNT = 3;
  const VERSION_DROP_THRESHOLD = 0.6;
  const versionAnalysis = versionStats
    .filter((v) => v.count >= VERSION_MIN_COUNT)
    .map((v, idx, arr) => {
      const prev = idx > 0 ? arr[idx - 1] : null;
      const scoreDrop = prev ? prev.avgScore - v.avgScore : null;
      const negativeReviews = v.reviews.filter((r) => r.sentiment === 'negative');
      const catCount = {};
      negativeReviews.forEach((r) => {
        r.categories.forEach((c) => {
          if (c === OTHER_CATEGORY) return;
          catCount[c] = (catCount[c] || 0) + 1;
        });
      });
      const topCats = Object.entries(catCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([cat, n]) => `${cat}（${n}則）`);
      return {
        version: v.version,
        prevVersion: prev ? prev.version : null,
        prevAvgScore: prev ? prev.avgScore : null,
        count: v.count,
        avgScore: v.avgScore,
        negativeCount: negativeReviews.length,
        negativeRatio: negativeReviews.length / v.count,
        scoreDrop,
        isRegression: prev !== null && scoreDrop !== null && scoreDrop >= VERSION_DROP_THRESHOLD,
        topCats,
      };
    });
  const versionRegressions = versionAnalysis.filter((v) => v.isRegression).sort((a, b) => b.scoreDrop - a.scoreDrop);

  // ===== 自動摘要（二）：歷史高頻痛點 Top 5 =====
  // 依「負評則數」排序（不是總則數），因為這裡要找的是「造成用戶不滿的沉疴」，
  // 「其他」分類本身不夠具體、不列入排行，但保留在資料裡供你自行查閱。
  const topPainPoints = CATEGORY_ORDER.filter((c) => c !== OTHER_CATEGORY)
    .map((cat) => ({
      category: cat,
      negativeCount: categoryStats[cat].negative,
      totalCount: categoryStats[cat].count,
      avgScore: categoryStats[cat].count > 0 ? categoryStats[cat].scoreSum / categoryStats[cat].count : null,
    }))
    .filter((c) => c.negativeCount > 0)
    .sort((a, b) => b.negativeCount - a.negativeCount);
  const topPainPoints16 = topPainPoints.slice(0, 16); // 展開「歷史高頻痛點詳情」時列出更多筆數用
  const topPainPointsTop5 = topPainPoints.slice(0, 5); // 洞察卡片跟精簡長條圖維持 Top 5

  // ===== 自動摘要（三）：突發趨勢變化（本月 vs 上月，找出負評明顯增加的分類） =====
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const lastMonthEnd = monthStart; // 上個月的區間是 [lastMonthStart, monthStart)
  const reviewsLastMonth = allReviewsFlatWithManual.filter(
    (r) => r.timestamp >= lastMonthStart && r.timestamp < lastMonthEnd
  );
  const lastMonthCategoryStats = computeCategoryStats(reviewsLastMonth);

  // 近 6 個日曆月的月份清單（不管有沒有資料都佔一格，供迷你走勢線使用）
  function lastNCalendarMonths(n) {
    const arr = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      arr.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return arr;
  }
  const recentMonths6 = lastNCalendarMonths(6);

  const trendChanges = CATEGORY_ORDER.filter((c) => c !== OTHER_CATEGORY)
    .map((cat) => {
      const thisMonthNeg = categoryStatsByRange.month[cat].negative;
      const lastMonthNeg = lastMonthCategoryStats[cat].negative;
      const sparkline = recentMonths6.map(
        (mk) => allReviewsFlatWithManual.filter((r) => r.month === mk && r.sentiment === 'negative' && r.categories.includes(cat)).length
      );
      return {
        category: cat,
        thisMonthNeg,
        lastMonthNeg,
        delta: thisMonthNeg - lastMonthNeg,
        sparkline,
      };
    })
    .filter((c) => c.delta > 0 && c.thisMonthNeg >= 2) // 至少要有 2 則才算有意義的訊號，避免 1 則的雜訊被誤判成趨勢
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);

  // ===== 字詞出現頻率排行（評論 tab 用）=====
  // 中文沒有空格分詞，免費資源下用「雙字詞」(bigram) + 停用詞過濾來抓有意義的詞彙，
  // 不是真正的斷詞演算法，準確度有限但不需要額外套件。
  const SINGLE_CHAR_STOPWORDS = new Set(
    '的了我你他她它們是就都也很太更再才呢吧嗎啊喔啦個那這之於並及或不沒有在到對為被把讓用跟和給從向以等還又要會可能就算但而且所以因為如果雖然這那些哪什怎麼樣子啦嘛耶喔唷阿'.split('')
  );
  const PHRASE_STOPWORDS = new Set([
    '一個', '一下', '一直', '現在', '已經', '還是', '什麼', '怎麼', '這樣', '那樣',
    '這個', '那個', '這些', '那些', '我們', '你們', '他們', '自己', '真的', '非常',
    '可以', '因為', '但是', '而且', '所以', '之後', '之前', '沒有', '沒辦法', '不會',
    '不能', '不是', '就是', '還有', '而已', '結果', '然後', '如果', '雖然', '雖說',
  ]);

  function extractWordFrequency(reviews) {
    const freq = new Map();
    reviews.forEach((r) => {
      const text = r.text || '';
      const segments = text.match(/[\u4e00-\u9fa5]+/g) || [];
      segments.forEach((seg) => {
        for (let i = 0; i < seg.length - 1; i++) {
          const bigram = seg.slice(i, i + 2);
          if (PHRASE_STOPWORDS.has(bigram)) continue;
          if (SINGLE_CHAR_STOPWORDS.has(bigram[0]) || SINGLE_CHAR_STOPWORDS.has(bigram[1])) continue;
          freq.set(bigram, (freq.get(bigram) || 0) + 1);
        }
      });
    });
    return Array.from(freq.entries())
      .map(([word, count]) => ({ word, count }))
      .filter((w) => w.count >= 2) // 只出現 1 次的字詞雜訊太多，過濾掉
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }
  const wordFrequency = extractWordFrequency(allReviewsFlatWithManual);

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
    actualAndroidTotal: allReviewsFlatWithManual.filter((r) => r.platform === 'android').length, // 含手動補充資料的真實總數
    actualIosTotal: allReviewsFlatWithManual.filter((r) => r.platform === 'ios').length, // 含手動補充資料的真實總數
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
    versionStats: versionStats.map(({ reviews, ...rest }) => rest), // 前端圖表用，不含完整評論陣列避免檔案過大
    otherCount,
    dateRange: overallRange(),
    hasFullHistory: fullHistory.length > 0,
    versionAnalysis: versionAnalysis.map(({ ...rest }) => rest),
    versionRegressions,
    topPainPoints: topPainPointsTop5,
    topPainPoints16,
    trendChanges,
    recentMonths6,
    wordFrequency,
  };
}

function renderHtml(dataset) {
  const dataJson = JSON.stringify(dataset);

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>阿葛格 評論追蹤 Dashboard</title>
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
    --android: #c6f24e;
    --ios: #FF9500;
    --neg: #ff6b6b;
  }
  * { box-sizing: border-box; }
  html, body {
    overflow-x: hidden; /* 展開/收合動畫過程中，內容可能暫時視覺上超出畫面寬度，這裡確保永遠不會出現左右捲軸 */
    max-width: 100%;
  }
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
    color: #C6F24E;
  }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }
  @media (max-width: 900px) {
    .grid { grid-template-columns: repeat(2, 1fr); }
  }
  .grid.grid-2col { grid-template-columns: repeat(2, 1fr); }
  /* 頂部卡片：不限制每行張數，單純由左至右排列，靠內容自然換行 */
  .grid.grid-flow {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }
  .card {
    background: #C6F24E;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
  }
  .card.card-square {
    aspect-ratio: 1 / 1;
    width: 140px;
    flex-shrink: 0;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .card.card-square .label {
    font-size: 14px;
    margin-bottom: 3px;
    line-height: 1.2;
  }
  .card.card-square .value {
    font-size: 34px;
    line-height: 1.1;
  }
  .card-sub {
    margin-top: 6px;
    line-height: 1.3;
  }
  .card-sub-label {
    font-size: 9px;
    color: #1a1a1a;
    opacity: 0.6;
  }
  .card-sub-value {
    font-size: 11px;
    font-weight: 600;
    color: #1a1a1a;
    opacity: 0.85;
  }
  .card .label { color: #1a1a1a; font-size: 12px; margin-bottom: 6px; opacity: 0.7; }
  .card .value { font-size: 26px; font-weight: 600; color: #1a1a1a; }
  .card .value.android { color: #1a1a1a; }
  .card .value.ios { color: var(--ios); }
  .card .value.new-count { color: #C6F24E; }

  /* App Store 累積評論數／平均星等 卡片：底色改成亮橘色，文字黑色 */
  .card.card-ios-bg {
    background: var(--ios);
  }
  .card.card-ios-bg .label,
  .card.card-ios-bg .value,
  .card.card-ios-bg .value.ios {
    color: #1a1a1a;
  }

  /* 「新評論數」卡片維持深色底（跟每月評論趨勢等圖表卡片一致），
     有新評論時用萊姆綠邊框凸顯，沒有新評論時就是普通深色卡片 */
  .card.new-count-card {
    background: var(--card);
  }
  .card.new-count-card .label { color: var(--muted); opacity: 1; }
  .card.new-count-card .value { color: var(--text); }
  @keyframes blinkBorder {
    0%, 100% { border-color: #C6F24E; }
    50% { border-color: rgba(198,242,78,0.25); }
  }
  .card.new-count-card.has-new {
    border: 2px solid #C6F24E;
    animation: blinkBorder 1.2s ease-in-out infinite;
  }
  .card.new-count-card .value.new-count { color: #C6F24E; }
  @keyframes blinkNumber {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .value.blink-number {
    animation: blinkNumber 1.2s ease-in-out infinite;
  }
  .card.card-clickable {
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .card.card-clickable:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }

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
    color: #C6F24E;
    border-bottom-color: #C6F24E;
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
  .h2-note {
    color: var(--muted);
    font-size: 11px;
    margin-top: -12px;
    margin-bottom: 16px;
  }
  .three-col {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 900px) {
    .three-col { grid-template-columns: 1fr; }
  }
  /* ===== 自動摘要：三個詳情區塊，點擊整張卡片可展開成一整欄、其餘兩欄自動下移。
     用 Flexbox 的 width 百分比做原生 CSS 過渡，而不是硬拉伸再裁切——
     這樣任何時刻卡片寬度都是容器寬度的某個百分比，數學上不會超出範圍。 ===== */
  .detail-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
  }
  .detail-card {
    width: calc(33.333% - 13.34px);
    transition: width 0.35s ease;
    flex-shrink: 0;
  }
  .detail-grid.expanded-version #versionDetailCard { width: 100%; order: -1; }
  .detail-grid.expanded-version #painDetailCard,
  .detail-grid.expanded-version #trendDetailCard { width: calc(50% - 10px); }

  .detail-grid.expanded-pain #painDetailCard { width: 100%; order: -1; }
  .detail-grid.expanded-pain #versionDetailCard,
  .detail-grid.expanded-pain #trendDetailCard { width: calc(50% - 10px); }

  .detail-grid.expanded-trend #trendDetailCard { width: 100%; order: -1; }
  .detail-grid.expanded-trend #versionDetailCard,
  .detail-grid.expanded-trend #painDetailCard { width: calc(50% - 10px); }

  @media (max-width: 900px) {
    .detail-grid .detail-card { width: 100% !important; }
  }
  .detail-card {
    cursor: pointer;
    user-select: none;
    transition: box-shadow 0.2s ease, border-color 0.2s ease;
  }
  .detail-card.is-first { order: -1; }
  .detail-card:hover {
    border-color: #454b58;
    box-shadow: 0 0 24px rgba(198, 242, 78, 0.15);
  }
  .detail-card:hover h2 { color: #C6F24E; transition: color 0.2s ease; }
  .detail-card table,
  .detail-card tr.clickable-row {
    cursor: pointer;
  }

  /* ===== 回饋洞察：四個區塊，點擊整張卡片可展開成一整欄、其餘三欄自動下移。
     同樣用 Flexbox 的 width 百分比做原生 CSS 過渡，避免超出範圍。 ===== */
  .insight-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
  }
  .insight-card {
    width: calc(25% - 15px);
    transition: width 0.35s ease;
    flex-shrink: 0;
  }
  .insight-grid.expanded-category #categoryInsightCard { width: 100%; }
  .insight-grid.expanded-category #stageInsightCard,
  .insight-grid.expanded-category #matrixInsightCard,
  .insight-grid.expanded-category #intentInsightCard { width: calc(33.333% - 13.34px); }

  .insight-grid.expanded-stage #stageInsightCard { width: 100%; }
  .insight-grid.expanded-stage #categoryInsightCard,
  .insight-grid.expanded-stage #matrixInsightCard,
  .insight-grid.expanded-stage #intentInsightCard { width: calc(33.333% - 13.34px); }

  .insight-grid.expanded-matrix #matrixInsightCard { width: 100%; }
  .insight-grid.expanded-matrix #categoryInsightCard,
  .insight-grid.expanded-matrix #stageInsightCard,
  .insight-grid.expanded-matrix #intentInsightCard { width: calc(33.333% - 13.34px); }

  .insight-grid.expanded-intent #intentInsightCard { width: 100%; }
  .insight-grid.expanded-intent #categoryInsightCard,
  .insight-grid.expanded-intent #stageInsightCard,
  .insight-grid.expanded-intent #matrixInsightCard { width: calc(33.333% - 13.34px); }

  @media (max-width: 900px) {
    .insight-grid .insight-card { width: 100% !important; }
  }
  .insight-card {
    cursor: pointer;
    user-select: none;
    transition: box-shadow 0.2s ease, border-color 0.2s ease;
  }
  .insight-card.is-first { order: -1; }
  .insight-card:hover {
    border-color: #454b58;
    box-shadow: 0 0 24px rgba(198, 242, 78, 0.15);
  }
  .insight-card:hover h2 { color: #C6F24E; transition: color 0.2s ease; }

  /* 說明文字（列點式）預設隱藏，只有該區塊展開時才顯示，避免收合狀態下版面被說明文字撐開 */
  .expand-only-note { display: none; }
  ul.expand-only-note { margin: 8px 0 0; padding-left: 18px; }
  .expand-only-note li { margin-bottom: 4px; }
  .expand-only-note li:last-child { margin-bottom: 0; }
  .expand-only-note ul { margin: 6px 0 0; padding-left: 18px; }
  .insight-grid.expanded-category #categoryInsightCard .expand-only-note,
  .insight-grid.expanded-stage #stageInsightCard .expand-only-note,
  .insight-grid.expanded-matrix #matrixInsightCard .expand-only-note,
  .insight-grid.expanded-intent #intentInsightCard .expand-only-note {
    display: block;
  }

  .insight-highlight {
    font-size: 22px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 6px;
  }
  .insight-highlight.warn { color: #ff6b6b; }
  .insight-highlight.hot { color: #C6F24E; }
  .insight-highlight.trend { color: #C6F24E; }
  .insight-sub { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .insight-empty { color: var(--muted); font-size: 13px; }
  tr.clickable-row { cursor: pointer; }
  tr.clickable-row:hover { background: rgba(255,255,255,0.04); }
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
  .badge.android { background: rgba(198,242,78,0.15); color: var(--android); }
  .badge.ios { background: rgba(255,149,0,0.15); color: var(--ios); }
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
    border-color: #FF9500;
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
    .card.card-square { width: 108px; padding: 8px 10px; }
    .card.card-square .label { font-size: 13px; }
    .card.card-square .value { font-size: 24px; }
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
  .star-btn {
    cursor: pointer;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    user-select: none;
    transition: color 0.15s ease, transform 0.1s ease;
  }
  .star-btn:hover { transform: scale(1.15); }
  .star-btn.star-filled { color: #C6F24E; }
  .star-btn-drawer {
    position: absolute;
    top: 14px;
    right: 0;
    font-size: 18px;
  }

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

  <h1>阿葛格 評論追蹤 Dashboard</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="grid grid-flow" id="summaryCards"></div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="comments">評論</button>
    <button class="tab-btn" data-tab="autosummary">自動摘要</button>
    <button class="tab-btn" data-tab="sentiment">回饋洞察</button>
    <button class="tab-btn" data-tab="version">版本</button>
    <button class="tab-btn" data-tab="ratings">評分</button>
    <button class="tab-btn" data-tab="favorites">收藏</button>
  </div>

  <div class="tab-panel active" id="tab-comments">
    <div class="two-col">
    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">每月評論趨勢</h2>
        <div class="toggle-group" id="rangeToggleGroup">
          <button class="toggle-btn" data-range="3">近3個月</button>
          <button class="toggle-btn active" data-range="6">近6個月</button>
          <button class="toggle-btn" data-range="12">近1年</button>
          <button class="toggle-btn" data-range="all">全部</button>
          <button class="toggle-btn" id="btnResetZoom">重置縮放</button>
        </div>
      </div>
      <div class="h2-note">每個點代表一則實際評論，滑鼠移到點上可看內容</div>
      <div class="scatter-nav">
        <button class="nav-btn" id="btnPrevWindow">◀ 上一區間</button>
        <span class="note" id="scatterRangeNote" style="margin:0"></span>
        <button class="nav-btn" id="btnNextWindow">下一區間 ▶</button>
      </div>
      <div class="chart-container">
        <canvas id="commentScatterChart" height="110"></canvas>
      </div>
      <div class="note">用上方按鈕控制縮放程度（近3個月／近6個月／近1年／全部）；用「上一區間／下一區間」按鈕移動檢視區間，查看更早或更晚的資料。</div>
    </div>

    <div class="chart-card">
      <h2>常見字詞頻率排行</h2>
      <div class="h2-note">不分正負評，已過濾常見口語詞/語助詞</div>
      <div class="chart-container" id="wordFrequencyContainer" style="height:280px;">
        <canvas id="wordFrequencyChart"></canvas>
      </div>
      <button class="nav-btn" id="btnLoadMoreWords" style="margin-top:10px;">載入更多字詞</button>
      <div class="note">用「雙字詞」統計，不是正式的中文斷詞演算法，準確度有限，僅供快速抓語感參考。點擊長條可查看包含該字詞的評論。</div>
    </div>
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
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th><th></th><th>處理進度</th></tr>
        </thead>
        <tbody id="reviewTableBody"></tbody>
      </table>
      </div>
      <div class="note" id="reviewListNote"></div>
      <button class="nav-btn" id="btnLoadMoreReviews" style="margin-top:10px;">載入更多評論</button>
    </div>
  </div>

  <div class="tab-panel" id="tab-autosummary">
    <div class="note" style="margin-bottom: 16px;">以下內容是依規則自動比對數字產生（版本評分落差、負評分類排序、月增減比較），不是 AI 理解語意後寫出來的分析，準確度以此為前提，建議搭配下方「回饋洞察」「版本」交叉確認。</div>

    <div class="three-col" style="margin-bottom: 20px;">
      <div class="chart-card" id="insightCardRegression">
        <h2>⚠️ 版本異常警告</h2>
        <div id="insightRegressionBody"></div>
        <div class="chart-container" style="height:160px; margin-top:12px;">
          <canvas id="versionTrendChart"></canvas>
        </div>
      </div>
      <div class="chart-card" id="insightCardPain">
        <h2>🔥 歷史高頻痛點 Top 5</h2>
        <div id="insightPainBody"></div>
        <div class="chart-container" style="height:160px; margin-top:12px;">
          <canvas id="painPointsChart"></canvas>
        </div>
      </div>
      <div class="chart-card" id="insightCardTrend">
        <h2>📈 突發趨勢變化</h2>
        <div class="h2-note">本月 vs 上月</div>
        <div id="insightTrendBody"></div>
        <div class="chart-container" style="height:160px; margin-top:12px;">
          <canvas id="trendChangeChart"></canvas>
        </div>
        <div id="trendSparklineRow" style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;"></div>
      </div>
    </div>

    <div class="detail-grid" id="autoSummaryDetailGrid">
    <div class="chart-card detail-card" id="versionDetailCard" data-detail-key="version">
      <h2>版本異常詳情</h2>
      <div class="h2-note">點擊此區塊可展開查看更多內容</div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>版本</th><th>則數</th><th>平均星等</th><th>較前版落差</th><th>疑似原因</th></tr>
        </thead>
        <tbody id="versionRegressionTableBody"></tbody>
      </table>
      </div>
      <div class="note">點擊任一列可查看該版本的實際負評內容。</div>
    </div>

    <div class="chart-card detail-card" id="painDetailCard" data-detail-key="pain">
      <h2>歷史高頻痛點詳情</h2>
      <div class="h2-note">點擊此區塊可展開查看更多內容</div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>排名</th><th>分類</th><th>負評則數</th><th>總則數</th><th>平均星等</th></tr>
        </thead>
        <tbody id="painPointTableBody"></tbody>
      </table>
      </div>
      <div class="note">點擊任一列可查看該分類的負評內容。</div>
    </div>

    <div class="chart-card detail-card" id="trendDetailCard" data-detail-key="trend">
      <h2>趨勢變化詳情</h2>
      <div class="h2-note">點擊此區塊可展開查看更多內容</div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>分類</th><th>本月負評</th><th>上月負評</th><th>增加則數</th></tr>
        </thead>
        <tbody id="trendChangeTableBody"></tbody>
      </table>
      </div>
      <div class="note">只列出「本月至少 2 則」且比上月增加的分類，避免 1 則的雜訊被誤判成趨勢。點擊任一列可查看本月該分類的負評內容。</div>
    </div>
    </div>
  </div>

  <div class="tab-panel" id="tab-ratings">
    <div class="grid grid-2col" id="ratingsSummaryCards" style="margin-bottom: 20px;"></div>

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
    <div class="insight-grid" id="insightDetailGrid">
    <div class="chart-card insight-card" id="categoryInsightCard" data-insight-key="category">
      <div class="list-header">
        <h2 style="margin:0">情緒與類別分析</h2>
        <div class="toggle-group" id="categoryTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="h2-note">依關鍵字比對，可能一則評論同時符合多個類別；點擊此區塊可展開查看更多內容</div>
      <div class="chart-container">
        <canvas id="categoryChart" height="100"></canvas>
      </div>
      <ul class="note expand-only-note">
        <li>分類依你提供的分類架構建立（定車相關／取車相關／還車相關／客服／審核／付款／站點與車輛數／停權／基本資料／系統／車輛設備／優惠碼/優惠券／帳號／車損拍照／通知／軟體更新／icon設計／投保／搜尋／更改密碼／共同承租人），皆未符合則歸入「其他」。</li>
        <li>情緒判斷以星等為代理指標（1-3星負面、4-5星正面）。</li>
        <li>點擊長條圖任一區塊，或用下方篩選器，可查看該分類/情緒的實際評論。</li>
        <li id="otherCategoryNote"></li>
      </ul>
    </div>

    <div class="chart-card insight-card" id="stageInsightCard" data-insight-key="stage">
      <div class="list-header">
        <h2 style="margin:0">用戶旅程階段檢視</h2>
        <div class="toggle-group" id="stageTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="h2-note">點擊此區塊可展開查看更多內容</div>
      <div class="chart-container">
        <canvas id="stageChart" height="100"></canvas>
      </div>
      <div class="note expand-only-note">
        依分類對應回使用流程階段：
        <ul>
          <li>預約前（定車相關/審核）</li>
          <li>使用中（取車相關/車輛設備/系統/站點與車輛數/icon設計/搜尋/通知/軟體更新/投保）</li>
          <li>結束後（還車相關/付款/車損拍照）</li>
          <li>帳號與其他（客服/帳號/更改密碼/共同承租人/優惠碼/停權/基本資料/其他）</li>
        </ul>
      </div>
    </div>

    <div class="chart-card insight-card" id="matrixInsightCard" data-insight-key="matrix">
      <div class="list-header">
        <h2 style="margin:0">頻率 × 嚴重度矩陣</h2>
        <div class="toggle-group" id="matrixTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="h2-note">每個點是一個分類；越靠右代表提到次數越多，越靠下代表平均星等越低；點擊此區塊可展開查看更多內容</div>
      <div class="chart-container">
        <canvas id="matrixChart" height="110"></canvas>
      </div>
      <div class="note">右下角（高頻率、低星等）是最優先該處理的痛點；左下角則是次數雖少、但每次都很嚴重的「地雷」類別，也值得留意。</div>
    </div>

    <div class="chart-card insight-card" id="intentInsightCard" data-insight-key="intent">
      <div class="list-header">
        <h2 style="margin:0">意圖分佈</h2>
        <div class="toggle-group" id="intentTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
          <button class="toggle-btn" data-time-range="week">本週</button>
        </div>
      </div>
      <div class="h2-note">抱怨/bug、功能請求、純稱讚、一般，依關鍵字粗略判斷；點擊此區塊可展開查看更多內容</div>
      <div class="chart-container">
        <canvas id="intentChart" height="90"></canvas>
      </div>
    </div>
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
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th><th></th></tr>
        </thead>
        <tbody id="categoryDetailTableBody"></tbody>
      </table>
      </div>
      <div class="note" id="categoryDetailNote"></div>
    </div>
  </div>

  <div class="tab-panel" id="tab-version">
    <div class="chart-card">
      <h2>各版本平均評分與評論數</h2>
      <div class="h2-note">僅 Google Play，App Store 抓取流程目前未取得版本號</div>
      <div class="chart-container">
        <canvas id="versionChart" height="100"></canvas>
      </div>
      <div class="note">若某個版本後評分明顯下滑，通常代表該次改版造成體驗劣化，可以回頭比對該版本的更新內容。滑鼠移到長條上可看該版本的則數與平均星等。</div>
    </div>
  </div>

  <div class="tab-panel" id="tab-favorites">
    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">收藏的評論</h2>
      </div>
      <div class="note" style="margin-bottom:12px;">收藏狀態存在這台電腦的瀏覽器裡，不會同步給其他人、換瀏覽器或清除瀏覽器資料後會消失。</div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th><th></th></tr>
        </thead>
        <tbody id="favoritesTableBody"></tbody>
      </table>
      </div>
      <div class="note" id="favoritesNote"></div>
    </div>
  </div>

  <script>
    const dataset = ${dataJson};

    // ===== 記住目前分頁：重新整理網頁時停留在原本的分頁，不要都跳回「評論」 =====
    // 在任何圖表建立之前就先切換好分頁，這樣被還原的分頁一開始就是「可見」狀態，
    // 圖表尺寸計算也會是正確的，不需要額外等 resize。
    const TAB_STORAGE_KEY = 'gosmart-active-tab';
    (function restoreActiveTab() {
      const savedTab = localStorage.getItem(TAB_STORAGE_KEY);
      if (!savedTab) return;
      const targetBtn = document.querySelector('.tab-btn[data-tab="' + savedTab + '"]');
      const targetPanel = document.getElementById('tab-' + savedTab);
      if (!targetBtn || !targetPanel) return;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      targetBtn.classList.add('active');
      targetPanel.classList.add('active');
    })();

    // ===== 讓所有分頁在圖表建立當下都先有「正確的版面尺寸」，避免圖表在寬高是 0 的
    //      隱藏分頁裡建立、內部座標塌陷到左上角（切換分頁時修正尺寸會變成從左上角「彈出來」的怪異動畫）=====
    // 做法：暫時讓所有分頁都用 visibility:hidden（保留版面空間、但不會被畫出來）取代
    // display:none，讓 Chart.js 在建立當下就能量到正確的寬高；因為這整段（樣式覆蓋→
    // 建立所有圖表→恢復樣式）是同一串同步執行的程式碼，瀏覽器不會在中途畫面，
    // 所以不會有「畫面暫時變很長」的閃爍問題。所有圖表都建立完成後，再恢復正常的顯示/隱藏規則。
    const allTabPanelsForInit = document.querySelectorAll('.tab-panel');
    allTabPanelsForInit.forEach((p) => {
      if (!p.classList.contains('active')) {
        p.style.display = 'block';
        p.style.visibility = 'hidden';
      }
    });

    // 註冊縮放/平移外掛（不同版本的 UMD 建置可能掛在不同全域變數名稱下，都嘗試看看）
    const zoomPluginRef = window.ChartZoom || window['chartjs-plugin-zoom'] || window.zoomPlugin;
    if (zoomPluginRef && window.Chart) {
      Chart.register(zoomPluginRef);
    } else {
      console.warn('縮放/平移外掛未成功載入，圖表的滾輪縮放與拖曳平移功能可能無法使用（不影響其他功能）。');
    }

    // ===== 圖表進場動畫（每次重整網頁都會重新播放一次，因為每次都是重新建立圖表） =====
    // 全域預設：Chart.js 對長條圖的預設動畫本來就是「從座標軸的 0 基準點往外長出」，
    // 直立長條圖剛好符合「由下往上長出」、橫條圖剛好符合「由左往右長出」，
    // 所以只要確保動畫有開啟、給一個統一的時長跟緩動曲線即可，不需要每張圖表另外寫設定。
    if (window.Chart) {
      Chart.defaults.animation = { duration: 800, easing: 'easeOutQuart' };
    }

    // 散佈圖（純點點，例如每月評論趨勢、頻率×嚴重度矩陣）：用「淡入」取代 Chart.js 預設的
    // 「點點半徑從 0 長大」動畫，畫布本身用 CSS 做透明度淡入，圖表內部動畫關閉避免兩種效果打架。
    function fadeInCanvas(canvas, duration) {
      canvas.style.opacity = '0';
      requestAnimationFrame(() => {
        canvas.style.transition = 'opacity ' + (duration || 700) + 'ms ease-out';
        canvas.style.opacity = '1';
      });
    }

    // 點點+線段圖（例如每月平均評分趨勢、版本評分趨勢）：點點依 X 軸順序由左至右陸續出現，
    // 線段因為是即時連接「目前已經動畫到的點位置」，會自然跟著點點一起由左至右延伸出來。
    function pointsThenLineAnimation(stepMs) {
      return {
        delay(ctx) {
          if (ctx.type === 'data' && ctx.mode === 'default') {
            return ctx.dataIndex * (stepMs || 45);
          }
          return 0;
        },
      };
    }

    // ===== 點擊圖表資料點時滑出的評論抽屜 =====
    const drawerOverlay = document.getElementById('drawerOverlay');
    const reviewDrawer = document.getElementById('reviewDrawer');
    const drawerTitle = document.getElementById('drawerTitle');
    const drawerSubtitle = document.getElementById('drawerSubtitle');
    const drawerBody = document.getElementById('drawerBody');

    function renderDrawerReview(r) {
      const platformLabel = r.platform === 'android' ? 'Android' : 'iOS';
      return '<div class="drawer-review-item" style="position:relative;">' +
        starButtonHtml(r.key, 'star-btn-drawer') +
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
    drawerBody.addEventListener('click', (e) => {
      const star = e.target.closest('.star-btn');
      if (!star) return;
      e.stopPropagation();
      toggleFavoriteAndRefreshStars(star.dataset.starKey);
      if (typeof refreshFavoritesTabIfActive === 'function') refreshFavoritesTabIfActive();
    });
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
    const ratingsSummaryEl = document.getElementById('ratingsSummaryCards');

    function renderCardGroup(containerEl, cardsList, options) {
      const square = options && options.square;
      const clickable = options && options.clickable;
      containerEl.innerHTML = cardsList.map(c => {
        const isNewCountCard = c.cls === 'new-count';
        const isIosCard = c.cls === 'ios';
        const hasNew = isNewCountCard && c.value > 0;
        let cardClass = 'card';
        if (square) cardClass += ' card-square';
        if (isNewCountCard) cardClass += ' new-count-card' + (hasNew ? ' has-new' : '');
        if (isIosCard) cardClass += ' card-ios-bg';
        if (clickable && c.clickKey) cardClass += ' card-clickable';
        const isZeroNewCount = isNewCountCard && c.value === 0;
        const style = isZeroNewCount ? ' style="opacity:0.2"' : '';
        const valueClass = 'value ' + c.cls + (hasNew ? ' blink-number' : '');
        const clickAttr = (clickable && c.clickKey) ? ' data-click-key="' + c.clickKey + '"' : '';
        const subHtml = (c.subLabel !== undefined && c.subValue !== undefined)
          ? '<div class="card-sub"><div class="card-sub-label">' + c.subLabel + '</div><div class="card-sub-value">' + c.subValue + '</div></div>'
          : '';
        // 沒有有效數值時（例如尚無評分資料），直接顯示 "-"，不套用計數動畫
        if (c.value === null || c.value === undefined || isNaN(c.value)) {
          return '<div class="' + cardClass + '"' + clickAttr + '><div class="label">' + c.label + '</div><div class="' + valueClass + '"' + style + '>-</div>' + subHtml + '</div>';
        }
        const initialText = c.decimals > 0 ? (0).toFixed(c.decimals) : '0';
        return '<div class="' + cardClass + '"' + clickAttr + '><div class="label">' + c.label + '</div>' +
          '<div class="' + valueClass + '"' + style + ' data-count-target="' + c.value + '" data-count-decimals="' + c.decimals + '">' + initialText + '</div>' + subHtml + '</div>';
      }).join('');
    }

    renderCardGroup(summaryEl, [
      { label: 'Google Play<br>累積評論數', value: dataset.androidTotal, cls: 'android', decimals: 0, clickKey: 'android-total', subLabel: '實際總數(含手動補充)', subValue: dataset.actualAndroidTotal },
      { label: 'App Store<br>累積評論數', value: dataset.iosTotal, cls: 'ios-lime', decimals: 0, clickKey: 'ios-total', subLabel: '實際總數(含手動補充)', subValue: dataset.actualIosTotal },
      { label: 'Google Play<br>新評論數', value: dataset.newReviewsCount.android, cls: 'new-count', decimals: 0, clickKey: 'android-new' },
      { label: 'App Store<br>新評論數', value: dataset.newReviewsCount.ios, cls: 'new-count', decimals: 0, clickKey: 'ios-new' },
    ], { square: true, clickable: true });

    // ===== 頂部四張卡片可點擊，直接跳出評論抽屜（跟其他圖表的點擊互動邏輯一致） =====
    const cardClickMap = {
      'android-total': {
        title: 'Google Play 全部評論',
        getReviews: () => dataset.allReviewsFlat.filter(r => r.platform === 'android'),
      },
      'ios-total': {
        title: 'App Store 全部評論',
        getReviews: () => dataset.allReviewsFlat.filter(r => r.platform === 'ios'),
      },
      'android-new': {
        title: 'Google Play 新增評論',
        getReviews: () => (dataset.newReviewsList && dataset.newReviewsList.android) || [],
      },
      'ios-new': {
        title: 'App Store 新增評論',
        getReviews: () => (dataset.newReviewsList && dataset.newReviewsList.ios) || [],
      },
    };
    summaryEl.addEventListener('click', (e) => {
      const card = e.target.closest('[data-click-key]');
      if (!card) return;
      const cfg = cardClickMap[card.dataset.clickKey];
      if (!cfg) return;
      const reviews = cfg.getReviews();
      openReviewDrawer(cfg.title, '共 ' + reviews.length + ' 則', reviews);
    });

    renderCardGroup(ratingsSummaryEl, [
      { label: 'Google Play<br>平均星等', value: dataset.androidAvgOverall, cls: 'android', decimals: 2 },
      { label: 'App Store<br>平均星等', value: dataset.iosAvgOverall, cls: 'ios', decimals: 2 },
    ]);

    // ===== 卡片數字：滾動進入畫面時，從 0 跑到目標值（只觸發一次） =====
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

    function setupCountAnimation(containerEl) {
      const countTargets = containerEl.querySelectorAll('[data-count-target]');
      if (countTargets.length === 0) return;
      if ('IntersectionObserver' in window) {
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
        countObserver.observe(containerEl);
      } else {
        // 瀏覽器不支援 IntersectionObserver 時，直接顯示最終數值，不做動畫
        countTargets.forEach(el => {
          const target = parseFloat(el.dataset.countTarget);
          const decimals = parseInt(el.dataset.countDecimals, 10) || 0;
          el.textContent = decimals > 0 ? target.toFixed(decimals) : target.toLocaleString();
        });
      }
    }

    setupCountAnimation(summaryEl);
    setupCountAnimation(ratingsSummaryEl);

    // ===== 切換到某個分頁時，重播該分頁裡圖表的進場動畫 =====
    // 圖表在頁面載入當下就已經全部建立好、動畫也已經在背景（隱藏狀態）悄悄播完了，
    // 所以單純切換分頁不會看到任何動畫。這裡用 Chart.js 的 reset()+update() 技巧，
    // 在「真正切過去、看得到的那一刻」重新播放一次進場動畫；純點點淡入的圖表另外重播 CSS 淡入。
    const TAB_CHART_IDS = {
      comments: ['commentScatterChart', 'wordFrequencyChart'],
      autosummary: ['versionTrendChart', 'painPointsChart', 'trendChangeChart'],
      sentiment: ['categoryChart', 'stageChart', 'matrixChart', 'intentChart'],
      version: ['versionChart'],
      ratings: ['trendChart', 'androidDistChart', 'iosDistChart'],
    };
    function replayTabAnimations(tabKey) {
      if (window.Chart && Chart.instances) {
        const idsForTab = TAB_CHART_IDS[tabKey] || [];
        Object.values(Chart.instances).forEach((c) => {
          const canvasId = c.canvas && c.canvas.id;
          if (!canvasId) return;
          const belongsToTab = idsForTab.includes(canvasId) || (tabKey === 'autosummary' && canvasId.indexOf('sparkline-') === 0);
          if (!belongsToTab) return;
          try {
            c.reset();
            c.update();
          } catch (e) {}
        });
      }
      // 純點點淡入的圖表（Chart.js 內建動畫關閉，靠外層 canvas 的 CSS 淡入呈現），額外重播一次
      if (tabKey === 'comments') {
        const el = document.getElementById('commentScatterChart');
        if (el) fadeInCanvas(el, 700);
      }
      if (tabKey === 'sentiment') {
        const el = document.getElementById('matrixChart');
        if (el) fadeInCanvas(el, 700);
      }
    }

    // ===== Tab 切換 =====
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        localStorage.setItem(TAB_STORAGE_KEY, btn.dataset.tab); // 記住這次切到的分頁，下次重整網頁時還原
        replayTabAnimations(btn.dataset.tab);
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
            backgroundColor: '#c6f24e',
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
          if (evt.native) evt.native.stopPropagation();
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
      return avgScore <= 3 ? '#ff6b6b' : '#c6f24e';
    }

    fadeInCanvas(document.getElementById('matrixChart'), 700);
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
        animation: false, // 用外層 canvas 的 CSS 淡入取代，避免跟點點半徑動畫互相打架
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
          if (evt.native) evt.native.stopPropagation();
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
          backgroundColor: ['#ff6b6b', '#FF9500', '#c6f24e', '#5b6272'],
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
          if (evt.native) evt.native.stopPropagation();
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
          { label: '正面', data: dataset.stageOrder.map(s => dataset.stageStatsByRange.all[s].positive), backgroundColor: '#c6f24e', sentimentKey: 'positive' },
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
          if (evt.native) evt.native.stopPropagation();
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
              borderColor: '#e8e9ed',
              backgroundColor: 'rgba(232,233,237,0.1)',
              yAxisID: 'y1',
              tension: 0.3,
            },
            {
              type: 'bar',
              label: '評論則數',
              data: dataset.versionStats.map(v => v.count),
              backgroundColor: 'rgba(198,242,78,0.5)',
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
              <div class="review-meta">\${r.userName || ''}\${r.version ? '　版本 ' + r.version : ''}</div>
            </td>
            <td>\${starButtonHtml(r.key)}</td>
          </tr>
        \`).join('');
      }
      noteEl.textContent = '「' + category + '」分類，最多顯示 50 則（依日期排序）。';
    }

    document.getElementById('categoryDetailTableBody').addEventListener('click', (e) => {
      const star = e.target.closest('.star-btn');
      if (!star) return;
      toggleFavoriteAndRefreshStars(star.dataset.starKey);
      if (typeof refreshFavoritesTabIfActive === 'function') refreshFavoritesTabIfActive();
    });

    categorySelect.addEventListener('change', renderCategoryDetail);
    intentSelect.addEventListener('change', renderCategoryDetail);
    document.querySelectorAll('#sentimentToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => setSentimentFilter(btn.dataset.sentiment));
    });

    renderCategoryDetail();

    // ===== 回饋洞察：四個區塊，點擊整張卡片展開成一整欄、其餘三欄自動下移。
    //      版面切換純粹靠 CSS 的 width 過渡完成（見上方 .insight-grid 樣式），
    //      這裡只需要切換 class，不需要 JS 計算位移/縮放，也就不會有超出畫面的風險。 =====
    (function setupInsightGridExpand() {
      const insightGrid = document.getElementById('insightDetailGrid');
      if (!insightGrid) return;
      const INSIGHT_ANIMATION_MS = 350;

      function resizeChartsAfterTransition() {
        setTimeout(() => {
          if (window.Chart && Chart.instances) {
            Object.values(Chart.instances).forEach(c => {
              try { c.resize(); } catch (e) {}
            });
          }
        }, INSIGHT_ANIMATION_MS + 30);
      }

      const insightCardsList = document.querySelectorAll('.insight-card');
      insightCardsList.forEach(card => {
        card.addEventListener('click', (e) => {
          // 點在右上角的篩選按鈕上時，不要觸發整張卡片的展開/收合（讓篩選按鈕自己的功能正常運作）
          if (e.target.closest('.toggle-group')) return;
          // 點在圖表（canvas）範圍內時也不要觸發，不管有沒有真的點中資料點，
          // 讓「跟圖表互動看細部評論」跟「展開/收合卡片」徹底分開，不會互相誤觸
          if (e.target.closest('canvas')) return;

          const key = card.dataset.insightKey;
          const expandedClass = 'expanded-' + key;
          if (insightGrid.classList.contains(expandedClass)) {
            insightGrid.className = 'insight-grid';
            card.classList.remove('is-first');
          } else {
            insightGrid.className = 'insight-grid ' + expandedClass;
            insightCardsList.forEach(c => c.classList.remove('is-first'));
            card.classList.add('is-first');
          }
          resizeChartsAfterTransition();
        });
      });
    })();

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

      const prevBtn = document.getElementById('btnPrevWindow');
      const nextBtn = document.getElementById('btnNextWindow');
      if (size === 'all') {
        prevBtn.disabled = true;
        nextBtn.disabled = true;
      } else {
        prevBtn.disabled = minIndex <= 0;
        nextBtn.disabled = maxIndex >= monthKeys.length - 1;
      }

      if (scatterChart) {
        scatterChart.destroy();
      }

      fadeInCanvas(document.getElementById('commentScatterChart'), 700);
      scatterChart = new Chart(document.getElementById('commentScatterChart'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Google Play',
              data: androidPoints,
              backgroundColor: 'rgba(198,242,78,' + pointAlpha + ')',
              pointRadius,
              pointHoverRadius: pointRadius + 3,
            },
            {
              label: 'App Store',
              data: iosPoints,
              backgroundColor: 'rgba(255,149,0,' + (pointAlpha + 0.05) + ')',
              pointRadius,
              pointHoverRadius: pointRadius + 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false, // 用外層 canvas 的 CSS 淡入取代，避免跟點點半徑動畫互相打架
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
              pan: { enabled: false },
              zoom: {
                wheel: { enabled: false },
                pinch: { enabled: false },
                mode: 'x',
              },
              limits: {
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

    document.getElementById('btnPrevWindow').addEventListener('click', () => {
      if (currentWindowSize === 'all') return;
      currentWindowStart = clampWindowStart(currentWindowSize, currentWindowStart - currentWindowSize);
      renderScatterChart();
    });

    document.getElementById('btnNextWindow').addEventListener('click', () => {
      if (currentWindowSize === 'all') return;
      currentWindowStart = clampWindowStart(currentWindowSize, currentWindowStart + currentWindowSize);
      renderScatterChart();
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

    // ===== 收藏功能：同樣存在瀏覽器的 localStorage 裡（只存在這台電腦/這個瀏覽器，不會同步給其他人） =====
    const FAVORITE_PREFIX = 'gosmart-review-favorite:';

    function isFavorited(key) {
      try {
        return localStorage.getItem(FAVORITE_PREFIX + key) === '1';
      } catch (e) {
        return false;
      }
    }

    function setFavorited(key, value) {
      try {
        if (value) localStorage.setItem(FAVORITE_PREFIX + key, '1');
        else localStorage.removeItem(FAVORITE_PREFIX + key);
      } catch (e) {
        // 靜默失敗
      }
    }

    function getFavoriteKeys() {
      const keys = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(FAVORITE_PREFIX) === 0) keys.push(k.slice(FAVORITE_PREFIX.length));
        }
      } catch (e) {
        // 靜默失敗
      }
      return keys;
    }

    function starButtonHtml(key, extraClass) {
      const filled = isFavorited(key);
      return '<span class="star-btn' + (filled ? ' star-filled' : '') + (extraClass ? ' ' + extraClass : '') +
        '" data-star-key="' + key + '" title="收藏">' + (filled ? '★' : '☆') + '</span>';
    }

    function toggleFavoriteAndRefreshStars(key) {
      const newState = !isFavorited(key);
      setFavorited(key, newState);
      document.querySelectorAll('[data-star-key="' + key + '"]').forEach(el => {
        el.classList.toggle('star-filled', newState);
        el.textContent = newState ? '★' : '☆';
      });
      return newState;
    }

    // ===== 收藏 tab：渲染實際內容 =====
    const reviewsByKey = new Map(dataset.allReviewsFlat.map(r => [r.key, r]));

    function renderFavoritesTab() {
      const favTbody = document.getElementById('favoritesTableBody');
      const favNote = document.getElementById('favoritesNote');
      if (!favTbody) return;

      const keys = getFavoriteKeys();
      const favReviews = keys
        .map(k => reviewsByKey.get(k))
        .filter(Boolean)
        .sort((a, b) => b.timestamp - a.timestamp);

      if (favReviews.length === 0) {
        favTbody.innerHTML = '<tr><td colspan="5" style="color:#9aa0ac">目前沒有收藏的評論，點擊評論旁邊的星號即可加入收藏。</td></tr>';
      } else {
        favTbody.innerHTML = favReviews.map(r => \`
          <tr>
            <td><span class="badge \${r.platform}">\${r.platform === 'android' ? 'Android' : 'iOS'}</span></td>
            <td>\${r.date}</td>
            <td class="\${r.score <= 3 ? 'score-neg' : 'score-pos'}">\${r.score} ★</td>
            <td>
              \${r.title ? '<div class="review-text"><b>' + r.title + '</b></div>' : ''}
              <div class="review-text">\${(r.text || '').slice(0, 200)}</div>
              <div class="review-meta">\${r.userName || ''}</div>
            </td>
            <td>\${starButtonHtml(r.key)}</td>
          </tr>
        \`).join('');
      }
      favNote.textContent = '共收藏 ' + favReviews.length + ' 則評論。';
    }

    function refreshFavoritesTabIfActive() {
      renderFavoritesTab();
    }

    document.getElementById('favoritesTableBody').addEventListener('click', (e) => {
      const star = e.target.closest('.star-btn');
      if (!star) return;
      toggleFavoriteAndRefreshStars(star.dataset.starKey);
      renderFavoritesTab(); // 取消收藏後要立刻從清單移除
    });

    renderFavoritesTab(); // 頁面載入時先渲染一次（如果這個瀏覽器之前就收藏過評論）

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
        tbody.innerHTML = '<tr><td colspan="6" style="color:#9aa0ac">目前沒有符合條件的評論</td></tr>';
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
            <td>\${starButtonHtml(r.key)}</td>
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

    // 用事件委派監聽狀態下拉選單的變更、以及星星收藏點擊，因為每次 render 都會整個重建 tbody 內容
    tbody.addEventListener('change', (e) => {
      if (e.target.classList.contains('status-select')) {
        setReviewStatus(e.target.dataset.reviewKey, e.target.value);
        applyStatusColor(e.target, e.target.value);
      }
    });
    tbody.addEventListener('click', (e) => {
      const star = e.target.closest('.star-btn');
      if (!star) return;
      toggleFavoriteAndRefreshStars(star.dataset.starKey);
      if (typeof refreshFavoritesTabIfActive === 'function') refreshFavoritesTabIfActive();
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

    // ===== 評論 tab：字詞頻率排行 =====
    (function renderWordFrequency() {
      const words = dataset.wordFrequency || [];
      const canvas = document.getElementById('wordFrequencyChart');
      const container = document.getElementById('wordFrequencyContainer');
      const btnLoadMoreWords = document.getElementById('btnLoadMoreWords');

      if (words.length === 0) {
        canvas.parentElement.innerHTML = '<div class="insight-empty">目前資料量不足以統計出有意義的字詞頻率。</div>';
        btnLoadMoreWords.style.display = 'none';
        return;
      }

      const COLLAPSED_COUNT = 8;
      let expanded = false;
      let wordChartInstance = null;

      function draw() {
        const shownWords = expanded ? words : words.slice(0, COLLAPSED_COUNT);
        container.style.height = expanded ? '600px' : '280px';

        if (wordChartInstance) wordChartInstance.destroy();
        wordChartInstance = new Chart(canvas, {
          type: 'bar',
          data: {
            labels: shownWords.map(w => w.word),
            datasets: [{
              data: shownWords.map(w => w.count),
              backgroundColor: '#C6F24E',
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { ticks: { color: '#9aa0ac' }, grid: { color: '#2a2e38' } },
              y: { ticks: { color: '#9aa0ac', autoSkip: false }, grid: { display: false } },
            },
            plugins: { legend: { display: false } },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const w = shownWords[elements[0].index];
              const matched = dataset.allReviewsFlat.filter(r => (r.text || '').includes(w.word));
              openReviewDrawer('包含「' + w.word + '」的評論', '共 ' + matched.length + ' 則', matched);
            },
          },
        });

        if (words.length <= COLLAPSED_COUNT) {
          btnLoadMoreWords.style.display = 'none';
        } else {
          btnLoadMoreWords.style.display = '';
          btnLoadMoreWords.textContent = expanded ? '收合字詞排行' : '載入更多字詞（還有 ' + (words.length - COLLAPSED_COUNT) + ' 個）';
        }
      }

      btnLoadMoreWords.addEventListener('click', () => {
        expanded = !expanded;
        draw();
      });

      draw();
    })();

    // ===== 自動摘要 tab：規則式洞察 =====
    (function renderAutoSummary() {
      const regressions = dataset.versionRegressions || [];
      const painPoints = dataset.topPainPoints || [];
      const trends = dataset.trendChanges || [];

      const CATEGORY_ICONS = {
        '定車相關': '🗓️', '取車相關': '🔑', '還車相關': '🚗', '客服': '🎧',
        '審核': '📋', '付款': '💳', '站點與車輛數': '📍', '停權': '🚫',
        '基本資料': '🪪', '系統': '⚙️', '車輛設備': '🔧', '優惠碼/優惠券': '🎟️',
        '帳號': '👤', '車損拍照': '📸', '通知': '🔔', '軟體更新': '🔄',
        'icon設計': '🎨', '投保': '🛡️', '搜尋': '🔍', '更改密碼': '🔒',
        '共同承租人': '👥', '其他': '📦',
      };
      const iconFor = (cat) => CATEGORY_ICONS[cat] || '📌';

      // --- 卡片一：版本異常警告 ---
      const regressionBody = document.getElementById('insightRegressionBody');
      if (regressions.length === 0) {
        regressionBody.innerHTML = '<div class="insight-empty">目前沒有偵測到明顯的版本評分驟降。</div>';
      } else {
        const top = regressions[0];
        regressionBody.innerHTML =
          '<div class="insight-highlight warn">版本 ' + top.version + '</div>' +
          '<div class="insight-sub">平均星等較前一版下降 ' + top.scoreDrop.toFixed(2) + ' 分（' + top.avgScore.toFixed(2) + ' ★，共 ' + top.count + ' 則）' +
          (top.topCats.length ? '，主要負評類型：' + top.topCats.join('、') : '') + '</div>' +
          (regressions.length > 1 ? '<div class="insight-sub" style="margin-top:6px;">另外還有 ' + (regressions.length - 1) + ' 個版本也被標記，詳見下方表格。</div>' : '');
      }

      // --- 卡片二：歷史高頻痛點 ---
      const painBody = document.getElementById('insightPainBody');
      if (painPoints.length === 0) {
        painBody.innerHTML = '<div class="insight-empty">目前沒有足夠資料歸納出痛點排行。</div>';
      } else {
        const top = painPoints[0];
        painBody.innerHTML =
          '<div class="insight-highlight hot">' + top.category + '</div>' +
          '<div class="insight-sub">歷史累積 ' + top.negativeCount + ' 則負評（平均 ' + top.avgScore.toFixed(2) + ' ★），是目前最該優先排入 Roadmap 的問題。</div>' +
          '<div class="insight-sub" style="margin-top:6px;">Top 5：' + painPoints.map(p => p.category).join('、') + '</div>';
      }

      // --- 卡片三：突發趨勢變化 ---
      const trendBody = document.getElementById('insightTrendBody');
      if (trends.length === 0) {
        trendBody.innerHTML = '<div class="insight-empty">本月跟上月相比，沒有偵測到明顯增加的負評類型。</div>';
      } else {
        const top = trends[0];
        trendBody.innerHTML =
          '<div class="insight-highlight trend">' + top.category + ' +' + top.delta + '</div>' +
          '<div class="insight-sub">本月已有 ' + top.thisMonthNeg + ' 則負評（上月 ' + top.lastMonthNeg + ' 則），是本月新浮現或惡化的方向。</div>' +
          (trends.length > 1 ? '<div class="insight-sub" style="margin-top:6px;">其他上升類型：' + trends.slice(1).map(t => t.category + ' +' + t.delta).join('、') + '</div>' : '');
      }

      // --- 詳情表格：版本異常 ---
      const versionTbody = document.getElementById('versionRegressionTableBody');
      if (regressions.length === 0) {
        versionTbody.innerHTML = '<tr><td colspan="5" class="insight-empty">目前沒有被標記的版本。</td></tr>';
      } else {
        versionTbody.innerHTML = regressions.map(v => \`
          <tr class="clickable-row" data-version="\${v.version}">
            <td>\${v.version}</td>
            <td>\${v.count}</td>
            <td class="score-neg">\${v.avgScore.toFixed(2)} ★</td>
            <td class="score-neg">-\${v.scoreDrop.toFixed(2)}</td>
            <td>\${v.topCats.join('、') || '-'}</td>
          </tr>
        \`).join('');
        versionTbody.querySelectorAll('tr[data-version]').forEach(row => {
          row.addEventListener('click', () => {
            const version = row.dataset.version;
            const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === version && r.sentiment === 'negative');
            openReviewDrawer('版本 ' + version + ' 的負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      // --- 詳情表格：高頻痛點（預設 Top 5，展開卡片後改列出 Top 16） ---
      const painTbody = document.getElementById('painPointTableBody');
      function renderPainPointTable(list) {
        if (list.length === 0) {
          painTbody.innerHTML = '<tr><td colspan="5" class="insight-empty">目前沒有資料。</td></tr>';
          return;
        }
        painTbody.innerHTML = list.map((p, idx) => \`
          <tr class="clickable-row" data-category="\${p.category}">
            <td>#\${idx + 1}</td>
            <td>\${iconFor(p.category)} \${p.category}</td>
            <td class="score-neg">\${p.negativeCount}</td>
            <td>\${p.totalCount}</td>
            <td>\${p.avgScore !== null ? p.avgScore.toFixed(2) + ' ★' : '-'}</td>
          </tr>
        \`).join('');
        painTbody.querySelectorAll('tr[data-category]').forEach(row => {
          row.addEventListener('click', () => {
            const category = row.dataset.category;
            const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(category) && r.sentiment === 'negative');
            openReviewDrawer(category + ' 的歷史負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }
      renderPainPointTable(painPoints);

      // --- 詳情表格：趨勢變化 ---
      const trendTbody = document.getElementById('trendChangeTableBody');
      if (trends.length === 0) {
        trendTbody.innerHTML = '<tr><td colspan="4" class="insight-empty">目前沒有偵測到明顯趨勢。</td></tr>';
      } else {
        trendTbody.innerHTML = trends.map(t => \`
          <tr class="clickable-row" data-category="\${t.category}">
            <td>\${iconFor(t.category)} \${t.category}</td>
            <td class="score-neg">\${t.thisMonthNeg}</td>
            <td>\${t.lastMonthNeg}</td>
            <td class="score-neg">+\${t.delta}</td>
          </tr>
        \`).join('');
        trendTbody.querySelectorAll('tr[data-category]').forEach(row => {
          row.addEventListener('click', () => {
            const category = row.dataset.category;
            const matched = dataset.reviewsByRange.month.filter(r => r.categories.includes(category) && r.sentiment === 'negative');
            openReviewDrawer(category + '（本月）', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      // --- 圖表一：版本 × 平均星等 折線圖（異常版本用紅點標示） ---
      const versionAnalysis = dataset.versionAnalysis || [];
      if (versionAnalysis.length > 0) {
        new Chart(document.getElementById('versionTrendChart'), {
          type: 'line',
          data: {
            labels: versionAnalysis.map(v => v.version),
            datasets: [{
              label: '平均星等',
              data: versionAnalysis.map(v => v.avgScore),
              borderColor: '#C6F24E',
              backgroundColor: 'rgba(198,242,78,0.08)',
              tension: 0.3,
              pointRadius: versionAnalysis.map(v => v.isRegression ? 6 : 3),
              pointBackgroundColor: versionAnalysis.map(v => v.isRegression ? '#ff6b6b' : '#C6F24E'),
              pointBorderColor: versionAnalysis.map(v => v.isRegression ? '#ff6b6b' : '#C6F24E'),
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: pointsThenLineAnimation(50),
            scales: {
              y: { min: 0, max: 5, ticks: { color: '#9aa0ac', font: { size: 10 } }, grid: { color: '#2a2e38' } },
              x: { ticks: { color: '#9aa0ac', font: { size: 9 }, maxRotation: 60, minRotation: 45 }, grid: { display: false } },
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const v = versionAnalysis[ctx.dataIndex];
                    const lines = ['平均 ' + v.avgScore.toFixed(2) + ' ★（' + v.count + ' 則）'];
                    if (v.isRegression) lines.push('⚠️ 較前版下降 ' + v.scoreDrop.toFixed(2) + ' 分');
                    return lines;
                  },
                },
              },
            },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const v = versionAnalysis[elements[0].index];
              const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === v.version);
              openReviewDrawer('版本 ' + v.version, '共 ' + matched.length + ' 則', matched);
            },
          },
        });
      }

      // --- 圖表二：歷史高頻痛點 橫向長條圖 ---
      if (painPoints.length > 0) {
        new Chart(document.getElementById('painPointsChart'), {
          type: 'bar',
          data: {
            labels: painPoints.map(p => iconFor(p.category) + ' ' + p.category),
            datasets: [{
              data: painPoints.map(p => p.negativeCount),
              backgroundColor: painPoints.map((p, i) => i === 0 ? '#C6F24E' : 'rgba(198,242,78,' + (0.85 - i * 0.12) + ')'),
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { ticks: { color: '#9aa0ac', font: { size: 10 } }, grid: { color: '#2a2e38' } },
              y: { ticks: { color: '#9aa0ac', font: { size: 11 } }, grid: { display: false } },
            },
            plugins: { legend: { display: false } },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const p = painPoints[elements[0].index];
              const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(p.category) && r.sentiment === 'negative');
              openReviewDrawer(p.category + ' 的歷史負評', '共 ' + matched.length + ' 則', matched);
            },
          },
        });
      }

      // --- 圖表三：本月 vs 上月 對比長條圖 ---
      if (trends.length > 0) {
        new Chart(document.getElementById('trendChangeChart'), {
          type: 'bar',
          data: {
            labels: trends.map(t => t.category),
            datasets: [
              { label: '上月', data: trends.map(t => t.lastMonthNeg), backgroundColor: '#5b6272' },
              { label: '本月', data: trends.map(t => t.thisMonthNeg), backgroundColor: '#C6F24E' },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { ticks: { color: '#9aa0ac', font: { size: 10 } }, grid: { display: false } },
              y: { ticks: { color: '#9aa0ac', font: { size: 10 } }, grid: { color: '#2a2e38' } },
            },
            plugins: { legend: { labels: { color: '#e8e9ed', font: { size: 10 } } } },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const t = trends[elements[0].index];
              const matched = dataset.reviewsByRange.month.filter(r => r.categories.includes(t.category) && r.sentiment === 'negative');
              openReviewDrawer(t.category + '（本月）', '共 ' + matched.length + ' 則', matched);
            },
          },
        });
      }

      // --- 圖表四：每個上升分類的近 6 個月迷你走勢線（sparkline） ---
      const sparklineRow = document.getElementById('trendSparklineRow');
      if (trends.length > 0 && dataset.recentMonths6) {
        const months6 = dataset.recentMonths6;
        sparklineRow.innerHTML = trends.map((t, i) =>
          '<div style="flex:1; min-width:110px; background:#0f1115; border:1px solid #2a2e38; border-radius:8px; padding:8px;">' +
            '<div style="font-size:11px; color:#9aa0ac; margin-bottom:4px;">' + iconFor(t.category) + ' ' + t.category + '</div>' +
            '<div style="position:relative; width:100%; height:44px;"><canvas id="sparkline-' + i + '"></canvas></div>' +
          '</div>'
        ).join('');

        trends.forEach((t, i) => {
          new Chart(document.getElementById('sparkline-' + i), {
            type: 'line',
            data: {
              labels: months6,
              datasets: [{
                data: t.sparkline,
                borderColor: '#C6F24E',
                backgroundColor: 'rgba(198,242,78,0.15)',
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                borderWidth: 2,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: { x: { display: false }, y: { display: false, min: 0 } },
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    title: (items) => months6[items[0].dataIndex],
                    label: (ctx) => ctx.parsed.y + ' 則負評',
                  },
                },
              },
            },
          });
        });
      } else {
        sparklineRow.innerHTML = '';
      }

      // --- 三個詳情區塊：點擊整張卡片展開成一整欄，其餘兩欄自動下移。
      //     版面切換純粹靠 CSS 的 width 過渡完成（見上方 .detail-grid 樣式），
      //     這裡只需要切換 class，不需要 JS 計算位移/縮放，也就不會有超出畫面的風險。 ---
      const detailGrid = document.getElementById('autoSummaryDetailGrid');
      const ANIMATION_MS = 350;

      function resizeChartsAfterDetailTransition() {
        setTimeout(() => {
          if (window.Chart && Chart.instances) {
            Object.values(Chart.instances).forEach(c => {
              try { c.resize(); } catch (e) {}
            });
          }
        }, ANIMATION_MS + 30);
      }

      const detailCardsList = document.querySelectorAll('.detail-card');
      detailCardsList.forEach(card => {
        card.addEventListener('click', (e) => {
          // 點在資料列（會跳出評論抽屜）上時，不要同時觸發整張卡片的展開/收合
          if (e.target.closest('tr.clickable-row')) return;

          const key = card.dataset.detailKey;
          const expandedClass = 'expanded-' + key;
          if (detailGrid.classList.contains(expandedClass)) {
            detailGrid.className = 'detail-grid'; // 再點一次已展開的卡片 → 收合回三欄
            card.classList.remove('is-first');
          } else {
            detailGrid.className = 'detail-grid ' + expandedClass;
            detailCardsList.forEach(c => c.classList.remove('is-first'));
            card.classList.add('is-first');
          }
          // 「歷史高頻痛點詳情」展開時列出 Top 16，收合（或切到其他卡片展開）時維持 Top 5
          renderPainPointTable(detailGrid.classList.contains('expanded-pain') ? (dataset.topPainPoints16 || painPoints) : painPoints);
          resizeChartsAfterDetailTransition();
        });
      });
    })();

    // ===== 評分 tab：月平均趨勢 + 星等分佈 =====
    new Chart(document.getElementById('trendChart'), {
      type: 'line',
      data: {
        labels: dataset.monthlyStats.map(d => d.month),
        datasets: [
          {
            label: 'Google Play 平均星等',
            data: dataset.monthlyStats.map(d => d.androidAvg),
            borderColor: '#c6f24e',
            backgroundColor: 'rgba(198,242,78,0.1)',
            tension: 0.3,
            spanGaps: true,
          },
          {
            label: 'App Store 平均星等',
            data: dataset.monthlyStats.map(d => d.iosAvg),
            borderColor: '#FF9500',
            backgroundColor: 'rgba(255,149,0,0.1)',
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
        animation: pointsThenLineAnimation(35),
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
    distChart('androidDistChart', dataset.androidDist, '#c6f24e');
    distChart('iosDistChart', dataset.iosDist, '#FF9500');

    // ===== 所有圖表都建立完成，現在把剛才暫時的「有版面但看不見」樣式清乾淨，
    //      恢復成正常的分頁顯示/隱藏規則（靠 .tab-panel.active 這個 class 控制）=====
    allTabPanelsForInit.forEach((p) => {
      p.style.display = '';
      p.style.visibility = '';
    });
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
  dataset.newReviewsList = {
    android: newReviews.filter((r) => r.platform === 'android'),
    ios: newReviews.filter((r) => r.platform === 'ios'),
  };

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
