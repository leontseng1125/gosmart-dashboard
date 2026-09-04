const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'dashboard.html');
const FULL_HISTORY_FILE = path.join(DATA_DIR, 'android-full-history.json');
const MANUAL_REVIEWS_FILE = path.join(DATA_DIR, 'manual-coded-reviews.json');

// ===== 資料來源開關 =====
// true：以手動匯出的CSV（Google Play Console / App Store Connect 的評論匯出檔）為主要資料來源。
// false：改回原本的爬蟲資料（reviews-*.json + android-full-history.json）。
// 目前先固定用CSV，因為比對過後發現爬蟲資料還有些地方需要校正；
// 爬蟲相關的程式碼完全沒有刪除，之後校正好想切回來，把這裡改成 false 就可以了。
const USE_CSV_AS_PRIMARY_SOURCE = true;
const ANDROID_CSV_FILE = path.join(DATA_DIR, 'android-reviews.csv');
const IOS_CSV_FILE = path.join(DATA_DIR, 'ios-reviews.csv');

// ===== CSV 解析（自己寫，不依賴額外套件，Node環境不用另外npm install） =====
// 處理RFC4180格式：欄位可以用雙引號包起來，裡面可以有逗號、換行、用""表示的逸出雙引號。
function parseCsv(content) {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // 去掉檔案開頭可能的BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // 忽略，統一靠 \n 判斷換行，避免 CRLF/LF 混用時多算一行
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === '')); // 濾掉檔案結尾的空白行
}

function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

// 解析「2026年9月1日 15:43」或「2026年7月31日」這種中文日期格式（時間部分可有可無）
function parseChineseDateTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0);
}

function loadCsvReviews() {
  const result = { android: [], ios: [] };

  if (fs.existsSync(ANDROID_CSV_FILE)) {
    const rows = csvRowsToObjects(parseCsv(fs.readFileSync(ANDROID_CSV_FILE, 'utf-8')));
    result.android = rows
      .map((row) => {
        const realDate = parseChineseDateTime(row['評論時間']);
        const versionRaw = (row['應用程式版本名稱'] || '').trim();
        const version = versionRaw && versionRaw !== '-' ? versionRaw : null;
        const text = row['評論內容'] || '';
        const userName = row['評論人'] || '';
        // 這份匯出檔沒有唯一ID欄位，用「使用者+評論時間+內容前50字」組一個穩定的識別碼，
        // 只要原始資料沒變，重新產生報表時算出來的id會一樣，不會被誤判成「新評論」而重複計算。
        const id = 'csv-android-' + userName + '|' + (row['評論時間'] || '') + '|' + text.slice(0, 50);
        return {
          id,
          date: realDate ? realDate.toISOString().slice(0, 10) : null,
          score: row['星等'],
          text,
          version,
          userName,
        };
      })
      .filter((r) => r.date); // 日期解析失敗的直接跳過，避免髒資料混進報表
  }

  if (fs.existsSync(IOS_CSV_FILE)) {
    const rows = csvRowsToObjects(parseCsv(fs.readFileSync(IOS_CSV_FILE, 'utf-8')));
    result.ios = rows
      .map((row) => {
        const realDate = parseChineseDateTime(row['評論時間']);
        // 「4.13.0 - 台灣」這種格式，只取版本號部分
        const versionRaw = (row['版本'] || '').split(' - ')[0].trim();
        const version = versionRaw || null;
        const body = row['評論內容'] || '';
        const userName = row['評論人'] || '';
        // 轉成 YYYY/MM/DD，剛好對應到 parseIosDate() 原本就有支援的格式，不用另外改那個函式
        const isoLikeDate = realDate
          ? realDate.getFullYear() + '/' + String(realDate.getMonth() + 1).padStart(2, '0') + '/' + String(realDate.getDate()).padStart(2, '0')
          : null;
        return {
          date: isoLikeDate,
          rating: row['星等'],
          body,
          userName,
          version,
        };
      })
      .filter((r) => r.date);
  }

  return result;
}

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

// ===== 「整合式旅程痛點」tab 專用：服務藍圖 14 階段 + F/D/W 分類 =====
// ⚠️ 這份對照表是依現有 20 個分類的語意做的第一版草稿判斷，
//    不是逐則評論分類，而是「這個分類整體來說最像哪個階段、哪種類型」的一次性判斷。
//    請 Kai 實際看過評論內容後再調整 stage / type，尤其標了「?」的幾筆已知比較沒把握。
const JOURNEY_STAGES = ['選擇品牌','會員註冊','審核身份','搜尋欲租車輛','預定車輛','等待取車','前往取車','取車中','使用中','準備還車','還車','付款','還車後服務','狀況排除'];

const JOURNEY_MACRO_GROUPS = [
  { label: '用車前', span: 6 },
  { label: '用車中', span: 6 },
  { label: '用車後', span: 1 },
  { label: '客服',   span: 1 },
];

const JOURNEY_CHANNELS = {
  '選擇品牌':'官網/APP','會員註冊':'APP','審核身份':'APP','搜尋欲租車輛':'APP','預定車輛':'APP',
  '等待取車':'APP','前往取車':'APP','取車中':'APP/實體車輛','使用中':'APP/實體車輛','準備還車':'APP/實體車輛',
  '還車':'APP/實體車輛','付款':'APP','還車後服務':'APP','狀況排除':'APP/電話/Line/Chatbot',
};

const JOURNEY_FLOW_TEXT = {
  '選擇品牌':'學習使用方式 → 與競品比較差異',
  '會員註冊':'註冊 → 付款完成',
  '審核身份':'審核',
  '搜尋欲租車輛':'搜尋車輛 → 查看詳情',
  '預定車輛':'定車 → 預授權費用',
  '等待取車':'確認租車資訊',
  '前往取車':'前往取車地點',
  '取車中':'檢查車輛 → 拍照存證',
  '使用中':'發動 → 熟悉車輛 → 離開停車場 → 控制車輛',
  '準備還車':'找站點與車位 → 抵達停車場 → 即將逾時',
  '還車':'進入停車場 → 熄火 → 檢查車輛 → 拍照存證 → 車格與環境照',
  '付款':'發票明細 → 選擇付款方式 → 付款完成',
  '還車後服務':'問卷回饋 → 評價 → 推廣',
  '狀況排除':'發生異常狀況 → 進線客服 → 排除問題',
};

// 20個既有分類 → 14階段 + F/D/W類型（草稿，待確認）
const JOURNEY_CATEGORY_MAP = [
  { category: '定車相關',       stage: '預定車輛',     type: 'F', label: '定車/預約問題' },
  { category: '取車相關',       stage: '取車中',       type: 'F', label: '取車問題' },
  { category: '還車相關',       stage: '還車',         type: 'F', label: '還車問題' },
  { category: '客服',           stage: '狀況排除',     type: 'F', label: '客服無回應/未解決' }, // ? 也可能偏向W(等待回覆)，待確認
  { category: '審核',           stage: '審核身份',     type: 'D', label: '審核決策/條件不清' },
  { category: '付款',           stage: '付款',         type: 'F', label: '付款/扣款失敗' },
  { category: '站點與車輛數',   stage: '搜尋欲租車輛', type: 'F', label: '找不到可租車輛' },
  { category: '停權',           stage: '狀況排除',     type: 'D', label: '停權決策' },
  { category: '基本資料',       stage: '會員註冊',     type: 'F', label: '基本資料問題' },
  { category: '系統',           stage: '使用中',       type: 'F', label: '系統錯誤/閃退' },
  { category: '車輛設備',       stage: '使用中',       type: 'F', label: '車輛設備問題' },
  { category: '優惠碼/優惠券',  stage: '付款',         type: 'F', label: '優惠碼失效' },
  { category: '帳號',           stage: '會員註冊',     type: 'F', label: '帳號問題' },
  { category: '車損拍照',       stage: '還車',         type: 'F', label: '車損照片爭議' },
  { category: '通知',           stage: '準備還車',     type: 'W', label: '提醒/通知時機' }, // ? 通知類別橫跨多階段，暫歸還車前提醒
  { category: '軟體更新',       stage: '使用中',       type: 'F', label: '軟體更新問題' },
  { category: 'icon設計',       stage: '使用中',       type: 'F', label: 'icon/介面設計' },
  { category: '投保',           stage: '預定車輛',     type: 'D', label: '投保決策' },
  { category: '搜尋',           stage: '搜尋欲租車輛', type: 'F', label: '搜尋功能問題' },
  { category: '更改密碼',       stage: '會員註冊',     type: 'F', label: '改密碼問題' },
  { category: '共同承租人',     stage: '會員註冊',     type: 'D', label: '共同承租人審核' },
];

// 依 F/D/W 類型自動編號（F1, F2... D1... W1...），不強行對應論文原圖的代碼
(function assignJourneyCodes() {
  const counters = { F: 0, D: 0, W: 0 };
  JOURNEY_CATEGORY_MAP.forEach((item) => {
    counters[item.type] += 1;
    item.code = item.type + counters[item.type];
  });
})();

function computeJourneyPainPoints(reviews) {
  return JOURNEY_CATEGORY_MAP.map((item) => {
    const matched = reviews.filter((r) => r.categories.includes(item.category) && r.sentiment === 'negative');
    const android = matched.filter((r) => r.platform === 'android').length;
    const ios = matched.filter((r) => r.platform === 'ios').length;

    // 滿意度分數用「這個分類底下所有評論（不只負評）」的平均星等去換算，
    // 不能只看負評數量，否則評論量大的分類會被誤判成「更不滿意」。
    const allMatched = reviews.filter((r) => r.categories.includes(item.category) && typeof r.score === 'number');
    const allCount = allMatched.length;
    const avgScore = allCount > 0 ? allMatched.reduce((s, r) => s + r.score, 0) / allCount : null;

    return { ...item, count: matched.length, android, ios, allCount, avgScore };
  });
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
          version: r.version || null, // CSV匯出檔iOS也有版本欄位了（原本爬蟲抓不到才寫死null）
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

  function extractWordFrequency(reviews, ngramSizes) {
    const sizes = ngramSizes || [2];
    const freq = new Map();
    reviews.forEach((r) => {
      const text = r.text || '';
      const segments = text.match(/[\u4e00-\u9fa5]+/g) || [];
      // 用 Set 讓同一則評論裡重複出現的詞只算一次——
      // 這樣「詞出現的則數」才會跟點擊後看到的實際評論筆數一致，不會對不起來。
      const seenInThisReview = new Set();
      segments.forEach((seg) => {
        sizes.forEach((n) => {
          for (let i = 0; i <= seg.length - n; i++) {
            const gram = seg.slice(i, i + n);
            if (PHRASE_STOPWORDS.has(gram)) continue;
            if (SINGLE_CHAR_STOPWORDS.has(gram[0]) || SINGLE_CHAR_STOPWORDS.has(gram[gram.length - 1])) continue;
            seenInThisReview.add(gram);
          }
        });
      });
      seenInThisReview.forEach((gram) => {
        freq.set(gram, (freq.get(gram) || 0) + 1);
      });
    });
    return Array.from(freq.entries())
      .map(([word, count]) => ({ word, count }))
      .filter((w) => w.count >= 2) // 只出現在 1 則評論的詞雜訊太多，過濾掉
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }
  const wordFrequency = extractWordFrequency(allReviewsFlatWithManual);

  // ===== 近期熱門負評關鍵字（LIVE MONITOR 用）：近一年（12個月）的負評，雙字詞+三字詞一起抓 =====
  const recentMonthsForKeywords = lastNCalendarMonths(12);
  const recentNegativeReviews = allReviewsFlatWithManual.filter(
    (r) => r.sentiment === 'negative' && recentMonthsForKeywords.includes(r.month)
  );
  const recentNegativeWordFrequency = extractWordFrequency(recentNegativeReviews, [2, 3]).slice(0, 20);

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
    thisYearTotal: reviewsByRange.year.length, // 今年新增評論數（不分平台）
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
    recentNegativeWordFrequency,
    recentMonthsForKeywords,
    journeyPainPoints: computeJourneyPainPoints(allReviewsFlatWithManual),
  };
}

