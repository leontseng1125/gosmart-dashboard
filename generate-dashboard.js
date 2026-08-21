const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(__dirname, 'dashboard.html');
const FULL_HISTORY_FILE = path.join(DATA_DIR, 'android-full-history.json');

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
  // App Store 頁面上的日期格式通常是 MM/DD/YYYY
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, month, day, year] = m;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function monthKey(date) {
  if (!date || isNaN(date)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildDataset(dailyRuns, fullHistory) {
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

  const monthKeys = Array.from(monthlyMap.keys()).sort();
  const monthlyStats = monthKeys.map((key) => {
    const { android, ios } = monthlyMap.get(key);
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
      .map((r) => ({
        platform,
        score: r.score,
        date: r.realDate.toISOString().slice(0, 10),
        timestamp: r.realDate.getTime(),
        month: monthKey(r.realDate),
        text: platform === 'android' ? r.text : r.body,
        title: r.title || null,
        userName: r.userName || null,
      }));

  const allReviewsFlat = [...flatten(allAndroid, 'android'), ...flatten(allIos, 'ios')].sort(
    (a, b) => a.timestamp - b.timestamp
  );

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
    allReviewsFlat,
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
<title>格上 GoSmart 評論追蹤 Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
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
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
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
  .score-neg { color: var(--neg); font-weight: 600; }
  .score-pos { color: var(--text); font-weight: 600; }
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
  }
  .toggle-btn.active {
    background: #2a2e38;
    color: var(--text);
  }

  /* Chart.js tooltip 客製外觀由 canvas 內部繪製處理，此區塊為 fallback（若瀏覽器不支援 external tooltip 就不需要） */
</style>
</head>
<body>
  <h1>格上 GoSmart 評論追蹤 Dashboard</h1>
  <div class="subtitle" id="subtitle"></div>

  <div class="grid" id="summaryCards"></div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="comments">評論</button>
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
        </div>
      </div>
      <canvas id="commentScatterChart" height="110"></canvas>
      <div class="note" id="scatterRangeNote"></div>
    </div>

    <div class="chart-card">
      <div class="list-header">
        <h2 style="margin:0">評論清單</h2>
        <div class="toggle-group">
          <button class="toggle-btn active" id="btnShowNegative">近期負評（2星以下）</button>
          <button class="toggle-btn" id="btnShowAll">所有評價</button>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>平台</th><th>日期</th><th>星等</th><th>內容</th></tr>
        </thead>
        <tbody id="reviewTableBody"></tbody>
      </table>
      <div class="note" id="reviewListNote"></div>
    </div>
  </div>

  <div class="tab-panel" id="tab-ratings">
    <div class="chart-card">
      <h2>每月平均評分趨勢</h2>
      <canvas id="trendChart" height="90"></canvas>
      <div class="note">iOS 目前僅涵蓋近期資料（App Store 網頁無法回溯完整歷史），Android 已涵蓋完整歷史（如已執行過 android-full-history.js）。</div>
    </div>

    <div class="two-col">
      <div class="chart-card">
        <h2>Google Play 星等分佈</h2>
        <canvas id="androidDistChart" height="180"></canvas>
      </div>
      <div class="chart-card">
        <h2>App Store 星等分佈</h2>
        <canvas id="iosDistChart" height="180"></canvas>
      </div>
    </div>
  </div>

  <script>
    const dataset = ${dataJson};

    document.getElementById('subtitle').textContent =
      '資料期間：' + dataset.dateRange.earliest + ' ~ ' + dataset.dateRange.latest +
      '　（產出時間：' + new Date().toLocaleString('zh-TW') + '）' +
      (dataset.hasFullHistory ? '　｜ 已整合 Android 完整歷史資料' : '');

    const summaryEl = document.getElementById('summaryCards');
    const cards = [
      { label: 'Google Play 累積評論數', value: dataset.androidTotal, cls: 'android' },
      { label: 'Google Play 平均星等', value: dataset.androidAvgOverall ? dataset.androidAvgOverall.toFixed(2) : '-', cls: 'android' },
      { label: 'App Store 累積評論數', value: dataset.iosTotal, cls: 'ios' },
      { label: 'App Store 平均星等', value: dataset.iosAvgOverall ? dataset.iosAvgOverall.toFixed(2) : '-', cls: 'ios' },
    ];
    summaryEl.innerHTML = cards.map(c =>
      '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + c.cls + '">' + c.value + '</div></div>'
    ).join('');

    // ===== Tab 切換 =====
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    // ===== 評論 tab：散佈圖（每個點 = 一則評論） =====
    const monthKeys = dataset.monthKeys;
    function monthToIndex(m) {
      const idx = monthKeys.indexOf(m);
      return idx === -1 ? 0 : idx;
    }

    function buildScatterPoints(platform, minIndex) {
      const list = dataset.allReviewsFlat.filter(r => r.platform === platform && monthToIndex(r.month) >= minIndex);
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

    function renderScatterChart(rangeMonths) {
      const minIndex = rangeMonths === 'all' ? 0 : Math.max(0, monthKeys.length - rangeMonths);
      const androidPoints = buildScatterPoints('android', minIndex);
      const iosPoints = buildScatterPoints('ios', minIndex);
      const totalPoints = androidPoints.length + iosPoints.length;

      // 點越多，畫面越擁擠 → 自動縮小點的大小與不透明度，減少視覺混亂
      let pointRadius = 4, pointAlpha = 0.75;
      if (totalPoints > 400) { pointRadius = 2; pointAlpha = 0.45; }
      else if (totalPoints > 150) { pointRadius = 3; pointAlpha = 0.6; }

      const noteEl = document.getElementById('scatterRangeNote');
      noteEl.textContent = '目前顯示 ' + totalPoints + ' 則評論' +
        (rangeMonths !== 'all' ? '（近 ' + rangeMonths + ' 個月）' : '（全部期間，點數較多時建議切換到較短區間查看細節）');

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
              max: monthKeys.length - 0.5,
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
          },
        },
      });
    }

    document.querySelectorAll('#rangeToggleGroup .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#rangeToggleGroup .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const val = btn.dataset.range === 'all' ? 'all' : Number(btn.dataset.range);
        renderScatterChart(val);
      });
    });

    renderScatterChart(6); // 預設顯示近 6 個月

    // ===== 評論 tab：清單（負評 / 全部 切換） =====
    const tbody = document.getElementById('reviewTableBody');
    const noteEl = document.getElementById('reviewListNote');
    const btnNegative = document.getElementById('btnShowNegative');
    const btnAll = document.getElementById('btnShowAll');

    function renderReviewTable(mode) {
      const sortedDesc = [...dataset.allReviewsFlat].sort((a, b) => b.timestamp - a.timestamp);
      let list;
      let note;
      if (mode === 'negative') {
        list = sortedDesc.filter(r => r.score <= 2).slice(0, 30);
        note = '顯示最近 30 則 2 星以下的評論。';
      } else {
        list = sortedDesc.slice(0, 100);
        note = '顯示最近 100 則評論（依日期排序）。';
      }

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:#9aa0ac">目前沒有符合條件的評論</td></tr>';
      } else {
        tbody.innerHTML = list.map(r => \`
          <tr>
            <td><span class="badge \${r.platform}">\${r.platform === 'android' ? 'Android' : 'iOS'}</span></td>
            <td>\${r.date}</td>
            <td class="\${r.score <= 2 ? 'score-neg' : 'score-pos'}">\${r.score} ★</td>
            <td>
              \${r.title ? '<div class="review-text"><b>' + r.title + '</b></div>' : ''}
              <div class="review-text">\${(r.text || '').slice(0, 200)}</div>
              <div class="review-meta">\${r.userName || ''}</div>
            </td>
          </tr>
        \`).join('');
      }
      noteEl.textContent = note;
    }

    btnNegative.addEventListener('click', () => {
      btnNegative.classList.add('active');
      btnAll.classList.remove('active');
      renderReviewTable('negative');
    });
    btnAll.addEventListener('click', () => {
      btnAll.classList.add('active');
      btnNegative.classList.remove('active');
      renderReviewTable('all');
    });

    renderReviewTable('negative');

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

function main() {
  const dailyRuns = loadDailyRuns();
  const fullHistory = loadFullHistory();

  if (dailyRuns.length === 0 && fullHistory.length === 0) {
    console.error('沒有任何資料可以產生報表，請先跑過 scheduled-scrape.js 或 android-full-history.js。');
    process.exit(1);
  }

  const dataset = buildDataset(dailyRuns, fullHistory);
  const html = renderHtml(dataset);
  fs.writeFileSync(OUT_FILE, html, 'utf-8');
  console.log(`Dashboard 已產出：${OUT_FILE}`);
  console.log(
    `資料範圍 ${dataset.dateRange.earliest} ~ ${dataset.dateRange.latest}，Google Play 累積 ${dataset.androidTotal} 則、App Store 累積 ${dataset.iosTotal} 則`
  );
  if (!fullHistory.length) {
    console.log('提示：尚未偵測到 data/android-full-history.json，目前 Android 趨勢僅包含每日排程累積的資料。');
  }
}

main();
