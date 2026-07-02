// ── グローバルエラートラップ（デバッグ用：画面にエラーを表示） ──
window.addEventListener('error', function(e) {
  var msg = 'JS ERR: ' + e.message + ' [' + (e.filename || '').split('/').pop() + ':' + e.lineno + ']';
  var el = document.getElementById('toast');
  if (el) {
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:20px;left:10px;right:10px;background:#c00;color:#fff;padding:14px;font-size:12px;z-index:9999;border-radius:8px;word-break:break-all;display:block;opacity:1;pointer-events:none;';
  } else {
    console.error(msg);
  }
});

// ── 即実行: 旧 Service Worker と全キャッシュを強制クリア ──
// app.js 読み込み時に即座に実行（IIFE 内のエラーに依存しない）
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    }).catch(function () {});
  }
  if (window.caches && caches.keys) {
    caches.keys().then(function (keys) {
      keys.forEach(function (k) { caches.delete(k); });
    }).catch(function () {});
  }
})();

/* ============================================================
   WADACHI  (Ver.4.0 / 藤井工藝)
   GPS time-attack PWA with map-based line drawing
   ============================================================ */

(() => {
  'use strict';

  // ============================================================
  // CONSTANTS
  // ============================================================
  const STORAGE_KEY = 'mirage.courses.v2';
  const SETTINGS_KEY = 'wadachi.settings.v1';
  const SESSIONS_KEY = 'wadachi.sessions.v1';

  // ── 旧ブランド名 (timeattacker.*) → wadachi.* への一度限りの移行 ──
  // 新キーが未使用かつ旧キーにデータがある場合のみコピーする（上書き事故防止）
  // BLE キーはこの時点で未宣言(TDZ)のため文字列リテラルで直接指定する
  (function migrateStorageKeys() {
    const map = [
      ['timeattacker.settings.v1', SETTINGS_KEY],
      ['timeattacker.sessions.v1', SESSIONS_KEY],
      ['timeattacker.ble.device.v1', 'wadachi.ble.device.v1'],
    ];
    try {
      for (const [oldKey, newKey] of map) {
        if (localStorage.getItem(newKey) != null) continue;
        const old = localStorage.getItem(oldKey);
        if (old != null) localStorage.setItem(newKey, old);
      }
    } catch (_) { /* ストレージ利用不可環境では何もしない */ }
  })();
  const MAX_SESSIONS = 30;
  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const DEFAULT_CENTER = [35.6812, 139.7671];
  const R_EARTH = 6378137;
  let G_RANGE = 2.0;             // G-ball max scale (設定から変更可)
  let _gMode  = 'vector';        // 'vector' | 'inertia'
  // 慣性式の物理状態
  let _gInBall = { x: 0, y: 0, vx: 0, vy: 0, t: 0 };
  // localStorage から復元
  try {
    const _gc = JSON.parse(localStorage.getItem('pta_gcfg') || '{}');
    if (_gc && isFinite(+_gc.range) && +_gc.range > 0) G_RANGE = +_gc.range;
    if (_gc && _gc.mode) _gMode = _gc.mode;
  } catch (e) {}
  const SPEED_WINDOW_S = 30.0;     // speed graph window
  const RECORD_LIMIT = 50000;      // CSV row cap (~14h @ 1Hz)

  // Default per-course tunables (overrideable via detail modal)
  const DEFAULT_COOLDOWN_S = 5.0;
  const DEFAULT_ACC_M = 30;        // 0 = disabled
  const DEFAULT_DIRFILTER = false;

  // ============================================================
  // GEO HELPERS
  // ============================================================
  function toLocal(lat, lon, lat0, lon0) {
    const dLat = (lat - lat0) * Math.PI / 180;
    const dLon = (lon - lon0) * Math.PI / 180;
    return {
      x: dLon * Math.cos(lat0 * Math.PI / 180) * R_EARTH,
      y: dLat * R_EARTH
    };
  }

  function segmentIntersect(p1, p2, a, b) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = b.x - a.x,   d2y = b.y - a.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((a.x - p1.x) * d2y - (a.y - p1.y) * d2x) / denom;
    const u = ((a.x - p1.x) * d1y - (a.y - p1.y) * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { t, side: Math.sign(denom) };
    }
    return null;
  }

  function detectCrossing(prevFix, currFix, lineA, lineB) {
    if (!prevFix || !currFix) return null;
    const p1 = toLocal(prevFix.lat, prevFix.lon, lineA[0], lineA[1]);
    const p2 = toLocal(currFix.lat, currFix.lon, lineA[0], lineA[1]);
    const a  = { x: 0, y: 0 };
    const b  = toLocal(lineB[0], lineB[1], lineA[0], lineA[1]);
    const r  = segmentIntersect(p1, p2, a, b);
    if (!r) return null;
    return {
      t: prevFix.t + (currFix.t - prevFix.t) * r.t,
      side: r.side
    };
  }

  /** Distance between two GPS points in meters (haversine, simplified for short distances). */
  function distM(lat1, lon1, lat2, lon2) {
    const p = toLocal(lat2, lon2, lat1, lon1);
    return Math.sqrt(p.x * p.x + p.y * p.y);
  }

  // ============================================================
  // FORMAT HELPERS
  // ============================================================
  function formatTime(ms) {
    if (ms == null || !isFinite(ms)) return '--:--.---';
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const ms3 = Math.floor(ms % 1000);
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
  }

  function formatTimeShort(ms) {
    if (ms == null || !isFinite(ms)) return '--:--.--';
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  function formatDelta(ms) {
    if (ms == null || !isFinite(ms)) return '--';
    const sign = ms >= 0 ? '+' : '−';
    return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
  }

  // 差分を秒単位（小数点以下なし）で表示: +5 / −12 など
  function formatDeltaNoMs(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const sign = ms >= 0 ? '+' : '−';
    return `${sign}${Math.floor(Math.abs(ms) / 1000)}`;
  }

  /**
   * Parse MMSS.CC numeric input → ms
   * Accepts:
   *   "0520.10" → 05:20.10  (MMSS.CC with dot)
   *   "052010"  → 05:20.10  (6-digit MMSSCC)
   *   "0520"    → 05:20.00  (4-digit MMSS)
   */
  function parseTargetTime(raw) {
    if (!raw || !raw.trim()) return null;
    const s = raw.trim();
    let mm, ss, cc;
    if (s.includes('.')) {
      const dot = s.indexOf('.');
      const ip  = s.slice(0, dot).replace(/\D/g, '').padStart(4, '0').slice(-4);
      const fp  = s.slice(dot + 1).replace(/\D/g, '').padEnd(2, '0').slice(0, 2);
      mm = parseInt(ip.slice(0, 2), 10);
      ss = parseInt(ip.slice(2, 4), 10);
      cc = parseInt(fp, 10);
    } else {
      const d = s.replace(/\D/g, '');
      if (d.length >= 6) {
        const e = d.padStart(6, '0').slice(-6);
        mm = parseInt(e.slice(0, 2), 10);
        ss = parseInt(e.slice(2, 4), 10);
        cc = parseInt(e.slice(4, 6), 10);
      } else {
        const e = d.padStart(4, '0').slice(-4);
        mm = parseInt(e.slice(0, 2), 10);
        ss = parseInt(e.slice(2, 4), 10);
        cc = 0;
      }
    }
    if (isNaN(mm) || isNaN(ss) || isNaN(cc)) return null;
    if (ss >= 60 || cc >= 100) return null;
    return mm * 60000 + ss * 1000 + cc * 10;
  }

  /** Format ms → "MM:SS.CC" for display */
  function formatNumericDisplay(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cc = Math.floor((ms % 1000) / 10);
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // ============================================================
  // STORAGE
  // ============================================================
  function loadCourses() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      // Migrate fields with defaults
      arr.forEach(c => {
        if (c.duration == null) c.duration = 0;
        if (c.cooldownS == null) c.cooldownS = DEFAULT_COOLDOWN_S;
        if (c.accLimitM == null) c.accLimitM = DEFAULT_ACC_M;
        if (c.dirFilter == null) c.dirFilter = DEFAULT_DIRFILTER;
        c.sections = c.sections || [];
      });
      return arr;
    } catch (e) {
      console.error('Load failed', e);
      return [];
    }
  }

  function saveCourses() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.courses));
    } catch (e) {
      console.error('Save failed', e);
      toast('Save failed: storage error');
    }
  }

  // ============================================================
  // SETTINGS (Phase 0: UI + 永続化のみ。Phase 1 で BLE 接続が読み取って利用)
  // ============================================================

  const DEFAULT_SETTINGS = {
    obdMode: 'double',          // 'single' | 'double'
    obdAutoReconnect: 'on',     // 'on' | 'off'
    pids: {
      rpm:      true,
      coolant:  true,
      oiltemp:  true,
      intake:   true,
      throttle: true,
    },
    // 横画面ダッシュボード設定（GT_DASH 互換）
    // Mini F56 JCW Automatic (6-speed Aisin Steptronic Sports) — BMW Group 公式スペック
    vehicle: {
      finalDrive:  3.502,
      tireDiamMm:  616,
      gearRatios:  [4.459, 2.508, 1.555, 1.142, 0.851, 0.672],
      tolerancePct: 10,
      hysteresis:   2,
      minSpeed:     4,
      minRpm:       500,
      medianSize:   5,
    },
    // 横画面ダッシュボード (GT DASH 移植) 設定
    dash: {
      enabled:   true,          // 横画面時にダッシュボード表示
      showBoost: true,          // ブーストバー (ターボ車)
      boostMin:  -0.5,          // バー左端 [kg/cm²]
      boostMax:  2.0,           // バー右端 [kg/cm²]
      maxRpm:    6200,
      warnRpm:   4800,          // 以上で LED 全点滅
      rpmDots:   12,
      dotConfig: [
        {color:'green', threshold:1000},{color:'green', threshold:1500},
        {color:'green', threshold:2000},{color:'green', threshold:2500},
        {color:'green', threshold:3000},{color:'green', threshold:3500},
        {color:'yellow',threshold:4000},{color:'yellow',threshold:4300},
        {color:'yellow',threshold:4600},{color:'red',   threshold:5000},
        {color:'red',   threshold:5400},{color:'red',   threshold:5800},
      ],
      gearSource: 'gps',        // 'gps' (GPS速度) | 'obd' (PID 010D)
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      const s = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...s,
        pids:     { ...DEFAULT_SETTINGS.pids,     ...(s.pids     || {}) },
        vehicle:  { ...DEFAULT_SETTINGS.vehicle,  ...(s.vehicle  || {}) },
        dash:     { ...DEFAULT_SETTINGS.dash,     ...(s.dash     || {}) },
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      console.error('Settings save failed', e);
      toast('Failed to save settings');
    }
  }

  // ============================================================
  // SESSIONS / HISTORY (走行履歴の永続化)
  // ============================================================
  function loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveSessions(list) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      console.error('Sessions save failed', e);
      // 容量オーバーの場合は古いセッションを削除して再試行
      if (e.name === 'QuotaExceededError' && list.length > 5) {
        list.splice(0, Math.max(1, Math.floor(list.length / 4)));
        try {
          localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
          toast('Storage full — oldest sessions removed');
          return true;
        } catch (_) {}
      }
      toast('Failed to save session (storage full)');
      return false;
    }
  }

  // 走行終了時に呼ばれる: 現状のセッションデータを履歴に保存
  function persistCurrentSession(course) {
    // データが何もないなら保存しない
    if (!state.csvRows || state.csvRows.length === 0) return;
    if (!state.sessionStartTime) return;

    const laps = (state.completedLaps || []).map(l => ({
      number:  l.number,
      totalMs: l.totalMs,
      splits:  l.splits || [],
      date:    l.date,
    }));

    // 最速ラップの index を計算
    let bestLapIdx = -1;
    if (laps.length > 0) {
      let bestMs = Infinity;
      laps.forEach((l, i) => { if (l.totalMs < bestMs) { bestMs = l.totalMs; bestLapIdx = i; } });
    }

    // OBD データが入っているか（接続フラグ OR 行データのどちらかで判定）
    const obdRowHasData = state.csvRows.some(r =>
      (r[9]  !== '' && r[9]  != null) ||
      (r[10] !== '' && r[10] != null) ||
      (r[11] !== '' && r[11] != null) ||
      (r[12] !== '' && r[12] != null) ||
      (r[13] !== '' && r[13] != null));
    // セッション中に BLE が一度でも繋がっていたら OBD Yesとみなす
    const hasObdData = state.sessionObdActive || obdRowHasData;

    const session = {
      id: 'sess_' + uid(),
      courseId:   course?.id || null,
      courseName: course?.name || 'Unknown',
      courseType: course?.type || 'circuit',
      startTime:  state.sessionStartTime,
      endTime:    Date.now(),
      laps,
      bestLapIdx,
      hasObdData,
      // CSV と同じ順序のカラム定義
      columns: [
        'iso_time','lat','lon','acc','speed_kmh','lap','sector','g_lat','g_lon',
        'rpm','coolant','oilTemp','intake','throttle',
      ],
      rows: state.csvRows.slice(),  // shallow copy
    };

    const sessions = loadSessions();
    sessions.push(session);
    // 古いセッションを削除して上限を維持
    while (sessions.length > MAX_SESSIONS) sessions.shift();
    saveSessions(sessions);
  }

  function deleteSession(id) {
    const sessions = loadSessions().filter(s => s.id !== id);
    saveSessions(sessions);
  }

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    view: 'home',
    courses: loadCourses(),
    activeCourseId: null,
    settings: loadSettings(),

    // Edit
    editMap: null,
    editLineLayers: { start: null, finish: null, sections: [] },
    editMode: null,
    editPendingPoint: null,
    editPendingMarker: null,
    editLocateMarker: null,
    locateWatchId: null,

    // Drive
    driveActive: false,                // session armed
    driveStartT: null,                 // session start (for FINISH countdown)
    lapStartT: null,                   // current lap start
    lapStarted: false,                 // start line crossed
    lapNumber: 0,
    lastLapMs: null,
    currentLapSplits: [],              // [{ idx, t, splitMs }]
    mapRotOffset: 0,                   // 地図回転オフセット [ラジアン] スライダーで調整
    completedLaps: [],                 // セッション中に完走した全ラップの配列
    sessionStartTime: null,            // セッション開始 ms
    sessionObdActive: false,           // このセッション中に OBD が接続されていたか
    sectionStartT: null,               // start of current section (for live target Δ)
    currentSectorIdx: 0,
    gateCooldown: {},                  // gateKey → last trigger time
    gateValidSide: {},                 // gateKey → first valid side (direction filter)

    // GPS
    watchId: null,
    prevFix: null,
    currentSpeedMS: -1,

    // Sensors
    motionEnabled: false,
    g_calib: { x: 0, z: 0 },
    g_raw: { x: 0, y: 0, z: 0 },
    g_smooth: { x: 0, z: 0 },   // EMA-filtered values for stable display
    g_lat: 0, g_lon: 0,

    // CSV record buffer
    csvRows: [],

    // ============================================================
    // OBD2 リアルタイム値（Phase 1 で BLE 接続が更新する）
    // 未接続時はすべて null。CSV / 分析機能はこれを読んで記録する
    // ============================================================
    obd: {
      rpm:      null,  // 回転数 [rpm]
      coolant:  null,  // 水温 [°C]
      oiltemp:  null,  // 油温 [°C]
      intake:   null,  // 吸気温 [°C]
      throttle: null,  // スロットル開度 [%]
      mapKpa:   null,  // 吸気圧 [kPa] (PID 010B)
      boost:    null,  // 相対ブースト [kg/cm²] (mapKpa から算出)
      speed:    null,  // 車速 [km/h] (PID 010D, gearSource='obd' 時のみ)
      // BLE接続状態
      connected: false,
      lastUpdateMs: null,
      // BLE デバイスハンドル（Phase 1）
      device:     null,
      txChar:     null,
      rxChar:     null,
      deviceName: null,
      deviceId:   null,
      status:     'disconnected',
    },

    // Wake lock
    wakeLock: null,

    // Render loop
    rafId: null,

    // Widgets
    gball: null,
    courseMap: null,
  };

  // ============================================================
  // SCREEN ROUTING
  // ============================================================
  function showScreen(name) {
    state.view = name;
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
    // drive 出入り時に横画面ダッシュボード状態を再評価
    try { updateOrientation(); } catch (_) {}
  }

  function getActiveCourse() {
    return state.courses.find(c => c.id === state.activeCourseId) || null;
  }

  // ============================================================
  // HOME
  // ============================================================
  function renderHome() {
    const list = document.getElementById('course-list');
    list.innerHTML = '';
    if (state.courses.length === 0) {
      list.innerHTML = `<div class="empty-state">No courses yet<br>Tap “Create New Course” to begin</div>`;
      return;
    }
    state.courses.forEach(c => {
      const card = document.createElement('div');
      card.className = 'course-card';
      const best = c.bestLap ? formatTime(c.bestLap.totalMs) : '--:--.---';
      const bestCls = c.bestLap ? '' : 'none';
      const sectionCount = (c.sections || []).length;
      const hasLines = c.startLine && (c.type === 'circuit' || c.finishLine);
      card.innerHTML = `
        <div>
          <div class="name">${escapeHtml(c.name || '(Unnamed Course)')}</div>
          <div class="meta">${c.type === 'circuit' ? 'Loop' : 'P2P'} · ${sectionCount} sector${sectionCount === 1 ? '' : 's'} ${hasLines ? '' : '· Incomplete'}</div>
        </div>
        <div class="right">
          <div class="best ${bestCls}">${best}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        state.activeCourseId = c.id;
        openEdit();
      });
      list.appendChild(card);
    });
  }

  document.getElementById('btn-new-course').addEventListener('click', () => {
    const c = {
      id: uid(),
      name: 'New Course',
      type: 'circuit',
      duration: 0,
      cooldownS: DEFAULT_COOLDOWN_S,
      accLimitM: DEFAULT_ACC_M,
      dirFilter: DEFAULT_DIRFILTER,
      startLine: null,
      finishLine: null,
      sections: [],
      bestLap: null,
      createdAt: Date.now(),
    };
    state.courses.push(c);
    saveCourses();
    state.activeCourseId = c.id;
    openEdit();
  });

  // ============================================================
  // SETTINGS SCREEN
  // ============================================================
  function openSettings() {
    showScreen('settings');
    renderSettings();
    // G-ball モードボタン: 設定画面を開くたびにバインド
    const setGMode = (mode) => {
      _gMode = mode;
      // 慣性状態リセット(モード切替時に残留速度を消去)
      _gInBall.x = _gInBall.y = _gInBall.vx = _gInBall.vy = _gInBall.t = 0;
      document.getElementById('cfg-gball-vec')?.classList.toggle('active', mode === 'vector');
      document.getElementById('cfg-gball-ine')?.classList.toggle('active', mode === 'inertia');
      try { localStorage.setItem('pta_gcfg', JSON.stringify({ range: G_RANGE, mode: _gMode })); } catch (e) {}
    };
    const vecBtn = document.getElementById('cfg-gball-vec');
    const ineBtn = document.getElementById('cfg-gball-ine');
    if (vecBtn) { vecBtn.onclick = () => setGMode('vector');  }
    if (ineBtn) { ineBtn.onclick = () => setGMode('inertia'); }
  }

  // 設定値を画面に反映
  function renderSettings() {
    const s = state.settings;

    // Segmented toggles
    document.querySelectorAll('.seg-toggle').forEach(group => {
      const key = group.dataset.key;
      const currentVal = s[key];
      group.querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === currentVal);
      });
    });

    // PID checkboxes
    document.getElementById('cb-pid-rpm').checked      = !!s.pids.rpm;
    document.getElementById('cb-pid-coolant').checked  = !!s.pids.coolant;
    document.getElementById('cb-pid-oiltemp').checked  = !!s.pids.oiltemp;
    document.getElementById('cb-pid-intake').checked   = !!s.pids.intake;
    document.getElementById('cb-pid-throttle').checked = !!s.pids.throttle;

    // G-ball 設定
    const gRangeEl = document.getElementById('cfg-gball-range');
    if (gRangeEl) gRangeEl.value = G_RANGE;
    const gModeVec = document.getElementById('cfg-gball-vec');
    const gModeIne = document.getElementById('cfg-gball-ine');
    if (gModeVec) gModeVec.classList.toggle('active', _gMode === 'vector');
    if (gModeIne) gModeIne.classList.toggle('active', _gMode === 'inertia');

    // BLE 状態を画面に反映
    if (typeof updateBleUI === 'function') updateBleUI();

    // 横画面ダッシュボード設定 UI
    renderDashSettings(s);
  }

  // ─── 横画面ダッシュボード設定 UI ───
  const DASH_LED_COLORS = ['green', 'yellow', 'red', 'blue', 'orange', 'white'];
  const DASH_LED_LABELS = { green:'Green', yellow:'Yellow', red:'Red', blue:'Blue', orange:'Orange', white:'White' };

  function renderDashSettings(s) {
    const d = s.dash, v = s.vehicle;
    const el = id => document.getElementById(id);
    if (!el('cfg-dash-enabled')) return;   // HTML 未追加なら何もしない

    el('cfg-dash-enabled').checked = !!d.enabled;
    el('cfg-dash-boost').checked   = !!d.showBoost;
    el('cfg-dash-boostmin').value  = d.boostMin;
    el('cfg-dash-boostmax').value  = d.boostMax;
    el('cfg-dash-maxrpm').value    = d.maxRpm;
    el('cfg-dash-warnrpm').value   = d.warnRpm;
    el('cfg-dash-dotcount').value  = d.rpmDots;
    el('cfg-dash-gearsrc').value   = d.gearSource || 'gps';
    el('cfg-dash-finaldrive').value = v.finalDrive;
    el('cfg-dash-tirediam').value   = v.tireDiamMm;
    el('cfg-dash-gearcount').value  = (v.gearRatios || []).length;
    el('cfg-dash-tolerance').value  = v.tolerancePct;

    renderDashDotRows(d);
    renderDashGearRows(v);

    // 個数変更で行を再構築（現在の入力値を保持しつつ増減）
    el('cfg-dash-dotcount').onchange = () => {
      const n = Math.max(4, Math.min(20, parseInt(el('cfg-dash-dotcount').value) || 12));
      el('cfg-dash-dotcount').value = n;
      const cur = collectDashDots();
      while (cur.length < n) cur.push({ color:'red', threshold:(cur[cur.length-1]?.threshold || 5000) + 200 });
      renderDashDotRows({ ...collectDashBasics(), rpmDots:n, dotConfig:cur.slice(0, n) });
    };
    el('cfg-dash-gearcount').onchange = () => {
      const n = Math.max(3, Math.min(10, parseInt(el('cfg-dash-gearcount').value) || 6));
      el('cfg-dash-gearcount').value = n;
      const cur = collectDashGears();
      while (cur.length < n) cur.push(+(cur[cur.length-1] * 0.8).toFixed(3) || 1.0);
      renderDashGearRows({ gearRatios: cur.slice(0, n) });
    };
    // 均等配分: minRpm相当(1000)〜MAX RPM を LED 個数で等分
    el('btn-dash-autodist').onclick = () => {
      const n = parseInt(el('cfg-dash-dotcount').value) || 12;
      const maxR  = parseInt(el('cfg-dash-maxrpm').value)  || 6200;
      const warnR = parseInt(el('cfg-dash-warnrpm').value) || 4800;
      const startR = 1000;
      const dots = [];
      for (let i = 0; i < n; i++) {
        const th = Math.round((startR + (maxR - startR) * i / (n - 1)) / 50) * 50;
        const frac = i / (n - 1);
        const color = th >= warnR ? 'red' : frac >= 0.5 ? 'yellow' : 'green';
        dots.push({ color, threshold: th });
      }
      renderDashDotRows({ rpmDots:n, dotConfig:dots });
      toast('LED thresholds distributed evenly');
    };
  }

  function renderDashDotRows(d) {
    const wrap = document.getElementById('cfg-dash-dots');
    if (!wrap) return;
    wrap.innerHTML = '';
    const n = d.rpmDots || (d.dotConfig || []).length || 12;
    for (let i = 0; i < n; i++) {
      const dc = (d.dotConfig || [])[i] || { color:'green', threshold:1000 + i * 400 };
      const row = document.createElement('div');
      row.className = 'dash-dot-row';
      const swatches = DASH_LED_COLORS.map(c =>
        `<button type="button" class="led ${c} on dash-swatch${c === dc.color ? ' selected' : ''}" data-color="${c}" aria-label="${DASH_LED_LABELS[c]}" aria-pressed="${c === dc.color}"></button>`
      ).join('');
      row.innerHTML =
        `<span class="dot-idx">#${i + 1}</span>` +
        `<div class="dash-dot-swatches" data-i="${i}">${swatches}</div>` +
        `<input type="number" class="dash-dot-th" data-i="${i}" step="50" inputmode="numeric" value="${dc.threshold}">` +
        `<span class="dot-unit">rpm</span>`;
      wrap.appendChild(row);
    }
  }

  // スウォッチ選択（イベント委譲: 行の再構築後も再バインド不要）
  document.getElementById('cfg-dash-dots')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.dash-swatch');
    if (!btn) return;
    const group = btn.closest('.dash-dot-swatches');
    group.querySelectorAll('.dash-swatch').forEach(s => {
      s.classList.remove('selected');
      s.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  });

  function renderDashGearRows(v) {
    const wrap = document.getElementById('cfg-dash-gears');
    if (!wrap) return;
    wrap.innerHTML = '';
    (v.gearRatios || []).forEach((gr, i) => {
      const row = document.createElement('div');
      row.className = 'dash-gear-row';
      row.innerHTML =
        `<span class="gear-idx">${ordinal(i + 1)}</span>` +
        `<input type="number" class="dash-gear-ratio" data-i="${i}" step="0.001" inputmode="decimal" value="${gr}">`;
      wrap.appendChild(row);
    });
  }

  function collectDashDots() {
    const groups = [...document.querySelectorAll('.dash-dot-swatches')];
    const ths    = [...document.querySelectorAll('.dash-dot-th')];
    return groups.map((g, i) => ({
      color: g.querySelector('.dash-swatch.selected')?.dataset.color || 'green',
      threshold: parseInt(ths[i]?.value) || 0,
    }));
  }
  function collectDashGears() {
    return [...document.querySelectorAll('.dash-gear-ratio')]
      .map(inp => parseFloat(inp.value) || 1.0);
  }
  function collectDashBasics() {
    const el = id => document.getElementById(id);
    return {
      enabled:   el('cfg-dash-enabled').checked,
      showBoost: el('cfg-dash-boost').checked,
      boostMin:  parseFloat(el('cfg-dash-boostmin').value),
      boostMax:  parseFloat(el('cfg-dash-boostmax').value),
      maxRpm:    parseInt(el('cfg-dash-maxrpm').value)  || 6200,
      warnRpm:   parseInt(el('cfg-dash-warnrpm').value) || 4800,
      rpmDots:   parseInt(el('cfg-dash-dotcount').value) || 12,
      gearSource: el('cfg-dash-gearsrc').value,
    };
  }

  // 現在のUIから設定オブジェクトを構築
  function collectSettings() {
    const s = JSON.parse(JSON.stringify(state.settings));

    document.querySelectorAll('.seg-toggle').forEach(group => {
      const key = group.dataset.key;
      const active = group.querySelector('.seg-btn.active');
      if (active) s[key] = active.dataset.value;
    });

    s.pids = {
      rpm:      document.getElementById('cb-pid-rpm').checked,
      coolant:  document.getElementById('cb-pid-coolant').checked,
      oiltemp:  document.getElementById('cb-pid-oiltemp').checked,
      intake:   document.getElementById('cb-pid-intake').checked,
      throttle: document.getElementById('cb-pid-throttle').checked,
    };

    // 横画面ダッシュボード設定
    if (document.getElementById('cfg-dash-enabled')) {
      const basics = collectDashBasics();
      const dots = collectDashDots();
      // 入力検証: min < max、しきい値昇順は強制しない（自由設定を尊重）
      if (!(basics.boostMin < basics.boostMax)) {
        basics.boostMin = DEFAULT_SETTINGS.dash.boostMin;
        basics.boostMax = DEFAULT_SETTINGS.dash.boostMax;
        toast('Invalid boost range — reset to defaults');
      }
      s.dash = { ...s.dash, ...basics, dotConfig: dots.slice(0, basics.rpmDots) };
      s.vehicle = {
        ...s.vehicle,
        finalDrive:   parseFloat(document.getElementById('cfg-dash-finaldrive').value) || s.vehicle.finalDrive,
        tireDiamMm:   parseInt(document.getElementById('cfg-dash-tirediam').value)     || s.vehicle.tireDiamMm,
        gearRatios:   collectDashGears(),
        tolerancePct: parseInt(document.getElementById('cfg-dash-tolerance').value)    || s.vehicle.tolerancePct,
      };
    }

    // G-ball 設定を即時反映 + localStorage 保存
    const gRangeEl = document.getElementById('cfg-gball-range');
    if (gRangeEl) {
      const v = parseFloat(gRangeEl.value);
      if (isFinite(v) && v > 0) G_RANGE = v;
    }
    try {
      localStorage.setItem('pta_gcfg', JSON.stringify({ range: G_RANGE, mode: _gMode }));
    } catch (e) {}

    return s;
  }

  // Settings: 開くボタン
  document.getElementById('btn-open-settings').addEventListener('click', openSettings);

  // Settings: 戻るボタン (収集せずに破棄して戻る)
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    showScreen('home');
  });

  // Settings: セグメントトグル (Single/Double, ON/OFF) のクリック処理
  document.querySelectorAll('.seg-toggle').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Settings: 保存
  document.getElementById('btn-settings-save').addEventListener('click', () => {
    state.settings = collectSettings();
    saveSettings(state.settings);
    // Connectedなら PID リストを即時反映
    if (state.obd.connected && typeof recomputeActivePids === 'function') {
      recomputeActivePids();
    }
    // 横画面ダッシュボードのギア表・LED・ブースト範囲を再構築
    try { Landscape.rebuild(); } catch (_) {}
    toast('Settings saved');
    showScreen('home');
  });

  // ============================================================
  // BLE / OBD2 接続 (Phase 1: 接続のみ。PID 取得は Phase 2)
  // ============================================================
  // ELM327 互換アダプタが使う可能性のあるサービス UUID
  const ELM_SERVICES = [
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '000018f0-0000-1000-8000-00805f9b34fb',
    '0000ffe5-0000-1000-8000-00805f9b34fb',
  ];
  const BLE_DEVICE_KEY = 'wadachi.ble.device.v1';

  function bleSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ATコマンド送信
  // BLE 送信キュー — 複数の write が競合しないよう 1 件ずつ順番に処理
  // 送信 — GT_DASH と完全同一の同期 fire-and-forget 方式
  // (旧: 20ms 間隔の非同期キューだったが、その遅延が応答 race の原因だった)
  function bleSend(cmd) {
    if (!state.obd.txChar) return;
    try {
      state.obd.txChar.writeValueWithoutResponse(
        new TextEncoder().encode(cmd + '\r')
      ).catch(e => console.warn('[BLE SEND]', e));
    } catch (e) {
      console.warn('[BLE SEND]', e);
    }
  }

  // 接続状態の UI 更新（設定画面 + Drive 画面のインジケータ）
  function updateBleUI() {
    const status = state.obd.status;
    const connected = (status === 'connected');

    // 設定画面 — 状態インジケータ
    const ind = document.getElementById('ble-status-indicator');
    const txt = document.getElementById('ble-status-text');
    const name = document.getElementById('ble-device-name');
    if (ind && txt) {
      ind.classList.remove('connected', 'connecting', 'scanning', 'error');
      const statusMap = {
        disconnected: 'Disconnected',
        scanning:     'Scanning…',
        connecting:   'Connecting…',
        discovering:  'Discovering services…',
        connected:    'Connected',
        error:        'Connection failed',
      };
      txt.textContent = statusMap[status] || status;
      if (status !== 'disconnected') ind.classList.add(status);
      if (name) name.textContent = connected && state.obd.deviceName ? state.obd.deviceName : '';
    }

    // 設定画面 — ボタン表示切替
    const scanBtn       = document.getElementById('btn-ble-scan');
    const reconnectBtn  = document.getElementById('btn-ble-reconnect');
    const disconnectBtn = document.getElementById('btn-ble-disconnect');
    if (scanBtn && reconnectBtn && disconnectBtn) {
      const saved = bleLoadDevice();
      const busy = (status === 'scanning' || status === 'connecting' || status === 'discovering');
      scanBtn.disabled = busy;
      scanBtn.textContent = busy ? 'Connecting…' : 'Scan & Connect BLE';
      reconnectBtn.style.display = (!connected && !busy && saved) ? '' : 'none';
      disconnectBtn.style.display = connected ? '' : 'none';
    }

    // Drive 画面 — OBD インジケータ
    const obdInd = document.getElementById('obd-indicator');
    if (obdInd) {
      obdInd.classList.remove('connected', 'connecting');
      if (status === 'connected') obdInd.classList.add('connected');
      else if (status === 'scanning' || status === 'connecting' || status === 'discovering') {
        obdInd.classList.add('connecting');
      }
    }
  }

  function bleSetStatus(s) {
    if (state.obd.status !== s && typeof dbg === 'function') {
      dbg('[STATUS] ' + (state.obd.status || '?') + ' → ' + s);
    }
    state.obd.status = s;
    state.obd.connected = (s === 'connected');
    // 計測中に OBD が接続されたタイミングをキャプチャ
    if (s === 'connected' && state.driveActive) {
      state.sessionObdActive = true;
    }
    updateBleUI();
  }

  // デバイス記憶（次回起動でクイック再接続用）
  function bleSaveDevice(id, name) {
    try { localStorage.setItem(BLE_DEVICE_KEY, JSON.stringify({ id, name })); } catch (_) {}
  }
  function bleLoadDevice() {
    try { return JSON.parse(localStorage.getItem(BLE_DEVICE_KEY)); } catch (_) { return null; }
  }

  // 切断ハンドラ（GATT 切断時の状態クリア）
  function bleAddDisconnectHandler(device) {
    if (device._taDisconnectHandlerAdded) return;
    device._taDisconnectHandlerAdded = true;
    device.addEventListener('gattserverdisconnected', () => {
      console.log('[BLE] gattserverdisconnected');
      bleStopPolling();
      stopKeepAlive();
      stopWatchdog();
      state.obd.txChar = null;
      state.obd.rxChar = null;
      // OBD 値もクリア
      state.obd.rpm = null;
      state.obd.coolant = null;
      state.obd.oiltemp = null;
      state.obd.intake = null;
      state.obd.throttle = null;
      // 自動再接続が ON で、ユーザー意図でない切断（_reconnecting中でない）なら再接続を試みる
      if (state.settings.obdAutoReconnect === 'on' && !_reconnecting) {
        // 短いディレイの後 attemptReconnect を試行
        setTimeout(() => {
          if (!state.obd.connected) attemptReconnect();
        }, 1500);
      } else {
        bleSetStatus('disconnected');
        toast('OBD2 disconnected');
      }
    });
  }

  // ── スキャン & 接続 ─────────────────────────────────
  async function bleStartScan() {
    if (!navigator.bluetooth) {
      toast('This browser does not support Web Bluetooth');
      return;
    }
    try {
      bleSetStatus('scanning');
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ELM_SERVICES,
      });
      state.obd.device = device;
      bleSaveDevice(device.id, device.name || 'Unknown');
      bleAddDisconnectHandler(device);

      bleSetStatus('connecting');
      const server = await device.gatt.connect();
      await bleInitAfterConnect(server, device);
    } catch (e) {
      console.error('[BLE scan]', e);
      bleSetStatus('disconnected');
      if (e.name === 'NotFoundError') {
        // ユーザーがキャンセル
      } else {
        toast('Connection failed: ' + (e.message || e.name));
      }
    }
  }

  // ── 前回のデバイスへ再接続 ──────────────────────────
  async function bleQuickReconnect() {
    const saved = bleLoadDevice();
    if (!saved) {
      toast('No saved device');
      return;
    }
    if (!navigator.bluetooth?.getDevices) {
      toast('Reconnect not supported — please scan');
      return;
    }
    try {
      bleSetStatus('scanning');
      const devices = await navigator.bluetooth.getDevices();
      const device = devices.find(d => d.id === saved.id);
      if (!device) {
        bleSetStatus('disconnected');
        toast('Device not found — please scan');
        return;
      }
      state.obd.device = device;
      bleAddDisconnectHandler(device);
      bleSetStatus('connecting');
      const server = await device.gatt.connect();
      await bleInitAfterConnect(server, device);
    } catch (e) {
      console.error('[BLE quick]', e);
      bleSetStatus('disconnected');
      toast('Reconnect failed: ' + (e.message || e.name));
    }
  }

  // ── 切断 ────────────────────────────────────────────
  function bleDisconnect() {
    // ユーザー意図の切断中は再接続させない（_reconnecting フラグを流用）
    _reconnecting = true;
    stopKeepAlive();
    stopWatchdog();
    bleStopPolling();
    if (state.obd.device?.gatt?.connected) {
      state.obd.device.gatt.disconnect();
    } else {
      bleSetStatus('disconnected');
    }
    // 200ms 後にフラグを戻す（gattserverdisconnected イベント処理後）
    setTimeout(() => { _reconnecting = false; }, 200);
  }

  // ── GATT サービス検出 + ELM327 初期化シーケンス ──────
  async function bleInitAfterConnect(server, device) {
    try {
      bleSetStatus('discovering');
      let txChar = null, rxChar = null;

      // ELM327 標準サービスを優先試行
      for (const svcUuid of ELM_SERVICES) {
        try {
          const svc = await server.getPrimaryService(svcUuid);
          const chars = await svc.getCharacteristics();
          for (const c of chars) {
            if ((c.properties.notify || c.properties.indicate) && !rxChar) rxChar = c;
            if ((c.properties.writeWithoutResponse || c.properties.write) && !txChar) txChar = c;
          }
          if (txChar && rxChar) break;
        } catch (_) { /* このサービスはNoい、次へ */ }
      }

      // フォールバック: 全サービスから探索（標準BLEサービス除外）
      if (!txChar || !rxChar) {
        const STD = ['00001800', '00001801', '0000180a', '0000180f'];
        const services = await server.getPrimaryServices();
        for (const svc of services) {
          if (STD.some(s => svc.uuid.startsWith(s))) continue;
          try {
            const chars = await svc.getCharacteristics();
            for (const c of chars) {
              if ((c.properties.notify || c.properties.indicate) && !rxChar) rxChar = c;
              if ((c.properties.writeWithoutResponse || c.properties.write) && !txChar) txChar = c;
            }
            if (txChar && rxChar) break;
          } catch (_) {}
        }
      }

      if (!txChar || !rxChar) {
        bleSetStatus('error');
        toast('No ELM327-compatible characteristic found');
        return;
      }

      state.obd.txChar = txChar;
      state.obd.rxChar = rxChar;
      state.obd.deviceName = device.name || 'Unknown';
      state.obd.deviceId   = device.id;

      // 通知受信 → PID 応答パースへ
      await rxChar.startNotifications();
      // 旧リスナーを必ず削除してから再登録（再接続時の二重登録防止）
      rxChar.removeEventListener('characteristicvaluechanged', bleOnData);
      rxChar.addEventListener('characteristicvaluechanged', bleOnData);

      // ELM327 初期化シーケンス — GT_DASH と完全一致 (Mini F56 で動作確認済)
      await bleSleep(500);
      dbg('[INIT] ELM327 init start');

      bleSend('ATZ'); await bleSleep(1600);
      // ATST FF: ELM327 タイムアウトを最大(約4秒)に設定 → 勝手な切断を防ぐ
      for (const cmd of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATST FF', 'ATSP0']) {
        bleSend(cmd);
        await bleSleep(400);
      }
      dbg('[INIT] complete → polling start');

      bleSetStatus('connected');
      toast(`OBD2 connected: ${state.obd.deviceName}`);

      // ポーリング + 安定化機能を開始
      bleStartPolling();
      startKeepAlive();
      startWatchdog();
    } catch (e) {
      console.error('[BLE init]', e);
      bleSetStatus('error');
      toast('Init failed: ' + (e.message || e.name));
    }
  }

  // イベントバインド
  document.getElementById('btn-ble-scan').addEventListener('click', bleStartScan);
  document.getElementById('btn-ble-reconnect').addEventListener('click', bleQuickReconnect);
  document.getElementById('btn-ble-disconnect').addEventListener('click', bleDisconnect);

  // ============================================================
  // HISTORY (走行履歴一覧 + セッション詳細)
  // ============================================================
  let _currentSessionId = null;

  function openHistory() {
    showScreen('history');
    renderHistoryList();
  }

  function renderHistoryList() {
    const sessions = loadSessions().slice().sort((a, b) => b.startTime - a.startTime);
    const listEl = document.getElementById('history-list');
    const emptyEl = document.getElementById('history-empty');

    listEl.innerHTML = '';

    if (sessions.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    sessions.forEach(s => {
      const bestMs = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
        ? s.laps[s.bestLapIdx].totalMs : null;
      const dateStr = formatSessionDate(s.startTime);

      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.sessionId = s.id;
      item.innerHTML = `
        <div class="history-item-top">
          <div class="history-item-name">${escapeHtml(s.courseName)}</div>
          <div class="history-item-date">${dateStr}</div>
        </div>
        <div class="history-item-stats">
          <span><span class="label">LAPS</span>${s.laps.length}</span>
          <span><span class="label">BEST</span><span class="best">${bestMs ? formatTime(bestMs) : '--'}</span></span>
          ${s.hasObdData ? '<span class="obd-flag">● OBD</span>' : ''}
        </div>`;
      item.addEventListener('click', () => openSessionDetail(s.id));
      listEl.appendChild(item);
    });
  }

  function formatSessionDate(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // SESSION ANALYSIS  (Phase 5b + 5c)
  // ============================================================

  // 利用可能なメトリック定義
  // columns 順: 0=iso_time 1=lat 2=lon 3=acc 4=speed_kmh 5=lap 6=sector 7=g_lat 8=g_lon
  //             9=rpm 10=coolant 11=oilTemp 12=intake 13=throttle
  const METRICS = [
    { key: 'speed',    label: 'SPEED',    col: 4,  unit: 'km/h', requiresObd: false, abs: false },
    { key: 'line',     label: 'LINE',     col: -2, unit: '',     requiresObd: false, abs: false, lineMode: true },
    { key: 'lat_g',    label: 'LAT G',    col: 7,  unit: 'G',    requiresObd: false, abs: true  },
    { key: 'lon_g',    label: 'LON G',    col: 8,  unit: 'G',    requiresObd: false, abs: true  },
    { key: 'combined_g', label: 'COMBINED G', col: -1, unit: 'G', requiresObd: false, abs: false, combined: true },
    { key: 'rpm',      label: 'RPM',      col: 9,  unit: 'rpm',  requiresObd: true,  abs: false },
    { key: 'throttle', label: 'THROTTLE', col: 13, unit: '%',  requiresObd: true,  abs: false },
    { key: 'coolant',  label: 'COOLANT',  col: 10, unit: '°C',   requiresObd: true,  abs: false },
    { key: 'oilTemp',  label: 'OIL TEMP', col: 11, unit: '°C',   requiresObd: true,  abs: false },
    { key: 'intake',   label: 'INTAKE',   col: 12, unit: '°C',   requiresObd: true,  abs: false },
  ];

  // 複数ラップ重ね合わせ時のラップ色（高コントラスト）
  const LAP_COLORS = [
    '#ffb000', '#4fc3f7', '#3fb950', '#f85149', '#a371f7',
    '#ff8c00', '#00d4ff', '#22e54a', '#ff3d1a', '#bd93f9',
  ];

  // 分析画面のローカル状態
  const analysis = {
    sessionId:    null,
    metric:       'speed',     // 選択中のメトリック
    selectedLaps: [],          // 表示中ラップ番号の配列
    selectedSector: 'all',     // 'all' | 1 | 2 | ... | 'fs'（区間フィルタ）
    compareSessions: [],       // 比較対象セッションIDの配列（同コースの別走行）
    map:          null,
    layers:       [],          // 描画したレイヤー配列（クリア用）
  };

  function openSessionDetail(sessionId) {
    const sessions = loadSessions();
    const s = sessions.find(x => x.id === sessionId);
    if (!s) {
      toast('Session not found');
      return;
    }
    _currentSessionId = sessionId;
    analysis.sessionId = sessionId;
    analysis.selectedSector = 'all';   // 区間選択を初期化
    analysis.compareSessions = [];     // 比較走行を初期化

    // サマリ
    document.getElementById('session-course-name').textContent = s.courseName || '--';
    document.getElementById('session-date').textContent = formatSessionDate(s.startTime);
    document.getElementById('session-lap-count').textContent = String(s.laps.length);

    const bestMs = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
      ? s.laps[s.bestLapIdx].totalMs : null;
    document.getElementById('session-best').textContent =
      bestMs ? formatTime(bestMs) : '--:--.---';

    const durSec = Math.round((s.endTime - s.startTime) / 1000);
    const hh = Math.floor(durSec / 3600);
    const mm = Math.floor((durSec % 3600) / 60);
    const ss = durSec % 60;
    document.getElementById('session-duration').textContent =
      hh > 0 ? `${hh}h${mm}m` : `${mm}m${String(ss).padStart(2, '0')}s`;

    const obdFlag = document.getElementById('session-obd-flag');
    obdFlag.querySelector('.summary-value').textContent = s.hasObdData ? 'Yes' : 'No';
    obdFlag.querySelector('.summary-value').style.color = s.hasObdData ? '#3fb950' : 'var(--fg-dim)';

    // 初期選択: ベストラップ単独。完走ラップがNoい場合は -1 = All dataを表示
    if (s.laps.length === 0) {
      analysis.selectedLaps = [-1];  // -1: All data（P2P や未完走セッション用）
    } else {
      analysis.selectedLaps = (s.bestLapIdx >= 0 && s.laps[s.bestLapIdx])
        ? [s.laps[s.bestLapIdx].number]
        : [s.laps[0].number];
    }

    // OBD データNoいセッションでは初期メトリックを speed に強制
    if (!s.hasObdData && METRICS.find(m => m.key === analysis.metric)?.requiresObd) {
      analysis.metric = 'speed';
    }

    renderMetricChips(s);
    renderSectorChips(s);
    renderCompareChips(s);
    renderLapChips(s);
    renderSessionLapList(s);

    // 再生シミュレーションを初期化（マップ生成後に drawAnalysis 経由で再構築される）
    resetPlaybackForSession();

    showScreen('session');
    // マップは画面表示後にサイズ計算する必要あり
    setTimeout(() => { initSessionMap(s); drawTimeSeriesGraph(s); }, 50);
    setTimeout(() => drawTimeSeriesGraph(s), 300);
    setTimeout(() => drawTimeSeriesGraph(s), 250);
    setTimeout(() => drawTimeSeriesGraph(s), 600);
  }

  // ── メトリック選択チップを描画 ───────────────────
  function renderMetricChips(s) {
    const wrap = document.getElementById('metric-chips');
    wrap.innerHTML = '';
    METRICS.forEach(m => {
      // OBD Noセッションでは OBD 系を非表示
      if (m.requiresObd && !s.hasObdData) return;
      const chip = document.createElement('button');
      chip.className = 'chip' + (m.key === analysis.metric ? ' active' : '');
      chip.textContent = m.label;
      chip.addEventListener('click', () => {
        analysis.metric = m.key;
        renderMetricChips(s);
        drawAnalysis(s);
        drawTimeSeriesGraph(s);
      });
      wrap.appendChild(chip);
    });
  }

  // ── セクター区間選択チップを描画 ───────────────────
  // ALL / セクター1 / セクター2 / ... / FS（最終区間）
  function renderSectorChips(s) {
    const wrap = document.getElementById('sector-chips');
    if (!wrap) return;
    wrap.innerHTML = '';

    // CSV の r[6]（区間番号）の最大値 = 区間総数
    let maxSector = 1;
    for (const r of s.rows) {
      const si = parseInt(r[6], 10);
      if (isFinite(si) && si > maxSector) maxSector = si;
    }

    const addChip = (label, value, color) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (analysis.selectedSector === value ? ' active' : '');
      chip.textContent = label;
      if (color && analysis.selectedSector === value) chip.style.borderColor = color;
      chip.addEventListener('click', () => {
        analysis.selectedSector = value;
        renderSectorChips(s);
        drawAnalysis(s);
        drawTimeSeriesGraph(s);
      });
      wrap.appendChild(chip);
    };

    addChip('ALL', 'all');
    if (maxSector >= 2) {
      // 区間1〜(maxSector-1): 番号のみ表示（計測画面の SECTOR N と統一）
      for (let i = 1; i <= maxSector; i++) {
        addChip('SECTOR ' + i, i, LAP_COLORS[(i - 1) % LAP_COLORS.length]);
      }
    } else {
      addChip('SECTOR 1', 1, LAP_COLORS[0]);
    }
  }

  // ── 比較走行チップ（同コースの別走行を日付で選択） ──────
  function renderCompareChips(s) {
    const wrap = document.getElementById('compare-chips');
    const row = document.getElementById('compare-row');
    if (!wrap) return;
    wrap.innerHTML = '';

    // 同じコースの他セッション（自分以外）を新しい順に
    const sessions = loadSessions();
    const sameCourse = sessions
      .filter(x => x.courseName === s.courseName && x.id !== s.id)
      .sort((a, b) => b.startTime - a.startTime);

    // 比較対象が無ければ丸ごと非表示
    if (sameCourse.length === 0) {
      if (row) row.style.display = 'none';
      return;
    }
    if (row) row.style.display = '';

    sameCourse.forEach((other, i) => {
      const isSel = analysis.compareSessions.includes(other.id);
      const chip = document.createElement('button');
      chip.className = 'chip' + (isSel ? ' active' : '');
      // 日付（M/D HH:MM）でラベル
      const d = new Date(other.startTime);
      const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      chip.textContent = label;
      // 比較走行の色（メインと被らないようオフセット）
      const cmpColor = LAP_COLORS[(i + 3) % LAP_COLORS.length];
      if (isSel) chip.style.borderColor = cmpColor;
      chip.addEventListener('click', () => {
        const idx = analysis.compareSessions.indexOf(other.id);
        if (idx >= 0) analysis.compareSessions.splice(idx, 1);
        else analysis.compareSessions.push(other.id);
        renderCompareChips(s);
        drawAnalysis(s);
        drawTimeSeriesGraph(s);
      });
      wrap.appendChild(chip);
    });
  }


  function drawTimeSeriesGraph(s) {
    const canvas = document.getElementById('analysis-graph');
    if (!canvas) return;
    const metricDef = METRICS.find(m => m.key === analysis.metric);
    if (!metricDef) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // レイアウト未確定で幅が取れない時はスキップ（後続の再描画に任せる）
    if (rect.width < 50) return;
    const W = Math.max(rect.width, 100);
    const H = Math.max(rect.height, 80);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1018';
    ctx.fillRect(0, 0, W, H);

    // ライン取り比較モードはグラフ非対象 → 案内表示
    if (metricDef.lineMode) {
      ctx.fillStyle = '#5a6472';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Comparing racing lines on the map', W / 2, H / 2);
      return;
    }

    const padL = 38, padR = 10, padT = 14, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const laps = (analysis.selectedLaps.length > 0) ? analysis.selectedLaps : [-1];

    // 各シリーズ: vals(値) + times(スタートからの経過秒)。経過時間はシリーズ先頭を 0 とする
    const buildSeries = (sess, lapNum) => {
      const pts = extractLapPoints(sess, lapNum, metricDef.col, analysis.selectedSector);
      let t0 = null;
      const vals = [], times = [];
      pts.forEach(p => {
        const tv = (p.t != null && isFinite(p.t)) ? p.t : null;
        if (t0 === null && tv != null) t0 = tv;
        times.push((tv != null && t0 != null) ? (tv - t0) / 1000 : null);
        vals.push((p.v == null || !isFinite(p.v)) ? null : (metricDef.abs ? Math.abs(p.v) : p.v));
      });
      return { vals, times };
    };

    const series = [];
    let vMin = Infinity, vMax = -Infinity;
    let tMaxAll = 0;
    laps.forEach(lapNum => {
      const { vals, times } = buildSeries(s, lapNum);
      vals.forEach(v => { if (v != null) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; } });
      times.forEach(t => { if (t != null && t > tMaxAll) tMaxAll = t; });
      series.push({ color: LAP_COLORS[(lapNum === -1 ? 1 : (lapNum - 1)) % LAP_COLORS.length], vals, times });
    });

    // 比較走行（同コースの別走行）を折れ線で重ねる
    if (analysis.compareSessions.length > 0 && !metricDef.requiresObd) {
      const sessions = loadSessions();
      const sameCourse = sessions
        .filter(x => x.courseName === s.courseName && x.id !== s.id)
        .sort((a, b) => b.startTime - a.startTime);
      analysis.compareSessions.forEach(cmpId => {
        const cmp = sessions.find(x => x.id === cmpId);
        if (!cmp) return;
        const ci = sameCourse.findIndex(x => x.id === cmpId);
        const color = LAP_COLORS[(ci + 3) % LAP_COLORS.length];
        const { vals, times } = buildSeries(cmp, -1);
        vals.forEach(v => { if (v != null) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; } });
        times.forEach(t => { if (t != null && t > tMaxAll) tMaxAll = t; });
        series.push({ color, vals, times, dashed: true });
      });
    }

    if (!isFinite(vMin) || !isFinite(vMax)) {
      ctx.fillStyle = '#5a6472';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }
    if (vMin === vMax) { vMin -= 1; vMax += 1; }
    const padv = (vMax - vMin) * 0.1;
    vMin -= padv; vMax += padv;
    const vSpan = vMax - vMin;

    ctx.strokeStyle = '#1c2230';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a6472';
    ctx.font = '10px "IBM Plex Mono",monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = padT + (plotH * i / yTicks);
      const val = vMax - (vSpan * i / yTicks);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(val.toFixed(val >= 100 ? 0 : 1), padL - 4, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#7a8499';
    ctx.fillText(metricDef.unit, 2, 2);

    // ── X 軸（スタートからの経過時間）────────────────
    const hasTime = tMaxAll > 0;
    const fmtElapsed = (sec) => {
      if (tMaxAll >= 60) {
        const m = Math.floor(sec / 60);
        const ss = Math.round(sec % 60);
        return `${m}:${String(ss).padStart(2, '0')}`;
      }
      return (sec % 1 === 0 ? sec.toFixed(0) : sec.toFixed(1)) + 's';
    };
    if (hasTime) {
      // 目盛り間隔: 約 4〜6 本になるキリの良い秒数を選択
      const NICE = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
      let step = NICE[NICE.length - 1];
      for (const st of NICE) { if (tMaxAll / st <= 6) { step = st; break; } }
      ctx.strokeStyle = '#1c2230';
      ctx.fillStyle = '#5a6472';
      ctx.font = '10px "IBM Plex Mono",monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let t = 0; t <= tMaxAll + 1e-6; t += step) {
        const x = padL + plotW * (t / tMaxAll);
        if (x > W - padR + 1) break;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        // 端のラベルがはみ出さないよう揃えを調整
        ctx.textAlign = (t === 0) ? 'left' : ((tMaxAll - t) < step * 0.5 ? 'right' : 'center');
        ctx.fillText(fmtElapsed(t), x, padT + plotH + 4);
      }
      // 軸ラベル
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7a8499';
      ctx.fillText('TIME', W - padR, 2);
    }

    series.forEach(({ color, vals, times, dashed }) => {
      const n = vals.length;
      if (n < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      let started = false;
      vals.forEach((v, i) => {
        if (v == null) { started = false; return; }
        // 経過時間が取れる場合は時間軸、Noい場合はインデックス軸にフォールバック
        const tv = times ? times[i] : null;
        const x = (hasTime && tv != null)
          ? padL + plotW * (tv / tMaxAll)
          : padL + (plotW * i / (n - 1));
        const y = padT + plotH * (1 - (v - vMin) / vSpan);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // ── ラップ選択チップを描画 ───────────────────────
  function renderLapChips(s) {
    const wrap = document.getElementById('lap-chips');
    wrap.innerHTML = '';

    // 完走ラップが無い場合: 「All data」チップのみ
    if (s.laps.length === 0) {
      const chip = document.createElement('button');
      chip.className = 'chip active';
      chip.textContent = 'All data';
      wrap.appendChild(chip);
      return;
    }

    s.laps.forEach((lap, i) => {
      const isBest = (i === s.bestLapIdx);
      const isSelected = analysis.selectedLaps.includes(lap.number);
      const chip = document.createElement('button');
      chip.className = 'chip' +
        (isSelected ? ' active' : '') +
        (isBest ? ' lap-best' : '');
      chip.textContent = `L${lap.number}` + (isBest ? '★' : '');
      chip.addEventListener('click', () => {
        const idx = analysis.selectedLaps.indexOf(lap.number);
        if (idx >= 0) analysis.selectedLaps.splice(idx, 1);
        else          analysis.selectedLaps.push(lap.number);
        if (analysis.selectedLaps.length === 0) analysis.selectedLaps.push(lap.number);
        renderLapChips(s);
        renderSessionLapList(s);
        drawAnalysis(s);
        drawTimeSeriesGraph(s);
      });
      wrap.appendChild(chip);
    });
  }

  // ── 凡例（カラースケール）の更新 ───────────────────
  function updateLegend(min, max, unit) {
    const fmt = (v) => {
      if (!isFinite(v)) return '--';
      const abs = Math.abs(v);
      if (abs >= 100)  return Math.round(v).toString();
      if (abs >= 10)   return v.toFixed(1);
      return v.toFixed(2);
    };
    document.getElementById('legend-min').textContent = fmt(min) + unit;
    document.getElementById('legend-max').textContent = fmt(max) + unit;

    // 複数ラップ選択中は凡例グラデーションを薄くしてラップ色を強調
    const legendRow = document.getElementById('legend-row');
    const isMulti = analysis.selectedLaps.length > 1;
    legendRow.style.opacity = isMulti ? '0.35' : '1';
  }

  // ── マップ初期化 ───────────────────────────────────
  function initSessionMap(s) {
    const mapEl = document.getElementById('session-map');
    const emptyEl = document.getElementById('session-map-empty');

    // 既存マップは破棄
    if (analysis.map) {
      try { analysis.map.remove(); } catch (_) {}
      analysis.map = null;
      analysis.layers = [];
    }

    // GPS データがあるか確認
    const validRows = s.rows.filter(r =>
      isFinite(parseFloat(r[1])) && isFinite(parseFloat(r[2])));
    if (validRows.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    // 中心位置・範囲を計算
    const lats = validRows.map(r => parseFloat(r[1]));
    const lons = validRows.map(r => parseFloat(r[2]));
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);

    analysis.map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(analysis.map);

    // 境界 fit
    analysis.map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });

    drawAnalysis(s);
  }

  // ── メイン描画ロジック ─────────────────────────────
  function drawAnalysis(s) {
    if (!analysis.map) return;
    // 既存レイヤー削除
    analysis.layers.forEach(l => analysis.map.removeLayer(l));
    analysis.layers = [];

    const isMulti = analysis.selectedLaps.length > 1;
    const metricDef = METRICS.find(m => m.key === analysis.metric);

    if (metricDef && metricDef.lineMode) {
      // ── ライン取り比較モード: メイン走行を単色ソリッドで描画 ──
      const mainLap = analysis.selectedLaps.length === 1 ? analysis.selectedLaps[0] : -1;
      const mainPts = extractLapPoints(s, mainLap, 4, analysis.selectedSector);
      if (mainPts.length >= 2) {
        const line = L.polyline(mainPts.map(p => [p.lat, p.lon]), {
          color: '#00d4ff', weight: 4, opacity: 0.95, lineJoin: 'round', lineCap: 'round',
        }).addTo(analysis.map);
        analysis.layers.push(line);
        // 始点(緑)・終点(赤)マーカー
        const sp = mainPts[0], ep = mainPts[mainPts.length - 1];
        analysis.layers.push(L.circleMarker([sp.lat, sp.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#22e54a', fillOpacity: 1 }).addTo(analysis.map));
        analysis.layers.push(L.circleMarker([ep.lat, ep.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#ff3b30', fillOpacity: 1 }).addTo(analysis.map));
      }
      updateLegendLineMode();
    } else if (isMulti) {
      // 複数ラップ: 各ラップを別色でベタ塗り
      analysis.selectedLaps.forEach(lapNum => {
        const colorIdx = (lapNum - 1) % LAP_COLORS.length;
        const color = LAP_COLORS[colorIdx];
        drawLapSolid(s, lapNum, color);
      });
      // 凡例ダミー: メトリック範囲だけは出しておく
      const range = computeMetricRange(s, analysis.selectedLaps, metricDef);
      updateLegend(range.min, range.max, metricDef.unit);
    } else if (analysis.selectedLaps.length === 1) {
      // 単独ラップ: グラデーション着色
      const lapNum = analysis.selectedLaps[0];
      const range = computeMetricRange(s, [lapNum], metricDef);
      drawLapGradient(s, lapNum, metricDef, range);
      updateLegend(range.min, range.max, metricDef.unit);
    }

    // ── 比較走行（同コースの別走行）を別色で重ねる ──
    if (analysis.compareSessions.length > 0) {
      const isLineMode = metricDef && metricDef.lineMode;
      const sessions = loadSessions();
      const sameCourse = sessions
        .filter(x => x.courseName === s.courseName && x.id !== s.id)
        .sort((a, b) => b.startTime - a.startTime);
      analysis.compareSessions.forEach(cmpId => {
        const cmp = sessions.find(x => x.id === cmpId);
        if (!cmp) return;
        const i = sameCourse.findIndex(x => x.id === cmpId);
        const color = LAP_COLORS[(i + 3) % LAP_COLORS.length];
        const pts = extractLapPoints(cmp, -1, 4, analysis.selectedSector);
        if (pts.length >= 2) {
          const latlngs = pts.map(p => [p.lat, p.lon]);
          const line = L.polyline(latlngs, {
            color,
            weight: isLineMode ? 3.5 : 3,
            opacity: isLineMode ? 0.9 : 0.75,
            lineJoin: 'round', lineCap: 'round',
          }).addTo(analysis.map);
          analysis.layers.push(line);
        }
      });
    }

    // ── 再生シミュレーションのトラック・ドットを再構築 ──
    // (マップ再生成・ラップ/区間/指標チップ変更のすべてがここを通る)
    rebuildPlayback(s);
  }

  // ライン取りモード用の凡例（走行の色対応を表示）
  function updateLegendLineMode() {
    const grad = document.getElementById('legend-gradient');
    const minEl = document.getElementById('legend-min');
    const maxEl = document.getElementById('legend-max');
    if (grad) grad.style.background = 'linear-gradient(90deg,#00d4ff,#00d4ff)';
    if (minEl) minEl.textContent = 'This run';
    if (maxEl) maxEl.textContent = (analysis.compareSessions.length > 0) ? '+ comparison' : '';
  }

  // ラップ行をフィルタ + lat/lon/value 抽出
  // lapNum === -1 で「全行」を返す（P2P / 未完走セッション用）
  // metricCol: 通常は列番号。-1 = 合成G（横G・前後Gから計算）
  // sectorFilter: 'all' | 数値（区間番号 r[6]）で区間フィルタ
  function extractLapPoints(s, lapNum, metricCol, sectorFilter) {
    const pts = [];
    const isAll = (lapNum === -1);
    // state.lapNumber は finalizeLap 後に +1 されるため
    // ラップ N の走行行は r[5] = N-1 で記録されている
    const rowLap = isAll ? -1 : (lapNum - 1);
    const secF = (sectorFilter == null || sectorFilter === 'all') ? null : sectorFilter;
    const isCombined = (metricCol === -1);
    for (const r of s.rows) {
      if (!isAll && parseInt(r[5], 10) !== rowLap) continue;
      // セクター区間フィルタ（r[6] = currentSectorIdx + 1）
      if (secF != null && parseInt(r[6], 10) !== secF) continue;
      const lat = parseFloat(r[1]);
      const lon = parseFloat(r[2]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      let v;
      if (isCombined) {
        // 合成G = √(横G² + 前後G²)
        const lg = parseFloat(r[7]), fg = parseFloat(r[8]);
        v = (isFinite(lg) && isFinite(fg)) ? Math.sqrt(lg * lg + fg * fg) : null;
      } else {
        const rawV = r[metricCol];
        v = (rawV === '' || rawV == null) ? null : parseFloat(rawV);
      }
      // タイムスタンプ (r[0] = ISO 文字列) — 時間軸グラフ & 再生シミュレーション用
      const t = Date.parse(r[0]);
      pts.push({ lat, lon, v, t: isFinite(t) ? t : null });
    }
    return pts;
  }

  function computeMetricRange(s, lapNums, metricDef) {
    let min = Infinity, max = -Infinity;
    for (const lapNum of lapNums) {
      const pts = extractLapPoints(s, lapNum, metricDef.col, analysis.selectedSector);
      for (const p of pts) {
        if (p.v == null || !isFinite(p.v)) continue;
        const v = metricDef.abs ? Math.abs(p.v) : p.v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min) || !isFinite(max) || min === max) {
      return { min: 0, max: 1 };
    }
    return { min, max };
  }

  // 値 → 色 (0..1 を blue→cyan→green→yellow→red にマッピング)
  function metricColor(t) {
    t = Math.max(0, Math.min(1, t));
    // 5 ストップ補間
    const stops = [
      [0.00, [44, 127, 255]],
      [0.25, [0, 212, 255]],
      [0.50, [0, 255, 127]],
      [0.75, [255, 210, 0]],
      [1.00, [255, 61, 26]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const k = (t - t0) / (t1 - t0);
        const r = Math.round(c0[0] + (c1[0] - c0[0]) * k);
        const g = Math.round(c0[1] + (c1[1] - c0[1]) * k);
        const b = Math.round(c0[2] + (c1[2] - c0[2]) * k);
        return `rgb(${r},${g},${b})`;
      }
    }
    return 'rgb(255,255,255)';
  }

  // 単一ラップをグラデーション着色（小区間ごとに色を変える）
  function drawLapGradient(s, lapNum, metricDef, range) {
    const pts = extractLapPoints(s, lapNum, metricDef.col, analysis.selectedSector);
    if (pts.length < 2) return;
    const span = (range.max - range.min) || 1;

    // 各セグメントを個別 polyline として追加（短いので軽い）
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      // 区間値: 平均
      let vA = a.v, vB = b.v;
      if (metricDef.abs) {
        if (vA != null) vA = Math.abs(vA);
        if (vB != null) vB = Math.abs(vB);
      }
      let v = null;
      if (vA != null && vB != null) v = (vA + vB) / 2;
      else if (vA != null) v = vA;
      else if (vB != null) v = vB;

      const color = (v == null) ? '#6a6f7c' : metricColor((v - range.min) / span);

      const seg = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color, weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
      }).addTo(analysis.map);
      analysis.layers.push(seg);
    }
  }

  // 複数ラップ: 単色 polyline
  function drawLapSolid(s, lapNum, color) {
    const pts = extractLapPoints(s, lapNum, 4, analysis.selectedSector);
    if (pts.length < 2) return;
    const latlngs = pts.map(p => [p.lat, p.lon]);
    const line = L.polyline(latlngs, {
      color, weight: 3.5, opacity: 0.78, lineJoin: 'round',
    }).addTo(analysis.map);
    analysis.layers.push(line);
  }

  // ============================================================
  // PLAYBACK SIMULATION (走行再生シミュレーション)
  //   ・選択中ラップの軌跡を、記録タイムスタンプに忠実な速度でドット再生
  //   ・音楽プレイヤー風 UI: 再生/一時停止・停止・シークバー・再生速度
  //   ・BEST トグルで「同コースのベスト記録」をゴーストドットとして同時再生
  // ============================================================
  const playback = {
    track: [],        // メイン走行 [{lat,lon,t(相対ms),v(km/h)}]
    ghostTrack: [],   // ベスト記録 (ゴースト)
    ghostInfo: null,  // {totalMs, dateLabel, lapNumber, isSelf}
    duration: 0,      // 再生総時間 ms
    simTime: 0,       // 現在の再生位置 ms
    playing: false,
    speed: 1,
    speedSteps: [1, 2, 4, 8, 0.5],
    ghostOn: false,
    marker: null,
    ghostMarker: null,
    raf: null,
    lastTs: 0,
    mainLapNum: -1,
    seeking: false,   // シークバーをドラッグ中（rAF によるバー上書きを抑止）
  };

  // 経過時間 ms → "m:ss.d" 表示
  function fmtPlayClock(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = totalSec - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  // セッション + ラップ番号 → 再生トラック（先頭を t=0 に正規化）
  function buildTrackPoints(sess, lapNum, sectorFilter) {
    const pts = extractLapPoints(sess, lapNum, 4, sectorFilter);
    const out = [];
    let t0 = null;
    for (const p of pts) {
      if (p.t == null || !isFinite(p.t)) continue;
      if (t0 === null) t0 = p.t;
      const t = p.t - t0;
      // タイムスタンプ逆行（GPS 補正等）はスキップ
      if (out.length > 0 && t <= out[out.length - 1].t) continue;
      out.push({ lat: p.lat, lon: p.lon, t, v: p.v });
    }
    return out;
  }

  // 同コース全セッション中のベストラップ（= Best Record）を検索
  function findBestRecord(s) {
    const sessions = loadSessions();
    let best = null;
    sessions
      .filter(x => x.courseName === s.courseName)
      .forEach(sess => {
        sess.laps.forEach(lap => {
          if (best === null || lap.totalMs < best.totalMs) {
            best = { session: sess, lapNumber: lap.number, totalMs: lap.totalMs };
          }
        });
      });
    if (best) {
      const d = new Date(best.session.startTime);
      best.dateLabel = `${d.getMonth() + 1}/${d.getDate()}`;
      best.isSelf = (best.session.id === s.id);
    }
    return best;
  }

  // 時刻 t(ms) におけるトラック上の補間位置 {lat,lon,v} を返す
  function posAtTime(track, t) {
    const n = track.length;
    if (n === 0) return null;
    if (t <= track[0].t) return track[0];
    if (t >= track[n - 1].t) return track[n - 1];
    // 二分探索: track[lo].t <= t < track[lo+1].t
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = track[lo], b = track[lo + 1];
    const k = (t - a.t) / (b.t - a.t || 1);
    return {
      lat: a.lat + (b.lat - a.lat) * k,
      lon: a.lon + (b.lon - a.lon) * k,
      v: (a.v != null && b.v != null) ? a.v + (b.v - a.v) * k : (a.v != null ? a.v : b.v),
    };
  }

  function clearPlaybackMarkers() {
    if (analysis.map) {
      if (playback.marker)      { try { analysis.map.removeLayer(playback.marker); } catch (_) {} }
      if (playback.ghostMarker) { try { analysis.map.removeLayer(playback.ghostMarker); } catch (_) {} }
    }
    playback.marker = null;
    playback.ghostMarker = null;
  }

  // トラック再構築（ラップ・区間変更 / マップ再生成 / BEST トグル時）
  function rebuildPlayback(s) {
    const wasPlaying = playback.playing;
    pbPause();
    clearPlaybackMarkers();

    const lapNum = (analysis.selectedLaps.length > 0) ? analysis.selectedLaps[0] : -1;
    playback.mainLapNum = lapNum;
    playback.track = buildTrackPoints(s, lapNum, analysis.selectedSector);

    playback.ghostTrack = [];
    playback.ghostInfo = null;
    if (playback.ghostOn) {
      const best = findBestRecord(s);
      if (best) {
        playback.ghostTrack = buildTrackPoints(best.session, best.lapNumber, analysis.selectedSector);
        playback.ghostInfo = best;
      }
    }

    playback.duration = Math.max(
      playback.track.length     ? playback.track[playback.track.length - 1].t         : 0,
      playback.ghostTrack.length ? playback.ghostTrack[playback.ghostTrack.length - 1].t : 0
    );
    playback.simTime = Math.min(playback.simTime, playback.duration);

    // 再生可能データがNoければバーごと非表示
    const bar = document.getElementById('playback-bar');
    if (bar) bar.style.display = (playback.track.length >= 2) ? '' : 'none';

    renderPlaybackFrame();
    if (wasPlaying && playback.duration > 0 && playback.simTime < playback.duration) pbPlay();
  }

  // 現在の simTime に応じてドット位置 + UI を更新
  function renderPlaybackFrame() {
    const curEl = document.getElementById('pb-cur');
    const totEl = document.getElementById('pb-total');
    const seekEl = document.getElementById('pb-seek');
    const infoEl = document.getElementById('pb-info');
    if (curEl) curEl.textContent = fmtPlayClock(playback.simTime);
    if (totEl) totEl.textContent = fmtPlayClock(playback.duration);
    if (seekEl && playback.duration > 0 && !playback.seeking) {
      seekEl.value = String(Math.round(playback.simTime / playback.duration * 1000));
    }

    const infoParts = [];

    if (analysis.map && playback.track.length >= 2) {
      const p = posAtTime(playback.track, playback.simTime);
      if (p) {
        if (!playback.marker) {
          playback.marker = L.circleMarker([p.lat, p.lon], {
            radius: 8, color: '#fff', weight: 2,
            fillColor: '#ff3d1a', fillOpacity: 1,
          }).addTo(analysis.map);
        } else {
          playback.marker.setLatLng([p.lat, p.lon]);
        }
        const lapLabel = (playback.mainLapNum === -1) ? 'All data' : `L${playback.mainLapNum}`;
        infoParts.push(`<span class="pb-dot-main">●</span> ${lapLabel} ${p.v != null ? p.v.toFixed(1) + ' km/h' : '--'}`);
      }
    }

    if (analysis.map && playback.ghostOn && playback.ghostTrack.length >= 2) {
      const g = posAtTime(playback.ghostTrack, playback.simTime);
      if (g) {
        if (!playback.ghostMarker) {
          playback.ghostMarker = L.circleMarker([g.lat, g.lon], {
            radius: 8, color: '#fff', weight: 2,
            fillColor: '#4fc3f7', fillOpacity: 0.92,
          }).addTo(analysis.map);
        } else {
          playback.ghostMarker.setLatLng([g.lat, g.lon]);
        }
        const bi = playback.ghostInfo;
        const label = bi
          ? `BEST ${formatTime(bi.totalMs)} (${bi.dateLabel}${bi.isSelf ? ' · this run' : ''})`
          : 'BEST';
        infoParts.push(`<span class="pb-dot-ghost">●</span> ${label} ${g.v != null ? g.v.toFixed(1) + ' km/h' : '--'}`);
      }
    }

    if (infoEl) infoEl.innerHTML = infoParts.join('<span style="color:var(--fg-faint)">｜</span>');
  }

  // ── 再生ループ（requestAnimationFrame）────────────
  function pbTick(ts) {
    if (!playback.playing) return;
    const dt = ts - playback.lastTs;
    playback.lastTs = ts;
    playback.simTime += dt * playback.speed;
    if (playback.simTime >= playback.duration) {
      playback.simTime = playback.duration;
      pbPause();   // 終端で自動停止（位置は終端のまま）
    }
    renderPlaybackFrame();
    if (playback.playing) playback.raf = requestAnimationFrame(pbTick);
  }

  function pbPlay() {
    if (playback.duration <= 0 || playback.track.length < 2) return;
    // 終端から再生 → 先頭に巻き戻してリスタート
    if (playback.simTime >= playback.duration) playback.simTime = 0;
    playback.playing = true;
    playback.lastTs = performance.now();
    const btn = document.getElementById('pb-play');
    if (btn) btn.textContent = '❚❚';
    playback.raf = requestAnimationFrame(pbTick);
  }

  function pbPause() {
    playback.playing = false;
    if (playback.raf) { cancelAnimationFrame(playback.raf); playback.raf = null; }
    const btn = document.getElementById('pb-play');
    if (btn) btn.textContent = '▶';
  }

  function pbStop() {
    pbPause();
    playback.simTime = 0;
    renderPlaybackFrame();
  }

  // セッション画面を開いた時の初期化（openSessionDetail から呼ぶ）
  function resetPlaybackForSession() {
    pbPause();
    clearPlaybackMarkers();
    playback.simTime = 0;
    playback.track = [];
    playback.ghostTrack = [];
    playback.ghostInfo = null;
    playback.duration = 0;
    // ghostOn / speed はユーザー設定としてセッション間で維持
    const bar = document.getElementById('playback-bar');
    if (bar) bar.style.display = 'none';   // rebuildPlayback で再表示判定
    const ghostBtn = document.getElementById('pb-ghost');
    if (ghostBtn) ghostBtn.classList.toggle('active', playback.ghostOn);
    renderPlaybackFrame();
  }

  // ── 再生 UI イベント ──────────────────────────────
  (function bindPlaybackUI() {
    const play  = document.getElementById('pb-play');
    const stop  = document.getElementById('pb-stop');
    const seek  = document.getElementById('pb-seek');
    const speed = document.getElementById('pb-speed');
    const ghost = document.getElementById('pb-ghost');
    if (!play) return;   // 画面未ロード時ガード

    play.addEventListener('click', () => {
      if (playback.playing) pbPause();
      else pbPlay();
    });

    stop.addEventListener('click', pbStop);

    // シークバー: ドラッグ位置にジャンプ（再生中ならそのまま続行）
    const seekStart = () => { playback.seeking = true; };
    const seekEnd   = () => { playback.seeking = false; };
    seek.addEventListener('pointerdown', seekStart);
    seek.addEventListener('pointerup', seekEnd);
    seek.addEventListener('pointercancel', seekEnd);
    seek.addEventListener('touchstart', seekStart, { passive: true });
    seek.addEventListener('touchend', seekEnd);
    seek.addEventListener('input', () => {
      if (playback.duration <= 0) return;
      playback.simTime = (parseInt(seek.value, 10) / 1000) * playback.duration;
      playback.lastTs = performance.now();   // ジャンプ直後のフレーム飛び防止
      renderPlaybackFrame();
    });

    // 再生速度: ×1 → ×2 → ×4 → ×8 → ×0.5 → ×1 ...
    speed.addEventListener('click', () => {
      const i = playback.speedSteps.indexOf(playback.speed);
      playback.speed = playback.speedSteps[(i + 1) % playback.speedSteps.length];
      speed.textContent = '×' + (playback.speed === 0.5 ? '0.5' : playback.speed);
    });

    // BEST ゴースト比較トグル
    ghost.addEventListener('click', () => {
      const s = loadSessions().find(x => x.id === analysis.sessionId);
      if (!s) return;
      if (!playback.ghostOn) {
        const best = findBestRecord(s);
        if (!best) { toast('No best lap for this course'); return; }
        playback.ghostOn = true;
        if (best.isSelf && best.lapNumber === playback.mainLapNum) {
          toast('The playing lap is the best lap');
        }
      } else {
        playback.ghostOn = false;
      }
      ghost.classList.toggle('active', playback.ghostOn);
      rebuildPlayback(s);
    });
  })();

  // ── ラップタイム一覧（選択中ラップ強調 + 色マーカー）─────
  function renderSessionLapList(s) {
    const listEl = document.getElementById('session-lap-list');
    listEl.innerHTML = '';

    if (s.laps.length === 0) {
      listEl.innerHTML = '<div class="splits-empty" style="padding:18px;text-align:center;color:var(--fg-faint);line-height:1.7">No completed laps<br><span style="font-size:11px;opacity:0.7">P2P or incomplete — showing full track data on the map</span></div>';
      return;
    }

    const isMulti = analysis.selectedLaps.length > 1;

    s.laps.forEach((lap, i) => {
      const isBest = (i === s.bestLapIdx);
      const isSelected = analysis.selectedLaps.includes(lap.number);
      const splitsTxt = (lap.splits && lap.splits.length > 0)
        ? lap.splits.map(sp => formatTime(sp.splitMs)).join(' · ')
        : '';
      const colorIdx = (lap.number - 1) % LAP_COLORS.length;
      const colorDot = (isMulti && isSelected)
        ? `<span class="lap-row-color" style="background:${LAP_COLORS[colorIdx]}"></span>`
        : '';

      const row = document.createElement('div');
      row.className = 'lap-row' + (isBest ? ' best' : '') +
        ((isMulti && isSelected) ? ' selected-multi' : '');
      row.innerHTML = `
        <div class="lap-row-num">${colorDot}L${lap.number}${isBest ? '<span class="badge">BEST</span>' : ''}</div>
        <div class="lap-row-time">${formatTime(lap.totalMs)}</div>
        <div class="lap-row-splits">${splitsTxt}</div>
      `;
      listEl.appendChild(row);
    });
  }

  // History/Session: ナビゲーション
  document.getElementById('btn-open-history').addEventListener('click', openHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('home'));
  document.getElementById('btn-session-back').addEventListener('click', () => {
    // 再生シミュレーションを停止
    pbPause();
    playback.marker = null;
    playback.ghostMarker = null;
    // マップリソースを解放
    if (analysis.map) {
      try { analysis.map.remove(); } catch (_) {}
      analysis.map = null;
      analysis.layers = [];
    }
    showScreen('history');
  });

  // グラフ canvas のサイズ変化を監視して再描画
  (function () {
    const gc = document.getElementById('analysis-graph');
    if (gc && typeof ResizeObserver !== 'undefined') {
      let _t = null;
      new ResizeObserver(() => {
        clearTimeout(_t);
        _t = setTimeout(() => {
          if (!analysis.sessionId) return;
          const sess = loadSessions().find(x => x.id === analysis.sessionId);
          if (sess) drawTimeSeriesGraph(sess);
        }, 60);
      }).observe(gc);
    }
  })();

  // CSV エクスポート
  document.getElementById('btn-session-export').addEventListener('click', () => {
    if (!_currentSessionId) return;
    const s = loadSessions().find(x => x.id === _currentSessionId);
    if (!s) { toast('Session not found'); return; }
    const header = [
      'ISO_TIME', 'LAT', 'LON', 'ACC_M', 'SPEED_KMH',
      'LAP', 'SECTOR', 'G_LAT', 'G_LON',
      'RPM', 'COOLANT_C', 'OIL_TEMP_C', 'INTAKE_C', 'THROTTLE_PCT',
      'BOOST_KGCM2', 'MAP_KPA', 'GEAR',
    ];
    const lines = [header.join(',')].concat(s.rows.map(r => r.join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const stamp = new Date(s.startTime).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wadachi_${(s.courseName || 'session').replace(/\s+/g, '_')}_${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`CSV exported: ${s.rows.length} rows`);
  });

  // セッション削除
  document.getElementById('btn-session-delete').addEventListener('click', () => {
    if (!_currentSessionId) return;
    if (!confirm('Delete this session?')) return;
    deleteSession(_currentSessionId);
    _currentSessionId = null;
    toast('Session deleted');
    showScreen('history');
    renderHistoryList();
  });

  // ============================================================
  // OBD2 PID ポーリング & パース (Phase 2)
  // ============================================================
  // 設定された PID を「高速」「低速」に振り分け、高速は毎サイクル送信、
  // 低速はラウンドロビンで1つずつ送信する
  // ── 高速: RPM (動きの激しい値、高頻度で必要)
  // ── 低速: 水温 / 油温 / 吸気温 / スロットル (値の変化が緩やか)
  let ACTIVE_PIDS_FAST = [];
  let ACTIVE_PIDS_SLOW = [];
  let _slowIdx = 0;

  // ELM327 のエラー応答キーワード
  const OBD_NOISE = ['NODATA', 'ERROR', 'UNABLE', 'SEARCHING', 'STOPPED', 'BUSBUSY'];

  // ポーリング状態
  const pollState = {
    active:   false,
    pidQueue: [],
    curPid:   '',
    buf:      '',
    waiting:  false,
  };
  let _pollTimer    = null;
  let _timeoutTimer = null;

  function recomputeActivePids() {
    const pids = state.settings.pids;
    // GT_DASH と完全一致: 標準 Mode 01 PIDs のみ使用
    // (UniCarScan 2000 は Mode 22 を完全サポートしないため)
    const fast = new Set();
    const slow = new Set();
    fast.add('010C');                                  // RPM は GT_DASH と同じく常時 FAST
    if (pids.coolant)  slow.add('0105');
    if (pids.oiltemp)  slow.add('015C');
    if (pids.intake)   slow.add('010F');
    if (pids.throttle) slow.add('0111');
    // 横画面ダッシュボード用 PID
    const dash = state.settings.dash || {};
    if (dash.enabled && dash.showBoost) slow.add('010B');          // MAP → ブーストバー
    if (dash.enabled && dash.gearSource === 'obd') fast.add('010D'); // 車速 → ギア検出
    ACTIVE_PIDS_FAST = [...fast];
    ACTIVE_PIDS_SLOW = [...slow];
    _slowIdx = 0;
    // GT_DASH と同じ: キューリセット時に waiting / タイムアウト / lastDataAt も同時リセット
    // → ウォッチドッグの誤検知を防ぐ
    pollState.pidQueue = [];
    pollState.waiting  = false;
    pollState.buf      = '';
    clearTimeout(_timeoutTimer);
    _consecutiveTimeouts = 0;
    _lastDataAt = Date.now();
    dbg('[PID] fast=' + JSON.stringify(ACTIVE_PIDS_FAST) + ' slow=' + JSON.stringify(ACTIVE_PIDS_SLOW));
  }

  function nextPids() {
    // GT_DASH と同じ: FAST PIDs + SLOW PIDs 1 個ずつローテーション
    const pids = [...ACTIVE_PIDS_FAST];
    if (ACTIVE_PIDS_SLOW.length > 0) {
      pids.push(ACTIVE_PIDS_SLOW[_slowIdx % ACTIVE_PIDS_SLOW.length]);
      _slowIdx++;
    }
    return pids;
  }

  // 100ms 間隔で 1 PID 送信。応答待ち中は何もしない
  // (元は GT_DASH と同じ 50ms。BMW Mini のバス混雑回避のため緩めて検証中)
  function bleStartPolling() {
    recomputeActivePids();
    pollState.active   = true;
    pollState.pidQueue = nextPids();
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (!pollState.active || !state.obd.connected) {
        clearInterval(_pollTimer);
        _pollTimer = null;
        return;
      }
      if (pollState.waiting) return;
      if (!pollState.pidQueue.length) pollState.pidQueue = nextPids();
      if (!pollState.pidQueue.length) return;
      pollState.curPid  = pollState.pidQueue.shift();
      pollState.waiting = true;
      bleSend(pollState.curPid);
      _timeoutTimer = setTimeout(() => {
        pollState.buf     = '';
        pollState.waiting = false;
        _consecutiveTimeouts++;
        dbg('[TIMEOUT] pid=' + pollState.curPid + ' count=' + _consecutiveTimeouts);
      }, 500);
    }, 100);   // ← 50ms → 100ms (BMW bus 混雑回避)
  }

  function bleStopPolling() {
    pollState.active  = false;
    pollState.buf     = '';
    pollState.waiting = false;
    if (_pollTimer)    { clearInterval(_pollTimer);    _pollTimer = null; }
    if (_timeoutTimer) { clearTimeout(_timeoutTimer);  _timeoutTimer = null; }
  }

  // ════════════════════════════════════════════════════════
  // notify ハンドラ — GT_DASH の onData を丸ごと移植 (動作実績あるコード)
  // ════════════════════════════════════════════════════════
  function bleOnData(event) {
    try {
      pollState.buf += new TextDecoder().decode(event.target.value);
    } catch (_) { return; }
    // buf 肥大化ガード: 512 byte 超えたら破棄してリセット
    if (pollState.buf.length > 512) {
      dbg('[BUF] overflow → clear');
      pollState.buf = '';
      pollState.waiting = false;
      return;
    }
    if (!pollState.buf.includes('>') &&
        pollState.buf.split('\r').filter(x => x.trim()).length < 1) return;
    clearTimeout(_timeoutTimer);
    const r = pollState.buf;
    pollState.buf = '';
    pollState.waiting = false;
    _consecutiveTimeouts = 0;
    _lastDataAt = Date.now();
    if (!state.obd.connected) return;

    // デバッグカウンタ
    _dbgRxCount++;
    const elRaw = document.getElementById('dbg-raw');
    if (elRaw) elRaw.textContent = r.replace(/[\r\n]/g, '↵').slice(0, 40);

    const lines = r.split('\r')
      .map(l => l.replace(/[\n>]/g, '').trim())
      .filter(l => l.length > 3);
    const pid = pollState.curPid;
    dbg('[' + pid + '] mode=' + state.settings.obdMode + ' lines=' + JSON.stringify(lines));
    if (lines.length > 0) {
      if (state.settings.obdMode === 'single') {
        for (const l of lines) { if (parseObdLine(pid, l)) break; }
      } else {
        for (const l of lines) parseObdLine(pid, l);
      }
    }
  }

  // PID 別パース (GT_DASH の parseLine と完全一致)
  function parseObdLine(pid, raw) {
    const s = raw.replace(/[\s\r\n>]/g, '').toUpperCase();
    if (!s || OBD_NOISE.some(n => s.includes(n))) return false;

    // Mode 22 検出は残置（将来用、現状は使われない）
    let hdr;
    if (pid.length >= 6 && pid.startsWith('22')) {
      hdr = '62' + pid.slice(2);
    } else {
      hdr = '4' + pid.slice(1);
    }
    const idx = s.indexOf(hdr);
    if (idx < 0) return false;
    const v = s.slice(idx + hdr.length);
    try {
      // ──── 標準 Mode 01 PIDs ────
      if (pid === '010C' && v.length >= 4) {
        // RPM = ((A*256) + B) / 4
        state.obd.rpm = (parseInt(v.slice(0, 2), 16) * 256 + parseInt(v.slice(2, 4), 16)) >> 2;
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '0105' && v.length >= 2) {
        state.obd.coolant = parseInt(v.slice(0, 2), 16) - 40;
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '015C' && v.length >= 2) {
        state.obd.oiltemp = parseInt(v.slice(0, 2), 16) - 40;
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '010F' && v.length >= 2) {
        state.obd.intake = parseInt(v.slice(0, 2), 16) - 40;
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '0111' && v.length >= 2) {
        state.obd.throttle = Math.round(parseInt(v.slice(0, 2), 16) / 255 * 100);
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '010B' && v.length >= 2) {
        // MAP (Manifold Absolute Pressure) [kPa] = A
        state.obd.mapKpa = parseInt(v.slice(0, 2), 16);
        // 相対ブースト [kg/cm²] — GT_DASH と同一式
        state.obd.boost = (state.obd.mapKpa - 101.325) / 98.0665;
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      } else if (pid === '010D' && v.length >= 2) {
        // Vehicle Speed [km/h] = A
        state.obd.speed = parseInt(v.slice(0, 2), 16);
        _dbgOkCount++; _lastOkParseAt = Date.now();
        return true;
      }
    } catch (e) {
      console.warn('[OBD PARSE]', e);
    }
    return false;
  }

  // ============================================================
  // 横画面 DASHBOARD (GT_DASH スタイル)
  // ============================================================

  // 端末の向きを検出して body にクラスを付与
  // TWA や Android で各種イベントの発火タイミングがバラバラなため、
  // 複数の検出ソースを併用 + 遅延ポーリングで取りこぼし防止
  function isLandscapeNow() {
    // 複数ソースで判定（TWA/Android の発火タイミング差異対策）
    if (screen.orientation && screen.orientation.type) {
      return screen.orientation.type.startsWith('landscape');
    }
    if (window.matchMedia) {
      return window.matchMedia('(orientation: landscape)').matches;
    }
    return window.innerWidth > window.innerHeight;
  }

  function updateOrientation() {
    // 走 rows中は開始時の向きで固定（ドライバーの意図しない切替を防止）
    try { if (state.driveActive && Landscape.isLocked()) return; } catch (_) {}
    // 横画面ダッシュボード: drive 画面 + 設定 ON のときのみ発動
    const want = isLandscapeNow()
              && state.view === 'drive'
              && state.settings.dash && state.settings.dash.enabled;
    const has = document.body.classList.contains('landscape');
    if (want === has) return;
    document.body.classList.toggle('landscape', want);
    if (want) Landscape.onEnter();
    else      Landscape.onExit();
  }
  // 標準イベント
  window.addEventListener('resize', updateOrientation);
  window.addEventListener('orientationchange', updateOrientation);
  // screen.orientation API（最も新しいが TWA で確実に発火）
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', updateOrientation);
  }
  // matchMedia（フォールバック、Android 多くで動く）
  if (window.matchMedia) {
    const mql = window.matchMedia('(orientation: landscape)');
    if (mql.addEventListener) mql.addEventListener('change', updateOrientation);
    else if (mql.addListener) mql.addListener(updateOrientation);
  }
  // orientationchange は viewport resize より先に発火することがあるので、
  // 遅延を入れて確実にレイアウトが反映された後にも判定し直す
  window.addEventListener('orientationchange', () => {
    setTimeout(updateOrientation, 50);
    setTimeout(updateOrientation, 250);
    setTimeout(updateOrientation, 500);
  });

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  }

  // 横画面のイベントハンドラ（init 時に一度だけバインド。tick に依存しない）
  function bindLandscapeHandlers() { /* 後方互換で残す（tick から呼ばれていてもNo害） */ }

  // ============================================================
  // 横画面ダッシュボード本体 (GT_DASH 移植)
  // ── tick() 内から Landscape.isActive() / update() が呼ばれる
  // ============================================================
  const Landscape = (() => {
    let _active   = false;
    let _built    = false;
    let _updTimer = null;

    // ─── ギア検出 (GT_DASH detectGear 移植) ───
    let GEAR_TABLE = [];
    const _ratioHistory = [];
    let _gear = 'N', _gearCand = 'N', _gearCnt = 0;

    function buildGearTable() {
      const v = state.settings.vehicle;
      const circ = Math.PI * v.tireDiamMm / 1000;          // タイヤ外周 [m]
      const factor = v.finalDrive * 1000 / (circ * 60);    // rpm/km/h 換算係数
      GEAR_TABLE = (v.gearRatios || []).map((gr, i) =>
        ({ gear: String(i + 1), rpmPerKmh: gr * factor }));
    }

    function currentSpeedKmh() {
      const dash = state.settings.dash;
      if (dash.gearSource === 'obd') return state.obd.speed ?? -1;
      return state.currentSpeedMS >= 0 ? state.currentSpeedMS * 3.6 : -1;
    }

    function detectGear() {
      const v = state.settings.vehicle;
      const spd = currentSpeedKmh();
      const rpm = state.obd.rpm;
      if (rpm == null || spd < v.minSpeed || rpm < v.minRpm) {
        _ratioHistory.length = 0; _gearCand = 'N'; _gearCnt = 0; _gear = 'N'; return;
      }
      const ratio = rpm / spd;
      _ratioHistory.push(ratio);
      if (_ratioHistory.length > v.medianSize) _ratioHistory.shift();
      if (_ratioHistory.length < v.medianSize) return;
      const sorted = [..._ratioHistory].sort((a, b) => a - b);
      const medRatio = sorted[Math.floor(sorted.length / 2)];
      const maxDev = Math.max(...sorted) - Math.min(...sorted);
      if ((maxDev / medRatio) > 0.15) return;               // 変速中はスキップ
      const tol = (v.tolerancePct || 10) / 100;
      let best = 'N', bestPct = tol;
      for (const g of GEAR_TABLE) {
        const pct = Math.abs(medRatio - g.rpmPerKmh) / g.rpmPerKmh;
        if (pct < bestPct) { bestPct = pct; best = g.gear; }
      }
      if (best === 'N') return;
      if (best === _gearCand) {
        _gearCnt++;
        if (_gearCnt >= v.hysteresis) _gear = best;
      } else { _gearCand = best; _gearCnt = 1; }
    }

    // ─── LED バー (GT_DASH buildLeds/updateLeds 移植) ───
    function buildLeds() {
      const bar = document.getElementById('ls-led-bar');
      if (!bar) return;
      const dash = state.settings.dash;
      bar.innerHTML = '';
      for (let i = 0; i < dash.rpmDots; i++) {
        const d = document.createElement('div');
        d.className = 'led'; d.id = `ls-led-${i}`;
        bar.appendChild(d);
      }
    }
    function updateLeds() {
      const dash = state.settings.dash;
      const bar = document.getElementById('ls-led-bar');
      const rpm = state.obd.rpm ?? 0;
      if (bar) bar.classList.toggle('warn', rpm >= dash.warnRpm);
      for (let i = 0; i < dash.rpmDots; i++) {
        const d = document.getElementById(`ls-led-${i}`);
        if (!d) continue;
        const dc = dash.dotConfig[i];
        if (!dc) { d.className = 'led'; continue; }
        const cc = ['green','yellow','red','blue','orange','white'].includes(dc.color) ? dc.color : 'green';
        d.className = rpm >= dc.threshold ? `led ${cc} on` : `led ${cc}`;
      }
    }

    // ─── ブーストバー ───
    function buildBoostTicks() {
      const dash = state.settings.dash;
      const wrap = document.getElementById('ls-boost-ticks');
      if (!wrap) return;
      wrap.innerHTML = '';
      const range = dash.boostMax - dash.boostMin;
      const step = range / 4;
      for (let i = 0; i <= 4; i++) {
        const s = document.createElement('span');
        s.className = 'ls-boost-tick';
        s.textContent = (dash.boostMin + step * i).toFixed(1);
        wrap.appendChild(s);
      }
    }
    function updateBoost() {
      const dash = state.settings.dash;
      const fill = document.getElementById('ls-boost-fill');
      const bval = document.getElementById('ls-boost-val');
      const bbig = document.getElementById('ls-boost-big');
      const b = state.obd.boost;
      if (b !== null && b !== undefined) {
        const pct = Math.min(1, Math.max(0, (b - dash.boostMin) / (dash.boostMax - dash.boostMin))) * 100;
        if (fill) fill.style.width = pct.toFixed(1) + '%';
        if (bval) bval.textContent = b.toFixed(2);
        if (bbig) bbig.textContent = b.toFixed(1);
      } else {
        if (fill) fill.style.width = '0%';
        if (bval) bval.textContent = '---';
        if (bbig) bbig.textContent = '-.-';
      }
    }

    function setTxt(id, v) {
      const el = document.getElementById(id);
      if (el && el.textContent !== String(v)) el.textContent = String(v);
    }

    // ─── UI 全体更新 (250ms 間隔 + tick からのタイマー系ミラー) ───
    function updateSlow() {
      if (!_active) return;
      const dash = state.settings.dash;
      // RPM
      const rpm = state.obd.rpm;
      const rpmEl = document.getElementById('ls-rpm-val');
      if (rpmEl) {
        rpmEl.textContent = rpm ?? 0;
        rpmEl.classList.toggle('warn', (rpm ?? 0) >= dash.warnRpm);
      }
      updateLeds();
      updateBoost();
      // 車速 (ギア検出と同じソースを使用)
      const spdEl = document.getElementById('ls-speed-val');
      if (spdEl) {
        const spd = currentSpeedKmh();
        spdEl.textContent = spd >= 0 ? String(Math.round(spd)) : '--';
      }
      // ギア
      detectGear();
      const gEl = document.getElementById('ls-gear-val');
      if (gEl) {
        gEl.textContent = _gear;
        gEl.classList.toggle('is-n', _gear === 'N');
      }
      // 温度
      setTxt('ls-coolant', state.obd.coolant ?? '--');
      setTxt('ls-oiltemp', state.obd.oiltemp ?? '--');
      // OBD 状態
      const chip = document.getElementById('ls-obd-chip');
      if (chip) {
        const st = state.obd.status || 'disconnected';
        chip.textContent = st === 'connected' ? 'Connected'
                        : st === 'connecting' ? 'Connecting…' : 'Disconnected';
        chip.classList.toggle('ok', st === 'connected');
      }
      // GPS 精度ミラー
      const acc = document.getElementById('gps-acc');
      if (acc) setTxt('ls-gps-acc', acc.textContent);
    }

    // ─── タイマー系ミラー (毎 tick 呼び出し・縦画面 DOM から複写) ───
    function mirrorTimers() {
      if (!_active) return;
      const map = [
        ['current-lap-time',  'ls-current-time'],
        ['next-sector-value', 'ls-next-sector'],
        ['best-lap-time',     'ls-record'],
        ['last-lap-time',     'ls-latest'],
        ['lap-count',         'ls-lap'],
        ['now-sector-num',    'ls-sector-num'],
      ];
      for (const [src, dst] of map) {
        const s = document.getElementById(src);
        const d = document.getElementById(dst);
        if (s && d && d.textContent !== s.textContent) d.textContent = s.textContent;
      }
      // ネクストセクターの faster/slower 色も複写
      const nsSrc = document.getElementById('next-sector-value');
      const nsDst = document.getElementById('ls-next-sector');
      if (nsSrc && nsDst) {
        nsDst.classList.toggle('faster', nsSrc.classList.contains('faster'));
        nsDst.classList.toggle('slower', nsSrc.classList.contains('slower'));
      }
      // START/STOP ボタン状態ミラー
      const srcBtn = document.getElementById('btn-start-stop');
      const dstBtn = document.getElementById('ls-btn-start');
      if (srcBtn && dstBtn) {
        const stop = srcBtn.classList.contains('stop') || /STOP/i.test(srcBtn.textContent);
        dstBtn.textContent = stop ? 'STOP' : 'START';
        dstBtn.classList.toggle('stop', stop);
      }
    }

    function bindOnce() {
      if (_built) return;
      _built = true;
      const startBtn = document.getElementById('ls-btn-start');
      if (startBtn) startBtn.addEventListener('click', () => {
        const b = document.getElementById('btn-start-stop');
        if (b) b.click();                       // 縦画面ボタンへ委譲（ロジック一元化）
      });
      const exitBtn = document.getElementById('ls-btn-exit');
      if (exitBtn) exitBtn.addEventListener('click', () => {
        const b = document.querySelector('[data-action="exit-drive"]');
        if (b) b.click();
      });
      const cfgBtn = document.getElementById('ls-btn-cfg');
      if (cfgBtn) cfgBtn.addEventListener('click', () => {
        if (state.driveActive) { toast('Stop the session before changing settings'); return; }
        document.body.classList.remove('landscape');
        _active = false;
        if (typeof openSettings === 'function') openSettings();
        else showScreen('settings');
      });
      const dbgBtn = document.getElementById('ls-btn-dbg');
      if (dbgBtn) dbgBtn.addEventListener('click', toggleDbgOverlay);
    }

    let _lockedOrientation = null;   // 走 rows中ロック: null | 'portrait' | 'landscape'

    return {
      isActive: () => _active,
      isLocked: () => _lockedOrientation !== null,
      check() { try { updateOrientation(); } catch (_) {} },
      // 走 rows開始時: 現在の向きで固定 / 停止時: 解除して再評価
      lockOrientation()   { _lockedOrientation = _active ? 'landscape' : 'portrait'; },
      unlockOrientation() { _lockedOrientation = null; try { updateOrientation(); } catch (_) {} },
      rebuild() {           // 設定保存時に呼ぶ（LED 個数・ブースト範囲反映）
        buildGearTable();
        if (_active) { buildLeds(); buildBoostTicks(); applyBoostVisibility(); }
      },
      onEnter() {
        _active = true;
        bindOnce();
        buildGearTable();
        buildLeds();
        buildBoostTicks();
        applyBoostVisibility();
        updateSlow();
        mirrorTimers();
        if (_updTimer) clearInterval(_updTimer);
        _updTimer = setInterval(updateSlow, 250);
        // Wake Lock 維持は既存の drive 画面ロジックに委譲
      },
      onExit() {
        _active = false;
        if (_updTimer) { clearInterval(_updTimer); _updTimer = null; }
      },
      update: mirrorTimers,   // tick() から毎フレーム呼び出し
    };

    function applyBoostVisibility() {
      const dash = state.settings.dash;
      const wrap = document.getElementById('ls-boost-wrap');
      const cell = document.getElementById('ls-boost-cell');
      if (wrap) wrap.style.display = dash.showBoost ? '' : 'none';
      if (cell) cell.style.display = dash.showBoost ? '' : 'none';
    }
  })();

  // ============================================================
  // 接続安定化 (Phase 3)
  // Watchdog: 通信断や応答Noしを検知 → 設定に応じて自動再接続
  // Keep-Alive: 30秒ごとにNo害なATコマンドを送り Android の OS による
  //             BLE スリープ強制切断を防ぐ
  // ============================================================
  const WATCHDOG_MS  = 5000;    // 5秒ごとにヘルスチェック
  const NO_DATA_MS   = 15000;   // 15秒以上データNo → 異常判定
  const MAX_TIMEOUTS = 15;      // 連続15回タイムアウト → 異常判定
  const KEEPALIVE_MS = 30000;   // Keep-Alive 送信間隔
  const RECONNECT_SAFETY_MS = 20000;  // 再接続が固まった場合の安全弁

  let _lastDataAt          = 0;
  let _consecutiveTimeouts = 0;
  let _watchdogTimer  = null;
  // STOPPED 連続カウント — プロトコル検出失敗・車両不応答の自動検出
  let _stoppedCount  = 0;
  // 100 連続 STOPPED で軽い再試行（BMW は通常 86% が STOPPED のため閾値は高く取る）
  const STOPPED_BACKOFF = 100;
  let _lastOkParseAt = 0;
  // 加えて 30 秒以上パース成功なし、の場合のみ発動
  const NO_DATA_BACKOFF_MS = 30000;
  // 「?」応答カウンタ：5 回連続で ATSP6 再送
  let _questionCount = 0;
  let _protoReinitInProgress = false;
  let _keepAliveTimer = null;
  let _reconnecting   = false;

  // デバッグカウンタ
  let _dbgRxCount  = 0;
  let _dbgOkCount  = 0;

  // ─── デバッグオーバーレイ (GT_DASH 互換) ───
  // 非表示時は完全に早期 return — BMW Mini の高頻度トラフィックで
  // CPU を浪費しないよう、GT_DASH と同じ実装に揃える
  let _dbgLog = '';
  let _dbgEnabled = false;

  function dbg(msg) {
    // ★ 非表示時は文字列操作を一切しない (GT_DASH と同じ)
    if (!_dbgEnabled) return;
    _dbgLog = msg + '\n' + _dbgLog;
    if (_dbgLog.length > 1200) _dbgLog = _dbgLog.slice(0, 1200);
    const el = document.getElementById('dbg-overlay');
    if (el) el.textContent = _dbgLog;
  }

  function toggleDbgOverlay() {
    _dbgEnabled = !_dbgEnabled;
    const ol = document.getElementById('dbg-overlay');
    const btn = document.getElementById('btn-dbg-portrait');
    if (ol) {
      ol.classList.toggle('show', _dbgEnabled);
      if (_dbgEnabled) {
        ol.textContent = _dbgLog;
      } else {
        // 閉じたら即クリア (GT_DASH と同じ)
        _dbgLog = '';
        ol.textContent = '';
      }
    }
    if (btn) btn.classList.toggle('active', _dbgEnabled);
  }

  // DBG ボタンクリックでトグル (縦画面フッター + 設定画面)
  document.addEventListener('DOMContentLoaded', () => {
    ['btn-dbg-portrait', 'btn-toggle-dbg-overlay'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', toggleDbgOverlay);
    });
  });
  // DOMContentLoaded が既に発火している場合の補完
  setTimeout(() => {
    ['btn-dbg-portrait', 'btn-toggle-dbg-overlay'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn && !btn._dbgBound) {
        btn.addEventListener('click', toggleDbgOverlay);
        btn._dbgBound = true;
      }
    });
  }, 500);

  function _updateDebugPanel() {
    const panel = document.getElementById('obd-debug-panel');
    if (!panel) return;
    // 接続状態に関わらず常時表示（診断に役立てる）
    panel.style.display = '';
    const el = id => document.getElementById(id);
    const st = state.obd.status || 'disconnected';
    if (el('dbg-status')) {
      el('dbg-status').textContent = st;
      el('dbg-status').style.color = st === 'connected' ? '#22e54a' : '#ff3d1a';
    }
    if (el('dbg-count'))   el('dbg-count').textContent   = _dbgRxCount;
    if (el('dbg-ok'))      el('dbg-ok').textContent      = _dbgOkCount;
    if (el('dbg-timeout')) el('dbg-timeout').textContent = _consecutiveTimeouts;
    if (el('dbg-stopped')) el('dbg-stopped').textContent = _stoppedCount;
    if (el('dbg-rpm'))     el('dbg-rpm').textContent     = state.obd.rpm     ?? '--';
    if (el('dbg-coolant')) el('dbg-coolant').textContent = state.obd.coolant ?? '--';
    if (el('dbg-oil'))     el('dbg-oil').textContent     = state.obd.oiltemp ?? '--';
  }
  setInterval(_updateDebugPanel, 500);

  function startKeepAlive() {
    if (_keepAliveTimer) clearInterval(_keepAliveTimer);
    _keepAliveTimer = setInterval(() => {
      if (!state.obd.connected || !state.obd.txChar) return;
      // ポーリング応答待ち中は絶対に割り込まない
      if (pollState.waiting) return;
      // 'AT I' = ELM327 識別情報。No害で応答が返るため接続維持に最適
      bleSend('AT I');
    }, KEEPALIVE_MS);
  }
  function stopKeepAlive() {
    if (_keepAliveTimer) {
      clearInterval(_keepAliveTimer);
      _keepAliveTimer = null;
    }
  }

  function startWatchdog() {
    if (_watchdogTimer) clearInterval(_watchdogTimer);
    _lastDataAt          = Date.now();
    _consecutiveTimeouts = 0;
    _watchdogTimer = setInterval(() => {
      if (!state.obd.connected || !pollState.active) return;
      const stale   = (Date.now() - _lastDataAt) > NO_DATA_MS;
      const tooMany = _consecutiveTimeouts >= MAX_TIMEOUTS;
      if (stale || tooMany) {
        console.warn('[WATCHDOG] stale=' + stale + ' tooMany=' + tooMany);
        if (state.settings.obdAutoReconnect === 'on') {
          attemptReconnect();
        } else {
          // 自動再接続OFFなら切断のみ
          bleDisconnect();
        }
      }
    }, WATCHDOG_MS);
  }
  function stopWatchdog() {
    if (_watchdogTimer) {
      clearInterval(_watchdogTimer);
      _watchdogTimer = null;
    }
  }

  async function attemptReconnect() {
    if (_reconnecting) return;
    _reconnecting = true;
    bleSetStatus('connecting');
    toast('OBD2 reconnecting…');

    // 安全弁: 20秒以内に完了しなければ強制リセット
    const safety = setTimeout(() => {
      if (_reconnecting) {
        _reconnecting = false;
        bleSetStatus('disconnected');
        toast('Reconnect timed out');
      }
    }, RECONNECT_SAFETY_MS);

    try {
      bleStopPolling();
      stopKeepAlive();
      stopWatchdog();
      state.obd.txChar = null;
      state.obd.rxChar = null;
      pollState.buf     = '';
      pollState.waiting = false;

      if (state.obd.device?.gatt?.connected) {
        try { state.obd.device.gatt.disconnect(); } catch (_) {}
      }
      await bleSleep(500);

      if (state.obd.device) {
        const server = await state.obd.device.gatt.connect();
        await bleInitAfterConnect(server, state.obd.device);
      } else {
        bleSetStatus('disconnected');
      }
    } catch (e) {
      console.error('[RECONNECT]', e);
      bleSetStatus('disconnected');
      toast('Reconnect failed');
    } finally {
      clearTimeout(safety);
      _reconnecting = false;
    }
  }

  // 画面が再表示された時、誤検知を防ぐためカウンタをリセット
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.obd.connected) {
      _lastDataAt          = Date.now();
      _consecutiveTimeouts = 0;
    }
  });

  // ============================================================
  // EDIT
  // ============================================================
  function openEdit() {
    showScreen('edit');
    const c = getActiveCourse();
    if (!c) return;

    document.getElementById('course-name').value = c.name || '';
    document.getElementById('circuit-toggle').checked = (c.type === 'circuit');

    if (state.editMap) { state.editMap.remove(); state.editMap = null; }
    setTimeout(initEditMap, 50);
  }

  function initEditMap() {
    const c = getActiveCourse();
    if (!c) return;
    let center = DEFAULT_CENTER;
    let zoom = 14;
    if (c.startLine) { center = midpoint(c.startLine); zoom = 17; }

    state.editMap = L.map('map-edit', { zoomControl: true, attributionControl: true }).setView(center, zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(state.editMap);

    if (!c.startLine && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        if (state.editMap && !c.startLine) {
          state.editMap.setView([pos.coords.latitude, pos.coords.longitude], 17);
        }
      }, () => {}, { enableHighAccuracy: true, timeout: 5000 });
    }

    redrawEditLines();
    state.editMap.on('click', onEditMapClick);
  }

  function midpoint(line) {
    return [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  }

  function redrawEditLines() {
    const map = state.editMap;
    const c = getActiveCourse();
    if (!map || !c) return;

    if (state.editLineLayers.start)  { map.removeLayer(state.editLineLayers.start);  state.editLineLayers.start  = null; }
    if (state.editLineLayers.finish) { map.removeLayer(state.editLineLayers.finish); state.editLineLayers.finish = null; }
    state.editLineLayers.sections.forEach(l => map.removeLayer(l));
    state.editLineLayers.sections = [];

    if (c.startLine) {
      state.editLineLayers.start = drawLine(map, c.startLine, '#ffb000', c.type === 'circuit' ? 'S/F' : 'START');
    }
    if (c.type !== 'circuit' && c.finishLine) {
      state.editLineLayers.finish = drawLine(map, c.finishLine, '#f85149', 'FINISH');
    }
    (c.sections || []).forEach((s, i) => {
      state.editLineLayers.sections.push(drawLine(map, s.line, '#4fc3f7', s.name || `S${i + 1}`));
    });
  }

  function drawLine(map, line, color, label) {
    const polyline = L.polyline(line, { color, weight: 5, opacity: 0.9 });
    const m1 = L.circleMarker(line[0], { radius: 4, color, fillColor: color, fillOpacity: 1, weight: 0 });
    const m2 = L.circleMarker(line[1], { radius: 4, color, fillColor: color, fillOpacity: 1, weight: 0 });
    const labelMarker = L.marker(midpoint(line), {
      icon: L.divIcon({
        className: 'line-label',
        html: `<div style="
          background: ${color}; color: #1a1300;
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 700; font-size: 10px; letter-spacing: 0.1em;
          padding: 2px 6px; border-radius: 2px;
          white-space: nowrap;
          transform: translate(-50%, -50%);">${label}</div>`,
        iconSize: [0, 0]
      })
    });
    return L.layerGroup([polyline, m1, m2, labelMarker]).addTo(map);
  }

  function onEditMapClick(ev) {
    if (!state.editMode) { toast('Select a gate type from the buttons above'); return; }
    const c = getActiveCourse();
    if (!c) return;

    const latlng = [ev.latlng.lat, ev.latlng.lng];

    if (!state.editPendingPoint) {
      state.editPendingPoint = latlng;
      state.editPendingMarker = L.circleMarker(latlng, {
        radius: 6, color: '#ffb000', fillColor: '#ffb000', fillOpacity: 0.5, weight: 2
      }).addTo(state.editMap);
      setStatus('Tap the second point on the map', 'warn');
    } else {
      const line = [state.editPendingPoint, latlng];
      if (state.editPendingMarker) {
        state.editMap.removeLayer(state.editPendingMarker);
        state.editPendingMarker = null;
      }
      state.editPendingPoint = null;

      if (state.editMode === 'start')  c.startLine = line;
      else if (state.editMode === 'finish') c.finishLine = line;
      else if (state.editMode === 'section') {
        c.sections = c.sections || [];
        c.sections.push({
          id: uid(),
          name: `S${c.sections.length + 1}`,
          line,
          targetMs: null
        });
      }
      // Reset best when topology changes
      c.bestLap = null;
      saveCourses();
      redrawEditLines();
      setEditMode(null);
      setStatus('Gate saved', 'ok');
    }
  }

  function setEditMode(mode) {
    state.editMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (state.editPendingMarker) {
      state.editMap.removeLayer(state.editPendingMarker);
      state.editPendingMarker = null;
    }
    state.editPendingPoint = null;
    if (mode) {
      const labels = { start: 'Start', finish: 'Finish', section: 'Sector' };
      setStatus(`${labels[mode]}: tap the first point on the map`, 'warn');
    } else {
      setStatus('Select a gate type from the buttons above', '');
    }
  }

  function setStatus(text, cls) {
    const el = document.getElementById('edit-status');
    el.textContent = text;
    el.classList.remove('warn', 'ok');
    if (cls) el.classList.add(cls);
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      setEditMode(state.editMode === m ? null : m);
    });
  });

  document.getElementById('course-name').addEventListener('change', e => {
    const c = getActiveCourse();
    if (c) { c.name = e.target.value.trim() || 'Unnamed Course'; saveCourses(); }
  });

  document.getElementById('circuit-toggle').addEventListener('change', e => {
    const c = getActiveCourse();
    if (!c) return;
    c.type = e.target.checked ? 'circuit' : 'ptp';
    if (c.type === 'circuit') c.finishLine = null;
    c.bestLap = null;
    saveCourses();
    redrawEditLines();
  });

  document.getElementById('btn-clear-section').addEventListener('click', () => {
    const c = getActiveCourse();
    if (!c) return;
    if (!confirm('Clear all sector gates?')) return;
    c.sections = [];
    c.bestLap = null;
    saveCourses();
    redrawEditLines();
    toast('Sector gates cleared');
  });

  document.querySelectorAll('[data-action="back-home"]').forEach(btn => {
    btn.addEventListener('click', () => {
      showScreen('home');
      renderHome();
    });
  });

  document.querySelector('[data-action="delete-course"]').addEventListener('click', () => {
    if (!confirm('Delete this course?')) return;
    state.courses = state.courses.filter(c => c.id !== state.activeCourseId);
    state.activeCourseId = null;
    saveCourses();
    showScreen('home');
    renderHome();
  });

  // Locate me on edit map
  document.querySelector('[data-action="locate-me"]').addEventListener('click', () => {
    if (!state.editMap || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      state.editMap.setView(ll, 18);
      if (state.editLocateMarker) state.editMap.removeLayer(state.editLocateMarker);
      state.editLocateMarker = L.circleMarker(ll, {
        radius: 8, color: '#4fc3f7', fillColor: '#4fc3f7', fillOpacity: 0.5, weight: 2
      }).addTo(state.editMap);
      toast(`Location ±${pos.coords.accuracy.toFixed(0)}m`);
    }, err => toast('Location failed: ' + err.message), { enableHighAccuracy: true, timeout: 8000 });
  });

  document.getElementById('btn-start-drive').addEventListener('click', () => {
    const c = getActiveCourse();
    if (!c) return;
    if (!c.startLine) { toast('Start line not defined'); return; }
    if (c.type === 'ptp' && !c.finishLine) { toast('Finish line not defined'); return; }
    openDrive();
  });

  // ============================================================
  // DETAIL MODAL
  // Cancel button: just close (no save)
  // Save button:   write settings, then close
  // ============================================================
  document.querySelector('[data-action="edit-settings"]').addEventListener('click', openDetailModal);
  document.querySelector('[data-action="close-detail"]').addEventListener('click', closeDetailModalNoSave);
  document.getElementById('modal-detail').addEventListener('click', e => {
    if (e.target.id === 'modal-detail') closeDetailModalNoSave();
  });
  document.getElementById('btn-save-detail').addEventListener('click', saveDetailAndClose);

  function openDetailModal() {
    const c = getActiveCourse();
    if (!c) return;
    document.getElementById('cfg-duration').value = c.duration ? Math.round(c.duration / 60) : '';
    document.getElementById('cfg-cooldown').value = c.cooldownS;
    document.getElementById('cfg-acc').value      = c.accLimitM;
    document.getElementById('cfg-dirfilter').checked = !!c.dirFilter;
    renderSectionsEdit();
    document.getElementById('modal-detail').classList.add('show');
  }

  /** Cancel: close modal without saving. */
  function closeDetailModalNoSave() {
    document.getElementById('modal-detail').classList.remove('show');
  }

  /** Save: persist all field values then close. */
  function saveDetailAndClose() {
    const c = getActiveCourse();
    if (c) {
      const dur = parseInt(document.getElementById('cfg-duration').value, 10);
      c.duration  = isNaN(dur) ? 0 : dur * 60;
      const cd  = parseFloat(document.getElementById('cfg-cooldown').value);
      c.cooldownS = isNaN(cd)  ? DEFAULT_COOLDOWN_S : Math.max(0, cd);
      const acc = parseInt(document.getElementById('cfg-acc').value, 10);
      c.accLimitM = isNaN(acc) ? DEFAULT_ACC_M : Math.max(0, acc);
      c.dirFilter = document.getElementById('cfg-dirfilter').checked;
      saveCourses();
      toast('Saved');
    }
    document.getElementById('modal-detail').classList.remove('show');
  }

  function renderSectionsEdit() {
    const c = getActiveCourse();
    const list = document.getElementById('sections-edit-list');
    if (!c || !c.sections || c.sections.length === 0) {
      list.innerHTML = '<div class="splits-empty">Appears once you draw sector gates</div>';
      return;
    }
    list.innerHTML = '';
    c.sections.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'section-edit-row';
      const targetText = s.targetMs != null ? formatNumericDisplay(s.targetMs) : '';
      row.innerHTML = `
        <span class="name">${escapeHtml(s.name || `S${idx + 1}`)}</span>
        <input class="target" type="text" inputmode="numeric" placeholder="MMSS.CC" value="${targetText}" />
        <button class="del">Delete</button>
      `;
      const inp = row.querySelector('input.target');
      inp.addEventListener('input', () => {
        if (!inp.value.trim()) { inp.classList.remove('valid', 'invalid'); return; }
        const ms = parseTargetTime(inp.value);
        inp.classList.toggle('valid',   ms != null);
        inp.classList.toggle('invalid', ms == null);
      });
      inp.addEventListener('blur', () => {
        if (!inp.value.trim()) {
          s.targetMs = null;
          inp.classList.remove('valid', 'invalid');
          return;
        }
        const ms = parseTargetTime(inp.value);
        if (ms != null) {
          s.targetMs = ms;
          inp.value = formatNumericDisplay(ms);
          inp.classList.add('valid');
          inp.classList.remove('invalid');
        } else {
          inp.classList.add('invalid');
        }
      });
      row.querySelector('.del').addEventListener('click', () => {
        const name = s.name || `S${idx + 1}`;
        if (!confirm(`Delete sector “${name}”?`)) return;
        c.sections.splice(idx, 1);
        c.sections.forEach((sec, i) => { if (!sec.name || /^S\d+$/.test(sec.name)) sec.name = `S${i + 1}`; });
        c.bestLap = null;
        saveCourses();
        renderSectionsEdit();
        redrawEditLines();
        toast(`Sector “${name}” deleted`);
      });
      list.appendChild(row);
    });

    // ─── 最終区間: 最後のセクター線 → ゴール の目標タイム ───
    // セクター設定がなければ S1、あれば S(n+1) と連番表示
    // スタート線があるコース（=コース定義済み）で常に表示
    if (c.startLine) {
      const fsLabel = 'S' + (c.sections.length + 1);
      const fsRow = document.createElement('div');
      fsRow.className = 'section-edit-row';
      const fsText = c.finalSectorTargetMs != null ? formatNumericDisplay(c.finalSectorTargetMs) : '';
      fsRow.innerHTML = `
        <span class="name" style="color:#4fc3f7;">${fsLabel}</span>
        <input class="target" type="text" inputmode="numeric" placeholder="MMSS.CC" value="${fsText}" />
        <button class="del" style="visibility:hidden;" tabindex="-1">Delete</button>
      `;
      const fsInp = fsRow.querySelector('input.target');
      fsInp.addEventListener('input', () => {
        if (!fsInp.value.trim()) { fsInp.classList.remove('valid', 'invalid'); return; }
        const ms = parseTargetTime(fsInp.value);
        fsInp.classList.toggle('valid',   ms != null);
        fsInp.classList.toggle('invalid', ms == null);
      });
      fsInp.addEventListener('blur', () => {
        if (!fsInp.value.trim()) {
          c.finalSectorTargetMs = null;
          fsInp.classList.remove('valid', 'invalid');
          return;
        }
        const ms = parseTargetTime(fsInp.value);
        if (ms != null) {
          c.finalSectorTargetMs = ms;
          fsInp.value = formatNumericDisplay(ms);
          fsInp.classList.add('valid');
          fsInp.classList.remove('invalid');
        } else {
          fsInp.classList.add('invalid');
        }
      });
      list.appendChild(fsRow);
    }
  }

  // ============================================================
  // DRIVE
  // ============================================================
  function openDrive() {
    showScreen('drive');
    const c = getActiveCourse();

    // 通常の計測モード
    if (!c) return;

    document.getElementById('drive-course-name').textContent = c.name;
    setDriveState('Ready', '');
    resetDriveMetrics();
    renderSplitsGrid();

    // Init canvas widgets
    state.gball = new GBall(document.getElementById('gball-canvas'));
    state.courseMap = new CourseMap(document.getElementById('course-canvas'));
    if (state.courseMap) state.courseMap.setCourse(c);

    // コースごとの地図回転オフセットを復元
    try {
      const saved = localStorage.getItem('pta_maprot_' + c.id);
      state.mapRotOffset = saved !== null ? parseFloat(saved) : 0;
    } catch (_) { state.mapRotOffset = 0; }
    // スライダーUIに反映
    const _rotSlider = document.getElementById('map-rot-slider');
    const _rotLabel  = document.getElementById('map-rot-label');
    const _rotDeg = Math.round(state.mapRotOffset * 180 / Math.PI);
    if (_rotSlider) _rotSlider.value = _rotDeg;
    if (_rotLabel)  _rotLabel.textContent = _rotDeg + '°';

    // CSV buffer
    state.csvRows = [];

    // Big start button reset
    const btn = document.getElementById('btn-start-stop');
    btn.textContent = 'START';
    btn.className = 'big-action start';

    // OBD2 Connectedはダッシュボード計測外でも即時Yes効にするため
    // START 前からループを起動（driveActive=false のまま tick は安全に動く）
    startTimerLoop();

    // iOS DeviceMotion permission prompt button
    const motionBtn = document.getElementById('btn-motion-perm');
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      motionBtn.style.display = '';
    } else {
      motionBtn.style.display = 'none';
      attachMotionListener();
    }
  }

  function resetDriveMetrics() {
    state.driveActive = false;
    state.driveStartT = null;
    state.lapStartT = null;
    state.lapStarted = false;
    state.lapNumber = 0;
    state.lastLapMs = null;
    state.currentLapSplits = [];
    state.sectionStartT = null;
    state.currentSectorIdx = 0;
    state.gateCooldown = {};
    state.gateValidSide = {};
    state.prevFix = null;
    state.currentSpeedMS = -1;

    document.getElementById('current-lap-time').textContent = '00:00.000';
    document.getElementById('finish-countdown').textContent = '--:--.--';
    document.getElementById('lap-count').textContent = '0';
    document.getElementById('last-lap-time').textContent = '--:--.---';
    document.getElementById('next-sector-value').textContent = '--:--.--';
    document.getElementById('next-sector-value').className = 'ns-value';
    document.getElementById('best-delta-display').classList.add('hidden');
    document.getElementById('now-sector-num').textContent = '1';

    const c = getActiveCourse();
    document.getElementById('best-lap-time').textContent =
      c?.bestLap ? formatTime(c.bestLap.totalMs) : '--:--.---';
  }

  function setDriveState(text, cls) {
    const el = document.getElementById('drive-state');
    el.textContent = text;
    el.classList.remove('armed', 'running', 'finished');
    if (cls) el.classList.add(cls);
  }

  // === START / STOP button ===
  document.getElementById('btn-start-stop').addEventListener('click', () => {
    if (!state.driveActive) {
      // START
      const c = getActiveCourse();
      if (!c) return;
      state.driveActive = true;
      state.driveStartT = Date.now();
      state.lapStarted = false;
      state.lapStartT = null;
      state.currentSectorIdx = 0;
      state.currentLapSplits = [];
      state.csvRows = [];
      state.completedLaps = [];
      state.sessionStartTime = Date.now();
      // セッション開始時に OBD が繋がっていたかを記録（途中で繋がっても updateBleUI 経由で更新される）
      state.sessionObdActive = !!state.obd.connected;

      // Calibrate G-ball at START (use smoothed values for stability)
      calibrateGBall();

      const btn = document.getElementById('btn-start-stop');
      btn.textContent = 'RUN';
      btn.className = 'big-action running';

      setDriveState('Waiting for start line', 'armed');
      startGPS();
      requestWakeLock();
      startTimerLoop();
    } else {
      // STOP
      finishSession();
    }
  });

  // Exit drive screen entirely
  document.querySelector('[data-action="exit-drive"]').addEventListener('click', () => {
    if (state.driveActive) {
      if (!confirm('Session in progress. Stop it?')) return;
      finishSession();
    }
    stopGPS();
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    releaseWakeLock();
    detachMotionListener();

    // START ボタンの disabled を解除（ダッシュボードモードで disabled 化した場合）
    const btn = document.getElementById('btn-start-stop');
    if (btn) btn.disabled = false;
          showScreen('edit');
      if (state.editMap) setTimeout(() => state.editMap.invalidateSize(), 50);
  });

  function finishSession() {
    state.driveActive = false;
    state.lapStarted = false;
    setDriveState('Finished', 'finished');
    stopGPS();
    releaseWakeLock();
    const btn = document.getElementById('btn-start-stop');
    // 一旦 STOP を表示
    btn.textContent = 'STOP';
    btn.className = 'big-action stop';
    setTimeout(() => {
      // 5秒後にユーザーが再度走 rowsできる状態へ
      if (!state.driveActive) {   // 念のため二重 START 防止
        btn.textContent = 'START';
        btn.className = 'big-action start';
      }
    }, 5000);

    // セッション終了時に主要な表示を5秒間点滅
    const flashIds = [
      'drive-state', 'last-lap-time', 'current-lap-time',
    ];
    flashIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('flash-end');
        setTimeout(() => el.classList.remove('flash-end'), 5000);
      }
    });

    // セッションを履歴に永続化
    const c = getActiveCourse();
    persistCurrentSession(c);
  }

  // === GPS ===
  let _gpsLastUpdateAt = 0;
  let _gpsHealthTimer  = null;
  const GPS_STALE_MS   = 8000;   // 8秒以上更新なし → 再起動

  function startGPS() {
    if (!navigator.geolocation) {
      toast('This browser does not support GPS');
      return;
    }
    _startGpsWatch();
    // 停止検知タイマー: TWA で OS が GPS を一時停止することがあるため
    if (_gpsHealthTimer) clearInterval(_gpsHealthTimer);
    _gpsHealthTimer = setInterval(() => {
      if (!state.driveActive) return;
      const stale = (Date.now() - _gpsLastUpdateAt) > GPS_STALE_MS;
      if (stale && _gpsLastUpdateAt > 0) {
        console.warn('[GPS] stale > ' + GPS_STALE_MS + 'ms — 自動再起動');
        _restartGpsWatch();
      }
    }, 3000);
  }

  function _startGpsWatch() {
    if (state.watchId != null) return;
    _gpsLastUpdateAt = Date.now();
    state.watchId = navigator.geolocation.watchPosition(
      _safeGPSUpdate,
      err => {
        console.warn('[GPS]', err.message);
        document.getElementById('gps-indicator').classList.remove('active');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  function _restartGpsWatch() {
    if (state.watchId != null) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (_) {}
      state.watchId = null;
    }
    _startGpsWatch();
  }

  // onGPSUpdate を try-catch で包む（コールバック例外で watch が静かに止まるのを防止）
  function _safeGPSUpdate(pos) {
    _gpsLastUpdateAt = Date.now();
    try {
      onGPSUpdate(pos);
    } catch (e) {
      console.error('[GPS update]', e);
    }
  }

  function stopGPS() {
    if (_gpsHealthTimer) { clearInterval(_gpsHealthTimer); _gpsHealthTimer = null; }
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    document.getElementById('gps-indicator').classList.remove('active');
  }

  function onGPSUpdate(pos) {
    const c = getActiveCourse();
    if (!c) return;

    const fix = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      acc: pos.coords.accuracy,
      speed: pos.coords.speed,        // m/s or null
      t: pos.timestamp || Date.now()
    };

    // GPS indicator
    const ind = document.getElementById('gps-indicator');
    ind.classList.add('active');
    document.getElementById('gps-acc').textContent = `±${fix.acc.toFixed(0)}m`;

    // Accuracy filter (0 = disabled)
    if (c.accLimitM > 0 && fix.acc > c.accLimitM) {
      // Skip detection but still update UI
      return;
    }

    // Speed update for graph
    if (fix.speed != null && fix.speed >= 0) {
      state.currentSpeedMS = fix.speed;
    } else if (state.prevFix) {
      // Fallback: position derivative
      const dt = (fix.t - state.prevFix.t) / 1000;
      if (dt > 0.05) {
        const d = distM(state.prevFix.lat, state.prevFix.lon, fix.lat, fix.lon);
        const v = d / dt;
        if (v < 110) state.currentSpeedMS = v; // sanity cap (~400 km/h)
      }
    }
    // 速度グラフは廃止。state.currentSpeedMS は CSV 記録とギア検出に継続利用。

    // CSV recording
    if (state.driveActive && state.csvRows.length < RECORD_LIMIT) {
      const dt = new Date(fix.t);
      // OBD2 値の安全な文字列化（null → '' で CSV の空セルになる）
      const obdStr = v => (v === null || v === undefined) ? '' : v;
      state.csvRows.push([
        dt.toISOString(),
        fix.lat.toFixed(7),
        fix.lon.toFixed(7),
        fix.acc.toFixed(1),
        (state.currentSpeedMS >= 0 ? (state.currentSpeedMS * 3.6).toFixed(1) : ''),
        state.lapNumber,
        state.currentSectorIdx + 1,
        state.g_lat.toFixed(3),
        state.g_lon.toFixed(3),
        // ── OBD2 カラム（Phase 1 未接続時は空欄）────────
        obdStr(state.obd.rpm),
        obdStr(state.obd.coolant),
        obdStr(state.obd.oiltemp),
        obdStr(state.obd.intake),
        obdStr(state.obd.throttle),
      ]);
    }

    // Crossing detection (only when active)
    if (state.driveActive && state.prevFix) {
      detectGateCrossings(c, fix);
    }

    state.prevFix = fix;
  }

  /**
   * Try crossing each relevant gate. Apply cooldown + direction filter
   * + per-lap once-only constraint for sections.
   */
  function detectGateCrossings(c, fix) {
    const cdSec = c.cooldownS;
    const dirFilter = c.dirFilter;

    // Helper to attempt one gate
    const tryGate = (lineA, lineB, key) => {
      const last = state.gateCooldown[key];
      if (last != null && (fix.t - last) / 1000 < cdSec) return null;
      const cross = detectCrossing(state.prevFix, fix, lineA, lineB);
      if (!cross) return null;
      if (dirFilter) {
        const valid = state.gateValidSide[key];
        if (valid == null) {
          state.gateValidSide[key] = cross.side;
        } else if (valid !== cross.side) {
          return null; // wrong direction
        }
      }
      state.gateCooldown[key] = fix.t;
      return cross;
    };

    // Sections (only between start crossing and lap end)
    if (state.lapStarted) {
      (c.sections || []).forEach((sec, idx) => {
        // Once per lap
        if (state.currentLapSplits.some(s => s.idx === idx)) return;
        const cross = tryGate(sec.line[0], sec.line[1], `sec_${idx}`);
        if (cross) {
          const splitMs = cross.t - state.lapStartT;
          state.currentLapSplits.push({ idx, t: cross.t, splitMs });
          state.sectionStartT = cross.t;
          state.currentSectorIdx = Math.min(idx + 1, (c.sections || []).length);
          renderSplitsGrid();

          const bestSplit = c.bestLap?.splits?.find(s => s.idx === idx);
          const dBest = bestSplit ? splitMs - bestSplit.splitMs : null;
          toast(`${sec.name} ${formatTime(splitMs)}${dBest != null ? '  ' + formatDelta(dBest) : ''}`);
        }
      });
    }

    // Start / finish
    if (c.type === 'circuit') {
      const cross = tryGate(c.startLine[0], c.startLine[1], 'sf');
      if (cross) handleStartFinishCross(cross.t, c);
    } else {
      if (!state.lapStarted) {
        const cross = tryGate(c.startLine[0], c.startLine[1], 'start');
        if (cross) handleStartCross(cross.t);
      } else {
        const cross = tryGate(c.finishLine[0], c.finishLine[1], 'finish');
        if (cross) handleFinishCross(cross.t, c);
      }
    }
  }

  function handleStartFinishCross(crossT, c) {
    if (!state.lapStarted) {
      // First crossing → start lap
      state.lapStarted = true;
      state.lapStartT = crossT;
      state.sectionStartT = crossT;
      state.currentLapSplits = [];
      state.currentSectorIdx = 0;
      setDriveState(`LAP ${state.lapNumber + 1}`, 'running');
      toast('▶ Lap started');
      document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
    } else {
      const lapMs = crossT - state.lapStartT;
      finalizeLap(lapMs, c);
      // Start next lap
      state.lapStartT = crossT;
      state.sectionStartT = crossT;
      state.currentLapSplits = [];
      state.currentSectorIdx = 0;
      // Reset section gate state for new lap (allow re-crossing)
      Object.keys(state.gateCooldown).forEach(k => {
        if (k.startsWith('sec_')) delete state.gateCooldown[k];
      });
      setDriveState(`LAP ${state.lapNumber + 1}`, 'running');
      document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
    }
  }

  function handleStartCross(crossT) {
    state.lapStarted = true;
    state.lapStartT = crossT;
    state.sectionStartT = crossT;
    state.currentLapSplits = [];
    state.currentSectorIdx = 0;
    setDriveState('Recording', 'running');
    toast('▶ Session started');
    const c = getActiveCourse();
    document.getElementById('best-delta-display').classList.toggle('hidden', !c.bestLap);
  }

  function handleFinishCross(crossT, c) {
    const lapMs = crossT - state.lapStartT;
    finalizeLap(lapMs, c);
    // P2P ゴール通過時は自動停止 + 履歴保存 + 5秒STOP点滅
    finishSession();
  }

  function finalizeLap(lapMs, c) {
    state.lapNumber += 1;
    state.lastLapMs = lapMs;
    document.getElementById('last-lap-time').textContent = formatTime(lapMs);
    document.getElementById('lap-count').textContent = String(state.lapNumber);

    const lapRecord = {
      totalMs: lapMs,
      splits: state.currentLapSplits.map(s => ({ idx: s.idx, splitMs: s.splitMs })),
      date: Date.now()
    };

    // セッション中のラップ履歴へ追加
    state.completedLaps.push({
      number:  state.lapNumber,
      totalMs: lapMs,
      splits:  lapRecord.splits,
      date:    lapRecord.date,
    });

    const isBest = !c.bestLap || lapMs < c.bestLap.totalMs;
    if (isBest) {
      c.bestLap = lapRecord;
      saveCourses();
      document.getElementById('best-lap-time').textContent = formatTime(lapMs);
      toast(`★ NEW BEST ${formatTime(lapMs)}`);
    } else {
      const d = lapMs - c.bestLap.totalMs;
      toast(`LAP ${state.lapNumber}: ${formatTime(lapMs)} (${formatDelta(d)})`);
    }
  }

  function renderSplitsGrid() {
    const c = getActiveCourse();
    const grid = document.getElementById('splits-grid');
    if (!c || !c.startLine) {
      grid.innerHTML = '<div class="splits-empty">No course set</div>';
      return;
    }
    grid.innerHTML = '';
    const sections = c.sections || [];

    const addItem = (idx, label, splitMs, bestMs, isLive) => {
      const item = document.createElement('div');
      item.className = 'split-item';
      let timeText = '--:--.---', deltaText = '', deltaCls = '';
      if (splitMs != null) {
        timeText = formatTime(splitMs);
        if (bestMs != null) {
          const d = splitMs - bestMs;
          deltaText = formatDelta(d);
          deltaCls = d < 0 ? 'faster' : 'slower';
        }
      } else if (bestMs != null) {
        timeText = formatTime(bestMs);
        item.style.opacity = '0.5';
      }
      if (isLive) item.classList.add('live');
      item.innerHTML = `
        <span class="sname">${escapeHtml(label)}</span>
        <span class="stime">${timeText}</span>
        <span class="sdelta ${deltaCls}">${deltaText}</span>
      `;
      grid.appendChild(item);
    };

    // 各セクター区間 (S1 .. Sn): ゲート通過の累積時間
    sections.forEach((sec, idx) => {
      const split = state.currentLapSplits.find(s => s.idx === idx);
      const bestSplit = c.bestLap?.splits?.find(s => s.idx === idx);
      addItem(idx, sec.name || `S${idx + 1}`,
        split ? split.splitMs : null,
        bestSplit ? bestSplit.splitMs : null,
        idx === state.currentSectorIdx && state.lapStarted);
    });

    // 最終区間 (S{n+1}): ゴールまでの累積時間 (= ラップ合計)
    const fIdx = sections.length;
    const fSplit = state.currentLapSplits.find(s => s.idx === fIdx);
    addItem(fIdx, `S${fIdx + 1}`,
      fSplit ? fSplit.splitMs : null,
      (c.bestLap && c.bestLap.totalMs != null) ? c.bestLap.totalMs : null,
      fIdx === state.currentSectorIdx && state.lapStarted);
  }

  // ============================================================
  // TIMER LOOP — drives all live displays at ~60Hz
  // ============================================================
  let _tickFrame = 0;   // 重い描画を間引くためのフレームカウンタ
  function startTimerLoop() {
    function tick() {
      if (state.view !== 'drive') return;

      // ─── 横画面アクティブ時: Canvas描画は継続、縦画面テキストDOM更新はスキップ
      //     ただしタイマー計算・ゲート通過検知・セッション時間切れ判定は必ず実 rows
      // ──────────────────────────────────────────────────────────────────────────
      const _lsActive = typeof Landscape !== 'undefined' && Landscape.isActive && Landscape.isActive();

      if (_lsActive) {
        // Canvas 描画は継続 (横画面右上ボックスへ移設されている)
        _tickFrame = (_tickFrame + 1) % 3;
        if (_tickFrame === 0) {
          try {
            if (state.gball) state.gball.draw(state.g_lat, state.g_lon);
            if (state.courseMap) state.courseMap.draw();
          } catch (_) {}
        }
      }

      const now = Date.now();
      const c = getActiveCourse();

      // セッション時間切れ判定
      if (state.driveActive && c?.duration > 0 && state.driveStartT != null) {
        const remaining = c.duration * 1000 - (now - state.driveStartT);
        if (remaining <= 0) {
          finishSession();
          toast('⏱ Session time up');
        }
      }

      // Lap timer — 横画面でも計算し、縦画面DOMと横画面DOMの両方を更新

      // Lap timer — 横画面でも計算し、縦画面DOMと横画面DOMの両方を更新
      if (state.lapStarted && state.lapStartT != null) {
        const elapsed = now - state.lapStartT;
        const timeStr = formatTime(elapsed);
        document.getElementById('current-lap-time').textContent = timeStr;

        // toNextSector: セクター経過時間（カウントアップ） + 目標との差分（小数点以下なし）
        if (c && c.sections && state.currentSectorIdx < c.sections.length) {
          const sec = c.sections[state.currentSectorIdx];
          const sectionElapsed = now - (state.sectionStartT || state.lapStartT);
          const ns = document.getElementById('next-sector-value');
          if (sec.targetMs != null) {
            const d = sectionElapsed - sec.targetMs;
            ns.textContent = `${formatTime(sectionElapsed)}  ${formatDeltaNoMs(d)}`;
            ns.className = 'ns-value ' + (d < 0 ? 'faster' : 'slower');
          } else {
            ns.textContent = formatTime(sectionElapsed);
            ns.className = 'ns-value';
          }
        } else if (c && c.sections && c.sections.length > 0) {
          // 最終区間 (FS)
          const ns = document.getElementById('next-sector-value');
          const sectionElapsed = now - (state.sectionStartT || state.lapStartT);
          if (c.finalSectorTargetMs != null) {
            const d = sectionElapsed - c.finalSectorTargetMs;
            ns.textContent = `${formatTime(sectionElapsed)}  ${formatDeltaNoMs(d)}`;
            ns.className = 'ns-value ' + (d < 0 ? 'faster' : 'slower');
          } else {
            ns.textContent = formatTime(sectionElapsed);
            ns.className = 'ns-value';
          }
        } else {
          // セクションなし → ラップ全体の経過時間
          document.getElementById('next-sector-value').textContent = formatTime(elapsed);
          document.getElementById('next-sector-value').className = 'ns-value';
        }

        // BEST Δ — predictive: use last completed split's delta
        if (c?.bestLap && state.currentLapSplits.length > 0) {
          const last = state.currentLapSplits[state.currentLapSplits.length - 1];
          const bestSplit = c.bestLap.splits?.find(s => s.idx === last.idx);
          const bdEl = document.getElementById('best-delta-display');
          const bdVal = document.getElementById('best-delta-value');
          if (bestSplit) {
            const d = last.splitMs - bestSplit.splitMs;
            bdVal.textContent = formatDelta(d);
            bdVal.className = 'bd-value ' + (d < 0 ? 'faster' : 'slower');
            bdEl.classList.remove('hidden');
          }
        }

        document.getElementById('now-sector-num').textContent =
          String(Math.min(state.currentSectorIdx + 1, (c?.sections?.length ?? 0) + 1));
      } else if (state.driveActive && c?.sections?.length > 0 && c.sections[0].targetMs != null) {
        // Pre-start: show first section target (目標ラベルなし)
        const ns = document.getElementById('next-sector-value');
        ns.textContent = formatTime(c.sections[0].targetMs);
        ns.className = 'ns-value';
      }

      // Session FINISH countdown
      if (state.driveActive && c?.duration > 0 && state.driveStartT != null) {
        const remaining = c.duration * 1000 - (now - state.driveStartT);
        document.getElementById('finish-countdown').textContent = formatTimeShort(Math.max(0, remaining));
        if (remaining <= 0) {
          // Auto-stop on duration
          finishSession();
          toast('⏱ Session time up');
        }
      }

      // ─────────────────────────────────────────────────────────
      // 描画 — 縦画面のみ。3 フレームに 1 回 (≈20fps) に間引いて
      // BLE 通知処理に CPU を譲る (slow PID STOPPED 対策)。
      //
      // ★ データ取得 (state.g_lat/g_lon, state.currentSpeedMS) は
      //   motionHandler / GPS handler 側で常時 rowsわれるため、
      //   描画を間引いても記録は継続する。
      // ─────────────────────────────────────────────────────────
      _tickFrame = (_tickFrame + 1) % 3;
      if (_tickFrame === 0) {
        try {
          // G-ボール (慣性式)
          if (state.gball) {
            state.gball.draw(state.g_lat, state.g_lon);
            const tg = Math.min(Math.sqrt(state.g_lat * state.g_lat + state.g_lon * state.g_lon), G_RANGE);
            const gt = document.getElementById('g-text');
            if (gt) gt.textContent = `${tg.toFixed(2)} G`;
            // スライダー横のG値表示も更新
            const gv = document.getElementById('map-rot-gval');
            if (gv) gv.textContent = `${tg.toFixed(2)} G`;
          }
          // コースマップ (ゲートから自動描画 + 現在地赤丸 + ベスト青丸)
          if (state.courseMap) state.courseMap.draw();
        } catch (_) {
          // Skip bad render frame; do not stop RAF loop
        }
      }

      // 横画面ダッシュボード: タイマー系 DOM をミラー
      if (_lsActive) { try { Landscape.update(); } catch (_) {} }

      state.rafId = requestAnimationFrame(tick);
    }
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(tick);
  }

  // ============================================================
  // G-BALL (Canvas widget)
  // ============================================================
  class GBall {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = r.width * dpr;
      this.canvas.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.h = r.height;
    }
    draw(lat_g, lon_g) {
      const ctx = this.ctx;
      const w = this.w, h = this.h;
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) / 2 - 12;
      const dot = 10;

      ctx.clearRect(0, 0, w, h);
      // Outer dim ring
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.fill();
      // Outer ring
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      // 1G ring
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r / G_RANGE, 0, Math.PI * 2); ctx.stroke();
      // Cross hairs
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();
      // Labels
      ctx.fillStyle = '#555';
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('F', cx, cy - r - 6);
      ctx.fillText('B', cx, cy + r + 6);
      ctx.fillText('L', cx - r - 8, cy);
      ctx.fillText('R', cx + r + 8, cy);

      // Dot position
      // ベクトル式: G 値を直接座標に変換
      // 慣性式: 質量+バネ+減衰でボールが転がる物理シミュレーション
      let lat_disp = lat_g, lon_disp = lon_g;
      if (_gMode === 'inertia') {
        const now2 = Date.now();
        const dt = _gInBall.t ? Math.min((now2 - _gInBall.t) / 1000, 0.1) : 0.06;
        _gInBall.t = now2;
        const FORCE = 12, SPRING = 3, FRIC = 7;
        _gInBall.vx += (lat_g * FORCE - _gInBall.x * SPRING) * dt;
        _gInBall.vy += (lon_g * FORCE - _gInBall.y * SPRING) * dt;
        _gInBall.vx *= Math.max(0, 1 - FRIC * dt);
        _gInBall.vy *= Math.max(0, 1 - FRIC * dt);
        _gInBall.x  += _gInBall.vx * dt;
        _gInBall.y  += _gInBall.vy * dt;
        const id = Math.sqrt(_gInBall.x**2 + _gInBall.y**2);
        if (id > G_RANGE) {
          _gInBall.x = (_gInBall.x / id) * G_RANGE;
          _gInBall.y = (_gInBall.y / id) * G_RANGE;
          _gInBall.vx *= -0.3; _gInBall.vy *= -0.3;
        }
        lat_disp = _gInBall.x; lon_disp = _gInBall.y;
      }
      let bx = cx - (lat_disp / G_RANGE) * r;
      let by = cy + (lon_disp / G_RANGE) * r;
      const dx = bx - cx, dy = by - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r - dot) {
        const sc = (r - dot) / Math.max(d, 0.001);
        bx = cx + dx * sc; by = cy + dy * sc;
      }
      const tg = Math.min(Math.sqrt(lat_g * lat_g + lon_g * lon_g), G_RANGE);
      const iv = tg / G_RANGE;
      ctx.fillStyle = `rgb(${Math.round(255 * iv)}, ${Math.round(255 * Math.max(0, 1 - iv * 1.2))}, 0)`;
      ctx.beginPath(); ctx.arc(bx, by, dot, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ============================================================
  // COURSE MAP (Canvas) — ゲートから自動描画
  //   灰線 = コース骨格 (start→sections→finish のゲート中点を接続)
  //   🔴 赤丸 = 現在地 (リアルタイム GPS)
  //   🔵 青丸 = ベストゴースト (best split times からゲート間を内分)
  // ============================================================
  class CourseMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.waypoints = [];   // [{lat, lon}, ...] ゲート中点 (start→sec→finish)
      this.ghostTimes = [];  // [0, split0, split1, ..., totalMs] (ms)
      this.bbox = null;      // {minLat, maxLat, minLon, maxLon, meanLat}
      this.panX = 0; this.panY = 0;   // 現在地追従パンのオフセット
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.max(1, r.width * dpr);
      this.canvas.height = Math.max(1, r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.h = r.height;
    }
    // 線分 [{lat,lng},{lat,lng}] の中点を返す
    _mid(line) {
      if (!line || line.length < 2) return null;
      const a = line[0], b = line[1];
      if (!a || !b) return null;
      // 線データは配列 [lat, lng] または オブジェクト {lat, lng/lon} の両形式に対応
      const alat = Array.isArray(a) ? a[0] : a.lat;
      const alon = Array.isArray(a) ? a[1] : (a.lon != null ? a.lon : a.lng);
      const blat = Array.isArray(b) ? b[0] : b.lat;
      const blon = Array.isArray(b) ? b[1] : (b.lon != null ? b.lon : b.lng);
      if (!isFinite(alat) || !isFinite(alon) || !isFinite(blat) || !isFinite(blon)) return null;
      return { lat: (alat + blat) / 2, lon: (alon + blon) / 2 };
    }
    // コースを受け取り、ゲート中点とゴースト時刻列を構築
    setCourse(c) {
      this.waypoints = [];
      this.ghostTimes = [];
      this.routePts = null;     // OSRM 道なり経路 ([{lat, lon}, ...])
      this.panX = 0; this.panY = 0;   // 追従パンをリセット
      if (!c) { this.bbox = null; return; }

      const wp = [];
      if (c.startLine) { const m = this._mid(c.startLine); if (m) wp.push(m); }
      (c.sections || []).forEach(s => { const m = this._mid(s.line); if (m) wp.push(m); });
      if (c.finishLine) { const m = this._mid(c.finishLine); if (m) wp.push(m); }
      // サーキット (finish なし) の場合は start に戻して閉ループ
      if (!c.finishLine && c.type === 'circuit' && c.startLine) {
        const m = this._mid(c.startLine); if (m) wp.push(m);
      }
      this.waypoints = wp;
      this.courseType = c.type || 'circuit';  // 'circuit' | 'ptp'

      // ゴースト時刻列: [0, split0, split1, ..., totalMs]
      if (c.bestLap) {
        const times = [0];
        const splits = c.bestLap.splits || [];
        splits.forEach(sp => { if (sp && sp.splitMs != null) times.push(sp.splitMs); });
        if (c.bestLap.totalMs != null) times.push(c.bestLap.totalMs);
        this.ghostTimes = times;
      }

      // バウンディングボックス
      if (wp.length > 0) {
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        wp.forEach(p => {
          minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
          minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
        });
        this.bbox = { minLat, maxLat, minLon, maxLon, meanLat: (minLat + maxLat) / 2 };
      } else {
        this.bbox = null;
      }

      // ─── OSRM 道なり経路を取得 (バックグラウンド) ───
      if (wp.length >= 2) {
        const key = wp.map(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';');
        if (this._lastRouteKey !== key) {
          this._lastRouteKey = key;
          const coordStr = wp.map(p => p.lon + ',' + p.lat).join(';');
          const url = 'https://router.project-osrm.org/route/v1/driving/' +
                      coordStr + '?overview=full&geometries=geojson';
          fetch(url)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data || !data.routes || data.routes.length === 0) return;
              const geom = data.routes[0].geometry || {};
              const coords = geom.coordinates || [];
              if (coords.length < 2) return;
              const pts = coords.map(c => ({ lat: c[1], lon: c[0] }));
              this.routePts = pts;
              // bbox を経路全体に拡張 (waypoint と道なり経路 両方を含む)
              let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
              pts.concat(this.waypoints || []).forEach(p => {
                minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
                minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
              });
              this.bbox = { minLat, maxLat, minLon, maxLon, meanLat: (minLat + maxLat) / 2 };
            })
            .catch(() => { /* ネットワーク失敗時は直線フォールバック */ });
        }
      }
    }
    // lat/lon → canvas x/y (アスペクト比保持, メートル換算)
    _project(lat, lon, pad) {
      const bb = this.bbox;
      if (!bb) return null;
      const cosLat = Math.cos(bb.meanLat * Math.PI / 180);
      // メートル換算
      const xm = (lon - bb.minLon) * cosLat * 111320;
      const ym = (lat - bb.minLat) * 111320;
      const wm = Math.max((bb.maxLon - bb.minLon) * cosLat * 111320, 1);
      const hm = Math.max((bb.maxLat - bb.minLat) * 111320, 1);
      // アスペクト比保持でフィット
      const usableW = this.w - pad * 2;
      const usableH = this.h - pad * 2;
      const scale = Math.min(usableW / wm, usableH / hm);
      const offX = pad + (usableW - wm * scale) / 2;
      const offY = pad + (usableH - hm * scale) / 2;
      const x = offX + xm * scale;
      const y = this.h - (offY + ym * scale);  // y 反転 (北=上)
      return { x, y };
    }
    // ベストゴースト位置を経過時間から内分で算出
    _ghostPos(elapsedMs) {
      const t = this.ghostTimes, wp = this.waypoints;
      if (t.length < 2 || wp.length < 2) return null;
      // wp と t の数を揃える (短い方に合わせる)
      const n = Math.min(t.length, wp.length);
      if (elapsedMs <= t[0]) return wp[0];
      if (elapsedMs >= t[n - 1]) return wp[n - 1];
      for (let i = 0; i < n - 1; i++) {
        if (elapsedMs >= t[i] && elapsedMs < t[i + 1]) {
          const span = t[i + 1] - t[i];
          const ratio = span > 0 ? (elapsedMs - t[i]) / span : 0;
          return {
            lat: wp[i].lat + (wp[i + 1].lat - wp[i].lat) * ratio,
            lon: wp[i].lon + (wp[i + 1].lon - wp[i].lon) * ratio,
          };
        }
      }
      return wp[n - 1];
    }
    draw() {
      const ctx = this.ctx, w = this.w, h = this.h;
      const pad = 8;   // 余白を最小化 → 描画エリア最大化
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      if (!this.bbox || this.waypoints.length < 1) {
        // No course set
        ctx.fillStyle = '#555';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No course set (draw start / sector gates)', w / 2, h / 2);
        return;
      }

      // コース骨格 (灰線)
      const pts = this.waypoints.map(p => this._project(p.lat, p.lon, pad)).filter(Boolean);

      // ─── 回転: コース種別に応じてSTART位置を固定 ───
      // 周回コース (circuit): STARTを右下に固定（π/4 = 45°、右下方向）
      //   → コースが左上・上方向に向かって走り出すイメージ
      // 非周回コース (ptp):   STARTを真下に固定（π/2 = 90°、真下）
      //   → コースが上方向に向かっていくイメージ
      ctx.save();
      if (pts.length >= 1) {
        const _cx = w / 2, _cy = h / 2;
        const _phi = Math.atan2(pts[0].y - _cy, pts[0].x - _cx);
        const _target = (this.courseType === 'circuit') ? Math.PI / 4 : 3 * Math.PI / 4;
        const _mapRot = _target - _phi + (state.mapRotOffset || 0);
        const _cos = Math.cos(_mapRot), _sin = Math.sin(_mapRot);

        // ─── 現在地追従パン: 回転後の現在地が枠の余白(20%)外に出そうなら滑らかにずらす ───
        let _px = this.panX || 0, _py = this.panY || 0;
        const _fix = state.prevFix;
        if (_fix && _fix.lat != null) {
          const _cpr = this._project(_fix.lat, (_fix.lon != null ? _fix.lon : _fix.lng), pad);
          if (_cpr) {
            const _dx = _cpr.x - _cx, _dy = _cpr.y - _cy;
            const _rx = _cx + _dx * _cos - _dy * _sin;   // 回転後の現在地 X
            const _ry = _cy + _dx * _sin + _dy * _cos;   // 回転後の現在地 Y
            const _sx = _rx + _px, _sy = _ry + _py;      // 既存パン込みの画面座標
            const _mX = w * 0.2, _mY = h * 0.2;
            let _tx = _px, _ty = _py;
            if (_sx < _mX) _tx = _px + (_mX - _sx);
            else if (_sx > w - _mX) _tx = _px - (_sx - (w - _mX));
            if (_sy < _mY) _ty = _py + (_mY - _sy);
            else if (_sy > h - _mY) _ty = _py - (_sy - (h - _mY));
            this.panX = _px + (_tx - _px) * 0.2;   // 滑らかに追従
            this.panY = _py + (_ty - _py) * 0.2;
            _px = this.panX; _py = this.panY;
          }
        }
        ctx.translate(_px, _py);               // 追従パン (画面座標)
        ctx.translate(_cx, _cy);
        ctx.rotate(_mapRot);
        ctx.translate(-_cx, -_cy);
      }

      // ─── 骨格描画: OSRM 道なり経路があれば優先、Noければ直線フォールバック ───
      if (this.routePts && this.routePts.length >= 2) {
        const rp = this.routePts.map(p => this._project(p.lat, p.lon, pad)).filter(Boolean);
        if (rp.length >= 2) {
          ctx.strokeStyle = '#9aa4b2';
          ctx.lineWidth = 4;
          ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          ctx.beginPath();
          rp.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
          ctx.stroke();
        }
      } else if (pts.length >= 2) {
        ctx.strokeStyle = '#9aa4b2';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
      }
      // ゲート点 (明るい色で大きめに)
      pts.forEach((p, i) => {
        ctx.fillStyle = (i === 0) ? '#22e54a' : (i === pts.length - 1 ? '#ffb000' : '#bfe6ff');
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
      });

      // 🔵 ベストゴースト (青丸)
      if (state.lapStarted && state.lapStartT && this.ghostTimes.length >= 2) {
        const elapsed = Date.now() - state.lapStartT;
        const g = this._ghostPos(elapsed);
        if (g) {
          const gp = this._project(g.lat, g.lon, pad);
          if (gp) {
            ctx.fillStyle = '#2f7bff';
            ctx.shadowColor = '#2f7bff'; ctx.shadowBlur = 8;
            ctx.beginPath(); ctx.arc(gp.x, gp.y, 7, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      }

      // 🔴 現在地 (赤丸)
      const fix = state.prevFix;
      if (fix && fix.lat != null) {
        const cp = this._project(fix.lat, (fix.lon != null ? fix.lon : fix.lng), pad);
        if (cp) {
          ctx.fillStyle = '#ff3b30';
          ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
          // 白縁
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2); ctx.stroke();
        }
      }

      // 回転を解除 (save と必ずペア)
      ctx.restore();
    }
  }

  // ============================================================
  // DEVICEMOTION
  // ----------------------------------------------------------------
  // Phone orientation assumption (per ユウぶん様 仕様):
  //   - Portrait, vertical, screen parallel to driver's face
  //   - Camera (top of phone) points up toward the sky
  //   - Screen faces driver (front camera toward driver)
  //
  // Device axes (W3C DeviceMotion convention):
  //   +X: phone right  → car right  (lateral)
  //   +Y: phone up     → world up   (gravity axis, mostly +9.81 m/s²)
  //   +Z: out of screen → toward driver → toward REAR of car (longitudinal)
  //
  // Display mapping (物理ボール慣習: 慣性で重心が移動する方向に転がる):
  //   lat_g = +X / g    → ball moves right (R) on lateral right accel
  //   lon_g = −Z / g    → 前進加速で下方向 (B 側) に転がる
  //                       ブレーキで上方向 (F 側) に転がる
  //                       (描画側で by = cy + lon_g として実現)
  //
  // EMA smoothing applied to suppress accelerometer noise.
  // α = 0.15 → ~7-sample (≈70 ms at 100 Hz) effective time constant.
  // ============================================================
  // G-SENSOR (重力ローパス追従 + 画面回転対応 — GT_DASH と共通)
  //
  //  1. 重力ベクトルを α=0.92 で動的に推定し、デバイスの傾き変化に追従
  //  2. 純加速度 = 生加速度 − 推定重力（瞬時応答、出力スムージングNoし）
  //  3. screen.orientation.angle に応じて画面座標へ回転変換
  //  4. 縦G(車両前後) は Z 軸（画面奥 rows）— 画面回転で変わらないため
  //  5. 50ms throttle（20Hz）で省電力
  // ============================================================
  const G_PER_MS2     = 1 / 9.80665;
  const G_LP_ALPHA    = 0.92;          // 重力推定のローパス係数（GT_DASHと同じ）
  let _gravX = 0, _gravY = 0, _gravZ = 0;
  let _gInit         = false;
  let _calibPending  = false;
  let _lastMotionAt  = 0;
  let motionHandler        = null;
  let orientationHandler   = null;

  function getOrientationAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
      let a = window.orientation;
      if (a === -90) a = 270;
      return a;
    }
    return 0;
  }

  function attachMotionListener() {
    if (state.motionEnabled) return;
    motionHandler = (e) => {
      const now = Date.now();
      if (now - _lastMotionAt < 50) return;  // 20Hz throttle
      _lastMotionAt = now;

      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const ax = a.x || 0, ay = a.y || 0, az = a.z || 0;

      // 重力推定（初回 or キャリブ要求 or 回転変化後 → 即セット）
      if (!_gInit || _calibPending) {
        _gravX = ax; _gravY = ay; _gravZ = az;
        _gInit = true;
        _calibPending = false;
      } else {
        _gravX = G_LP_ALPHA * _gravX + (1 - G_LP_ALPHA) * ax;
        _gravY = G_LP_ALPHA * _gravY + (1 - G_LP_ALPHA) * ay;
        _gravZ = G_LP_ALPHA * _gravZ + (1 - G_LP_ALPHA) * az;
      }

      // 純加速度 [m/s²]
      const lx = ax - _gravX;
      const ly = ay - _gravY;
      const lz = az - _gravZ;

      // 画面回転を考慮した座標変換
      const angle = getOrientationAngle();
      const rad   = angle * Math.PI / 180;
      const cos   = Math.cos(rad);
      const sin   = Math.sin(rad);
      // 画面右方向 sx（端末を縦/横どちらに持ってもこれが正しい "lateral"）
      const sx = lx * cos + ly * sin;
      // 縦G（車両前後）は画面奥 rows −lz（forward = +）
      const lonG = -lz;

      // [G]単位に変換して state へ反映（瞬時応答）
      state.g_lat = sx   * G_PER_MS2;
      state.g_lon = lonG * G_PER_MS2;

      // 互換性のため g_smooth/g_raw も同期（既存コードが参照する場合に備える）
      state.g_smooth.x = state.g_lat;
      state.g_smooth.z = state.g_lon;
      state.g_raw.x = ax * G_PER_MS2;
      state.g_raw.y = ay * G_PER_MS2;
      state.g_raw.z = az * G_PER_MS2;
    };

    window.addEventListener('devicemotion', motionHandler, { passive: true });

    // 画面回転時は重力推定をリセット（向きが変わると重力ベクトルも変わるため）
    orientationHandler = () => { _gInit = false; };
    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', orientationHandler);
    }
    window.addEventListener('orientationchange', orientationHandler);

    state.motionEnabled = true;
  }

  function detachMotionListener() {
    if (motionHandler) {
      window.removeEventListener('devicemotion', motionHandler);
      motionHandler = null;
    }
    if (orientationHandler) {
      if (screen.orientation && screen.orientation.removeEventListener) {
        screen.orientation.removeEventListener('change', orientationHandler);
      }
      window.removeEventListener('orientationchange', orientationHandler);
      orientationHandler = null;
    }
    state.motionEnabled = false;
  }

  /**
   * G ボールのゼロ点補正。
   * GT_DASH と同じ動作: 次のモーションイベントで重力推定を現在値にリセットする。
   * これにより端末をその姿勢で水平と見なし、以降の動きを純加速度として検出する。
   */
  function calibrateGBall() {
    _calibPending = true;
    state.g_lat = 0;
    state.g_lon = 0;
    state.g_smooth.x = 0;
    state.g_smooth.z = 0;
  }

  // Manual ZERO button (always available on drive screen)
  document.getElementById('btn-g-cal').addEventListener('click', () => {
    calibrateGBall();
    const btn = document.getElementById('btn-g-cal');
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 250);
    toast('G zero calibrated');
  });

  document.getElementById('btn-motion-perm').addEventListener('click', async () => {
    try {
      const r = await DeviceMotionEvent.requestPermission();
      if (r === 'granted') {
        attachMotionListener();
        document.getElementById('btn-motion-perm').style.display = 'none';
        toast('Sensors enabled');
      } else {
        toast('Sensor permission denied');
      }
    } catch (e) {
      toast('Sensor permission error');
    }
  });

  // ============================================================
  // WAKE LOCK (TWA でも安定動作するように)
  // 重要: WakeLock は visibilitychange で自動解放されるため、
  //       走 rows中は visible に戻ったタイミングで必ず再取得する
  // ============================================================
  let _wakeLockHeld = false;   // ユーザー意図として保持したいか

  async function requestWakeLock() {
    _wakeLockHeld = true;
    await acquireWakeLockInternal();
  }

  async function acquireWakeLockInternal() {
    if (!_wakeLockHeld) return;
    if (!('wakeLock' in navigator)) return;
    if (state.wakeLock) return;  // 既に取得済
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      // 解放イベント（OS 都合や visibility 変更で発火）
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
        // ユーザーが解放したのでなければ、可能なら再取得
        if (_wakeLockHeld && document.visibilityState === 'visible') {
          // 連続再取得を避ける軽い遅延
          setTimeout(acquireWakeLockInternal, 500);
        }
      });
    } catch (e) {
      // 失敗してもユーザー意図は保ち、次の visibility 変更で再試行
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    _wakeLockHeld = false;
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  // 画面が再表示されたら WakeLock を必ず再取得
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _wakeLockHeld) {
      acquireWakeLockInternal();
    }
  });

  // ============================================================
  // CSV EXPORT
  // ============================================================
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (state.csvRows.length === 0) {
      toast('No recorded data');
      return;
    }
    const c = getActiveCourse();
    const header = [
      'ISO_TIME', 'LAT', 'LON', 'ACC_M', 'SPEED_KMH',
      'LAP', 'SECTOR', 'G_LAT', 'G_LON',
      // OBD2 カラム (Phase 1 で BLE 接続時に値が入る、未接続時は空)
      'RPM', 'COOLANT_C', 'OIL_TEMP_C', 'INTAKE_C', 'THROTTLE_PCT',
    ];
    const lines = [header.join(',')].concat(state.csvRows.map(r => r.join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dt = new Date();
    const stamp = dt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `wadachi_${(c?.name || 'session').replace(/\s+/g, '_')}_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    toast(`CSV exported: ${state.csvRows.length} rows`);
  });

  // ============================================================
  // TOAST
  // ============================================================
  let toastTimeout = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ============================================================
  // WARNING SCREEN (startup disclaimer)
  // Shown on every app launch. OK transitions to home.
  // ============================================================
  document.getElementById('btn-warning-ok').addEventListener('click', () => {
    showScreen('home');
    renderHome();
  });

  // ============================================================
  // INIT
  // ============================================================
  // ── 縦画面: MAP + G-ball 横並びレイアウト CSS ──
  (function () {
    if (document.getElementById('pta-portrait-css')) return;
    const s = document.createElement('style');
    s.id = 'pta-portrait-css';
    s.textContent = `
/* MAP + G-ball 横並びラッパー */
.map-gball-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  align-items: stretch;
  min-height: 0;
}
/* MAP: 横幅を flex で広げ、aspect-ratio を外してラッパーの高さに合わせる */
.map-gball-row .course-map-cell {
  flex: 1 1 0;
  margin-top: 0 !important;
  aspect-ratio: auto !important;
  min-height: 0;
}
/* G-ball 枠内の数値テキストを非表示（スライダー横に統一） */
.gball-cell #g-text { display: none !important; }

/* 時系列グラフ */
.analysis-graph-wrap {
  margin: 10px 0;
  padding: 0;
  background: #0d1018;
  border: 1px solid #1c2230;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0 !important;
  height: 190px;
}
.analysis-graph {
  display: block;
  width: 100%;
  height: 190px;
}
/* session 画面の各セクションが flex で圧縮されないように */
.session-main > * { flex-shrink: 0 !important; }
.analysis-map-wrap { flex-shrink: 0 !important; height: 240px; }
.analysis-map { height: 100% !important; }
.map-gball-row .sensors-row {
  flex: 0 0 auto;
  width: 38%;
  max-width: 180px;
  margin-top: 0 !important;
  justify-content: flex-start;
}
.map-gball-row .sensor-cell.gball-cell {
  width: 100% !important;
  max-width: none !important;
}

/* 凡例: 縦並び・小さい文字・左上 */
.course-map-legend {
  flex-direction: column !important;
  gap: 3px !important;
  font-size: 9px !important;
  top: 4px !important;
  left: 5px !important;
  right: auto !important;
}
.cm-dot {
  width: 6px !important;
  height: 6px !important;
}
/* 地図回転スライダー rows（縦画面） */
.map-rot-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0 2px;
}
/* スライダー部分: MAP と同じ flex:1 幅 */
.map-rot-slider-wrap {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.map-rot-icon {
  font-size: 14px;
  color: #7a8499;
  flex-shrink: 0;
}
.map-rot-slider {
  flex: 1;
  accent-color: #ffb800;
  height: 4px;
  cursor: pointer;
  min-width: 0;
}
.map-rot-label {
  font: 11px 'IBM Plex Mono', monospace;
  color: #ffb800;
  min-width: 3em;
  text-align: right;
  flex-shrink: 0;
}
/* G値表示: G-ball と同じ 38% 幅 */
.map-rot-gval {
  flex: 0 0 38%;
  max-width: 180px;
  text-align: center;
  font: bold 16px 'IBM Plex Mono', monospace;
  color: #e0e6f0;
  letter-spacing: 0.04em;
}
`;
    document.head.appendChild(s);
  })();

  renderHome();
  // ============================================================
  // SPLASH → WARNING 自動遷移（2秒）
  // ============================================================
  renderHome();
  showScreen('splash');
  setTimeout(() => {
    showScreen('warning');
  }, 2000);

  // ============================================================
  // (旧 横画面オーバーレイ実装は GT DASH 移植版に統合済み — 上部 Landscape 参照)
  // ============================================================

  // ── 地図回転スライダー: 縦横共通ハンドラ ──────────────────
  function applyMapRot(deg) {
    state.mapRotOffset = deg * Math.PI / 180;
    const s1 = document.getElementById('map-rot-slider');
    const l1 = document.getElementById('map-rot-label');
    if (s1) s1.value = deg;
    if (l1) l1.textContent = deg + '°';
    // コースIDに紐付けて保存
    const c = getActiveCourse();
    if (c) {
      try { localStorage.setItem('pta_maprot_' + c.id, state.mapRotOffset); } catch (_) {}
    }
  }

  document.addEventListener('input', e => {
    if (e.target.id === 'map-rot-slider') {
      applyMapRot(parseInt(e.target.value, 10));
    }
  });

  // ── 走 rows開始/停止時に向きをロック/解除 ────────────────────
  // btn-start-stop のクリック直後にロック状態を切り替え
  const _origStartBtn = document.getElementById('btn-start-stop');
  if (_origStartBtn) {
    _origStartBtn.addEventListener('click', () => {
      // クリック処理が走った後の state.driveActive を確認
      setTimeout(() => {
        if (state.driveActive) {
          Landscape.lockOrientation();
        } else {
          Landscape.unlockOrientation();
        }
      }, 50);
    }, true);
  }

  // 起動時に向きを判定
  setTimeout(() => Landscape.check(), 300);


  // 動作確認できたら下記のコメントを外す
  // if ('serviceWorker' in navigator) {
  //   window.addEventListener('load', () => {
  //     navigator.serviceWorker.register('sw.js').catch(() => {});
  //   });
  // }

  // Re-acquire wake lock on visibility return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.driveActive) {
      requestWakeLock();
    }
  });

})();