function renderHtml(dataset) {
  const dataJson = JSON.stringify(dataset);

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>阿葛格 宇航一等兵</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
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
    --ios: #00DDCD;
    --neg: #ff6b6b;
  }
  :root {
    --hud-glow: 198, 242, 78; /* 主色(lime)的RGB，供發光邊框/HUD文字使用；iOS專屬色維持獨立、不混用在這裡 */
    /* 青綠網格線專用色，數值跟 --ios(#00DDCD) 剛好一樣，但刻意獨立成一個變數：
       --ios 是「iOS平台識別色」，語意上跟這裡「HUD網格裝飾」是兩件事，
       分開宣告之後，之後想單獨調網格線濃淡/色相，不會不小心牽動到iOS相關UI的顏色。 */
    --hud-grid: 0, 221, 205;
  }
  .mono{
    font-family: "JetBrains Mono", "Space Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .status-pill{
    display:inline-flex; align-items:center; gap:5px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size:10.5px; font-weight:700; letter-spacing:0.03em;
    padding:3px 9px; border-radius:20px; text-transform:uppercase;
    border:1px solid currentColor;
  }
  .status-pill::before{ content:''; width:6px; height:6px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .status-pill.status-ok{ color:#00E676; background:rgba(0,230,118,0.08); }
  .status-pill.status-warn{ color:#FFAA00; background:rgba(255,170,0,0.08); }
  .status-pill.status-critical{ color:#FF3860; background:rgba(255,56,96,0.10); }
  @keyframes pillPulse{ 0%,100%{ opacity:1; } 50%{ opacity:0.55; } }
  .status-pill.status-critical::before{ animation: pillPulse 1.3s ease-in-out infinite; }
  .info-hint{
    display:inline-block;
    color:var(--muted);
    font-size:0.78em;
    cursor:pointer;
    position:relative;
    vertical-align:middle;
    line-height:1;
    margin-left:1px;
  }
  .info-hint:hover, .info-hint.open{ color:rgb(var(--hud-glow)); }
  .info-hint-pop{
    display:none; position:absolute; z-index:40; top:22px; left:50%; transform:translateX(-50%);
    width:260px; background:#11151d; border:1px solid rgba(var(--hud-glow),0.35);
    border-radius:8px; padding:10px 12px; font-size:11.5px; line-height:1.6; color:var(--muted);
    font-weight:400; text-transform:none; letter-spacing:normal; cursor:default;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 12px rgba(var(--hud-glow),0.12);
  }
  .info-hint.open .info-hint-pop{ display:block; }
  @media (hover:hover){
    .info-hint:hover .info-hint-pop{ display:block; }
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
    position: relative;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -2;
    pointer-events: none;
    /* 全域微掃描線：極淡的橫向線條紋理，疊在原本的星點雜訊「上面」（寫在前面的圖層在上層），
       每3px一條、透明度只有2.5%，做出老式CRT螢幕的掃描線質感，跟下面的星點雜訊共用同一顆
       偽元素、同一個z-index，不需要另外佔用一層。 */
    background-image:
      repeating-linear-gradient(
        0deg,
        rgba(255,255,255,0.025) 0px,
        rgba(255,255,255,0.025) 1px,
        transparent 1px,
        transparent 3px
      ),
      radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px);
    background-size: 100% 3px, 26px 26px;
  }
  body::after {
    content: '';
    position: fixed;
    inset: -30%;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(120deg, transparent 42%, rgba(var(--hud-glow), 0.05) 50%, transparent 58%);
    animation: bgScanSweep 10s ease-in-out infinite;
  }
  @keyframes bgScanSweep {
    0%   { transform: translate(-15%, -15%); }
    50%  { transform: translate(15%, 15%); }
    100% { transform: translate(-15%, -15%); }
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
    align-items: flex-start;
  }
  .card {
    background: #C6F24E;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    position: relative;
  }
  .card::before, .card::after {
    content: '';
    position: absolute;
    width: 12px;
    height: 12px;
    pointer-events: none;
    border: 1.5px solid rgba(26, 26, 26, 0.4);
  }
  .card::before {
    top: 5px;
    left: 5px;
    border-right: none;
    border-bottom: none;
  }
  .card::after {
    bottom: 5px;
    right: 5px;
    border-left: none;
    border-top: none;
  }
  .card.card-square {
    aspect-ratio: 1 / 1;
    width: 140px;
    flex-shrink: 0;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    position: relative;
  }
  .card.card-square .label-wrap {
    position: relative;
    height: 2.4em; /* 固定保留 2 行的高度，不管文字實際幾行，數字位置都會對齊 */
    margin-bottom: 3px;
  }
  .card.card-square .label {
    font-size: 14px;
    line-height: 1.2;
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    margin: 0;
  }
  .card.card-square .value {
    font-size: 34px;
    line-height: 1.1;
  }
  .card-badge-note {
    position: absolute;
    bottom: 8px;
    right: 10px;
    font-size: 9px;
    color: #1a1a1a;
    opacity: 0.55;
  }
  .card-sub {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 8px;
    line-height: 1.3;
    display: flex;
    align-items: baseline;
    gap: 4px;
    white-space: nowrap;
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
  .card .label-wrap {
    position: relative;
    height: 2.4em; /* 固定保留 2 行的高度，不管文字實際幾行，數字位置都會對齊 */
    margin-bottom: 6px;
  }
  .card .label {
    color: #1a1a1a;
    font-size: 12px;
    opacity: 0.7;
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    margin: 0;
  }
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
  @media (hover: hover) {
    .card.card-clickable:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
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

  .group-panel { display: none; }
  .group-panel.active { display: block; }

  .group-nav{
    display:flex; gap:12px; margin-bottom:24px; flex-wrap:wrap;
  }
  .group-btn{
    flex:1; min-width:220px; display:flex; align-items:center; gap:12px;
    background: rgba(23, 26, 33, 0.82);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border:1px solid var(--border);
    border-radius:10px; padding:14px 18px; cursor:pointer;
    font-family: inherit; text-align:left; transition: border-color .15s, box-shadow .15s;
  }
  .group-btn:hover{ border-color: rgba(var(--hud-glow), 0.35); }
  .group-btn.active{
    border-color: rgb(var(--hud-glow));
    background: rgba(var(--hud-glow), 0.15);
    box-shadow: 0 0 15px rgba(var(--hud-glow), 0.15);
  }
  /* 「收藏」獨立出來放在三大按鈕右邊，但比重要比它們小一號，不是等寬的第四個分組 */
  .group-btn.group-btn-mini{
    flex: 0 0 auto;
    min-width: 0;
    padding: 14px 16px;
  }
  .group-btn-mini .group-icon{ font-size:18px; }
  .group-btn-mini .group-title{ font-size:11px; }
  .group-btn-mini .group-subtitle{ font-size:11px; }
  .group-icon{ font-size:22px; line-height:1; flex-shrink:0; }
  .group-text{ display:flex; flex-direction:column; gap:2px; }
  .group-title{
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size:13px; font-weight:700; letter-spacing:0.04em; color: var(--muted);
  }
  .group-btn.active .group-title{ color: rgb(var(--hud-glow)); }
  .group-subtitle{ font-size:12px; color: var(--muted); opacity:0.75; }
  /* 常態就先用同一個 ::after 佔好底線指標的寬度空間（opacity:0 隱形，但寬度已經算進按鈕裡），
     未選取／打字中／打完字閃爍這幾個狀態下的按鈕寬度就會完全一致，不會因為指標突然被插入
     文件流而把按鈕往右撐開、跟著抖動。 */
  .group-title::after{
    content:'_';
    display:inline-block;
    margin-left:2px;
    opacity:0;
  }
  /* 打字動效播完之後，只切換 opacity 並套用閃爍動畫，不再動態新增/移除這個佔位字元本身 */
  .group-title.caret-blink::after{
    opacity:1;
    animation: groupCaretBlink 1s steps(1) infinite;
  }
  @keyframes groupCaretBlink{ 50%{ opacity:0; } }

  .anomaly-row{ display:flex; align-items:center; gap:9px; padding:8px 2px; border-bottom:1px solid var(--border); font-size:12px; cursor:pointer; }
  .anomaly-row:last-child{ border-bottom:none; }
  .anomaly-row:hover{ background: rgba(255,255,255,0.03); }
  .anomaly-severity{ width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .anomaly-severity.critical{ background:#FF3860; box-shadow:0 0 6px rgba(255,56,96,0.8); }
  .anomaly-severity.warn{ background:#FFAA00; }
  .anomaly-tag-type{ font-size:10px; color:var(--muted); width:34px; flex-shrink:0; letter-spacing:0.03em; }
  .anomaly-label{ flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .anomaly-label.critical{ color:#FF3860; }
  .anomaly-label.warn{ color:#FFAA00; }
  .anomaly-count{ color:var(--muted); font-size:11px; flex-shrink:0; }

  .radar-scan-wrap{ overflow: hidden; border-radius: 8px; position: relative; }

  @keyframes anomalyRowIn {
    from { opacity: 0; transform: translateX(8px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .anomaly-row{ animation: anomalyRowIn 0.35s ease-out both; }

  .anomaly-divider{ border-top:1px solid var(--border); margin:16px 0 14px; }

  .live-grid{
    display:grid;
    grid-template-columns: 1fr 1.6fr 1fr;
    gap:20px;
    align-items:start;
  }
  /* Grid item 預設 min-width:auto，代表欄位不會縮小到比內部內容的「最小內容寬度」還窄；
     一旦欄位裡出現不可縮小的固定寬度內容（例如底下的LED Meter，一列裡label/track/count都是
     固定px、flex-shrink:0），這個欄位（甚至整個 .live-grid）就會被撐寬到超過版面、超出視窗，
     在窄螢幕上就是使用者看到的「內容跑出邊界」。加 min-width:0 讓欄位可以正常縮小，
     真正裝不下的內容改由下面 .led-track 內部自己 overflow-x:auto 處理，不會再往外撐開整個頁面。 */
  .live-grid > div { min-width: 0; }
  /* LED Meter 的實際內容（5列燈條+刻度尺）高度通常比卡片被撐開後的高度矮很多
     （卡片高度是跟左欄的KPI+平台佔比對齊撐高的，見syncKeywordCardHeight）。
     容器內容用置中對齊，讓多出來的空白平均分配在上下，不要整段都堆積在LED meter下方。 */
  #keywordChartCard .chart-container{
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  @media (max-width:1100px){
    .live-grid{ grid-template-columns: 1fr; }
    #keywordChartCard{ display:block; }
    #keywordChartCard .chart-container{ flex:none; height:220px; }
  }
  .live-col-3{
    display:flex;
    flex-direction:column;
    gap:20px;
  }
  .live-col-3 .live-col-anomaly{
    flex:1;
    display:flex;
    flex-direction:column;
    min-height:0;
  }
  .live-col-3 .live-col-anomaly #anomalyList{
    flex:1;
    overflow-y:auto;
    /* 最小高度安全網：正常情況下靠 flex:1 自動填滿/收縮以對齊左欄底部，
       但視窗高度極端不足時，寧可讓清單保有基本可讀高度、把整個頁面推長出現捲軸，
       也不要被壓縮到看不見（見 syncLiveColumnHeights 裡搭配的 naturalHeight 判斷）。 */
    min-height:160px;
  }
  .live-col-kpi{
    display:grid; grid-template-columns: 1fr 1fr; gap:14px;
  }
  .live-col-kpi .card:nth-child(3){ grid-column: 1 / -1; }
  .live-col-anomaly{ margin-bottom:0; }
  /* ===== LIVE MONITOR：突發異常警示橫幅（第三欄，疊在「系統異常與熱門痛點」正上方） =====
     資料來源跟 DEEP INSIGHTS／AI 洞察 tab 裡的 aiAlertBanner 共用同一份 insights.json 的
     anomaly_alert，這裡只是同一筆資料的第二個呈現位置，讓使用者在LIVE頁就能看到並點擊跳轉。 */
  .chart-card.live-anomaly-alert{
    display:flex;
    align-items:flex-start;
    gap:10px;
    margin-bottom:0;
    cursor:pointer;
    background: rgba(255,56,96,0.08);
    border:1px solid rgba(255,56,96,0.35);
    transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }
  .chart-card.live-anomaly-alert:hover,
  .chart-card.live-anomaly-alert:focus-visible{
    background: rgba(255,56,96,0.15);
    border-color: rgba(255,56,96,0.6);
    box-shadow: 0 0 15px rgba(255,56,96,0.18);
    outline:none;
  }
  .chart-card.live-anomaly-alert:active{ transform: scale(0.997); }
  .live-anomaly-alert-text{ flex:1; min-width:0; }
  .chart-card.live-col-radar{
    padding-top: 0;
    padding-left: 0;
    padding-right: 0;
    padding-bottom: 14px; /* 圖例(本期/上期)跟卡片底部邊界之間留一點呼吸空間，不要緊貼在一起 */
    overflow: hidden;
  }
  .live-col-radar .radar-scan-wrap{
    border-radius: 12px;
  }
  .live-col-radar h2{
    position: absolute;
    top: 14px;
    left: 0;
    right: 0;
    z-index: 3;
    pointer-events: none;
  }
  .live-col-radar h2 .info-hint{
    pointer-events: auto;
  }

  .chart-card {
    background: rgba(23, 26, 33, 0.82);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(var(--hud-glow), 0.18);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
    box-shadow: 0 0 15px rgba(var(--hud-glow), 0.06);
    position: relative;
  }
  .chart-card::before, .chart-card::after {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    pointer-events: none;
    border: 1px solid rgba(var(--hud-glow), 0.55);
  }
  .chart-card::before {
    top: -1px;
    left: -1px;
    border-right: none;
    border-bottom: none;
    border-radius: 4px 0 0 0;
  }
  .chart-card::after {
    bottom: -1px;
    right: -1px;
    border-left: none;
    border-top: none;
    border-radius: 0 0 4px 0;
  }
  .chart-card h2 { font-size: 14px; margin: 0 0 16px; color: var(--muted); font-weight: 500; }

  /* ===== 「近期熱門負評關鍵字」LED Meter（戰術點陣微格）=====
     每條軌道固定40格微型燈格，命中筆數決定點亮幾格；超過40筆上限時全數點亮，
     末端5格轉琥珀色代表過載。取代原本的 Chart.js 長條圖，改成純 DOM/CSS 渲染。 */
  .led-meter {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .led-row {
    display: flex;
    align-items: center;
    gap: 14px;
    cursor: pointer;
    padding: 3px 4px;
    border-radius: 2px;
    transition: background 0.15s ease;
  }
  @media (hover: hover) {
    .led-row:hover { background: rgba(255,255,255,0.04); }
  }
  .led-label {
    width: 118px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .led-idx {
    font-family: "JetBrains Mono", "Space Mono", ui-monospace, monospace;
    font-size: 11px;
    color: rgb(var(--hud-grid));
    margin-right: 2px;
  }
  .led-slash {
    font-family: "JetBrains Mono", "Space Mono", ui-monospace, monospace;
    font-size: 11px;
    color: var(--muted);
    margin-right: 5px;
  }
  .led-track-scroll {
    /* 安全網：正常情況下容器夠寬，這層幾乎不會觸發捲動；只有在螢幕極窄、
       就算套用下面 640px 斷點的縮小版尺寸也還是放不下時，才會在「這一列自己的範圍內」
       橫向捲動，不會撐開 .chart-card、更不會撐開整個頁面（配合上面 .live-grid > div 的
       min-width:0 一起生效）。隱藏捲軸是為了維持HUD儀表的視覺乾淨。 */
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .led-track-scroll::-webkit-scrollbar { display: none; }
  .led-track {
    display: flex;
    gap: 2px;
    width: 100%;
  }
  .led-seg {
    /* RWD：flex-grow讓燈格在大螢幕、卡片夠寬時可以長寬一點，不要固定死3px造成
       右邊留一大片空白；flex-shrink:0 + flex-basis 3px 是小螢幕的下限，維持原本
       「小網沒問題」的樣子不變——螢幕不夠寬時容器本身沒有多餘空間可以grow，
       行為會跟改之前完全一樣；真的連3px的下限都放不下，交給.led-track-scroll捲動。 */
    flex: 1 0 3px;
    max-width: 10px;
    height: 12px;
    border-radius: 1px;
    background: rgba(255,255,255,0.05);
    opacity: 0;
    transform: scaleY(0.35);
    animation: ledSweepIn 0.22s ease forwards;
    animation-delay: var(--seg-delay, 0ms);
  }
  .led-seg.is-active {
    background: rgb(var(--hud-glow));
    box-shadow: 0 0 6px rgba(var(--hud-glow), 0.45);
    transition: box-shadow 0.2s ease;
  }
  .led-seg.is-overload {
    background: #FFB000;
    box-shadow: 0 0 6px rgba(255,176,0,0.5);
    transition: box-shadow 0.2s ease;
  }
  @media (hover: hover) {
    .led-row:hover .led-seg.is-active { box-shadow: 0 0 10px rgba(var(--hud-glow), 0.8); }
    .led-row:hover .led-seg.is-overload { box-shadow: 0 0 10px rgba(255,176,0,0.85); }
  }
  @keyframes ledSweepIn {
    from { opacity: 0; transform: scaleY(0.35); }
    to { opacity: 1; transform: scaleY(1); }
  }
  .led-count {
    font-family: "JetBrains Mono", "Space Mono", ui-monospace, monospace;
    font-size: 12px;
    color: rgb(var(--hud-glow));
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 64px;
    text-align: right;
  }
  .led-count.is-overload { color: var(--neg); }
  .led-scale {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 2px;
  }
  .led-scale-spacer { width: 118px; flex-shrink: 0; }
  .led-scale-spacer-right { width: 64px; flex-shrink: 0; }
  .led-scale-track-scroll {
    /* 跟 .led-track-scroll 用同一套 flex 規則（flex:1 1 auto; min-width:0），
       確保刻度尺的寬度在任何螢幕寬度下都會跟上面燈條的實際寬度算出同一個結果，
       刻度用百分比定位（見 buildScaleTicks()）才能穩定對齊，不用額外寫JS去量測燈條寬度。 */
    flex: 1 1 auto;
    min-width: 0;
  }
  .led-scale-track {
    position: relative;
    width: 100%;
    height: 9px;
  }
  .led-scale-track .tick {
    position: absolute;
    top: 0;
    width: 1px;
  }
  .led-scale-track .tick.major {
    height: 8px;
    background: rgba(var(--hud-grid), 0.4);
  }
  .led-scale-track .tick.minor {
    height: 3px;
    background: rgba(255,255,255,0.15);
  }
  /* 窄螢幕：縮小 label 欄寬、列間距、字級，盡量讓完整198px的燈條不用捲動就能顯示；
     真的還是放不下的極窄裝置，就交給上面 .led-track-scroll 的 overflow-x:auto 兜底。
     燈格本身尺寸（3px/2px間隙）刻意不縮小，維持規格要求的實體尺寸。 */
  @media (max-width: 640px) {
    .led-row { gap: 8px; }
    .led-scale { gap: 8px; }
    .led-label { width: 76px; font-size: 11px; }
    .led-scale-spacer { width: 76px; }
    .led-count { font-size: 11px; }
  }

  .h2-note {
    color: var(--muted);
    font-size: 11px;
    margin-top: -12px;
    margin-bottom: 16px;
  }
  .insight-headline-stat {
    font-size: 15px;
    font-weight: 700;
    color: #C6F24E;
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .insight-headline-stat .headline-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
    margin-left: 6px;
  }
  .three-col {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 20px;
    align-items: start; /* 三張卡片高度各自獨立，展開其中一張時不會用CSS Grid預設的stretch
                            把另外兩張的外框也一起撐高（那樣視覺上會像另外兩張也跟著展開） */
  }
  @media (max-width: 900px) {
    .three-col { grid-template-columns: 1fr; }
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
  @media (hover: hover) {
    .insight-card:hover {
      border-color: #454b58;
      box-shadow: 0 0 24px rgba(198, 242, 78, 0.15);
    }
    .insight-card:hover h2 { color: #C6F24E; transition: color 0.2s ease; }
  }

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

  /* ===== 自動摘要：3 個結構化卡片（What&Where / Change&Health / Context&Action） ===== */
  .insight-card-v2 h2 { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
  .insight-card-v2 .h2-note { font-size:10px; font-weight:500; color:var(--muted); font-family:"JetBrains Mono", ui-monospace, monospace; letter-spacing:0.03em; }

  .insight-v2-headline { font-size:14px; font-weight:700; color:#C6F24E; line-height:1.5; margin-bottom:12px; }
  .insight-v2-toplist { display:flex; flex-direction:column; gap:2px; }
  .insight-v2-item { display:flex; align-items:center; gap:8px; font-size:12px; padding:7px 2px; border-bottom:1px solid var(--border); cursor:pointer; white-space:nowrap; }
  .insight-v2-item:last-child { border-bottom:none; }
  .insight-v2-item:hover { background: rgba(255,255,255,0.03); }
  .insight-v2-item .rank { color:var(--muted); font-family:"JetBrains Mono", ui-monospace, monospace; font-size:11px; flex-shrink:0; width:18px; }
  .insight-v2-item .item-label { flex:1; overflow:hidden; text-overflow:ellipsis; }
  .insight-v2-item .item-count { color:var(--muted); font-size:11px; flex-shrink:0; }

  .insight-v2-compare { display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; }
  @media (max-width:900px) { .insight-v2-compare { grid-template-columns:1fr; } }
  .insight-v2-compare-col { display:flex; flex-direction:column; gap:2px; }
  .insight-v2-compare-title { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px; }
  .insight-v2-metric { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:12px; padding:6px 0; border-bottom:1px solid var(--border); white-space:nowrap; }
  .insight-v2-metric:last-child { border-bottom:none; }
  .insight-v2-metric .metric-label { color:var(--text); overflow:hidden; text-overflow:ellipsis; }
  .insight-v2-metric .metric-value { font-family:"JetBrains Mono", ui-monospace, monospace; flex-shrink:0; }
  .insight-v2-metric .metric-delta { font-family:"JetBrains Mono", ui-monospace, monospace; font-weight:700; margin-left:4px; }
  .insight-v2-metric .metric-delta.up { color:#4ade8f; }
  .insight-v2-metric .metric-delta.down { color:#ff6b6b; }
  .insight-v2-metric .metric-delta.flat { color:var(--muted); font-weight:500; }

  .insight-v2-tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  .insight-v2-tag { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:999px; background:rgba(198,242,78,0.12); color:#C6F24E; font-size:11px; font-family:"JetBrains Mono", ui-monospace, monospace; cursor:pointer; border:none; }
  .insight-v2-tag:hover { background:rgba(198,242,78,0.22); }
  .insight-v2-quote { border-left:2px solid var(--border); padding:8px 12px; margin-bottom:12px; font-size:12px; color:var(--muted); line-height:1.6; font-style:italic; cursor:pointer; }
  .insight-v2-quote:hover { border-left-color:rgb(var(--hud-glow)); color:var(--text); }
  .insight-v2-actions { display:flex; flex-direction:column; gap:7px; }
  .insight-v2-action { font-size:12px; line-height:1.6; padding-left:16px; position:relative; }
  .insight-v2-action::before { content:'▸'; position:absolute; left:0; color:rgb(var(--hud-glow)); }

  /* ===== AI 智慧洞察與版本預警卡片 ===== */
  .ai-alert-banner {
    display:flex; align-items:flex-start; gap:10px;
    background: rgba(255,56,96,0.08);
    border:1px solid rgba(255,56,96,0.35);
    border-radius:8px;
    padding:10px 14px;
    margin-bottom:16px;
  }
  .ai-alert-dot {
    width:9px; height:9px; border-radius:50%; margin-top:4px; flex-shrink:0;
    background:#FF3860;
    box-shadow:0 0 8px rgba(255,56,96,0.8);
    animation: aiAlertBreathe 1.6s ease-in-out infinite;
  }
  @keyframes aiAlertBreathe {
    0%,100% { opacity:1; transform:scale(1); }
    50% { opacity:0.4; transform:scale(0.75); }
  }
  .ai-alert-title { font-size:13px; font-weight:700; color:#FF6B85; line-height:1.5; }
  .ai-alert-meta { font-size:11px; color:var(--muted); margin-top:3px; }

  .ai-issue-list { display:flex; flex-direction:column; gap:10px; margin-bottom:6px; }
  .ai-issue-item { border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:rgba(255,255,255,0.02); }
  .ai-issue-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
  .ai-issue-rank { font-family:"JetBrains Mono", ui-monospace, monospace; font-size:11px; color:rgb(var(--hud-glow)); font-weight:700; }
  .ai-issue-title { font-size:13px; font-weight:600; color:var(--text); flex:1; min-width:120px; }
  .ai-issue-count { padding:2px 8px; border-radius:999px; font-size:10.5px; font-weight:700; background:rgba(255,170,0,0.12); color:#FFAA00; font-family:"JetBrains Mono", ui-monospace, monospace; white-space:nowrap; }
  .ai-issue-quote { border-left:2px solid var(--border); padding:6px 10px; font-size:12px; color:var(--muted); line-height:1.6; font-style:italic; }

  /* ===== 自動摘要 v2：3張卡片（版本評分與健康度／歷史高頻痛點Top5／近期異動與行動指引），
     收合時只顯示 headline + 精簡圖表，點擊「整張卡片」（跟「回饋洞察」四張卡片同樣的互動方式，
     排除圖表/標籤/詳情表格本身的點擊）展開內嵌詳情表格；同一時間只允許一張卡片展開，
     點別張卡片時，原本展開的會自動收合。詳情表格用獨立的 .card-detail-drawer 包起來
     （max-height 0→scrollHeight 過渡），跟卡片本身的高度變化分開處理。 ===== */
  .auto-card { cursor:pointer; user-select:none; transition:box-shadow 0.2s ease, border-color 0.2s ease; }
  @media (hover: hover) {
    .auto-card:hover { border-color:#454b58; box-shadow:0 0 24px rgba(198, 242, 78, 0.15); }
    .auto-card:hover h2 { color:#C6F24E; transition:color 0.2s ease; }
  }
  .auto-card-header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:14px; }
  .auto-card-header h2 { margin:0; }
  .auto-card .insight-v2-headline { margin-bottom:10px; }
  .auto-card-chart-wrap { height:168px; position:relative; }
  .card-detail-drawer { max-height:0; overflow:hidden; transition:max-height 0.35s ease; }
  .auto-detail-inner { padding-top:14px; margin-top:14px; border-top:1px solid var(--border); }
  .auto-detail-table { width:100%; border-collapse:collapse; font-size:11.5px; }
  .auto-detail-table th, .auto-detail-table td { text-align:left; padding:7px 6px; border-bottom:1px solid var(--border); white-space:nowrap; vertical-align:top; }
  .auto-detail-table th { color:var(--muted); font-weight:500; font-size:10.5px; text-transform:uppercase; letter-spacing:0.03em; }
  .auto-detail-table tbody tr.clickable-row { cursor:pointer; }
  @media (hover: hover) {
    .auto-detail-table tbody tr.clickable-row:hover { background: rgba(255,255,255,0.04); }
  }
  .auto-delta.up { color:#4ade8f; font-weight:700; }
  .auto-delta.down { color:#ff6b6b; font-weight:700; }
  .auto-delta.flat { color:var(--muted); }
  .auto-card-tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  tr.clickable-row { cursor: pointer; }
  @media (hover: hover) {
    tr.clickable-row:hover { background: rgba(255,255,255,0.04); }
  }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 720px) {
    .two-col { grid-template-columns: 1fr; }
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; white-space: nowrap; }
  /* 表格欄位預設一律不折行（含標題），只有實際評論內容本身允許正常換行 */
  .review-text, .review-meta { white-space: normal; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.android { background: rgba(198,242,78,0.15); color: var(--android); }
  .badge.ios { background: rgba(0,221,205,0.15); color: var(--ios); }
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
    border-color: #00DDCD;
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
    .card .value { font-size: 32px; line-height: 1.1; margin-bottom: 4px; }
    .card.card-square { width: 108px; padding: 8px 10px; }
    .card.card-square .label { font-size: 13px; }
    .card.card-square .value { font-size: 24px; }
    .card-sub {
      position: static;
      left: auto; right: auto; bottom: auto;
      margin-top: 6px;
    }
    .card-sub-label { font-size: 10px; }
    .card-sub-value { font-size: 12px; }
    .card-badge-note {
      position: static;
      display: block;
      text-align: right;
      margin-top: 4px;
    }
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
    overscroll-behavior: contain;
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
  @media (hover: hover) {
    .star-btn:hover { transform: scale(1.15); }
  }
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

  /* ===== 整合式旅程痛點 tab ===== */
  .jp-card-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:24px; flex-wrap:wrap; margin-bottom:14px; }
  .jp-card-head-title{ flex:1; min-width:220px; }
  .jp-card-head-tools{ flex:0 0 auto; max-width:100%; }
  .jp-info-toggle-row{ margin-bottom:4px; }
  .jp-info-toggle{ display:flex; align-items:center; gap:5px; background:var(--bg); border:1px solid var(--border); color:var(--muted); font-size:11px; font-family:inherit; padding:6px 11px; border-radius:20px; cursor:pointer; flex-shrink:0; white-space:nowrap; }
  .jp-info-toggle:hover{ color:var(--text); }
  .jp-info-toggle .jp-chev{ transition:transform .15s; font-size:9px; }
  .jp-info-toggle.open .jp-chev{ transform:rotate(180deg); }
  .jp-info-box{ max-height:0; overflow:hidden; transition:max-height .25s ease; background:var(--bg); border:1px solid var(--border); border-radius:10px; }
  .jp-info-box.open{ max-height:900px; margin:10px 0 14px; }
  .jp-info-box-inner{ padding:14px 16px; }
  .jp-info-section{ margin-bottom:14px; }
  .jp-info-section:last-child{ margin-bottom:0; }
  .jp-info-section h4{ font-size:12px; margin:0 0 6px; color:var(--text); }
  .jp-info-section p{ font-size:11.5px; line-height:1.7; color:var(--muted); margin:0 0 6px; }
  .jp-info-list{ margin:0; padding-left:18px; font-size:11.5px; line-height:1.8; color:var(--muted); }
  .jp-info-list b{ color:var(--text); }
  .jp-type-row{ display:flex; align-items:flex-start; gap:8px; margin-bottom:7px; }
  .jp-type-row:last-child{ margin-bottom:0; }
  .jp-type-text{ font-size:11.5px; line-height:1.6; color:var(--muted); }
  .jp-type-text b{ color:var(--text); font-weight:600; }

  .jp-toolbar{ display:flex; flex-wrap:wrap; gap:18px; align-items:center; background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:12px 16px; font-size:12.5px; }
  .jp-legend-group{ display:flex; align-items:center; gap:10px; }
  .jp-legend-item{ display:flex; align-items:center; gap:5px; color:var(--muted); }
  .jp-icon{ width:16px; height:16px; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#111; }
  .jp-divider-v{ width:1px; height:20px; background:var(--border); }
  .jp-filter-group{ display:flex; align-items:center; gap:8px; }
  .jp-chip{ display:flex; align-items:center; gap:5px; padding:4px 10px; border-radius:14px; border:1px solid var(--border); cursor:pointer; color:var(--muted); user-select:none; background:var(--card); }
  .jp-chip.active{ color:var(--text); border-color:currentColor; }
  .jp-dot{ width:9px; height:9px; border-radius:50%; }

  .jp-board-section{ width:100%; }
  /* 流程複雜度×痛點密集度 / 痛點排行榜：維持原本一行四欄的寬度不變，
     點擊任一區塊時該卡片自己向下展開顯示更多內容，寬度跟另一個區塊都不受影響。 */
  .jp-charts-grid{ display:grid; grid-template-columns:repeat(4, 1fr); gap:20px; margin-top:20px; align-items:start; }
  @media (max-width:1180px){
    .jp-charts-grid{ grid-template-columns:repeat(2, 1fr); }
  }
  @media (max-width:720px){
    .jp-charts-grid{ grid-template-columns:1fr; }
  }
  .jp-expandable-card {
    cursor: pointer;
    user-select: none;
    overflow: hidden;
    transition: max-height 0.35s ease;
  }
  @media (hover: hover) {
    .jp-expandable-card:hover {
      border-color: #454b58;
      box-shadow: 0 0 24px rgba(198, 242, 78, 0.15);
    }
    .jp-expandable-card:hover h2 { color: #C6F24E; transition: color 0.2s ease; }
  }

  .jp-board-wrap{ overflow-x:auto; padding-bottom:14px; }
  .jp-board{ min-width:1080px; position:relative; }
  .jp-macro-divider{ position:absolute; top:0; width:1px; background:rgba(255,255,255,0.12); pointer-events:none; z-index:1; }
  .jp-row{ display:flex; gap:8px; align-items:stretch; padding:12px 0; }
  .jp-row.jp-section-divider{ border-top:1px solid rgba(255,255,255,0.07); }
  .jp-row-label{ flex:0 0 82px; display:flex; align-items:center; justify-content:space-between; font-size:11px; color:var(--muted); padding-left:2px; }
  .jp-row-label .jp-arrow{ cursor:pointer; color:var(--muted); font-size:12px; transition:transform .15s, color .15s; padding:4px; }
  .jp-row-label .jp-arrow:hover{ color:var(--text); }
  .jp-row-label .jp-arrow.open{ transform:rotate(180deg); }
  .jp-grid{ display:grid; grid-template-columns:repeat(14,1fr); gap:6px; flex:1; }

  .jp-macro-cell{ border-radius:6px; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; min-height:32px; letter-spacing:0.04em; color:#111; background:#C6F24E; }
  .jp-stage-cell{ background:#3a4560; border-radius:6px; color:#fff; font-size:9.5px; font-weight:600; text-align:center; display:flex; align-items:center; justify-content:center; min-height:36px; padding:4px 2px; transition:box-shadow .3s; }
  .jp-stage-cell.flash{ box-shadow:0 0 0 2px var(--android); }
  .jp-channel-cell{ font-size:9px; color:var(--muted); text-align:center; display:flex; align-items:center; justify-content:center; min-height:20px; }
  .jp-flow-cell{ font-size:9px; color:var(--muted); text-align:center; display:flex; align-items:center; justify-content:center; line-height:1.35; padding:5px 3px; min-height:40px; }

  .jp-action-cell{ background:var(--card); border:1px solid var(--border); border-radius:8px; min-height:96px; display:flex; flex-direction:column; justify-content:flex-end; padding:8px 5px 0; position:relative; overflow:hidden; }
  .jp-action-cell.jp-empty-stage{ opacity:0.45; }
  .jp-action-top{ flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; min-height:34px; }
  .jp-no-data{ font-size:9px; color:var(--muted); }
  .jp-dots{ display:flex; flex-wrap:wrap; gap:3px; justify-content:center; }
  .jp-point{ border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:7.5px; font-weight:700; color:#111; cursor:pointer; border:1.5px solid rgba(255,255,255,0.25); transition:transform .12s; }
  .jp-point:hover{ transform:scale(1.18); }
  .jp-mini-bar-track{ width:100%; height:6px; background:var(--bg); border-radius:2px; overflow:hidden; margin-top:6px; }
  .jp-mini-bar-fill{ height:100%; border-radius:2px; }
  .jp-total-count{ font-size:9px; color:var(--muted); text-align:center; padding:4px 0 6px; }

  .jp-satisfaction-cell{ background:var(--card); border:1px solid var(--border); border-radius:8px; min-height:64px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:8px 5px; }
  .jp-satisfaction-score{ font-size:18px; font-weight:700; line-height:1; }
  .jp-satisfaction-scale{ font-size:9px; color:var(--muted); margin-top:-2px; }
  .jp-satisfaction-track{ width:80%; height:5px; background:var(--bg); border-radius:3px; overflow:hidden; margin-top:4px; }
  .jp-satisfaction-fill{ height:100%; border-radius:3px; }

  .jp-row-label.jp-row-label-stacked{ flex-direction:column; align-items:flex-start; justify-content:center; gap:2px; }
  .jp-row-label-main{ font-weight:600; color:var(--text); }
  .jp-row-sublabel{ font-size:8px; line-height:1.35; color:var(--muted); opacity:0.85; }

  .jp-collapsible{ overflow:hidden; transition:max-height .2s ease; max-height:0; flex:1; }
  .jp-collapsible.open{ max-height:80px; }
  .jp-front-cell, .jp-back-cell{ background:var(--card); border:1px solid var(--border); border-radius:6px; min-height:40px; display:flex; align-items:center; justify-content:center; font-size:9px; color:var(--muted); text-align:center; padding:4px; }
  .jp-back-cell.jp-empty{ opacity:0.25; }

  .jp-quad-label{ font-size:9.5px; fill:var(--muted); }
  .jp-quad-point{ cursor:pointer; }
  .jp-quad-point circle{ transition:r .12s, stroke-width .12s; }
  .jp-quad-point:hover circle{ stroke:#fff; stroke-width:1.5; }
  .jp-quad-point text{ font-size:8.5px; fill:var(--text); font-weight:600; pointer-events:none; }
  .jp-quad-axis{ font-size:9.5px; fill:var(--muted); }
  .jp-quad-line{ stroke:var(--border); stroke-width:1; }
  .jp-quad-grid{ stroke:var(--border); stroke-width:1; stroke-dasharray:3 3; opacity:0.5; }
  .jp-priority-list{ display:flex; flex-direction:column; gap:6px; margin-top:10px; }
  .jp-priority-item{ display:flex; align-items:center; gap:8px; background:var(--card); border-radius:8px; padding:7px 9px; cursor:pointer; }
  .jp-priority-item:hover{ outline:1px solid var(--border); }
  .jp-priority-rank{ width:18px; height:18px; border-radius:50%; background:var(--neg); color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .jp-priority-name{ font-size:11.5px; font-weight:600; flex:1; }
  .jp-priority-meta{ font-size:10px; color:var(--muted); }

  .jp-pareto-row{ cursor:pointer; margin-bottom:14px; }
  .jp-pareto-row:last-child{ margin-bottom:0; }
  .jp-pareto-top{ display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
  .jp-pareto-rank{ font-size:10px; color:var(--muted); margin-right:6px; }
  .jp-pareto-code{ font-size:11px; font-weight:700; }
  .jp-pareto-label{ font-size:10.5px; color:var(--muted); margin-bottom:6px; }
  .jp-pareto-count{ font-size:11px; font-weight:700; color:var(--text); }
  .jp-pareto-track{ width:100%; height:8px; background:var(--bg); border-radius:3px; overflow:hidden; }
  .jp-pareto-fill{ height:100%; border-radius:3px; }
  .jp-pareto-pct{ font-size:9.5px; color:var(--muted); margin-top:6px; }

  /* ===== 手機小尺寸螢幕響應式修復：卡片在窄螢幕上向右突破畫面邊界、產生橫向捲動破版 =====
     （html,body 的 overflow-x:hidden / max-width:100% 已經在上面設過，這裡處理實際會撐寬
     版面的元素：各種 Grid 容器、以及卡片外層容器本身的收縮能力）
     排除範圍：總覽(LIVE MONITOR/DEEP INSIGHTS/JOURNEY BLUEPRINT/FAVORITES)那四顆分組按鈕、
     以及最上面那 5 張 KPI 卡片（.live-col-kpi），這兩處維持原本的版面，不套用下面的修正。 */
  @media (max-width: 768px) {
    /* 儀表板 Grid 容器在手機上強制單欄，minmax(0,1fr) 讓欄位可以正常縮小
       （單純 1fr 在內容不可縮小時還是會被撐寬，minmax(0,1fr) 才會真的收得回來） */
    .grid,
    .grid.grid-2col,
    .live-grid,
    .three-col,
    .two-col,
    .insight-v2-compare,
    .jp-charts-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    /* 圖表卡片外層容器：Grid/Flex item 預設 min-width:auto，內容一旦有不可縮小的固定寬度
       元素（長字串、固定px的圖表/表格），欄位就會被撐寬到超出螢幕，出現橫向捲動破版。
       加 min-width:0 讓卡片可以正常收縮到容器寬度，max-width:100% 則保險擋住卡片本身
       比外層容器還寬的情況。 */
    .card,
    .chart-card {
      min-width: 0;
      max-width: 100%;
    }
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

  <h1>阿葛格 宇航一等兵</h1>
  <div class="subtitle" id="subtitle"></div>
  <div class="mono" id="hudStrip" style="font-size:11px; color:rgb(var(--hud-glow)); margin:-4px 0 20px; letter-spacing:0.03em; opacity:0.9;"></div>

  <div class="group-nav">
    <button class="group-btn active" data-group="live">
      <span class="group-icon">🚀</span>
      <span class="group-text"><span class="group-title">LIVE MONITOR</span><span class="group-subtitle">總覽</span></span>
    </button>
    <button class="group-btn" data-group="insights">
      <span class="group-icon">⚙️</span>
      <span class="group-text"><span class="group-title">DEEP INSIGHTS</span><span class="group-subtitle">深度洞察</span></span>
    </button>
    <button class="group-btn" data-group="journey">
      <span class="group-icon">🗺️</span>
      <span class="group-text"><span class="group-title">JOURNEY BLUEPRINT</span><span class="group-subtitle">服務藍圖</span></span>
    </button>
    <button class="group-btn group-btn-mini" data-group="favorites">
      <span class="group-icon">⭐</span>
      <span class="group-text"><span class="group-title">FAVORITES</span><span class="group-subtitle">收藏</span></span>
    </button>
  </div>

  <div class="group-panel active" id="group-live">
    <div class="live-grid">
      <div class="live-col-1">
        <div class="live-col-kpi" id="summaryCards"></div>

        <div class="chart-card" style="margin-top:20px;">
          <h2 style="margin:0 0 2px;">平台佔比</h2>
          <div class="note" style="margin:2px 0 8px;">Android／iOS 評論數量佔比</div>
          <div class="chart-container" style="max-width:260px; margin:0 auto; height:220px;">
            <canvas id="platformRatioChart"></canvas>
          </div>
        </div>
      </div>

      <div class="live-col-2">
        <div class="chart-card live-col-radar">
          <h2 style="margin:0; padding:0 20px;">健康雷達 <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">5個軸分別是：抱怨/bug、功能請求、純稱讚、一般（依評論意圖分類佔比換算，總和100%）；版本穩定度＝沒有發生評分驟降的版本佔全部版本的比例。範圍越靠外圍越好，但「抱怨/bug」軸例外——越靠外圍代表抱怨佔比越高，越差。實線（本期）＝依資料日期範圍中點切分後較新的一半，虛線（上期）＝較舊的一半，供對照趨勢。點擊「本期」的軸可查看該類別的實際評論。</div></span></h2>
          <div class="chart-container radar-scan-wrap" style="height:380px; position:relative;">
            <canvas id="healthRadarChart"></canvas>
          </div>
        </div>

        <div class="chart-card" id="keywordChartCard" style="display:flex; flex-direction:column;">
          <h2 style="margin:0 0 2px;">近期熱門負評關鍵字 <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">取最近一年（12個月）的負評，用「雙字詞＋三字詞」統計常見詞彙（跟評論tab的字詞頻率排行同一套邏輯）。點擊長條可查看包含該詞的負評。</div></span></h2>
          <div class="note" id="keywordChartNote" style="margin:2px 0 10px;">最近一年負評，依出現則數排序（前5名）</div>
          <div class="chart-container" style="flex:1; min-height:220px;">
            <div id="recentKeywordChart" class="led-meter"></div>
          </div>
        </div>
      </div>

      <div class="live-col-3">
        <div class="chart-card live-anomaly-alert" id="liveAnomalyAlert" style="display:none;" role="button" tabindex="0" aria-label="突發異常警示，點擊查看 AI 洞察">
          <span class="ai-alert-dot"></span>
          <div class="live-anomaly-alert-text">
            <div class="ai-alert-title" id="liveAnomalyAlertTitle"></div>
            <div class="ai-alert-meta mono" id="liveAnomalyAlertMeta"></div>
          </div>
        </div>
        <div class="chart-card live-col-anomaly">
          <h2 style="margin:0 0 2px;">系統異常與熱門痛點 <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">合併三個來源依「負評則數」排序：版本異常（評分驟降的版本）、熱門痛點（評論分類）、旅程痛點（服務藍圖分類）。前3名標記為CRITICAL，其餘為WARN。點擊可查看該項目的實際負評。</div></span></h2>
          <div class="note" style="margin:2px 0 10px;">依負評則數排序，點擊可查看實際評論</div>
          <div id="anomalyList" class="mono"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="group-panel" id="group-insights">

  <div class="tabs">
    <button class="tab-btn active" data-tab="ai">AI 洞察</button>
    <button class="tab-btn" data-tab="comments">評論</button>
    <button class="tab-btn" data-tab="sentiment">回饋摘要</button>
  </div>

  <div class="tab-panel active" id="tab-ai">

  <div class="chart-card ai-insight-card" id="aiInsightCard">
    <div class="auto-card-header">
      <h2>🛰️ AI 智慧洞察與版本預警 <span class="h2-note">AI DEEP INSIGHT</span></h2>
      <span class="status-pill status-ok mono" id="aiInsightStatus">SYNCED</span>
    </div>

    <div id="aiInsightBody">
      <div class="ai-alert-banner" id="aiAlertBanner" style="display:none;">
        <span class="ai-alert-dot"></span>
        <div>
          <div class="ai-alert-title" id="aiAlertTitle"></div>
          <div class="ai-alert-meta mono" id="aiAlertMeta"></div>
        </div>
      </div>

      <div class="ai-issue-list" id="aiIssueList"></div>

      <div class="h2-note" style="margin:14px 0 8px;">建議行動</div>
      <div class="insight-v2-actions" id="aiActionList"></div>
    </div>

    <div class="insight-empty" id="aiInsightEmpty" style="display:none;">暫無最新 AI 洞察資料</div>
  </div>

    <div style="display:flex; align-items:center; gap:6px; margin-bottom:16px;">
      <span class="status-pill status-ok mono">AUTO_SUMMARY</span>
      <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">以下內容是依規則自動比對數字產生（版本評分落差、負評分類排序、月增減比較、健康雷達維度變化），不是 AI 理解語意後寫出來的分析，準確度以此為前提，建議搭配下方「回饋摘要」「服務藍圖」交叉確認。</div></span>
    </div>

    <div class="three-col">
      <div class="chart-card insight-card-v2 auto-card" id="autoCard1" data-auto-key="version">
        <div class="auto-card-header">
          <h2>📈 版本評分與健康度 <span class="h2-note">VERSION HEALTH</span></h2>
        </div>
        <div class="insight-v2-headline" id="autoCard1Headline"></div>
        <div class="auto-card-chart-wrap">
          <canvas id="autoVersionChart"></canvas>
        </div>
        <div class="card-detail-drawer" id="autoCard1Detail">
          <div class="auto-detail-inner">
            <table class="auto-detail-table">
              <thead><tr><th>版本</th><th>負評則數</th><th>平均星等</th><th>較前版落差</th><th>疑似原因／主要負評類型</th></tr></thead>
              <tbody id="autoCard1Tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="chart-card insight-card-v2 auto-card" id="autoCard2" data-auto-key="pain">
        <div class="auto-card-header">
          <h2>🔥 歷史高頻痛點 Top 5 <span class="h2-note">TOP PAIN POINTS</span></h2>
        </div>
        <div class="insight-v2-headline" id="autoCard2Headline"></div>
        <div class="auto-card-chart-wrap">
          <canvas id="autoPainChart"></canvas>
        </div>
        <div class="card-detail-drawer" id="autoCard2Detail">
          <div class="auto-detail-inner">
            <table class="auto-detail-table">
              <thead><tr><th>排名</th><th>分類</th><th>負評則數</th><th>總則數</th><th>平均星等</th></tr></thead>
              <tbody id="autoCard2Tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="chart-card insight-card-v2 auto-card" id="autoCard3" data-auto-key="context">
        <div class="auto-card-header">
          <h2>🧭 近期異動與行動指引 <span class="h2-note">CONTEXT &amp; ACTION</span></h2>
        </div>
        <div class="insight-v2-headline" id="autoCard3Headline"></div>
        <div class="auto-card-tags" id="autoCard3Tags"></div>
        <div class="insight-v2-actions" id="autoCard3Actions"></div>
        <div class="card-detail-drawer" id="autoCard3Detail">
          <div class="auto-detail-inner">
            <table class="auto-detail-table">
              <thead><tr><th>分類</th><th>本月負評</th><th>上月負評</th><th>增加則數</th></tr></thead>
              <tbody id="autoCard3Tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tab-panel" id="tab-comments">
    <div class="two-col">
    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">每月評論趨勢
          <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">每個點代表一則實際評論，滑鼠移到點上可看內容。可用上方按鈕控制縮放程度（近3個月／近6個月／近1年／全部），或用下方「上一區間／下一區間」移動檢視區間，查看更早或更晚的資料。</div></span>
        </h2>
        <div class="toggle-group" id="rangeToggleGroup">
          <button class="toggle-btn" data-range="3">近3個月</button>
          <button class="toggle-btn active" data-range="6">近6個月</button>
          <button class="toggle-btn" data-range="12">近1年</button>
          <button class="toggle-btn" data-range="all">全部</button>
          <button class="toggle-btn" id="btnResetZoom">重置縮放</button>
        </div>
      </div>
      <div class="scatter-nav">
        <button class="nav-btn" id="btnPrevWindow">◀ 上一區間</button>
        <span class="note" id="scatterRangeNote" style="margin:0"></span>
        <button class="nav-btn" id="btnNextWindow">下一區間 ▶</button>
      </div>
      <div class="chart-container">
        <canvas id="commentScatterChart" height="110"></canvas>
      </div>
    </div>

    <div class="chart-card">
      <h2>常見字詞頻率排行
        <span class="info-hint" tabindex="0">ⓘ<div class="info-hint-pop">不分正負評，已過濾常見口語詞/語助詞。用「雙字詞」統計，不是正式的中文斷詞演算法，準確度有限，僅供快速抓語感參考。點擊長條可查看包含該字詞的評論。</div></span>
      </h2>
      <div class="chart-container" id="wordFrequencyContainer" style="height:280px;">
        <canvas id="wordFrequencyChart"></canvas>
      </div>
      <button class="nav-btn" id="btnLoadMoreWords" style="margin-top:10px;">載入更多字詞</button>
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

  <div class="tab-panel" id="tab-sentiment">
    <div class="insight-grid" id="insightDetailGrid">
    <div class="chart-card insight-card" id="categoryInsightCard" data-insight-key="category">
      <div class="list-header">
        <h2 style="margin:0">情緒與類別分析</h2>
        <div class="toggle-group" id="categoryTimeRangeToggleGroup">
          <button class="toggle-btn active" data-time-range="all">全部</button>
          <button class="toggle-btn" data-time-range="year">今年</button>
          <button class="toggle-btn" data-time-range="month">本月</button>
        </div>
      </div>
      <div class="h2-note">依關鍵字比對，可能一則評論同時符合多個類別；點擊此區塊可展開查看更多內容</div>
      <div class="insight-headline-stat" id="categoryHeadlineStat"></div>
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
        </div>
      </div>
      <div class="h2-note">點擊此區塊可展開查看更多內容</div>
      <div class="insight-headline-stat" id="stageHeadlineStat"></div>
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
        </div>
      </div>
      <div class="h2-note">每個點是一個分類；越靠右代表提到次數越多，越靠下代表平均星等越低；點擊此區塊可展開查看更多內容</div>
      <div class="insight-headline-stat" id="matrixHeadlineStat"></div>
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
        </div>
      </div>
      <div class="h2-note">抱怨/bug、功能請求、純稱讚、一般，依關鍵字粗略判斷；點擊此區塊可展開查看更多內容</div>
      <div class="insight-headline-stat" id="intentHeadlineStat"></div>
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

  </div>

  <div class="group-panel" id="group-journey">
  <div id="tab-journeypain">
    <div class="chart-card">
      <div class="jp-card-head">
        <div class="jp-card-head-title">
          <h2 style="margin:0">互動式服務藍圖</h2>
          <div class="note" style="margin-top:4px;">點擊圓點查看該痛點的實際評論；點擊右側圖表的項目會反過來highlight對應階段</div>
        </div>
        <div class="jp-card-head-tools">
          <div class="jp-toolbar">
            <div class="jp-legend-group">
              <div class="jp-legend-item"><span class="jp-icon" style="background:var(--neg)">✕</span> 失敗點 F</div>
              <div class="jp-legend-item"><span class="jp-icon" style="background:#ffd23f">D</span> 決策點 D</div>
              <div class="jp-legend-item"><span class="jp-icon" style="background:#7ee27e">W</span> 等待點 W</div>
            </div>
            <div class="jp-divider-v"></div>
            <div class="jp-filter-group" id="jpTypeFilters">
              <label class="jp-chip active" data-type="F"><span class="jp-dot" style="background:var(--neg)"></span>顯示F</label>
              <label class="jp-chip active" data-type="D"><span class="jp-dot" style="background:#ffd23f"></span>顯示D</label>
              <label class="jp-chip active" data-type="W"><span class="jp-dot" style="background:#7ee27e"></span>顯示W</label>
            </div>
            <div class="jp-divider-v"></div>
            <div class="jp-filter-group" id="jpPlatformFilters">
              <label class="jp-chip active" data-platform="android"><span class="jp-dot" style="background:var(--android)"></span>Android</label>
              <label class="jp-chip active" data-platform="ios"><span class="jp-dot" style="background:var(--ios)"></span>iOS</label>
            </div>
          </div>
          <div class="note" style="margin-top:6px; text-align:right;">篩選同步套用到下方「流程複雜度×痛點密集度」與「痛點排行榜」</div>
        </div>
      </div>

      <div class="jp-info-toggle-row">
        <button class="jp-info-toggle" id="jpInfoToggle"><span>📖 怎麼讀懂這張圖</span><span class="jp-chev">▾</span></button>
      </div>

      <div class="jp-info-box" id="jpInfoBox">
        <div class="jp-info-box-inner">
          <div class="jp-info-section">
            <h4>① 圖表結構怎麼看</h4>
            <ul class="jp-info-list">
              <li><b>藍色大階段</b>：用車前／用車中／用車後／客服，旅程的四個大區塊</li>
              <li><b>階段</b>：14個細部子階段（例如「取車中」「還車」）</li>
              <li><b>渠道</b>：使用者在這個階段是透過APP、實體車輛、還是客服管道接觸產品</li>
              <li><b>行為流程</b>：這個階段使用者實際做的事</li>
              <li><b>顧客行動</b>：熱力色階代表負評密集度，圓點代表個別痛點分類，大小＝評論數，點擊可看實際評論</li>
              <li><b>滿意度</b>：該階段對應分類的平均星等換算成0~5分，0最不滿意、5最滿意</li>
            </ul>
          </div>
          <div class="jp-info-section">
            <h4>② 為什麼要分 F / D / W</h4>
            <p>同一個階段的抱怨，卡住的「原因性質」不同，該做的事也不一樣：</p>
            <div class="jp-type-row"><span class="jp-icon" style="background:var(--neg)">✕</span><span class="jp-type-text"><b>失敗點 F</b>：功能真的壞了或流程斷裂，行動是「修」——通常是工程要處理的bug</span></div>
            <div class="jp-type-row"><span class="jp-icon" style="background:#ffd23f">D</span><span class="jp-type-text"><b>決策點 D</b>：系統要判斷放不放行，抱怨常來自「規則不透明」，行動是「說清楚規則」而不是修bug</span></div>
            <div class="jp-type-row"><span class="jp-icon" style="background:#7ee27e">W</span><span class="jp-type-text"><b>等待點 W</b>：東西沒壞，只是不知道要等多久，行動是「加進度／狀態回饋」</span></div>
          </div>
          <div class="jp-info-section">
            <h4>③ 怎麼互動</h4>
            <p>用右上角的篩選器（F/D/W顯示開關、Android/iOS）縮小範圍，會同步套用到藍圖、象限圖、排行榜三個區塊。點擊藍圖裡的圓點、排行榜項目、象限圖的點、優先清單，都會打開評論詳情抽屜；象限圖跟優先清單額外會讓藍圖對應的階段亮起提示，方便對照上下文。</p>
            <p style="margin-top:8px; opacity:0.75;">⚠️ 目前F/D/W與階段的對應，是依現有評論分類做的第一版判斷，準確度以此為前提，建議實際檢視評論後調整 <code>JOURNEY_CATEGORY_MAP</code>（在 generate-dashboard.js 裡）。</p>
          </div>
        </div>
      </div>

      <div class="jp-board-section">
        <div class="jp-board-wrap"><div class="jp-board" id="jpBoard"></div></div>
        <div class="jp-row jp-section-divider" id="jpFrontRowWrap"></div>
        <div class="jp-row jp-section-divider" id="jpBackRowWrap"></div>
      </div>
    </div>

    <div class="jp-charts-grid" id="jpChartsGrid">
      <div class="chart-card jp-expandable-card" id="jpQuadInsightCard" data-jp-key="jpquad">
        <h2 style="margin:0 0 2px; font-size:13px;">流程複雜度 × 痛點密集度</h2>
        <div class="note" style="margin:2px 0 8px;">X軸＝行為流程子步驟數，Y軸＝負評總則數。右上角＝優先重新設計候選；點擊資料點/下方清單可查看該階段實際負評；點擊卡片其他地方可展開放大圖表</div>
        <svg id="jpQuadChart" viewBox="0 0 380 300" width="100%"></svg>
        <div class="jp-priority-list" id="jpPriorityList"></div>
      </div>
      <div class="chart-card jp-expandable-card" id="jpParetoInsightCard" data-jp-key="jppareto">
        <h2 style="margin:0 0 2px; font-size:13px;">痛點排行榜</h2>
        <div class="note" style="margin:2px 0 8px;">依篩選後負評則數排序，點擊可查看實際評論；點擊此區塊可展開查看更多內容</div>
        <div class="jp-pareto-list" id="jpParetoList"></div>
      </div>
    </div>
  </div>
  </div>

  <div class="group-panel" id="group-favorites">
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

    // ===== 整合式旅程痛點 tab：靜態結構設定（來自論文服務藍圖，非資料運算結果） =====
    const JOURNEY_STAGES_CLIENT = ['選擇品牌','會員註冊','審核身份','搜尋欲租車輛','預定車輛','等待取車','前往取車','取車中','使用中','準備還車','還車','付款','還車後服務','狀況排除'];
    const JOURNEY_MACRO_GROUPS_CLIENT = [
      { label: '用車前', span: 6 },
      { label: '用車中', span: 6 },
      { label: '用車後', span: 1 },
      { label: '客服',   span: 1 },
    ];
    const JOURNEY_CHANNELS_CLIENT = {
      '選擇品牌':'官網/APP','會員註冊':'APP','審核身份':'APP','搜尋欲租車輛':'APP','預定車輛':'APP',
      '等待取車':'APP','前往取車':'APP','取車中':'APP/實體車輛','使用中':'APP/實體車輛','準備還車':'APP/實體車輛',
      '還車':'APP/實體車輛','付款':'APP','還車後服務':'APP','狀況排除':'APP/電話/Line/Chatbot',
    };
    const JOURNEY_FLOW_TEXT_CLIENT = {
      '選擇品牌':'學習使用方式 → 與競品比較差異',
      '會員註冊':'註冊 → 付款完成',
      '審核身份':'審核',
      '搜尋欲租車輛':'搜尋車輛 → 查看詳情',
      '預定車輛':'定車 → 預授權費用',
      '等待取車':'確認租車資訊',
      '前往取車':'前往取車地點',
      '取車中':'檢查車輛 → 拍照存證',
      '使用中':'發動 → 熟悉車輛 → 離開停車場 → 控制車輛',
      '準備還車':'找站點與車位 → 抵達停車場 → 即將逾時',
      '還車':'進入停車場 → 熄火 → 檢查車輛 → 拍照存證 → 車格與環境照',
      '付款':'發票明細 → 選擇付款方式 → 付款完成',
      '還車後服務':'問卷回饋 → 評價 → 推廣',
      '狀況排除':'發生異常狀況 → 進線客服 → 排除問題',
    };
    const JOURNEY_STEPS_CLIENT = {
      '選擇品牌':2,'會員註冊':2,'審核身份':1,'搜尋欲租車輛':2,'預定車輛':2,'等待取車':1,'前往取車':1,
      '取車中':2,'使用中':4,'準備還車':3,'還車':5,'付款':3,'還車後服務':3,'狀況排除':3
    };
    const JOURNEY_FRONT_LABELS_CLIENT = { '選擇品牌':'','會員註冊':'註冊介面','審核身份':'審核介面','搜尋欲租車輛':'站點/地圖','預定車輛':'車輛資訊','等待取車':'訂單','前往取車':'站點/導航','取車中':'相機','使用中':'車輛控制','準備還車':'站點/導航','還車':'車輛檢查','付款':'金流方式','還車後服務':'問卷','狀況排除':'客服劇本' };
    const JOURNEY_BACK_LABELS_CLIENT = { '選擇品牌':'','會員註冊':'會員系統','審核身份':'AI/人工審核','搜尋欲租車輛':'訂單系統','預定車輛':'第三方支付','等待取車':'','前往取車':'','取車中':'','使用中':'車輛監控系統','準備還車':'車輛監控','還車':'訂單系統','付款':'第三方支付','還車後服務':'CRM','狀況排除':'客服系統' };

    // ===== 記住目前分組/分頁：重新整理網頁時停留在原本的位置，不要都跳回「LIVE MONITOR／評論」 =====
    // 在任何圖表建立之前就先切換好，這樣被還原的分組/分頁一開始就是「可見」狀態，
    // 圖表尺寸計算也會是正確的，不需要額外等 resize。
    const TAB_STORAGE_KEY = 'gosmart-active-tab';
    const GROUP_STORAGE_KEY = 'gosmart-active-group';

    // ===== 三大分組按鈕的英文標題：被選取時打字動效播一次，播完後改成閃爍指標 =====
    // 用 data-full 記住完整文字（第一次執行時從目前內容快取起來），這樣不管重播幾次
    // 都知道原本完整的字是什麼，不會因為中途被清空重打而弄丟。
    function typeGroupTitle(titleEl) {
      if (!titleEl) return;
      const full = titleEl.dataset.full || titleEl.textContent;
      titleEl.dataset.full = full;
      // 防止打字過程中文字從短到長，讓按鈕的版面寬度跟著抖動——尤其小螢幕上比重較小的
      // 「收藏」按鈕沒有固定寬度，文字變短的那零點幾秒可能會被擠到上一行、打完字又跳回下一行。
      // 第一次執行時把「完整文字」的實際寬度量出來鎖成 min-width，之後不管正在打幾個字，
      // 這個元素（進而整個按鈕）的版面寬度都維持打完字之後的最終寬度，不會反覆換行跳動。
      if (!titleEl.dataset.lockedWidth) {
        titleEl.style.minWidth = titleEl.getBoundingClientRect().width + 'px';
        titleEl.dataset.lockedWidth = '1';
      }
      if (titleEl._typeTimer) {
        clearInterval(titleEl._typeTimer);
        titleEl._typeTimer = null;
      }
      titleEl.classList.remove('caret-blink');
      titleEl.textContent = '';
      let i = 0;
      titleEl._typeTimer = setInterval(() => {
        i++;
        titleEl.textContent = full.slice(0, i);
        if (i >= full.length) {
          clearInterval(titleEl._typeTimer);
          titleEl._typeTimer = null;
          titleEl.classList.add('caret-blink'); // 打完字之後才開始閃爍指標
        }
      }, 45);
    }

    // 按鈕被切換掉（不再是目前選取的分組）時：中斷可能還在跑的打字動畫、直接顯示完整文字、拿掉閃爍指標
    function resetGroupTitle(titleEl) {
      if (!titleEl) return;
      if (titleEl._typeTimer) {
        clearInterval(titleEl._typeTimer);
        titleEl._typeTimer = null;
      }
      const full = titleEl.dataset.full || titleEl.textContent;
      titleEl.textContent = full;
      titleEl.classList.remove('caret-blink');
    }

    function activateGroup(groupName) {
      const btn = document.querySelector('.group-btn[data-group="' + groupName + '"]');
      const panel = document.getElementById('group-' + groupName);
      if (!btn || !panel) return false;
      document.querySelectorAll('.group-btn').forEach((b) => {
        b.classList.remove('active');
        if (b !== btn) resetGroupTitle(b.querySelector('.group-title'));
      });
      document.querySelectorAll('.group-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      panel.classList.add('active');
      typeGroupTitle(btn.querySelector('.group-title'));
      return true;
    }

    (function restoreActiveGroupAndTab() {
      let savedGroup = null;
      try { savedGroup = localStorage.getItem(GROUP_STORAGE_KEY); } catch (e) {}
      let savedTab = null;
      try { savedTab = localStorage.getItem(TAB_STORAGE_KEY); } catch (e) {}

      // 相容舊資料：改版前「自動摘要」是DEEP INSIGHTS底下獨立的子分頁，
      // 現在併入「AI 洞察」分頁（連同原本常駐在tab bar上方的AI智慧洞察卡片一起收納）。
      // 如果瀏覽器還記得舊的 'autosummary'，直接導向新的 'ai' 分頁鍵值，
      // 不然舊訪客重整頁面時會找不到 #tab-autosummary，畫面就會空白。
      if (savedTab === 'autosummary') {
        savedTab = 'ai';
      }

      // 相容舊資料：改版前「整合式旅程痛點」曾經是DEEP INSIGHTS底下的一個子分頁，
      // 如果瀏覽器還記得那筆舊的偏好，直接導向新的JOURNEY BLUEPRINT分組。
      // 注意：只有在「完全沒有GROUP_STORAGE_KEY紀錄」時才套用這個相容邏輯——
      // 不然只要瀏覽器裡還留著舊的 gosmart-active-tab='journeypain'（用過舊版介面時存下的），
      // 之後就算已經正常切換分組，也會每次重整頁面都被這條規則強制拉回服務藍圖。
      if (!savedGroup && savedTab === 'journeypain') {
        savedGroup = 'journey';
        savedTab = null;
      }

      // 相容舊資料：改版前「收藏」曾經是DEEP INSIGHTS底下的一個子分頁，
      // 如果瀏覽器還記得那筆舊的偏好，直接導向新的、獨立出來的收藏分組。
      if (!savedGroup && savedTab === 'favorites') {
        savedGroup = 'favorites';
        savedTab = null;
      }

      if (savedGroup) activateGroup(savedGroup);

      if (savedTab) {
        const targetBtn = document.querySelector('.tab-btn[data-tab="' + savedTab + '"]');
        const targetPanel = document.getElementById('tab-' + savedTab);
        if (targetBtn && targetPanel) {
          document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
          targetBtn.classList.add('active');
          targetPanel.classList.add('active');
        }
      }
    })();

    // 頁面剛載入時，把「目前使用中」的那個分組按鈕也播一次打字動效
    // （如果上面 restoreActiveGroupAndTab 已經呼叫過 activateGroup 觸發過一次，
    // 這裡等於重新觸發、乾淨地重播一次，不會疊加或衝突）。
    typeGroupTitle(document.querySelector('.group-btn.active .group-title'));

    // ===== 讓所有分組/分頁在圖表建立當下都先有「正確的版面尺寸」，避免圖表在寬高是 0 的
    //      隱藏區塊裡建立、內部座標塌陷到左上角（切換時修正尺寸會變成從左上角「彈出來」的怪異動畫）=====
    // 做法：暫時讓所有分組/分頁都用 visibility:hidden（保留版面空間、但不會被畫出來）取代
    // display:none，讓 Chart.js 在建立當下就能量到正確的寬高；因為這整段（樣式覆蓋→
    // 建立所有圖表→恢復樣式）是同一串同步執行的程式碼，瀏覽器不會在中途畫面，
    // 所以不會有「畫面暫時變很長」的閃爍問題。所有圖表都建立完成後，再恢復正常的顯示/隱藏規則。
    const allTabPanelsForInit = document.querySelectorAll('.tab-panel, .group-panel');
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

    // ===== 圖表進場動畫：全站關閉 =====
    // 原本這裡是全域預設進場動畫（duration 800），但 Chart.js 用同一個全域動畫排程器處理
    // 全站所有圖表，一旦其中任何一個圖表的動畫組態觸發內部異常（this._fn is not a function），
    // 整個排程器就會壞掉，殃及所有還在用動畫的圖表，連 tooltip 的淡入也一起失效。
    // 唯一目前確認完全沒事的圖表（矩陣圖、月趨勢散佈圖）共同點就是 animation:false，
    // 所以全站直接關閉進場動畫，圖表一載入就直接顯示最終樣子，不再冒這個風險。
    if (window.Chart) {
      Chart.defaults.animation = false;
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

    let lockedScrollY = 0;

    function lockBodyScroll() {
      lockedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = -lockedScrollY + 'px';
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
    }

    function unlockBodyScroll() {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      window.scrollTo(0, lockedScrollY);
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
      lockBodyScroll(); // 抽屜打開時鎖住背景頁面，滑抽屜內容不會連背景一起動
    }

    function closeReviewDrawer() {
      drawerOverlay.classList.remove('open');
      reviewDrawer.classList.remove('open');
      unlockBodyScroll();
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


    function latestDateForPlatform(platform) {
      const items = dataset.allReviewsFlat.filter((r) => r.platform === platform);
      if (!items.length) return null;
      const maxTs = Math.max(...items.map((r) => r.timestamp));
      const d = new Date(maxTs);
      return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    }
    const androidLatestDate = latestDateForPlatform('android');
    const iosLatestDate = latestDateForPlatform('ios');

    document.getElementById('subtitle').textContent =
      '資料期間：' + dataset.dateRange.earliest + ' ~ ' + dataset.dateRange.latest +
      '　（產出時間：' + new Date().toLocaleString('zh-TW') + '）' +
      (androidLatestDate ? '　｜ 更新至Android最新評論 ' + androidLatestDate : '') +
      (iosLatestDate ? '　｜ 更新至iOS最新評論 ' + iosLatestDate : '') +
      (dataset.newReviewsCount.isFirstRun
        ? '　｜ 首次產出，尚無比對基準'
        : '　｜ 與上次產出相比新增 ' + dataset.newReviewsCount.total + ' 則評論');

    // ===== 頂部HUD數據列：總評論數（純前端從allReviewsFlat即時算出，Node端不用另外加欄位） =====
    (function renderHudStrip() {
      const total = dataset.allReviewsFlat.length;
      document.getElementById('hudStrip').textContent =
        '總評論數: ' + total.toLocaleString('en-US');
    })();

    const summaryEl = document.getElementById('summaryCards');

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
        const valueClass = 'value mono ' + c.cls + (hasNew ? ' blink-number' : '');
        const clickAttr = (clickable && c.clickKey) ? ' data-click-key="' + c.clickKey + '"' : '';
        const subHtml = (c.subLabel !== undefined && c.subValue !== undefined)
          ? '<div class="card-sub"><div class="card-sub-label">' + c.subLabel + '</div><div class="card-sub-value mono">' + c.subValue + '</div></div>'
          : '';
        const badgeHtml = c.badgeNote ? '<div class="card-badge-note">' + c.badgeNote + '</div>' : '';
        const labelHtml = '<div class="label-wrap"><div class="label">' + c.label + '</div></div>';
        // 沒有有效數值時（例如尚無評分資料），直接顯示 "-"，不套用計數動畫
        if (c.value === null || c.value === undefined || isNaN(c.value)) {
          return '<div class="' + cardClass + '"' + clickAttr + '>' + labelHtml + '<div class="' + valueClass + '"' + style + '>-</div>' + subHtml + badgeHtml + '</div>';
        }
        const initialText = c.decimals > 0 ? (0).toFixed(c.decimals) : '0';
        return '<div class="' + cardClass + '"' + clickAttr + '>' + labelHtml +
          '<div class="' + valueClass + '"' + style + ' data-count-target="' + c.value + '" data-count-decimals="' + c.decimals + '">' + initialText + '</div>' + subHtml + badgeHtml + '</div>';
      }).join('');
    }

    renderCardGroup(summaryEl, [
      { label: 'Google Play<br>累積評論數', value: dataset.actualAndroidTotal, cls: 'android', decimals: 0, clickKey: 'android-total' },
      { label: 'App Store<br>累積評論數', value: dataset.actualIosTotal, cls: 'ios-lime', decimals: 0, clickKey: 'ios-total' },
      { label: '今年新增<br>評論數', value: dataset.thisYearTotal, cls: 'android', decimals: 0, clickKey: 'this-year-total', badgeNote: '不分平台' },
      { label: 'Google Play<br>新評論數', value: dataset.newReviewsCount.android, cls: 'new-count', decimals: 0, clickKey: 'android-new' },
      { label: 'App Store<br>新評論數', value: dataset.newReviewsCount.ios, cls: 'new-count', decimals: 0, clickKey: 'ios-new' },
    ], { clickable: true });

    // ===== 共用：建立一顆疊在圖表 canvas 上的透明畫布，專門畫「持續動畫」的裝飾效果 =====
    // 背景：雷達圖掃描光、平台佔比的光點漣漪、關鍵字長條圖的流光，這三個效果都需要
    // 不間斷的 requestAnimationFrame 重繪才能「動起來」。原本的做法是直接呼叫
    // chartInstance.draw()，但這會跟 Chart.js 自己管理的 tooltip / hover 重繪排程
    // 搶同一顆 canvas，導致 tooltip 顯示不穩定（不觸發、或觸發後被下一幀的裝飾效果蓋掉變很淡）。
    // 改成疊加一顆完全獨立的 canvas 專門畫裝飾效果，Chart.js 的 canvas 就不會再被外部
    // 的 draw() 打斷，tooltip 交回 Chart.js 自己管理即可恢復正常。
    //
    // 注意：這裡故意不自己另外掛 ResizeObserver 去監聽 mainCanvas——Chart.js 自己在
    // responsive:true 時，也會在 canvas 的父層容器掛一個內部的 ResizeObserver。
    // 如果我們又在「同一顆 canvas」上疊加一個自己的 ResizeObserver、又同時動它所在容器的
    // DOM 結構（插入疊加層），實測會跟 Chart.js 內部剛好在初始化的 resize 監聽機制衝突，
    // 導致 Chart.js 內部（chart.umd.min.js）直接丟出例外，波及所有圖表共用的動畫排程器，
    // 讓全站所有圖表的 tooltip 都跟著壞掉。
    // 改成完全交給 Chart.js 自己的 options.onResize(chart, size) 回呼通知我們「resize完成了」，
    // 我們只在那個時間點呼叫 overlay.resize() 同步疊加層尺寸，不再自己監聽容器，
    // 也不在 Chart 建立過程中去異動它的父層 DOM（呼叫端會在 new Chart(...) 完成之後才呼叫這個函式）。
    // insertBefore：true＝疊加畫布放在圖表 canvas「後面」（裝飾效果在圖表下方，例如雷達圖掃描光
    // 原本用 beforeDatasetsDraw 畫在資料之前）；false＝疊加畫布放在圖表 canvas「上面」
    // （裝飾效果在圖表上方，例如原本用 afterDraw／afterDatasetsDraw 疊加的光點/流光效果）。
    // ===== 所有裝飾用疊加 canvas（掃描光、光點/漣漪等）集中註冊在這裡，
    //      這樣不管是「大分組切換」「分頁切換」還是「視窗尺寸改變」，
    //      都能主動把它們全部重新 resize 一次，不用只靠 Chart.js 的 onResize
    //      回呼被動觸發——分組面板從 display:none 切回 display:block 時，
    //      有些瀏覽器不會可靠地重新觸發 ResizeObserver，導致疊加層尺寸卡在
    //      隱藏當下量到的 0，看起來就像「切換分頁後動效消失」。 =====
    const effectOverlays = [];
    function resizeAllEffectOverlays() {
      effectOverlays.forEach((o) => {
        try { o.resize(); } catch (e) {}
      });
    }

    function createEffectOverlay(mainCanvas, { insertBefore = false } = {}) {
      const overlay = document.createElement('canvas');
      overlay.style.position = 'absolute';
      overlay.style.inset = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.pointerEvents = 'none'; // 純視覺效果，滑鼠事件要穿透到底下真正的 Chart.js canvas

      const parent = mainCanvas.parentElement;
      if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'; // 保險起見，確保疊加層的絕對定位是相對這個容器
      }
      if (insertBefore) {
        parent.insertBefore(overlay, mainCanvas);
      } else {
        parent.insertBefore(overlay, mainCanvas.nextSibling);
      }

      const ctx = overlay.getContext('2d');

      function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = mainCanvas.getBoundingClientRect();
        // 面板還隱藏（display:none）時量到的寬高會是 0，這種情況先不要真的把疊加層縮到 0，
        // 避免之後切回來時還沒等到下一次 resize 呼叫，畫面就已經卡在「量不到尺寸」的狀態。
        if (rect.width <= 0 || rect.height <= 0) return;
        overlay.width = Math.max(1, Math.round(rect.width * dpr));
        overlay.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resize();

      // 保險：另外掛一個獨立的 ResizeObserver，觀察「容器的容器」（不是 Chart.js 自己在
      // 觀察的那個節點，避開文件開頭提到的那個初始化衝突），只要面板從 display:none 變回
      // 可見、或視窗尺寸改變，瀏覽器量到的 box 尺寸一有變化就會自動觸發，不必再靠我們自己
      // 猜「這個時間點呼叫 resize() 版面應該已經穩定了吧」，從根本解決「切換分組/分頁後
      // 掃描光效果消失」的問題。這裡刻意晚一點才掛（new Chart(...) 跟疊加層插入都已完成之後），
      // 不會跟 Chart.js 內部的 ResizeObserver 初始化時序衝突。
      let resizeObserver = null;
      if (typeof ResizeObserver !== 'undefined') {
        const observeTarget = (parent && parent.parentElement) || parent || mainCanvas;
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(observeTarget);
      }

      const entry = { canvas: overlay, ctx, resize, resizeObserver };
      effectOverlays.push(entry);
      return entry;
    }

    // ===== 共用：確保容器已經有實際寬高之後，才執行圖表 init =====
    // 問題背景：像「近期熱門負評關鍵字」這種放在 flex 版面裡、高度由 JS 事後量測撐開的容器，
    // 在 script 執行到 new Chart(...) 的當下，容器有可能還沒撐開到最終高度（例如還在等
    // flex 父層的高度由其他函式設定），這時候 Chart.js 讀到的容器尺寸是 0 或極小值，
    // 畫出來的圖表就會寬高坍塌、看起來像空白，重新整理後（瀏覽器對CSS的計算時序不同）才會正常。
    // 這裡用 requestAnimationFrame 輪詢容器實際尺寸，確定「寬高都>0」才呼叫 init()；
    // 設一個影格數上限（maxFrames）當保險，超過上限還是會強制呼叫一次 init()，
    // 避免萬一容器真的量不到尺寸（例如整個父層被隱藏）時卡住、永遠不畫圖。
    function whenContainerSized(el, init, maxFrames = 30) {
      let frame = 0;
      function check() {
        const rect = el.getBoundingClientRect();
        if ((rect.width > 0 && rect.height > 0) || frame >= maxFrames) {
          init();
          return;
        }
        frame++;
        requestAnimationFrame(check);
      }
      check();
    }

    // ===== 共用：健康快照（意圖分佈4軸 + 版本穩定度），健康雷達圖跟自動摘要卡片二都要用同一套數字 =====
    // 依資料的日期範圍中點，切成「本期」／「上期」兩段，供對照趨勢；
    // 版本穩定度：把版本依序切成前半／後半，各自算「非驟降版本」佔比，當作「上期／本期」的粗略對照。
    function computeHealthSnapshot() {
      const allReviews = dataset.allReviewsFlat || [];
      const parsedDates = allReviews.map(r => new Date(r.date)).filter(d => !isNaN(d));
      let midDate = null;
      if (parsedDates.length) {
        const minTime = Math.min(...parsedDates.map(d => d.getTime()));
        const maxTime = Math.max(...parsedDates.map(d => d.getTime()));
        midDate = new Date((minTime + maxTime) / 2);
      }

      function intentPctFor(reviews) {
        const total = reviews.length || 1;
        const count = (k) => reviews.filter(r => r.intent === k).length;
        return {
          '抱怨/bug': Math.round(count('抱怨/bug') / total * 100),
          '功能請求': Math.round(count('功能請求') / total * 100),
          '純稱讚': Math.round(count('純稱讚') / total * 100),
          '一般': Math.round(count('一般') / total * 100),
        };
      }

      const currentReviews = midDate ? allReviews.filter(r => new Date(r.date) >= midDate) : allReviews;
      const previousReviews = midDate ? allReviews.filter(r => new Date(r.date) < midDate) : [];

      const currentIntent = intentPctFor(currentReviews);
      const previousIntent = intentPctFor(previousReviews);

      const versionAnalysis = dataset.versionAnalysis || [];
      function stabilityFor(list) {
        if (!list.length) return 100;
        const regressions = list.filter(v => v.isRegression).length;
        return Math.round((1 - regressions / list.length) * 100);
      }
      const halfIdx = Math.ceil(versionAnalysis.length / 2);
      const previousVersions = versionAnalysis.slice(0, halfIdx);
      const currentVersions = versionAnalysis.slice(halfIdx);
      const currentStability = stabilityFor(currentVersions.length ? currentVersions : versionAnalysis);
      const previousStability = stabilityFor(previousVersions.length ? previousVersions : versionAnalysis);

      return { currentIntent, previousIntent, currentStability, previousStability };
    }

    // ===== LIVE MONITOR：健康雷達圖（意圖分佈4軸 + 版本穩定度1軸） =====
    (function renderHealthRadar() {
      const canvas = document.getElementById('healthRadarChart');
      if (!canvas || !window.Chart) return;

      const { currentIntent, previousIntent, currentStability, previousStability } = computeHealthSnapshot();

      const labels = ['抱怨/bug', '功能請求', '純稱讚', '一般', '版本穩定度'];
      const currentValues = [currentIntent['抱怨/bug'], currentIntent['功能請求'], currentIntent['純稱讚'], currentIntent['一般'], currentStability];
      const previousValues = [previousIntent['抱怨/bug'], previousIntent['功能請求'], previousIntent['純稱讚'], previousIntent['一般'], previousStability];

      // canvas 的顏色設定不支援 var(--xxx) 語法（那是CSS層級的東西，canvas 2D context不會解析），
      // 這裡先用 getComputedStyle 把主色的實際RGB值讀出來，再組成 canvas 看得懂的字串。
      const glowRgb = getComputedStyle(document.documentElement).getPropertyValue('--hud-glow').trim() || '198, 242, 78';

      // ===== 掃描光效果：畫在獨立的疊加 canvas 上（見 createEffectOverlay），不再進到 Chart.js 的圖表 canvas =====
      // insertBefore:true 讓疊加層放在雷達圖 canvas 底下，維持跟原本 beforeDatasetsDraw 一樣
      // 「掃描光在資料線/tooltip 後面」的視覺順序。
      let sweepAngle = 0;
      let sweepOverlay = null; // 建立 Chart 之後才會賦值，避免在 Chart.js 初始化過程中異動它的父層 DOM

      function drawSweep() {
        if (!sweepOverlay) return;
        const { ctx } = sweepOverlay;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return; // 面板還隱藏中，量到0就先不要空跑繪製
        ctx.clearRect(0, 0, rect.width, rect.height);

        const rScale = radarChartInstance && radarChartInstance.scales && radarChartInstance.scales.r;
        if (!rScale || typeof rScale.xCenter !== 'number') return;
        if (typeof ctx.createConicGradient !== 'function') return; // 舊瀏覽器沒有這個API就跳過裝飾效果，不影響圖表本身

        // 切換分組（display:none）再切回來時，Chart.js 的 scales.r 有可能還沒重新算好，
        // xCenter/yCenter 會暫時變成 0（型別仍是 number，過不了上面那個型別檢查）。
        // 這種情況改用畫布本身的中心點當 fallback，避免整個掃描光偏移到左上角、看起來像消失。
        const xCenter = rScale.xCenter > 0 ? rScale.xCenter : rect.width / 2;
        const yCenter = rScale.yCenter > 0 ? rScale.yCenter : rect.height / 2;

        // 半徑改成動態算：用「圓心到畫布最遠角落」的距離，
        // 這樣不管卡片實際多寬多高，掃描光轉一圈都能覆蓋到整個區塊，不會只在中間畫一個小圓。
        const cw = radarChartInstance.width || rect.width || 0;
        const ch = radarChartInstance.height || rect.height || 0;
        const dx = Math.max(xCenter, cw - xCenter);
        const dy = Math.max(yCenter, ch - yCenter);
        const radius = Math.sqrt(dx * dx + dy * dy);

        ctx.save();
        const gradient = ctx.createConicGradient(sweepAngle, xCenter, yCenter);
        gradient.addColorStop(0, 'rgba(' + glowRgb + ', 0.35)');
        gradient.addColorStop(0.16, 'rgba(' + glowRgb + ', 0)');
        gradient.addColorStop(1, 'rgba(' + glowRgb + ', 0)');
        ctx.beginPath();
        ctx.arc(xCenter, yCenter, radius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.globalCompositeOperation = 'screen';
        ctx.fill();
        ctx.restore();
      }

      let radarChartInstance; // drawSweep() 會讀取這個變數，先宣告好避免暫時性死區報錯

      radarChartInstance = new Chart(canvas, {
        type: 'radar',
        data: {
          labels,
          datasets: [
            {
              label: '本期',
              data: currentValues,
              borderColor: 'rgb(' + glowRgb + ')',
              backgroundColor: 'rgba(' + glowRgb + ', 0.15)',
              pointBackgroundColor: 'rgb(' + glowRgb + ')',
              pointBorderColor: '#0f1115',
              pointRadius: 6,
              pointHoverRadius: 9,
              borderWidth: 2,
            },
            {
              label: '上期',
              data: previousValues,
              borderColor: 'rgba(154,160,172,0.7)',
              backgroundColor: 'rgba(154,160,172,0.06)',
              pointBackgroundColor: 'rgba(154,160,172,0.7)',
              pointBorderColor: '#0f1115',
              pointRadius: 4,
              pointHoverRadius: 7,
              borderWidth: 1.5,
              borderDash: [4, 3],
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false, // 進場動畫全站關閉，見上方 Chart.defaults.animation 說明
          onResize: () => { if (sweepOverlay) sweepOverlay.resize(); }, // 疊加層尺寸交給Chart.js自己的resize通知來同步，不再自己另外掛ResizeObserver
          scales: {
            r: {
              min: 0, max: 100,
              angleLines: { color: 'rgba(255,255,255,0.08)' },
              grid: { color: 'rgba(255,255,255,0.08)' },
              pointLabels: { color: '#9aa0ac', font: { family: 'JetBrains Mono, monospace', size: 11 } },
              ticks: { display: false, stepSize: 25 },
            },
          },
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: { color: '#9aa0ac', font: { family: 'JetBrains Mono, monospace', size: 10 }, boxWidth: 12, padding: 12 },
            },
            tooltip: {
              animation: { duration: 0 }, // 掃描光效果已改成畫在獨立疊加canvas（見createEffectOverlay），不再跟這裡的tooltip搶畫布；保留不淡入純粹是喜歡這個顯示效果
              callbacks: {
                label: (ctx) => ctx.dataset.label + ' · ' + ctx.label + '：' + ctx.raw + '%' + (ctx.datasetIndex === 0 ? '（點擊查看評論）' : ''),
              },
            },
          },
          onClick: (evt, elements) => {
            if (!elements.length) return;
            const el = elements.find(e => e.datasetIndex === 0) || elements[0];
            if (el.datasetIndex !== 0) return; // 只有「本期」那條線可以點擊查看評論，「上期」是對照用
            const key = labels[el.index];
            let matched, title;
            if (key === '版本穩定度') {
              const regressionVersions = new Set(versionAnalysis.filter(v => v.isRegression).map(v => v.version));
              matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && regressionVersions.has(r.version) && r.sentiment === 'negative');
              title = '版本異常相關負評';
            } else {
              matched = dataset.allReviewsFlat.filter(r => r.intent === key);
              title = key + ' 的評論';
            }
            openReviewDrawer(title, '共 ' + matched.length + ' 則', matched);
          },
        },
      });

      // Chart 建立完成、DOM已穩定之後，才建立疊加canvas並插入它的父層容器，
      // 避免在 Chart.js 初始化/掛內部 ResizeObserver 的過程中去異動同一個容器的 DOM 結構。
      sweepOverlay = createEffectOverlay(canvas, { insertBefore: true });

      // 暴露到全域，讓「大分組切換」那段監聽器可以在切回 LIVE MONITOR 時主動呼叫一次
      // radarChartInstance.resize()，強制 Chart.js 重新計算 scales.r 的中心座標，
      // 不要只被動等內部 ResizeObserver（時機不保證跟 display:none→block 完全同步）。
      window.radarChartInstance = radarChartInstance;

      // ===== 用 requestAnimationFrame 持續轉動掃描光角度 =====
      // 現在只重繪疊加的 sweepOverlay canvas，完全不碰 radarChartInstance，
      // Chart.js 自己的 tooltip/hover 重繪排程不會再被打斷。分頁切到背景時暫停，切回來再繼續，省資源。
      let sweepRafId = null;
      function tickSweep() {
        sweepAngle += 0.025;
        if (sweepAngle > Math.PI * 2) sweepAngle -= Math.PI * 2;
        drawSweep();
        sweepRafId = requestAnimationFrame(tickSweep);
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (sweepRafId) cancelAnimationFrame(sweepRafId);
          sweepRafId = null;
        } else if (!sweepRafId) {
          sweepRafId = requestAnimationFrame(tickSweep);
        }
      });
      sweepRafId = requestAnimationFrame(tickSweep);
    })();

    // ===== LIVE MONITOR：平台佔比小圖表（補左欄高度，同時是有用的資訊） =====
    (function renderPlatformRatioChart() {
      const canvas = document.getElementById('platformRatioChart');
      if (!canvas || !window.Chart) return;

      const androidCount = (dataset.allReviewsFlat || []).filter(r => r.platform === 'android').length;
      const iosCount = (dataset.allReviewsFlat || []).filter(r => r.platform === 'ios').length;

      // 自訂plugin：在圖上對應的區塊拉出一條線＋百分比標註（不是疊在圖例文字裡）
      const pullOutLabelPlugin = {
        id: 'pullOutLabelPlugin',
        afterDraw(chart) {
          try {
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            if (!meta || !meta.data || !meta.data.length) return;
            const values = chart.data.datasets[0].data;
            const total = values.reduce((s, v) => s + v, 0) || 1;

            meta.data.forEach((arc, i) => {
              if (!values[i]) return; // 數值為0的區塊不畫標註，避免線條疊在圓心

              // 直接用ArcElement本身的x/y/outerRadius屬性（比呼叫getCenterPoint()更直接可靠）
              const cx = arc.x;
              const cy = arc.y;
              const r = arc.outerRadius;
              if (typeof cx !== 'number' || typeof cy !== 'number' || typeof r !== 'number') return;

              const angle = (arc.startAngle + arc.endAngle) / 2;
              const cos = Math.cos(angle);
              const sin = Math.sin(angle);
              const isRight = cos >= 0;

              const p1 = { x: cx + cos * r, y: cy + sin * r };
              const p2 = { x: cx + cos * (r + 10), y: cy + sin * (r + 10) };
              const p3 = { x: p2.x + (isRight ? 14 : -14), y: p2.y };

              const pct = Math.round(values[i] / total * 100);

              ctx.save();
              ctx.strokeStyle = 'rgba(255,255,255,0.5)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.lineTo(p3.x, p3.y);
              ctx.stroke();

              // 字體用保證存在的通用字體，不依賴網頁字體（JetBrains Mono）是否已經載入完成，
              // 避免字體還沒就緒時canvas文字畫不出來的問題。
              ctx.fillStyle = '#ffffff';
              ctx.font = 'bold 12px sans-serif';
              ctx.textAlign = isRight ? 'left' : 'right';
              ctx.textBaseline = 'middle';
              ctx.fillText(pct + '%', p3.x + (isRight ? 4 : -4), p3.y);
              ctx.restore();
            });
          } catch (err) {
            console.error('平台佔比拉出標註繪製失敗：', err);
          }
        },
      };

      // canvas 的顏色設定不支援 var(--xxx) 語法，這裡先讀出主色的實際RGB值
      const glowRgb = getComputedStyle(document.documentElement).getPropertyValue('--hud-glow').trim() || '198, 242, 78';

      // ===== 游標追蹤光點 + 同心圓漣漪：畫在獨立的疊加 canvas 上（見 createEffectOverlay） =====
      // 疊加層蓋在圖表 canvas 上面，維持跟原本 afterDraw 一樣「效果在圓環上方」的視覺順序；
      // 迴圈只重繪這顆疊加 canvas，完全不再呼叫 platformChartInstance.draw()。
      let dotAngle = 0;
      let ripples = []; // 每個元素：{ startTime }（用performance.now()記錄漣漪誕生時間）
      const RIPPLE_DURATION = 1800; // 一圈漣漪從出生到完全淡出要花多久（毫秒）
      const RIPPLE_EXPAND = 22; // 漣漪從外緣往外擴散的最大距離（px）

      let platformChartInstance; // drawRingEffects() 會讀取這個變數，先宣告好避免暫時性死區報錯
      let ringOverlay = null; // 建立 Chart 之後才會賦值，避免在 Chart.js 初始化過程中異動它的父層 DOM

      function drawRingEffects() {
        if (!ringOverlay) return;
        const { ctx } = ringOverlay;
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);

        try {
          const meta = platformChartInstance && platformChartInstance.getDatasetMeta(0);
          if (!meta || !meta.data || !meta.data.length) return;
          const arc = meta.data[0];
          if (typeof arc.x !== 'number') return;
          const cx = arc.x, cy = arc.y;
          const innerR = arc.innerRadius;
          const outerR = arc.outerRadius;
          const midR = (innerR + outerR) / 2;
          const now = performance.now();

          // 同心圓漣漪：每圈從圓環外緣往外擴散、邊淡出
          ripples.forEach((r) => {
            const age = now - r.startTime;
            if (age > RIPPLE_DURATION) return;
            const t = age / RIPPLE_DURATION;
            const radius = outerR + t * RIPPLE_EXPAND;
            const alpha = (1 - t) * 0.45;
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(' + glowRgb + ', ' + alpha.toFixed(2) + ')';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
          });

          // 游標追蹤光點：沿著圓環中線持續繞圈
          const dotX = cx + Math.cos(dotAngle) * midR;
          const dotY = cy + Math.sin(dotAngle) * midR;
          ctx.save();
          ctx.beginPath();
          ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = 'rgb(' + glowRgb + ')';
          ctx.shadowBlur = 9;
          ctx.fill();
          ctx.restore();
        } catch (err) {
          console.error('平台佔比動效繪製失敗：', err);
        }
      }

      platformChartInstance = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: ['Android', 'iOS'],
          datasets: [{
            data: [androidCount, iosCount],
            backgroundColor: ['#C6F24E', '#00DDCD'],
            borderColor: '#0f1115',
            borderWidth: 2,
          }],
        },
        plugins: [pullOutLabelPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          layout: { padding: { top: 18, bottom: 18, left: 40, right: 40 } },
          animation: false, // 進場動畫全站關閉，見上方 Chart.defaults.animation 說明
          onResize: () => { if (ringOverlay) ringOverlay.resize(); }, // 疊加層尺寸交給Chart.js自己的resize通知來同步，不再自己另外掛ResizeObserver
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: { color: '#9aa0ac', font: { family: 'JetBrains Mono, monospace', size: 10 }, boxWidth: 10, padding: 10 },
            },
            tooltip: {
              animation: { duration: 0 }, // 光點+漣漪效果已改成畫在獨立疊加canvas（見createEffectOverlay），不再跟這裡的tooltip搶畫布；保留不淡入純粹是喜歡這個顯示效果
              callbacks: {
                label: (ctx) => ctx.label + '：' + ctx.raw + ' 則',
              },
            },
          },
          onClick: (evt, elements) => {
            if (!elements.length) return;
            const platform = elements[0].index === 0 ? 'android' : 'ios';
            const matched = dataset.allReviewsFlat.filter(r => r.platform === platform);
            openReviewDrawer((platform === 'android' ? 'Android' : 'iOS') + ' 的評論', '共 ' + matched.length + ' 則', matched);
          },
        },
      });

      // Chart 建立完成、DOM已穩定之後，才建立疊加canvas並插入它的父層容器，
      // 避免在 Chart.js 初始化/掛內部 ResizeObserver 的過程中去異動同一個容器的 DOM 結構。
      ringOverlay = createEffectOverlay(canvas);

      // ===== 動畫迴圈：光點持續繞圈、每隔一段時間產生新的漣漪 =====
      // 現在只重繪疊加的 ringOverlay canvas，完全不碰 platformChartInstance。
      let ringRafId = null;
      let lastRippleSpawn = 0;
      function tickRingEffects(ts) {
        dotAngle += 0.03;
        if (dotAngle > Math.PI * 2) dotAngle -= Math.PI * 2;
        if (!lastRippleSpawn || ts - lastRippleSpawn > 2600) {
          ripples.push({ startTime: ts });
          lastRippleSpawn = ts;
        }
        ripples = ripples.filter((r) => ts - r.startTime <= RIPPLE_DURATION);
        drawRingEffects();
        ringRafId = requestAnimationFrame(tickRingEffects);
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (ringRafId) cancelAnimationFrame(ringRafId);
          ringRafId = null;
        } else if (!ringRafId) {
          ringRafId = requestAnimationFrame(tickRingEffects);
        }
      });
      ringRafId = requestAnimationFrame(tickRingEffects);
    })();

    // ===== LIVE MONITOR：整合告警清單（版本異常＋熱門痛點＋旅程痛點，依負評則數排序） =====
    // ===== 共用：整合告警清單的資料組裝（版本異常＋熱門痛點＋旅程痛點，依負評則數排序） =====
    // LIVE MONITOR 的異常清單、跟自動摘要卡片一都要用同一份「合併排序後」的訊號清單。
    function computeAnomalyItems() {
      const items = [];

      (dataset.versionRegressions || []).forEach((v) => {
        items.push({
          typeShort: '版本',
          label: 'v' + v.version + ' 評分驟降 ' + v.scoreDrop.toFixed(2) + ' 分',
          count: v.negativeCount,
          onClick: () => {
            const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === v.version && r.sentiment === 'negative');
            openReviewDrawer('v' + v.version + ' 的負評', '共 ' + matched.length + ' 則', matched);
          },
        });
      });

      (dataset.topPainPoints || []).forEach((p) => {
        items.push({
          typeShort: '痛點',
          label: p.category,
          count: p.negativeCount,
          onClick: () => {
            const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(p.category) && r.sentiment === 'negative');
            openReviewDrawer(p.category + ' 的歷史負評', '共 ' + matched.length + ' 則', matched);
          },
        });
      });

      (dataset.journeyPainPoints || []).forEach((p) => {
        if (!p.count) return;
        items.push({
          typeShort: '旅程',
          label: p.code + ' ' + p.label + '（' + p.stage + '）',
          count: p.count,
          onClick: () => {
            const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(p.category) && r.sentiment === 'negative');
            openReviewDrawer(p.code + ' · ' + p.label, '共 ' + matched.length + ' 則', matched);
          },
        });
      });

      items.sort((a, b) => b.count - a.count);
      return items;
    }

    (function renderAnomalyList() {
      const container = document.getElementById('anomalyList');
      if (!container) return;

      const top = computeAnomalyItems().slice(0, 20);

      container.innerHTML = top.map((item, i) => {
        const severity = i < 3 ? 'critical' : 'warn';
        return '<div class="anomaly-row" style="animation-delay:' + (i * 60) + 'ms">' +
          '<span class="anomaly-severity ' + severity + '"></span>' +
          '<span class="anomaly-tag-type">' + item.typeShort + '</span>' +
          '<span class="anomaly-label ' + severity + '">' + item.label + '</span>' +
          '<span class="anomaly-count">' + item.count + '則</span>' +
          '</div>';
      }).join('') || '<div class="note">目前沒有明顯異常</div>';

      container.querySelectorAll('.anomaly-row').forEach((el, i) => {
        el.addEventListener('click', () => top[i].onClick());
      });
    })();

    // ===== LIVE MONITOR：近期熱門負評關鍵字（改用長條圖，取代原本的文字雲呈現） =====
    // ===== LIVE MONITOR：近期熱門負評關鍵字（戰術點陣 LED Meter，取代原本 Chart.js 長條圖） =====
    // renderKeywordRows：由 syncKeywordCardHeight() 依卡片實際可用高度呼叫，
    // 決定LED Meter要顯示幾列關鍵字（大螢幕空間多就多顯示幾列，填滿空間；
    // 窄螢幕維持原本固定5列，這是原本就沒問題的版面，不用動）。
    // 先在外層宣告，避免在renderRecentKeywordChart完成賦值之前被提前呼叫時噴錯。
    let renderKeywordRows = null;

    (function renderRecentKeywordChart() {
      const container = document.getElementById('recentKeywordChart');
      if (!container) return;

      const words = dataset.recentNegativeWordFrequency || [];
      if (!words.length) {
        container.innerHTML = '<div class="note">最近一年沒有足夠的負評關鍵字資料</div>';
        return;
      }

      const CAPACITY = 40; // 每條軌道固定40格
      const OVERLOAD_TAIL = 5; // 超過上限時，末端幾格轉警示色
      const MAX_ROWS = words.length; // Node端(generate-dashboard.js)最多保留15筆，見 recentNegativeWordFrequency

      // 每個燈格用 CSS 變數帶入進場動畫的延遲時間，做出「由左至右逐格點亮」的掃描效果；
      // 40格全部一起錯開時間太久會顯得拖沓，這裡限制在很短的時間窗內（每格4ms）掃完。
      function buildTrack(count) {
        const isOverload = count > CAPACITY;
        const activeCount = isOverload ? CAPACITY : count;
        const overloadStart = CAPACITY - OVERLOAD_TAIL;

        let html = '';
        for (let i = 0; i < CAPACITY; i++) {
          let cls = 'led-seg';
          if (i < activeCount) {
            cls += (isOverload && i >= overloadStart) ? ' is-overload' : ' is-active';
          }
          html += '<span class="' + cls + '" style="--seg-delay:' + (i * 4) + 'ms"></span>';
        }
        return { html, isOverload };
      }

      // 底部刻度：每10格一個較亮的主刻度，每5格一個較淡的次刻度，純視覺，不帶數字。
      // 改用百分比定位（n/40）而不是固定px，因為燈條現在是RWD的（大螢幕會grow變寬），
      // 百分比可以確保不管燈條實際渲染出來多寬，刻度永遠對齊在正確的格數位置上。
      function buildScaleTicks() {
        let ticks = '';
        for (let n = 0; n <= CAPACITY; n += 5) {
          const isMajor = n % 10 === 0;
          const leftPct = Math.min((n / CAPACITY) * 100, 99.5);
          ticks += '<span class="tick ' + (isMajor ? 'major' : 'minor') + '" style="left:' + leftPct.toFixed(3) + '%"></span>';
        }
        return ticks;
      }

      // 點擊某一列＝查看該關鍵字相關負評，篩選條件要跟數字來源完全一致（近一年＋負評），
      // 不能只篩負評卻不限時間範圍，不然點進去看到的則數會比燈格代表的數字多。
      function openWordDrawer(word) {
        const months = dataset.recentMonthsForKeywords || [];
        const matched = dataset.allReviewsFlat.filter(r =>
          r.sentiment === 'negative' && months.includes(r.month) && (r.text || '').includes(word)
        );
        openReviewDrawer('「' + word + '」相關負評', '共 ' + matched.length + ' 則', matched);
      }

      function renderRows(rowCount) {
        const shown = words.slice(0, Math.max(1, Math.min(rowCount, MAX_ROWS)));

        const noteEl = document.getElementById('keywordChartNote');
        if (noteEl) noteEl.textContent = '最近一年負評，依出現則數排序（前' + shown.length + '名）';

        const rowsHtml = shown.map((w, i) => {
          const { html: trackHtml, isOverload } = buildTrack(w.count);
          const idx = String(i + 1).padStart(2, '0');
          const countLabel = isOverload ? ('[ ' + w.count + '! ]') : ('[ ' + w.count + ' 則 ]');
          return (
            '<div class="led-row" data-word-index="' + i + '" role="button" tabindex="0">' +
              '<div class="led-label" title="' + w.word + '">' +
                '<span class="led-idx">' + idx + '</span><span class="led-slash">//</span>' + w.word +
              '</div>' +
              '<div class="led-track-scroll"><div class="led-track">' + trackHtml + '</div></div>' +
              '<div class="led-count' + (isOverload ? ' is-overload' : '') + '">' + countLabel + '</div>' +
            '</div>'
          );
        }).join('');

        const scaleHtml =
          '<div class="led-scale">' +
            '<div class="led-scale-spacer"></div>' +
            '<div class="led-scale-track-scroll"><div class="led-scale-track">' + buildScaleTicks() + '</div></div>' +
            '<div class="led-scale-spacer-right"></div>' +
          '</div>';

        container.innerHTML = rowsHtml + scaleHtml;

        container.querySelectorAll('.led-row').forEach((row) => {
          const word = shown[Number(row.dataset.wordIndex)].word;
          row.addEventListener('click', () => openWordDrawer(word));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openWordDrawer(word);
            }
          });
        });
      }

      renderRows(5); // 先渲染預設5列（原本的行為），等版面高度定案後，syncKeywordCardHeight() 可能會呼叫 renderKeywordRows() 展開更多列
      renderKeywordRows = renderRows;
    })();


    // ===== LIVE MONITOR：讓右欄（系統異常清單）的底部，精準對齊左欄（KPI＋平台佔比）的底部 =====
    // 不依賴CSS Grid的align-items:stretch（不同瀏覽器對「grid item裡面還是flex容器」這種巢狀情境
    // 的處理不一致，實測發現不可靠），改用JS直接量兩欄實際的像素高度，強制設定右欄容器高度，
    // 讓內部的flex:1（異常清單）去吸收多出來的空間，異常清單的底部自然就會對齊左欄底部。
    function syncLiveColumnHeights() {
      const col1 = document.querySelector('.live-col-1');
      const col3 = document.querySelector('.live-col-3');
      if (!col1 || !col3) return;

      // 窄螢幕時 .live-grid 會變成單欄堆疊（見 CSS 的 max-width:1100px），這時候不需要（也不應該）
      // 強制對齊高度，直接清掉先前可能設過的高度即可。
      if (window.innerWidth <= 1100) {
        col3.style.height = '';
        return;
      }

      col3.style.height = ''; // 先清掉，重新量一次原始高度，避免疊加誤差
      const col1Rect = col1.getBoundingClientRect();
      const col3Rect = col3.getBoundingClientRect();
      // col3Rect.height 此時是「突發異常警示（若顯示）＋系統異常與熱門痛點」兩張卡片
      // 疊加後的自然高度，其中已經包含 #anomalyList 的 min-height:160px 安全網，
      // 所以這個值就是這一欄在目前資料量下「最少需要多高」。
      const naturalHeight = col3Rect.height;
      const targetHeight = col1Rect.bottom - col3Rect.top;

      // 底線對齊左欄：正常情況下 targetHeight 會大於 naturalHeight，直接用它撐高
      // #anomalyList（flex:1）去對齊左欄底部。但視窗高度極端不足、算出來的 targetHeight
      // 反而小於安全網下限時，改用 naturalHeight，寧可跟左欄底緣對不齊、讓頁面正常
      // 出現縱向捲軸，也不要把清單壓縮到看不見。
      const finalHeight = Math.max(targetHeight, naturalHeight);

      if (finalHeight > 0) {
        col3.style.height = finalHeight + 'px';
      }
    }

    // ===== LIVE MONITOR：讓「近期熱門負評關鍵字」卡片的底部，對齊左欄（KPI＋平台佔比）的底部 =====
    // 健康雷達卡片高度是固定的，「近期熱門負評關鍵字」疊在它下面，
    // 所以是靠壓縮/放寬「近期熱門負評關鍵字」這張卡片本身的高度，讓它跟左欄底部對齊，
    // 不是動整欄（live-col-2）的高度——雷達圖不該因為這個對齊需求被連帶壓縮或拉長。
    function syncKeywordCardHeight() {
      const col1 = document.querySelector('.live-col-1');
      const card = document.getElementById('keywordChartCard');
      if (!col1 || !card) return;

      if (window.innerWidth <= 1100) {
        card.style.height = '';
        if (renderKeywordRows) renderKeywordRows(5); // 窄螢幕維持原本固定5列，版面本來就沒問題
        return;
      }

      card.style.height = ''; // 先清掉，重新量一次原始高度，避免疊加誤差
      const col1Rect = col1.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const targetHeight = col1Rect.bottom - cardRect.top;
      const minHeight = 130; // 保留最基本的可讀高度，避免資料一多、算出來的高度被壓成看不出內容

      if (targetHeight > 0) {
        const finalHeight = Math.max(targetHeight, minHeight);
        card.style.height = finalHeight + 'px';

        // 大螢幕上這張卡片常會被撐得比LED Meter本身內容還高（見上方對齊左欄底部的邏輯），
        // 固定顯示5列會在下面留一大片空白。這裡改成依卡片實際可用高度，動態算出能放幾列，
        // 撐得越高就多顯示幾列關鍵字，把多出來的空間換成有用的資訊，而不是空白。
        // ROW_HEIGHT／SCALE_HEIGHT是估算值（列高+行距、底部刻度尺區域），加SAFETY_MARGIN
        // 是為了避免算得剛剛好、不同瀏覽器的字型度量差異導致最後一列被裁切。
        if (renderKeywordRows) {
          const containerEl = card.querySelector('.chart-container');
          const availableHeight = containerEl ? containerEl.getBoundingClientRect().height : 0;
          const ROW_HEIGHT = 31;
          const SCALE_HEIGHT = 20;
          const SAFETY_MARGIN = 8;
          const rowCapacity = Math.floor((availableHeight - SCALE_HEIGHT - SAFETY_MARGIN) / ROW_HEIGHT);
          const rowCount = Math.max(5, rowCapacity); // renderRows()內部會再依實際資料筆數(最多15筆)夾住上限
          renderKeywordRows(rowCount);
        }
      }
    }

    // 用 requestAnimationFrame 確保在圖表都畫完、實際版面穩定後才量測
    requestAnimationFrame(() => requestAnimationFrame(() => {
      syncLiveColumnHeights();
      syncKeywordCardHeight();
    }));
    window.addEventListener('resize', () => {
      syncLiveColumnHeights();
      syncKeywordCardHeight();
    });
    // 額外保險：等 window 的 load 事件（字型、圖片等外部資源都真正載入完成）之後，
    // 再量一次高度、觸發一次圖表 resize()。雙 requestAnimationFrame 通常已經足夠，
    // 但如果容器尺寸因為外部資源（例如自訂字型換臉造成的 reflow）在那之後才穩定，
    // 這裡補一次可以避免極端情況下第一次打開仍然量到不準的高度。
    window.addEventListener('load', () => {
      syncLiveColumnHeights();
      syncKeywordCardHeight();
    });


    const cardClickMap = {
      'android-total': {
        title: 'Google Play 全部評論',
        getReviews: () => dataset.allReviewsFlat.filter(r => r.platform === 'android'),
      },
      'ios-total': {
        title: 'App Store 全部評論',
        getReviews: () => dataset.allReviewsFlat.filter(r => r.platform === 'ios'),
      },
      'this-year-total': {
        title: '今年新增評論（不分平台）',
        getReviews: () => dataset.reviewsByRange.year,
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

    // ===== 切換到某個分頁時，重播該分頁裡圖表的進場動畫 =====
    // 圖表在頁面載入當下就已經全部建立好、動畫也已經在背景（隱藏狀態）悄悄播完了，
    // 所以單純切換分頁不會看到任何動畫。這裡用 Chart.js 的 reset()+update() 技巧，
    // 在「真正切過去、看得到的那一刻」重新播放一次進場動畫；純點點淡入的圖表另外重播 CSS 淡入。
    const TAB_CHART_IDS = {
      comments: ['commentScatterChart', 'wordFrequencyChart'],
      sentiment: ['categoryChart', 'stageChart', 'matrixChart', 'intentChart'],
    };
    function replayTabAnimations(tabKey) {
      if (window.Chart && Chart.instances) {
        const idsForTab = TAB_CHART_IDS[tabKey] || [];
        Object.values(Chart.instances).forEach((c) => {
          const canvasId = c.canvas && c.canvas.id;
          if (!canvasId) return;
          const belongsToTab = idsForTab.includes(canvasId);
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
      if (tabKey === 'journeypain' && window.jpRedrawDividers) {
        window.jpRedrawDividers();
      }
    }

    // ===== 整合式旅程痛點 tab =====
    try {
    (function () {
      const stages = JOURNEY_STAGES_CLIENT;
      const macroGroups = JOURNEY_MACRO_GROUPS_CLIENT;
      const channels = JOURNEY_CHANNELS_CLIENT;
      const flowText = JOURNEY_FLOW_TEXT_CLIENT;
      const stepsMap = JOURNEY_STEPS_CLIENT;
      const points = dataset.journeyPainPoints; // [{category,stage,type,label,code,count,android,ios}]

      const typeColor = { F: 'var(--neg)', D: '#ffd23f', W: '#7ee27e' };
      const typeName = { F: '失敗點', D: '決策點', W: '等待點' };

      let activeTypes = new Set(['F', 'D', 'W']);
      let activePlatforms = new Set(['android', 'ios']);

      function visiblePoints() { return points.filter(p => activeTypes.has(p.type)); }
      function pointsFor(stage) { return visiblePoints().filter(p => p.stage === stage); }
      function pointVisibleCount(p) {
        const a = activePlatforms.has('android') ? p.android : 0;
        const i = activePlatforms.has('ios') ? p.ios : 0;
        return a + i;
      }
      function stageTotal(stage) { return pointsFor(stage).reduce((s, p) => s + pointVisibleCount(p), 0); }
      function heatColor(ratio) {
        const scale = ['#26262a', '#5b4a2a', '#946b1f', '#c98a1a', '#e8621f', '#e8321f'];
        const idx = Math.min(scale.length - 1, Math.floor(ratio * scale.length));
        return scale[idx];
      }

      // 滿意度分數：用分類的平均星等（1~5星，不限負評）換算成0~5分（1星=0分，5星=5分），
      // 同一階段有多個分類時，依各分類的評論則數加權平均。
      function stageSatisfaction(stage) {
        const pts = pointsFor(stage).filter(p => p.avgScore !== null && p.allCount > 0);
        if (!pts.length) return null;
        const totalCount = pts.reduce((s, p) => s + p.allCount, 0);
        if (totalCount === 0) return null;
        const weightedAvgStar = pts.reduce((s, p) => s + p.avgScore * p.allCount, 0) / totalCount;
        return (weightedAvgStar - 1) / 4 * 5;
      }
      function satisfactionColor(score) {
        // 0分=紅、2.5分=黃、5分=綠，線性漸層
        const stops = [
          { at: 0, color: [232, 50, 31] },
          { at: 2.5, color: [232, 178, 31] },
          { at: 5, color: [126, 226, 126] },
        ];
        let a = stops[0], b = stops[stops.length - 1];
        for (let i = 0; i < stops.length - 1; i++) {
          if (score >= stops[i].at && score <= stops[i + 1].at) { a = stops[i]; b = stops[i + 1]; break; }
        }
        const t = b.at === a.at ? 0 : (score - a.at) / (b.at - a.at);
        const rgb = a.color.map((c, i) => Math.round(c + (b.color[i] - c) * t));
        return 'rgb(' + rgb.join(',') + ')';
      }

      function openJourneyDrawer(p) {
        const matched = dataset.allReviewsFlat.filter(r =>
          r.categories.includes(p.category) &&
          r.sentiment === 'negative' &&
          activePlatforms.has(r.platform)
        );
        openReviewDrawer(p.code + ' · ' + p.label, '階段：' + p.stage + '／' + typeName[p.type] + '　共 ' + matched.length + ' 則', matched);
      }

      // 「流程複雜度×痛點密集度」象限圖／優先清單點擊用：一個階段底下可能對應多個痛點分類，
      // 把該階段涵蓋到的所有分類彙整起來，一起找出對應的實際負評內容。
      function openStageDrawer(stage) {
        const categories = [...new Set(pointsFor(stage).map(p => p.category))];
        const matched = dataset.allReviewsFlat.filter(r =>
          categories.some(c => r.categories.includes(c)) &&
          r.sentiment === 'negative' &&
          activePlatforms.has(r.platform)
        );
        openReviewDrawer('階段：' + stage, '共 ' + matched.length + ' 則負評', matched);
      }

      function highlightStage(stage) {
        document.querySelectorAll('.jp-stage-cell').forEach(el => {
          if (el.dataset.stage === stage) {
            el.classList.add('flash');
            if (typeof el.scrollIntoView === 'function') {
              try { el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); } catch (e) {}
            }
            setTimeout(() => el.classList.remove('flash'), 1200);
          }
        });
      }

      function buildRow(labelText, withDivider, subLabel) {
        const row = document.createElement('div');
        row.className = 'jp-row' + (withDivider ? ' jp-section-divider' : '');
        const labelClass = subLabel ? 'jp-row-label jp-row-label-stacked' : 'jp-row-label';
        const labelHtml = subLabel
          ? '<span class="jp-row-label-main">' + labelText + '</span><span class="jp-row-sublabel">' + subLabel + '</span>'
          : '<span>' + labelText + '</span>';
        row.innerHTML = '<div class="' + labelClass + '">' + labelHtml + '</div><div class="jp-grid"></div>';
        return row;
      }

      function renderBoard() {
        const board = document.getElementById('jpBoard');
        board.innerHTML = '';

        const macroRow = buildRow('', false);
        const macroGrid = macroRow.querySelector('.jp-grid');
        macroGroups.forEach(g => {
          const cell = document.createElement('div');
          cell.className = 'jp-macro-cell';
          cell.style.gridColumn = 'span ' + g.span;
          cell.textContent = g.label;
          macroGrid.appendChild(cell);
        });
        board.appendChild(macroRow);

        const stageRow = buildRow('階段', true);
        const stageGrid = stageRow.querySelector('.jp-grid');
        stages.forEach(s => {
          const cell = document.createElement('div');
          cell.className = 'jp-stage-cell';
          cell.dataset.stage = s;
          cell.textContent = s;
          stageGrid.appendChild(cell);
        });
        board.appendChild(stageRow);

        const chRow = buildRow('渠道', true);
        const chGrid = chRow.querySelector('.jp-grid');
        stages.forEach(s => {
          const cell = document.createElement('div');
          cell.className = 'jp-channel-cell';
          cell.textContent = channels[s];
          chGrid.appendChild(cell);
        });
        board.appendChild(chRow);

        const flowRow = buildRow('行為流程', true);
        const flowGrid = flowRow.querySelector('.jp-grid');
        stages.forEach(s => {
          const cell = document.createElement('div');
          cell.className = 'jp-flow-cell';
          cell.textContent = flowText[s] || '—';
          flowGrid.appendChild(cell);
        });
        board.appendChild(flowRow);

        const actionRow = buildRow('顧客行動', true, '色深=負評密度｜大小=則數');
        const actionGrid = actionRow.querySelector('.jp-grid');
        const maxStageTotal = Math.max(1, ...stages.map(stageTotal));
        const maxPointCount = Math.max(1, ...visiblePoints().map(pointVisibleCount));

        stages.forEach(s => {
          const total = stageTotal(s);
          const pts = pointsFor(s);
          const ratio = total / maxStageTotal;
          const cell = document.createElement('div');
          const hasAnyMapping = points.some(p => p.stage === s);
          cell.className = 'jp-action-cell' + (!hasAnyMapping ? ' jp-empty-stage' : '');
          cell.style.background = pts.length ? heatColor(ratio) : 'var(--card)';

          if (!hasAnyMapping) {
            cell.innerHTML = '<div class="jp-action-top"><div class="jp-no-data">無對應分類</div></div>' +
              '<div class="jp-mini-bar-track"><div class="jp-mini-bar-fill" style="width:0%"></div></div>' +
              '<div class="jp-total-count">—</div>';
          } else {
            const dotsHtml = pts.map(p => {
              const vc = pointVisibleCount(p);
              const size = 13 + Math.round((vc / maxPointCount) * 13);
              return '<div class="jp-point" data-code="' + p.code + '" style="width:' + size + 'px;height:' + size + 'px;background:' + typeColor[p.type] + ';font-size:' + Math.max(7, size * 0.38) + 'px;">' + p.code + '</div>';
            }).join('');
            cell.innerHTML = '<div class="jp-action-top"><div class="jp-dots">' + (dotsHtml || '<span class="jp-no-data">已篩選為空</span>') + '</div></div>' +
              '<div class="jp-mini-bar-track"><div class="jp-mini-bar-fill" style="width:' + (ratio * 100) + '%; background:' + heatColor(ratio) + '; filter:brightness(1.5);"></div></div>' +
              '<div class="jp-total-count">共 ' + total + ' 則</div>';
          }
          actionGrid.appendChild(cell);
        });
        board.appendChild(actionRow);

        const satisfactionRow = buildRow('滿意度', true);
        const satisfactionGrid = satisfactionRow.querySelector('.jp-grid');
        stages.forEach(s => {
          const score = stageSatisfaction(s);
          const cell = document.createElement('div');
          cell.className = 'jp-satisfaction-cell';
          if (score === null) {
            cell.innerHTML = '<div class="jp-no-data">無資料</div>';
          } else {
            const color = satisfactionColor(score);
            cell.innerHTML =
              '<div class="jp-satisfaction-score" style="color:' + color + '">' + score.toFixed(1) + '</div>' +
              '<div class="jp-satisfaction-scale">／5</div>' +
              '<div class="jp-satisfaction-track"><div class="jp-satisfaction-fill" style="width:' + (score / 5 * 100) + '%; background:' + color + ';"></div></div>';
          }
          satisfactionGrid.appendChild(cell);
        });
        board.appendChild(satisfactionRow);

        board.querySelectorAll('.jp-point[data-code]').forEach(d => {
          d.addEventListener('click', () => {
            const p = points.find(pt => pt.code === d.dataset.code);
            if (p) openJourneyDrawer(p);
          });
        });

        drawDividers(board, stageRow);
      }

      function drawDividers(board, stageRow) {
        board.querySelectorAll('.jp-macro-divider').forEach(el => el.remove());
        const cells = stageRow.querySelector('.jp-grid').children;
        const boardRect = board.getBoundingClientRect();
        const boardHeight = board.scrollHeight;
        if (boardRect.width === 0) return; // 版面還量不到寬度，先跳過，稍後resize/切分頁時會重算
        let cumulative = 0;
        const boundaries = [];
        macroGroups.slice(0, -1).forEach(g => { cumulative += g.span; boundaries.push(cumulative); });
        boundaries.forEach(b => {
          const cellBefore = cells[b - 1], cellAfter = cells[b];
          if (!cellBefore || !cellAfter) return;
          const rectBefore = cellBefore.getBoundingClientRect();
          const rectAfter = cellAfter.getBoundingClientRect();
          const x = (rectBefore.right + rectAfter.left) / 2 - boardRect.left;
          const line = document.createElement('div');
          line.className = 'jp-macro-divider';
          line.style.left = x + 'px';
          line.style.height = boardHeight + 'px';
          board.appendChild(line);
        });
      }

      function buildIndependentRow(container, labelText, valuesMap, cellClass) {
        container.innerHTML = '';
        const label = document.createElement('div');
        label.className = 'jp-row-label';
        label.innerHTML = '<span>' + labelText + '</span><span class="jp-arrow">▾</span>';
        const gridWrap = document.createElement('div');
        gridWrap.className = 'jp-collapsible';
        const grid = document.createElement('div');
        grid.className = 'jp-grid';
        stages.forEach(s => {
          const val = valuesMap[s];
          const cell = document.createElement('div');
          cell.className = cellClass + (val ? '' : ' jp-empty');
          cell.textContent = val || '—';
          grid.appendChild(cell);
        });
        gridWrap.appendChild(grid);
        container.appendChild(label);
        container.appendChild(gridWrap);
        label.querySelector('.jp-arrow').addEventListener('click', () => {
          gridWrap.classList.toggle('open');
          label.querySelector('.jp-arrow').classList.toggle('open');
        });
      }

      let jpQuadExpanded = false;
      let jpParetoExpanded = false;

      function renderQuadrant() {
        const svg = document.getElementById('jpQuadChart');
        const W = 380, H = jpQuadExpanded ? 480 : 300, padL = 42, padR = 16, padT = 26, padB = 34;
        const plotW = W - padL - padR, plotH = H - padT - padB;

        const data = stages.filter(s => stepsMap[s]).map(s => ({ stage: s, steps: stepsMap[s] || 1, pain: stageTotal(s) }));
        const maxSteps = Math.max(...data.map(d => d.steps)) + 1;
        const maxPain = Math.max(1, ...data.map(d => d.pain)) + 3;
        const xScale = v => padL + (v / maxSteps) * plotW;
        const yScale = v => padT + plotH - (v / maxPain) * plotH;
        const midX = maxSteps / 2, midY = maxPain / 2;

        let html = '';
        html += '<rect x="' + xScale(midX) + '" y="' + padT + '" width="' + (xScale(maxSteps) - xScale(midX)) + '" height="' + (yScale(midY) - padT) + '" fill="rgba(255,107,107,0.10)"/>';
        html += '<rect x="' + padL + '" y="' + padT + '" width="' + (xScale(midX) - padL) + '" height="' + (yScale(midY) - padT) + '" fill="rgba(255,255,255,0.03)"/>';
        html += '<rect x="' + xScale(midX) + '" y="' + yScale(midY) + '" width="' + (xScale(maxSteps) - xScale(midX)) + '" height="' + (yScale(0) - yScale(midY)) + '" fill="rgba(255,255,255,0.03)"/>';
        html += '<rect x="' + padL + '" y="' + yScale(midY) + '" width="' + (xScale(midX) - padL) + '" height="' + (yScale(0) - yScale(midY)) + '" fill="rgba(255,255,255,0.015)"/>';
        html += '<line class="jp-quad-line" x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '"/>';
        html += '<line class="jp-quad-line" x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '"/>';
        html += '<line class="jp-quad-grid" x1="' + xScale(midX) + '" y1="' + padT + '" x2="' + xScale(midX) + '" y2="' + (H - padB) + '"/>';
        html += '<line class="jp-quad-grid" x1="' + padL + '" y1="' + yScale(midY) + '" x2="' + (W - padR) + '" y2="' + yScale(midY) + '"/>';
        html += '<text class="jp-quad-axis" x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle">流程步驟數 →</text>';
        html += '<text class="jp-quad-axis" x="12" y="' + (H / 2) + '" text-anchor="middle" transform="rotate(-90 12 ' + (H / 2) + ')">負評則數 →</text>';
        html += '<text class="jp-quad-label" x="' + (xScale(maxSteps) - 4) + '" y="' + (padT + 12) + '" text-anchor="end" fill="#ff6b6b">優先重新設計</text>';
        html += '<text class="jp-quad-label" x="' + (padL + 4) + '" y="' + (H - padB - 6) + '" text-anchor="start" fill="#7ee27e">相對健康</text>';

        // ===== 標籤防重疊：座標相近的點，標籤很容易疊在一起，這裡做簡單的碰撞偵測，
        //      重疊時就把後面的標籤往下移一點，直到不再跟前面已放置的標籤重疊為止；
        //      同時把「優先重新設計」「相對健康」這兩個角落文字也算進碰撞範圍，
        //      並限制標籤最少要離頂端 12px，避免超出可視範圍被裁切。 =====
        const placedLabels = [
          { x1: xScale(maxSteps) - 4 - 70, x2: xScale(maxSteps) - 4, y: padT + 12 },
          { x1: padL + 4, x2: padL + 4 + 40, y: H - padB - 6 },
        ];
        const MIN_LABEL_Y = 12;
        function findNonOverlappingY(cx, baseY, textWidth) {
          let y = Math.max(baseY, MIN_LABEL_Y);
          const x1 = cx - textWidth / 2, x2 = cx + textWidth / 2;
          const LINE_STEP = 11;
          let attempt = 0;
          while (attempt < 8) {
            const collide = placedLabels.some((p) => x1 < p.x2 && x2 > p.x1 && Math.abs(y - p.y) < LINE_STEP);
            if (!collide) break;
            y += LINE_STEP; // 往下疊放，而不是互相蓋住
            attempt++;
          }
          placedLabels.push({ x1, x2, y });
          return y;
        }

        const pointsHtml = data.map((d) => {
          const cx = xScale(d.steps), cy = yScale(d.pain);
          const r = 4 + Math.sqrt(d.pain) * 1.1;
          const isPriority = d.steps >= midX && d.pain >= midY;
          const color = isPriority ? '#ff6b6b' : (d.pain === 0 ? '#4a4a4e' : '#e8621f');
          const estWidth = d.stage.length * 12; // 粗略估計文字寬度（中文字約 12px/字），用於碰撞偵測
          const labelY = findNonOverlappingY(cx, cy - r - 4, estWidth);
          return '<g class="jp-quad-point" data-stage="' + d.stage + '"><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '" fill-opacity="0.75" stroke="' + color + '"/><text x="' + cx + '" y="' + labelY + '" text-anchor="middle">' + d.stage + '</text></g>';
        }).join('');
        html += pointsHtml;

        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); // 展開時 H 會變大，viewBox 也要跟著更新，不然畫面會被裁切
        svg.innerHTML = html;
        svg.querySelectorAll('.jp-quad-point').forEach(el => {
          el.addEventListener('click', () => {
            openStageDrawer(el.dataset.stage);
            highlightStage(el.dataset.stage);
          });
        });

        const priority = data.filter(d => d.steps >= midX && d.pain >= midY).sort((a, b) => b.pain - a.pain).slice(0, 5); // 只列前 5 名
        const list = document.getElementById('jpPriorityList');
        list.innerHTML = priority.map((d, i) =>
          '<div class="jp-priority-item" data-stage="' + d.stage + '">' +
          '<div class="jp-priority-rank">' + (i + 1) + '</div>' +
          '<div class="jp-priority-name">' + d.stage + '</div>' +
          '<div class="jp-priority-meta">' + d.steps + '步驟／' + d.pain + '則</div></div>'
        ).join('') || '<div class="jp-priority-meta">目前篩選下右上象限無資料</div>';
        list.querySelectorAll('.jp-priority-item').forEach(el => {
          el.addEventListener('click', () => {
            openStageDrawer(el.dataset.stage);
            highlightStage(el.dataset.stage);
          });
        });
      }

      function renderPareto() {
        const list = document.getElementById('jpParetoList');
        const visible = visiblePoints().map(p => Object.assign({}, p, { vc: pointVisibleCount(p) })).sort((a, b) => b.vc - a.vc);
        const totalAll = visible.reduce((s, p) => s + p.vc, 0) || 1;
        const top = visible.slice(0, jpParetoExpanded ? 20 : 6); // 收合時列前 6 名，展開時列前 20 名
        const maxVc = Math.max(1, ...top.map(p => p.vc));

        list.innerHTML = top.map((p, i) =>
          '<div class="jp-pareto-row" data-code="' + p.code + '">' +
          '<div class="jp-pareto-top"><span><span class="jp-pareto-rank">#' + (i + 1) + '</span>' +
          '<span class="jp-pareto-code" style="color:' + typeColor[p.type] + '">' + p.code + '</span></span>' +
          '<span class="jp-pareto-count">' + p.vc + ' 則</span></div>' +
          '<div class="jp-pareto-label">' + p.label + '（' + p.stage + '）</div>' +
          '<div class="jp-pareto-track"><div class="jp-pareto-fill" style="width:' + (p.vc / maxVc * 100) + '%; background:' + typeColor[p.type] + '"></div></div>' +
          '<div class="jp-pareto-pct">佔篩選後總負評 ' + Math.round(p.vc / totalAll * 100) + '%</div></div>'
        ).join('') || '<div class="jp-priority-meta">目前篩選條件下無資料</div>';

        list.querySelectorAll('.jp-pareto-row').forEach(el => {
          el.addEventListener('click', () => {
            const p = points.find(pt => pt.code === el.dataset.code);
            if (p) openJourneyDrawer(p);
          });
        });
      }

      function renderAll() {
        renderBoard();
        renderQuadrant();
        renderPareto();
        // 篩選條件改變時，已展開卡片的內容量可能跟著變，順便重新校正高度，避免內容被裁切或留白過多
        [
          { card: document.getElementById('jpQuadInsightCard'), expanded: jpQuadExpanded },
          { card: document.getElementById('jpParetoInsightCard'), expanded: jpParetoExpanded },
        ].forEach(({ card, expanded }) => {
          if (card && expanded) {
            card.style.maxHeight = 'none';
            requestAnimationFrame(() => { card.style.maxHeight = card.scrollHeight + 'px'; });
          }
        });
      }

      document.querySelectorAll('#jpTypeFilters .jp-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const t = chip.dataset.type;
          chip.classList.toggle('active');
          if (activeTypes.has(t)) activeTypes.delete(t); else activeTypes.add(t);
          renderAll();
        });
      });
      document.querySelectorAll('#jpPlatformFilters .jp-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const t = chip.dataset.platform;
          chip.classList.toggle('active');
          if (activePlatforms.has(t)) activePlatforms.delete(t); else activePlatforms.add(t);
          renderAll();
        });
      });

      document.getElementById('jpInfoToggle').addEventListener('click', function () {
        document.getElementById('jpInfoBox').classList.toggle('open');
        this.classList.toggle('open');
      });

      renderAll();

      // ===== 「流程複雜度×痛點密集度」「痛點排行榜」：點擊該卡片自己向下展開顯示更多內容，
      //      寬度維持原本一行四欄不變，也不會影響另一張卡片的大小/位置。 =====
      (function setupJpChartsExpand() {
        const jpQuadCard = document.getElementById('jpQuadInsightCard');
        const jpParetoCard = document.getElementById('jpParetoInsightCard');

        // 收合狀態的高度改成「實際量測」，不用猜固定數字——說明文字之後如果變長、
        // 或圖表內容變多，這裡都會自動量出正確高度，不會把底部內容裁掉。
        function measureAndLockCollapsed(card) {
          if (!card) return 0;
          card.style.maxHeight = 'none';
          const h = card.scrollHeight;
          card.style.maxHeight = h + 'px';
          return h;
        }
        const collapsedHeights = {
          quad: measureAndLockCollapsed(jpQuadCard),
          pareto: measureAndLockCollapsed(jpParetoCard),
        };

        if (jpQuadCard) {
          jpQuadCard.addEventListener('click', (e) => {
            if (e.target.closest('.jp-quad-point, .jp-priority-item')) return;
            jpQuadExpanded = !jpQuadExpanded;
            jpQuadCard.style.maxHeight = 'none'; // 先解除限制，讓內容重新渲染成完整高度
            renderQuadrant();
            requestAnimationFrame(() => {
              const targetHeight = jpQuadExpanded ? jpQuadCard.scrollHeight : collapsedHeights.quad;
              jpQuadCard.style.maxHeight = targetHeight + 'px';
            });
          });
        }

        if (jpParetoCard) {
          jpParetoCard.addEventListener('click', (e) => {
            if (e.target.closest('.jp-pareto-row')) return;
            jpParetoExpanded = !jpParetoExpanded;
            jpParetoCard.style.maxHeight = 'none';
            renderPareto();
            requestAnimationFrame(() => {
              const targetHeight = jpParetoExpanded ? jpParetoCard.scrollHeight : collapsedHeights.pareto;
              jpParetoCard.style.maxHeight = targetHeight + 'px';
            });
          });
        }
      })();

      buildIndependentRow(document.getElementById('jpFrontRowWrap'), '前台互動', JOURNEY_FRONT_LABELS_CLIENT, 'jp-front-cell');
      buildIndependentRow(document.getElementById('jpBackRowWrap'), '後台/系統', JOURNEY_BACK_LABELS_CLIENT, 'jp-back-cell');

      window.jpRedrawDividers = function () {
        const board = document.getElementById('jpBoard');
        const stageRow = board.children[1];
        if (stageRow) drawDividers(board, stageRow);
      };
      window.addEventListener('resize', () => { if (window.jpRedrawDividers) window.jpRedrawDividers(); });
    })();
    } catch (jpErr) {
      console.error('整合式旅程痛點 tab 初始化失敗：', jpErr);
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
        requestAnimationFrame(resizeAllEffectOverlays);
        // 面板從 display:none 切回可見時，Chart.js 的內部尺寸可能還停留在切走之前的舊值
        // （例如切到別的分頁後才發生 window resize，隱藏中的canvas不會收到通知）。
        // 這裡切分頁時統一強制 resize() 一次所有圖表，「AI 洞察」分頁併入自動摘要的
        // autoVersionChart／autoPainChart 也一併受惠，避免寬高塌陷或圖表跑位。
        if (window.Chart && Chart.instances) {
          requestAnimationFrame(() => {
            Object.values(Chart.instances).forEach(c => { try { c.resize(); } catch (e) {} });
          });
        }
      });
    });

    // ===== 大分組切換（LIVE MONITOR / DEEP INSIGHTS / JOURNEY BLUEPRINT） =====
    document.querySelectorAll('.group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activateGroup(btn.dataset.group);
        try { localStorage.setItem(GROUP_STORAGE_KEY, btn.dataset.group); } catch (e) {}
        if (btn.dataset.group === 'journey' && window.jpRedrawDividers) {
          requestAnimationFrame(() => window.jpRedrawDividers());
        }
        if (window.Chart && Chart.instances) {
          requestAnimationFrame(() => {
            Object.values(Chart.instances).forEach(c => { try { c.resize(); } catch (e) {} });
          });
        }
        // 切回 LIVE MONITOR 時，額外主動呼叫一次健康雷達的 resize()，強制 Chart.js
        // 重新計算 scales.r 的中心座標（xCenter/yCenter），不要只靠上面那個泛用迴圈被動觸發——
        // 這是「掃描光切回來會消失」的根因：xCenter 短暫變成 0 時 drawSweep() 沒有 fallback。
        if (btn.dataset.group === 'live' && window.radarChartInstance) {
          requestAnimationFrame(() => {
            try { window.radarChartInstance.resize(); } catch (e) {}
          });
        }
        // 面板從 display:none 切回可見後，強制把掃描光/光點等疊加 canvas 重新量一次尺寸，
        // 不要只靠 Chart.js 的 onResize 被動觸發（見 createEffectOverlay 上方註解）。
        requestAnimationFrame(() => requestAnimationFrame(resizeAllEffectOverlays));
      });
    });

    // ===== 瀏覽器視窗尺寸改變時（例如把視窗縮小），讓所有圖表重新計算正確尺寸 =====
    // 這裡只在「真的改變視窗大小」時觸發，跟切換分頁的動畫重播是兩件獨立的事，
    // 不會重新引入「切換分頁時圖表從左上角彈出來」那個問題。
    let resizeDebounceTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        if (window.Chart && Chart.instances) {
          Object.values(Chart.instances).forEach((c) => {
            try { c.resize(); } catch (e) {}
          });
        }
        resizeAllEffectOverlays();
      }, 150);
    });

    // ===== 情緒分析 tab：情緒 × 類別 統計圖 =====
    const sentimentLabelMap = { positive: '正面', neutral: '中性', negative: '負面' };
    const sentimentOrder = ['positive', 'neutral', 'negative'];

    // ===== 回饋洞察四張卡片：各自的「今年」重點統計（固定看今年，跟卡片本身的全部/今年/本月/本週篩選器分開） =====
    (function renderInsightHeadlineStats() {
      const yearCategoryStats = dataset.categoryStatsByRange.year;
      const yearStageStats = dataset.stageStatsByRange.year;
      const yearMatrix = dataset.categoryMatrixByRange.year;
      const yearIntentStats = dataset.intentStatsByRange.year;

      // 1) 情緒與類別分析：今年負評最多的分類
      const categoryEl = document.getElementById('categoryHeadlineStat');
      if (categoryEl) {
        let best = null;
        dataset.categoryOrder.forEach((cat) => {
          if (cat === '其他') return;
          const neg = (yearCategoryStats[cat] && yearCategoryStats[cat].negative) || 0;
          if (neg > 0 && (!best || neg > best.neg)) best = { cat, neg };
        });
        categoryEl.innerHTML = best
          ? '今年負評最多分類：' + best.cat + '<span class="headline-sub">（' + best.neg + ' 則）</span>'
          : '今年尚無足夠資料統計。';
      }

      // 2) 用戶旅程階段檢視：今年負評最多的階段
      const stageEl = document.getElementById('stageHeadlineStat');
      if (stageEl) {
        let best = null;
        dataset.stageOrder.forEach((stage) => {
          const neg = (yearStageStats[stage] && yearStageStats[stage].negative) || 0;
          if (neg > 0 && (!best || neg > best.neg)) best = { stage, neg };
        });
        stageEl.innerHTML = best
          ? '今年負評最多階段：' + best.stage + '<span class="headline-sub">（' + best.neg + ' 則）</span>'
          : '今年尚無足夠資料統計。';
      }

      // 3) 頻率 × 嚴重度矩陣：今年最需優先處理的分類（提及次數 × 嚴重程度的綜合排序）
      const matrixEl = document.getElementById('matrixHeadlineStat');
      if (matrixEl) {
        let best = null;
        (yearMatrix || []).forEach((m) => {
          if (m.category === '其他' || !m.count) return;
          const severityScore = m.count * (5 - m.avgScore); // 次數越多、平均星等越低，分數越高
          if (!best || severityScore > best.severityScore) best = { ...m, severityScore };
        });
        matrixEl.innerHTML = best
          ? '今年最需優先處理：' + best.category + '<span class="headline-sub">（提及 ' + best.count + ' 次、平均 ' + best.avgScore.toFixed(2) + ' ★）</span>'
          : '今年尚無足夠資料統計。';
      }

      // 4) 意圖分佈：今年最主要的意圖類型與佔比
      const intentEl = document.getElementById('intentHeadlineStat');
      if (intentEl) {
        const total = dataset.intentOrder.reduce((sum, key) => sum + (yearIntentStats[key] || 0), 0);
        let best = null;
        dataset.intentOrder.forEach((key) => {
          const count = yearIntentStats[key] || 0;
          if (!best || count > best.count) best = { key, count };
        });
        intentEl.innerHTML = best && total > 0
          ? '今年最主要意圖：' + best.key + '<span class="headline-sub">（佔比 ' + Math.round((best.count / total) * 100) + '%）</span>'
          : '今年尚無足夠資料統計。';
      }
    })();

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
          backgroundColor: ['#ff6b6b', '#00DDCD', '#c6f24e', '#5b6272'],
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
    //      版面切換純粹靠 CSS 的 width 過渡完成（見上方 .insight-grid 樣式）。=====
    (function setupInsightGridExpand() {
      const insightGrid = document.getElementById('insightDetailGrid');
      if (!insightGrid) return;

      function resizeAllCharts() {
        if (window.Chart && Chart.instances) {
          Object.values(Chart.instances).forEach(c => {
            try { c.resize(); } catch (e) {}
          });
        }
      }

      const insightCardsList = document.querySelectorAll('.insight-card');

      // 不用「猜時間」的 setTimeout，改成監聽每張卡片自己的 CSS width 過渡動畫「真正結束」的那一刻
      // 才校正圖表尺寸，不管裝置/網路速度快慢，都能保證是在動畫確實跑完之後才校正，避免校正到動畫
      // 途中的中間尺寸、之後就再也沒機會修正回來的問題。
      insightCardsList.forEach(card => {
        card.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'width') {
            resizeAllCharts();
          }
        });
      });

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
          // 保險：萬一某些瀏覽器沒有正確觸發 transitionend（例如寬度剛好沒變化），
          // 額外用一個較長的備援延遲也校正一次。
          setTimeout(resizeAllCharts, 500);
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
              backgroundColor: 'rgba(0,221,205,' + (pointAlpha + 0.05) + ')',
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

    // ===== 自動摘要 tab：規則式洞察（3張並排卡片，收合時只顯示 headline+精簡圖表，
    //      點擊卡頭/箭頭向下展開內嵌詳情表格；資料沿用既有的 versionAnalysis／
    //      topPainPoints16／trendChanges／recentNegativeWordFrequency 等欄位） =====
    (function renderAutoSummary() {
      const versionAnalysis = dataset.versionAnalysis || [];
      const regressions = dataset.versionRegressions || [];
      const painPoints5 = dataset.topPainPoints || [];
      const painPoints16 = dataset.topPainPoints16 || [];
      const trends = dataset.trendChanges || [];
      const anomalyItems = computeAnomalyItems();

      // ===== 卡片展開/收合的共用邏輯（跟「回饋洞察」四張卡片同一套互動方式）：
      //      點擊整張卡片（排除圖表/標籤/詳情表格本身的點擊區域）展開/收合，
      //      同一時間最多只有一張卡片展開——點別張卡片時，原本展開的會自動收合。
      //      詳情表格包在獨立的 .card-detail-drawer 裡，用 max-height 0 → scrollHeight
      //      的過渡做展開動畫，過渡結束後把展開狀態的 max-height 換成 'none'，避免內容
      //      之後變動被舊高度裁掉；收合時則要先把 'none' 換回明確的 px 值，才能正常觸發
      //      往 0 的過渡。 =====
      const autoCardEntries = [];

      function collapseAutoCard(entry) {
        const { card, detail } = entry;
        if (!card.classList.contains('expanded')) return;
        detail.style.maxHeight = detail.scrollHeight + 'px'; // 先換成明確px值（可能原本是'none'）
        requestAnimationFrame(() => {
          card.classList.remove('expanded');
          detail.style.maxHeight = '0px';
        });
      }

      function expandAutoCard(entry) {
        const { card, detail } = entry;
        card.classList.add('expanded');
        requestAnimationFrame(() => {
          detail.style.maxHeight = detail.scrollHeight + 'px';
        });
      }

      function setupAutoCardExpand(cardId, detailId, getChart) {
        const card = document.getElementById(cardId);
        const detail = document.getElementById(detailId);
        if (!card || !detail) return;

        const entry = { card, detail, getChart };
        autoCardEntries.push(entry);

        card.addEventListener('click', (e) => {
          // 點在圖表、標籤按鈕、或展開後的詳情表格本身時，不要觸發整張卡片的展開/收合，
          // 讓「跟圖表/標籤/表格列互動看細部評論」跟「展開/收合卡片」徹底分開，不會互相誤觸
          if (e.target.closest('canvas')) return;
          if (e.target.closest('.insight-v2-tag')) return;
          if (e.target.closest('.auto-detail-table')) return;

          const wasExpanded = card.classList.contains('expanded');
          autoCardEntries.forEach((other) => { if (other !== entry) collapseAutoCard(other); });
          if (wasExpanded) {
            collapseAutoCard(entry);
          } else {
            expandAutoCard(entry);
          }
        });

        detail.addEventListener('transitionend', (e) => {
          if (e.propertyName !== 'max-height') return;
          if (card.classList.contains('expanded')) {
            detail.style.maxHeight = 'none';
          }
          // Chart.js 畫布防護：展開/收合造成版面變動時強制 resize，避免圖表寬度塌陷或變形
          const chart = typeof getChart === 'function' ? getChart() : null;
          if (chart && typeof chart.resize === 'function') chart.resize();
        });
      }

      // ===== 卡片一：版本評分與健康度（針對最新版本的報告） =====
      const latestVersionEntry = versionAnalysis.length ? versionAnalysis[versionAnalysis.length - 1] : null;
      const card1Headline = document.getElementById('autoCard1Headline');
      if (card1Headline) {
        if (!latestVersionEntry) {
          card1Headline.textContent = '目前沒有足夠版本資料';
        } else if (latestVersionEntry.isRegression) {
          card1Headline.textContent = 'v' + latestVersionEntry.version + ' 評分驟降 ' + latestVersionEntry.scoreDrop.toFixed(2) + ' 分（' +
            latestVersionEntry.avgScore.toFixed(2) + '★，共 ' + latestVersionEntry.count + ' 則）';
        } else {
          const delta = latestVersionEntry.prevAvgScore != null ? (latestVersionEntry.avgScore - latestVersionEntry.prevAvgScore) : null;
          const deltaText = delta != null ? '，較前版 ' + (delta > 0 ? '+' : '') + delta.toFixed(2) + ' 分' : '';
          card1Headline.textContent = 'v' + latestVersionEntry.version + ' 平均星等 ' + latestVersionEntry.avgScore.toFixed(2) +
            '★（共 ' + latestVersionEntry.count + ' 則' + deltaText + '）';
        }
      }

      // 向下漸層面積填充：ChartArea 尚未初始化時（例如初次量測階段）回傳固定色 fallback，避免拋出 undefined 錯誤
      function versionAreaGradient(ctx, chartArea) {
        if (!chartArea) return 'rgba(198, 242, 78, 0.12)';
        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, 'rgba(198, 242, 78, 0.45)');
        gradient.addColorStop(0.5, 'rgba(198, 242, 78, 0.12)');
        gradient.addColorStop(1, 'rgba(198, 242, 78, 0.0)');
        return gradient;
      }

      let autoVersionChart = null;
      let latestVersionGlowOverlay = null; // 建立 Chart 之後才賦值，先宣告好讓下面 onResize callback 抓得到
      const versionCanvas = document.getElementById('autoVersionChart');
      if (versionCanvas && window.Chart) {
        fadeInCanvas(versionCanvas, 500);

        const lastIndex = versionAnalysis.length - 1;
        // 需求1：正常點用萊姆綠、半徑是異常點的一半；異常點維持較大尺寸＋警示紅。
        // 需求2：最新版本不管是否驟降，一律獨立蓋成紅色（呼吸光暈另外畫在疊加canvas上，見下面drawLatestVersionGlow）。
        const NORMAL_RADIUS = 3;
        const ANOMALY_RADIUS = 6; // 正常點固定是這個的一半
        const LATEST_RADIUS = 6;

        autoVersionChart = new Chart(versionCanvas, {
          type: 'line',
          data: {
            labels: versionAnalysis.map(v => 'v' + v.version),
            datasets: [{
              data: versionAnalysis.map(v => v.avgScore),
              borderColor: '#C6F24E',
              borderWidth: 2,
              fill: 'start',
              backgroundColor: (context) => versionAreaGradient(context.chart.ctx, context.chart.chartArea),
              tension: 0.3,
              pointRadius: (context) => {
                const v = versionAnalysis[context.dataIndex];
                if (!v) return 0;
                if (context.dataIndex === lastIndex) return LATEST_RADIUS;
                return v.isRegression ? ANOMALY_RADIUS : NORMAL_RADIUS;
              },
              pointHoverRadius: (context) => {
                const v = versionAnalysis[context.dataIndex];
                if (!v) return NORMAL_RADIUS + 2;
                if (context.dataIndex === lastIndex) return LATEST_RADIUS + 2;
                return (v.isRegression ? ANOMALY_RADIUS : NORMAL_RADIUS) + 2;
              },
              pointBackgroundColor: (context) => {
                const v = versionAnalysis[context.dataIndex];
                if (!v) return '#C6F24E';
                if (context.dataIndex === lastIndex) return '#FF3860'; // 最新版本固定紅色，不受是否驟降影響
                return v.isRegression ? '#FF3860' : '#C6F24E'; // 異常＝警示紅／正常＝萊姆綠
              },
              pointBorderColor: 'transparent',
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500 },
            layout: {
              padding: { right: 10, top: 4 }, // 給最右邊那個點（最新版本）留一點空間，不要讓紅點/hover圈被canvas邊緣切到
            },
            onResize: () => { if (latestVersionGlowOverlay) latestVersionGlowOverlay.resize(); },
            scales: {
              x: {
                offset: true, // 類別軸預設把第一/最後一個點畫在畫布最左右邊緣；開offset會在頭尾各留半格，
                               // 這樣最新版本那個點才不會卡在圖表最右邊被裁掉——不需要額外加一個看不見的假版本
                ticks: {
                  color: '#9aa0ac',
                  font: { size: 10 },
                  maxRotation: 0,
                  autoSkip: false, // 自己控制要顯示哪些刻度，不讓 Chart.js 的 autoSkip 隨機決定（可能把最新版本剛好跳過）
                  callback: function (value, index) {
                    const total = versionAnalysis.length;
                    // 版本數一多，橫軸放不下全部標籤：固定間隔抽稀顯示，但「最新版本」一定要保留，
                    // 其餘被隱藏掉版號的資料點還是能點擊/hover看到完整版本號（tooltip 有完整資訊）。
                    const step = Math.max(1, Math.ceil(total / 8));
                    const isLatest = index === total - 1;
                    if (isLatest || index % step === 0) {
                      return this.getLabelForValue(value);
                    }
                    return '';
                  },
                },
                grid: { display: false },
              },
              y: {
                min: 1,
                max: 6, // 資料本身只會到5★，多留一格刻度當作視覺緩衝，避免波峰貼齊圖表頂端看起來像被裁切
                ticks: { color: '#9aa0ac', font: { size: 10 }, stepSize: 1 },
                grid: { color: '#2a2e38' },
              },
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: (items) => (items.length ? 'v' + versionAnalysis[items[0].dataIndex].version : ''),
                  label: (ctx) => {
                    const v = versionAnalysis[ctx.dataIndex];
                    if (!v) return ctx.parsed.y;
                    let tag = '';
                    if (ctx.dataIndex === lastIndex) tag = '（最新版本）';
                    else if (v.isRegression) tag = '（評分驟降）';
                    return v.avgScore.toFixed(2) + ' ★' + tag;
                  },
                },
              },
            },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const v = versionAnalysis[elements[0].index];
              if (!v) return;
              const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === v.version && r.sentiment === 'negative');
              openReviewDrawer('v' + v.version + ' 的負評', '共 ' + matched.length + ' 則', matched);
            },
          },
        });

        // ===== 需求2：最新版本的呼吸光暈，畫在獨立疊加canvas上（跟健康雷達的掃描光同一套作法），
        //      不進Chart.js自己的canvas，才不會跟tooltip/hover的重繪排程搶畫布。 =====
        latestVersionGlowOverlay = createEffectOverlay(versionCanvas);
        const GLOW_RGB = '255, 56, 96'; // 跟異常/最新版本點位同一組警示紅
        const GLOW_PERIOD = 2600; // 呼吸一次的時間（ms），數字愈大節奏愈慢愈沉靜，不刺眼
        let glowRafId = null;

        function drawLatestVersionGlow(timestamp) {
          const { ctx } = latestVersionGlowOverlay;
          const rect = versionCanvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            ctx.clearRect(0, 0, rect.width, rect.height);
            const meta = autoVersionChart.getDatasetMeta(0);
            const point = meta && meta.data && meta.data[meta.data.length - 1];
            if (point && typeof point.x === 'number') {
              const t = (timestamp % GLOW_PERIOD) / GLOW_PERIOD; // 0~1
              const wave = (1 - Math.cos(t * Math.PI * 2)) / 2; // 0~1，柔和的來回曲線，不是線性鋸齒
              const ringRadius = LATEST_RADIUS + wave * 11;
              const ringAlpha = 0.45 * (1 - wave);
              ctx.save();
              ctx.beginPath();
              ctx.arc(point.x, point.y, ringRadius, 0, Math.PI * 2);
              ctx.strokeStyle = 'rgba(' + GLOW_RGB + ', ' + ringAlpha.toFixed(3) + ')';
              ctx.lineWidth = 2;
              ctx.stroke();
              ctx.restore();
            }
          }
          glowRafId = requestAnimationFrame(drawLatestVersionGlow);
        }
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) {
            if (glowRafId) cancelAnimationFrame(glowRafId);
            glowRafId = null;
          } else if (!glowRafId) {
            glowRafId = requestAnimationFrame(drawLatestVersionGlow);
          }
        });
        glowRafId = requestAnimationFrame(drawLatestVersionGlow);
      }

      const card1Tbody = document.getElementById('autoCard1Tbody');
      if (card1Tbody) {
        const rowsNewestFirst = [...versionAnalysis].reverse(); // 版本歷程詳情表嚴格由新至舊排序
        card1Tbody.innerHTML = rowsNewestFirst.length
          ? rowsNewestFirst.map((v) => {
              const delta = v.prevAvgScore != null ? (v.avgScore - v.prevAvgScore) : null;
              const deltaCls = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
              const deltaText = delta == null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(2);
              const reasonText = v.topCats && v.topCats.length ? v.topCats.join('、') : '—';
              // 需求3：這欄改顯示「負評則數」而不是總則數，跟點擊這一列打開的抽屜（只篩負評）
              // 用完全同一份 negativeCount 數字，不會再有「列表寫24則、點開卻只有3則」的落差。
              return '<tr class="clickable-row" data-version="' + v.version + '">' +
                '<td>v' + v.version + '</td>' +
                '<td>' + v.negativeCount + ' 則</td>' +
                '<td>' + v.avgScore.toFixed(2) + ' ★</td>' +
                '<td class="auto-delta ' + deltaCls + '">' + deltaText + '</td>' +
                '<td>' + reasonText + '</td>' +
                '</tr>';
            }).join('')
          : '<tr><td colspan="5" class="note">目前沒有足夠版本資料</td></tr>';

        card1Tbody.querySelectorAll('tr.clickable-row').forEach((tr) => {
          tr.addEventListener('click', () => {
            const version = tr.dataset.version;
            const matched = dataset.allReviewsFlat.filter(r => r.platform === 'android' && r.version === version && r.sentiment === 'negative');
            openReviewDrawer('v' + version + ' 的負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      setupAutoCardExpand('autoCard1', 'autoCard1Detail', () => autoVersionChart);

      // ===== 卡片二：歷史高頻痛點 Top 5 =====
      const card2Headline = document.getElementById('autoCard2Headline');
      if (card2Headline) {
        card2Headline.textContent = painPoints5.length
          ? ('「' + painPoints5[0].category + '」累積 ' + painPoints5[0].negativeCount + ' 則負評（平均 ' +
             (painPoints5[0].avgScore != null ? painPoints5[0].avgScore.toFixed(2) : '-') + '★），為歷史最大痛點')
          : '目前沒有偵測到明顯的高頻痛點';
      }

      let autoPainChart = null;
      const painCanvas = document.getElementById('autoPainChart');
      if (painCanvas && window.Chart) {
        fadeInCanvas(painCanvas, 500);
        autoPainChart = new Chart(painCanvas, {
          type: 'bar',
          data: {
            labels: painPoints5.map(p => p.category),
            datasets: [{
              data: painPoints5.map(p => p.negativeCount),
              backgroundColor: '#ff6b6b',
              borderRadius: 3,
              maxBarThickness: 22,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500 },
            scales: {
              x: { ticks: { color: '#9aa0ac', font: { size: 10 } }, grid: { color: '#2a2e38' } },
              y: { ticks: { color: '#e8e9ed', font: { size: 11 } }, grid: { display: false } },
            },
            plugins: { legend: { display: false } },
            onClick: (evt, elements) => {
              if (!elements.length) return;
              const p = painPoints5[elements[0].index];
              if (!p) return;
              const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(p.category) && r.sentiment === 'negative');
              openReviewDrawer(p.category + ' 的歷史負評', '共 ' + matched.length + ' 則', matched);
            },
          },
        });
      }

      const card2Tbody = document.getElementById('autoCard2Tbody');
      if (card2Tbody) {
        card2Tbody.innerHTML = painPoints16.length
          ? painPoints16.map((p, i) =>
              '<tr class="clickable-row" data-category="' + p.category + '">' +
              '<td>#' + (i + 1) + '</td>' +
              '<td>' + p.category + '</td>' +
              '<td>' + p.negativeCount + ' 則</td>' +
              '<td>' + p.totalCount + ' 則</td>' +
              '<td>' + (p.avgScore != null ? p.avgScore.toFixed(2) + ' ★' : '—') + '</td>' +
              '</tr>'
            ).join('')
          : '<tr><td colspan="5" class="note">目前沒有足夠痛點資料</td></tr>';

        card2Tbody.querySelectorAll('tr.clickable-row').forEach((tr) => {
          tr.addEventListener('click', () => {
            const category = tr.dataset.category;
            const matched = dataset.allReviewsFlat.filter(r => r.categories.includes(category) && r.sentiment === 'negative');
            openReviewDrawer(category + ' 的歷史負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      setupAutoCardExpand('autoCard2', 'autoCard2Detail', () => autoPainChart);

      // ===== 卡片三：近期異動與行動指引 =====
      // 標籤＝近期熱門負評關鍵字；行動建議＝從卡片一/二同一批訊號各挑最顯著的一項組成固定模板
      // （移除原本單一隨機評論引號區塊，避免代表性不足）。
      const card3Headline = document.getElementById('autoCard3Headline');
      if (card3Headline) {
        card3Headline.textContent = trends.length
          ? ('本月警訊：「' + trends[0].category + '」負評較上月增加 ' + trends[0].delta + ' 則')
          : '本月無異常突增痛點，整體趨勢平穩';
      }

      const card3Tags = document.getElementById('autoCard3Tags');
      if (card3Tags) {
        const keywords = (dataset.recentNegativeWordFrequency || []).slice(0, 6);
        card3Tags.innerHTML = keywords.length
          ? keywords.map(k => '<button type="button" class="insight-v2-tag" data-word="' + k.word + '">#' + k.word + ' ' + k.count + '</button>').join('')
          : '<span class="insight-empty">近期沒有足夠的關鍵字資料</span>';
        card3Tags.querySelectorAll('.insight-v2-tag').forEach((tag) => {
          tag.addEventListener('click', (e) => {
            e.stopPropagation();
            const word = tag.dataset.word;
            const months = dataset.recentMonthsForKeywords || [];
            const matched = dataset.allReviewsFlat.filter(r =>
              r.sentiment === 'negative' && months.includes(r.month) && (r.text || '').includes(word)
            );
            openReviewDrawer('「' + word + '」相關負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      const card3Actions = document.getElementById('autoCard3Actions');
      if (card3Actions) {
        const actionItems = [];
        if (anomalyItems[0]) actionItems.push('優先檢視「' + anomalyItems[0].label + '」，本期已累積 ' + anomalyItems[0].count + ' 則負評');
        if (regressions[0]) actionItems.push('檢視 v' + regressions[0].version + ' 版本改動，平均星等較前版下降 ' + regressions[0].scoreDrop.toFixed(2) + ' 分');
        if (painPoints5[0]) actionItems.push('「' + painPoints5[0].category + '」累積 ' + painPoints5[0].negativeCount + ' 則負評，建議列入優化 Roadmap');
        if (trends[0]) actionItems.push('留意「' + trends[0].category + '」本月負評增加 ' + trends[0].delta + ' 則，建議追蹤是否為新浮現問題');
        if (actionItems.length === 0) actionItems.push('目前沒有偵測到需要優先處理的明顯訊號，維持現有觀察頻率即可。');

        card3Actions.innerHTML = actionItems.slice(0, 3).map(a => '<div class="insight-v2-action">' + a + '</div>').join('');
      }

      const card3Tbody = document.getElementById('autoCard3Tbody');
      if (card3Tbody) {
        card3Tbody.innerHTML = trends.length
          ? trends.map((t) =>
              '<tr class="clickable-row" data-category="' + t.category + '">' +
              '<td>' + t.category + '</td>' +
              '<td>' + t.thisMonthNeg + ' 則</td>' +
              '<td>' + t.lastMonthNeg + ' 則</td>' +
              '<td class="auto-delta ' + (t.delta > 0 ? 'down' : 'flat') + '">+' + t.delta + '</td>' +
              '</tr>'
            ).join('')
          : '<tr><td colspan="4" class="note">本月無明顯增幅分類</td></tr>';

        card3Tbody.querySelectorAll('tr.clickable-row').forEach((tr) => {
          tr.addEventListener('click', () => {
            const category = tr.dataset.category;
            const monthReviews = (dataset.reviewsByRange && dataset.reviewsByRange.month) || [];
            const matched = monthReviews.filter(r => r.categories.includes(category) && r.sentiment === 'negative');
            openReviewDrawer(category + ' 本月負評', '共 ' + matched.length + ' 則', matched);
          });
        });
      }

      setupAutoCardExpand('autoCard3', 'autoCard3Detail', () => null);
    })();

    // ===== AI 智慧洞察與版本預警：獨立讀取 ./insights.json，跟其他圖表沒有資料相依，
    //      失敗時不影響任何既有圖表初始化。=====
    (function renderAIInsight() {
      const bodyEl = document.getElementById('aiInsightBody');
      const emptyEl = document.getElementById('aiInsightEmpty');
      const statusEl = document.getElementById('aiInsightStatus');

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
          { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
        ));
      }

      function showEmpty() {
        if (bodyEl) bodyEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'block';
        if (statusEl) { statusEl.textContent = 'NO_DATA'; statusEl.className = 'status-pill status-warn mono'; }
      }

      function renderAlert(alert) {
        const banner = document.getElementById('aiAlertBanner');
        if (!banner) return;
        const hasVersion = alert && (alert.version || alert.affected_version || alert.trigger_version);
        const hasDesc = alert && alert.description;
        if (!hasVersion && !hasDesc) { banner.style.display = 'none'; return; }
        let version = alert.version || alert.affected_version || alert.trigger_version || '未知版本';
        version = String(version).replace(/^v/i, ''); // 避免欄位本身已含 v 前綴，跟下面手動補的 v 重複變成 vv4.6.0
        const time = alert.detected_at || alert.time || alert.timestamp || alert.trigger_date || '';
        const desc = alert.description || alert.phenomenon || alert.summary || '偵測到異常訊號，請留意。';
        document.getElementById('aiAlertTitle').textContent = '突發異常警示：v' + version + '　' + desc;
        document.getElementById('aiAlertMeta').textContent = time ? ('偵測時間：' + time) : '';
        banner.style.display = 'flex';
      }

      // ===== LIVE MONITOR 突發異常警示橫幅：跟上面的 aiAlertBanner 讀同一筆 anomaly_alert，
      //      只是多渲染一份在 LIVE MONITOR 頁面讓使用者更早注意到。沒有資料時優雅隱藏
      //      （display:none 不留空白），並且無論顯示或隱藏，都要在DOM更新完之後
      //      主動重新呼叫一次 syncLiveColumnHeights()，避免這個fetch是非同步的、
      //      比一開始的 rAF 高度校正還晚完成，導致高度算完之後版面又被撐開一次而沒對齊。 =====
      function renderLiveAnomalyAlert(alert) {
        const card = document.getElementById('liveAnomalyAlert');
        if (!card) return;
        const hasVersion = alert && (alert.version || alert.affected_version || alert.trigger_version);
        const hasDesc = alert && alert.description;
        if (!hasVersion && !hasDesc) {
          card.style.display = 'none';
          if (typeof syncLiveColumnHeights === 'function') syncLiveColumnHeights();
          return;
        }
        let version = alert.version || alert.affected_version || alert.trigger_version || '未知版本';
        version = String(version).replace(/^v/i, '');
        const time = alert.detected_at || alert.time || alert.timestamp || alert.trigger_date || '';
        const desc = alert.description || alert.phenomenon || alert.summary || '偵測到異常訊號，請留意。';
        document.getElementById('liveAnomalyAlertTitle').textContent = '突發異常警示：v' + version + '　' + desc;
        document.getElementById('liveAnomalyAlertMeta').textContent = time ? ('偵測時間：' + time) : '';
        card.style.display = 'flex';
        if (typeof syncLiveColumnHeights === 'function') syncLiveColumnHeights();
      }

      // 點擊／鍵盤Enter或空白鍵：切到 DEEP INSIGHTS 群組的「AI 洞察」子分頁，
      // 並平滑捲動到AI洞察卡片位置。
      function goToAIInsightFromLiveBanner() {
        activateGroup('insights');
        try { localStorage.setItem(GROUP_STORAGE_KEY, 'insights'); } catch (e) {}

        const aiTabBtn = document.querySelector('.tab-btn[data-tab="ai"]');
        const aiTabPanel = document.getElementById('tab-ai');
        if (aiTabBtn && aiTabPanel) {
          document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
          aiTabBtn.classList.add('active');
          aiTabPanel.classList.add('active');
          try { localStorage.setItem(TAB_STORAGE_KEY, 'ai'); } catch (e) {}
          if (typeof replayTabAnimations === 'function') replayTabAnimations('ai');
        }

        // 分頁／群組從 display:none 切回可見，統一補一次 resize()，
        // 避免 autoVersionChart / autoPainChart 沿用切走前的舊尺寸而跑位或塌陷。
        requestAnimationFrame(() => {
          if (window.Chart && Chart.instances) {
            Object.values(Chart.instances).forEach((c) => { try { c.resize(); } catch (e) {} });
          }
          requestAnimationFrame(() => {
            if (typeof resizeAllEffectOverlays === 'function') resizeAllEffectOverlays();
            const target = document.getElementById('aiInsightCard');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      }

      const liveAnomalyAlertEl = document.getElementById('liveAnomalyAlert');
      if (liveAnomalyAlertEl) {
        liveAnomalyAlertEl.addEventListener('click', goToAIInsightFromLiveBanner);
        liveAnomalyAlertEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            goToAIInsightFromLiveBanner();
          }
        });
      }

      function renderIssues(issues) {
        const listEl = document.getElementById('aiIssueList');
        if (!listEl) return;
        const list = Array.isArray(issues) ? issues.slice(0, 3) : [];
        if (!list.length) {
          listEl.innerHTML = '<div class="insight-empty">目前沒有 AI 標記的重點痛點</div>';
          return;
        }
        listEl.innerHTML = list.map((item, idx) => {
          const rank = item.rank || (idx + 1);
          const tag = item.tag || item.label || '';
          const title = item.title || item.issue || item.subject || '未命名問題';
          const count = item.count != null ? item.count : (item.frequency != null ? item.frequency : 0);
          const quote = item.quote || item.review || item.sample_review || item.sample_quote || '';
          return (
            '<div class="ai-issue-item">' +
              '<div class="ai-issue-head">' +
                '<span class="ai-issue-rank">TOP ' + esc(rank) + '</span>' +
                (tag ? '<span class="badge ios">' + esc(tag) + '</span>' : '') +
                '<span class="ai-issue-title">' + esc(title) + '</span>' +
                '<span class="ai-issue-count">' + esc(count) + ' 則</span>' +
              '</div>' +
              (quote ? '<div class="ai-issue-quote">「' + esc(quote) + '」</div>' : '') +
            '</div>'
          );
        }).join('');
      }

      function renderActions(actions) {
        const listEl = document.getElementById('aiActionList');
        if (!listEl) return;
        const list = Array.isArray(actions) ? actions : [];
        listEl.innerHTML = list.length
          ? list.map(a => '<div class="insight-v2-action">' + esc(typeof a === 'string' ? a : (a.text || a.action || '')) + '</div>').join('')
          : '<div class="insight-empty">目前沒有建議行動項目</div>';
      }

      fetch('./insights.json')
        .then((res) => {
          if (!res.ok) throw new Error('insights.json HTTP ' + res.status);
          return res.json();
        })
        .then((data) => {
          if (!data || typeof data !== 'object') throw new Error('insights.json 格式異常');
          renderAlert(data.anomaly_alert);
          renderLiveAnomalyAlert(data.anomaly_alert);
          renderIssues(data.top_issues);
          renderActions(data.action_recommendation);
          if (statusEl) { statusEl.textContent = 'SYNCED'; statusEl.className = 'status-pill status-ok mono'; }
        })
        .catch((err) => {
          console.warn('[AI Insight] 讀取 insights.json 失敗，改用保底畫面：', err);
          showEmpty();
          renderLiveAnomalyAlert(null); // 讀取失敗時，LIVE頁的橫幅也一併優雅隱藏並重新對齊高度
        });
    })();

    // ===== 所有圖表都建立完成，現在把剛才暫時的「有版面但看不見」樣式清乾淨，
    //      恢復成正常的分頁顯示/隱藏規則（靠 .tab-panel.active 這個 class 控制）=====
    allTabPanelsForInit.forEach((p) => {
      p.style.display = '';
      p.style.visibility = '';
    });

    // ===== 說明文字 tooltip（info-hint）：桌機可hover，觸控裝置點擊切換顯示 =====
    document.querySelectorAll('.info-hint').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = el.classList.contains('open');
        document.querySelectorAll('.info-hint.open').forEach(o => { if (o !== el) o.classList.remove('open'); });
        el.classList.toggle('open', !wasOpen);
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.info-hint.open').forEach(o => o.classList.remove('open'));
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
  let dailyRuns;
  let fullHistory;

  if (USE_CSV_AS_PRIMARY_SOURCE) {
    if (!fs.existsSync(ANDROID_CSV_FILE) && !fs.existsSync(IOS_CSV_FILE)) {
      console.error(
        `找不到CSV評論檔案。請把手動匯出的評論檔分別放在：\n  ${ANDROID_CSV_FILE}\n  ${IOS_CSV_FILE}\n` +
        '（也可以把 generate-dashboard.js 開頭的 USE_CSV_AS_PRIMARY_SOURCE 改成 false，改回使用爬蟲資料。）'
      );
      process.exit(1);
    }
    const csvData = loadCsvReviews();
    fullHistory = csvData.android; // 走跟原本android-full-history.json一樣的去重/解析路徑
    dailyRuns = csvData.ios.length ? [{ date: 'csv-import', ios: csvData.ios }] : [];
  } else {
    dailyRuns = loadDailyRuns();
    fullHistory = loadFullHistory();
  }

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
  if (USE_CSV_AS_PRIMARY_SOURCE) {
    console.log('資料來源：CSV匯出檔（爬蟲資料目前暫停使用，程式碼保留，改 USE_CSV_AS_PRIMARY_SOURCE 為 false 可切回）');
    if (!fullHistory.length) {
      console.log(`提示：找不到 ${ANDROID_CSV_FILE}，本次沒有Android資料。`);
    }
  } else if (!fullHistory.length) {
    console.log('提示：尚未偵測到 data/android-full-history.json，目前 Android 趨勢僅包含每日排程累積的資料。');
  }
}

main();
