/* 卡塔音乐 — 前端脚本 */
// ============================================================
// State
// ============================================================
let curSort = 'name';
let curPlatform = 'netease';
let curPage = 1, curQuery = '', curSection = 'search', curTotal = 0;
const audio = new Audio();
let currentSong = null;  // {songId, platform, title, artist, cover}

let playlist = [], playIdx = -1;
let searchAbortController = null;  // cancel stale in-flight searches on rapid tab switches

// Play queue — populated by playlist import, or auto-populated from search results.
// When non-empty, player prev/next navigates the queue instead of search results.
let playQueue = [];
let queueIdx = -1;
let queueFromImport = false;  // true = explicit import, false = auto from search
let queueRenderLimit = 50;    // show 50 initially, more on scroll for huge playlists

// Play mode: 'list' (loop), 'single' (repeat one), 'shuffle' (random)
let playMode = 'list';

// Search result cache: key = query → {platform: {songs, total, page}}
// Persists across platform tab switches, cleared on new query.
let searchCache = {};

// Translation cache: preview → download flow
// Key: "songId@platform@lang" → {text, timer}
var lrcCache = {};
var lrcCacheKeys = [];  // ordered by insertion (oldest first), max 3

// ── Per-song stats (platform play/comment count, on-site playing/downloads) ──
var songStatsCache = {};      // "platform|songId" -> {data, ts}
var playHeartbeatTimer = null;

// ── 主题切换 ──
function toggleTheme() {
  // 临时挂载过渡类，让颜色平滑渐变而非瞬间跳变
  document.documentElement.classList.add('theme-transition');
  var light = document.documentElement.classList.toggle('light');
  try { localStorage.setItem('kata_theme', light ? 'light' : 'dark'); } catch(e) {}
  var b = document.getElementById('themeBtn');
  if (b) b.textContent = light ? '☀️' : '🌙';
  clearTimeout(window._themeTimer);
  window._themeTimer = setTimeout(function() {
    document.documentElement.classList.remove('theme-transition');
  }, 400);
}
(function initTheme() {
  var t = 'dark';
  try { t = localStorage.getItem('kata_theme') || 'dark'; } catch(e) {}
  if (t === 'light') {
    document.documentElement.classList.add('light');
    var b = document.getElementById('themeBtn');
    if (b) b.textContent = '☀️';
  }
})();

// ── 收藏 & 播放历史 (localStorage) ──
var favorites = loadJSON('kata_favs', {});
var playHistory = loadJSON('kata_history', []);

function loadJSON(key, fallback) {
  try { var v = JSON.parse(localStorage.getItem(key)); return v || fallback; } catch(e) { return fallback; }
}
function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {} }
function songKey(s) { return (s.platform || '') + '|' + (s.id || s.songId || ''); }
function normalizeSong(s) {
  return { id: s.id || s.songId, platform: s.platform, title: s.title, artist: s.artist,
           cover: s.cover || '', duration: s.duration || 0,
           platform_name: s.platform_name || '', url: s.url || '' };
}

function isFavorite(song) { return !!favorites[songKey(song)]; }
function toggleFavorite(song) {
  if (!song) return;
  var k = songKey(song);
  if (favorites[k]) { delete favorites[k]; toast('已取消收藏'); }
  else { favorites[k] = normalizeSong(song); toast('⭐ 已收藏'); }
  saveJSON('kata_favs', favorites);
  renderLibraryPanel();
}
function recordPlay(song) {
  if (!song) return;
  var k = songKey(song);
  playHistory = playHistory.filter(function(s) { return songKey(s) !== k; });
  playHistory.unshift(normalizeSong(song));
  if (playHistory.length > 50) playHistory = playHistory.slice(0, 50);
  saveJSON('kata_history', playHistory);
}
function clearHistory() {
  playHistory = [];
  saveJSON('kata_history', playHistory);
  renderLibraryPanel();
}

function toggleLibraryPanel() {
  var p = document.getElementById('libraryPanel');
  if (p.classList.contains('show')) p.classList.remove('show');
  else { p.classList.add('show'); renderLibraryPanel(); }
  updatePanelStack();
}

// 当「我的」和「播放队列」同时打开时，上下排列（我的在上、队列在下）
function updatePanelStack() {
  var q = document.getElementById('queuePanel');
  var l = document.getElementById('libraryPanel');
  var qOpen = q.classList.contains('show');
  var lOpen = l.classList.contains('show');
  l.style.bottom = '';
  if (qOpen && lOpen) {
    var qBottom = parseFloat(getComputedStyle(q).bottom) || 75;
    l.style.bottom = (qBottom + q.offsetHeight + 12) + 'px';
  }
}
function renderLibraryPanel() {
  var favArr = Object.values(favorites);
  var countEl = document.getElementById('libraryCount');
  if (countEl) countEl.textContent = (favArr.length + playHistory.length) + ' 首';
  var list = document.getElementById('libraryList');
  var html = '';
  if (favArr.length) {
    html += '<div class="library-section">⭐ 我的收藏</div>';
    html += renderLibraryRows(favArr, true);
  }
  if (playHistory.length) {
    html += '<div class="library-section">🕘 最近播放</div>';
    html += renderLibraryRows(playHistory, false);
  }
  if (!html) html = '<div class="queue-empty">暂无收藏或播放记录</div>';
  list.innerHTML = html;
}
function renderLibraryRows(arr, isFav) {
  return arr.map(function(s, i) {
    var k = songKey(s);
    var coverHtml = (s.cover && s.cover.startsWith('http'))
      ? '<img class="queue-cover-sm" src="' + esc(s.cover) + '" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="queue-cover-sm" style="display:flex;align-items:center;justify-content:center;font-size:14px">🎵</div>';
    return '<div class="queue-item">' +
      '<span class="queue-idx">' + (i + 1) + '</span>' + coverHtml +
      '<div class="queue-info"><div class="q-title">' + esc(s.title) + '</div><div class="q-artist">' + esc(s.artist) + '</div></div>' +
      '<span class="queue-tag">' + esc(s.platform_name || s.platform) + '</span>' +
      '<button class="queue-remove lib-play" data-key="' + esc(k) + '" data-action="play" title="播放">▶</button>' +
      (isFav ? '<button class="queue-remove lib-del" data-key="' + esc(k) + '" data-action="del" title="移除收藏">×</button>' : '') +
    '</div>';
  }).join('');
}
function playLibrarySong(key) {
  var s = favorites[key] || null;
  if (!s) {
    for (var i = 0; i < playHistory.length; i++) {
      if (songKey(playHistory[i]) === key) { s = playHistory[i]; break; }
    }
  }
  if (!s) return;
  playQueue = [s]; queueIdx = 0; queueFromImport = false;
  renderQueuePanel();
  playFromQueue(0);
}

// Library panel: play / remove-favorite via event delegation
document.getElementById('libraryPanel').addEventListener('click', function(e) {
  var btn = e.target.closest('button[data-key]');
  if (!btn) return;
  var key = btn.getAttribute('data-key');
  var action = btn.getAttribute('data-action');
  if (action === 'play') playLibrarySong(key);
  else if (action === 'del') { delete favorites[key]; saveJSON('kata_favs', favorites); renderLibraryPanel(); }
});

// ── Keyboard shortcuts: 空格=播放/暂停, ←/→=±5s, ↑/↓=音量 ──
document.addEventListener('keydown', function(e) {
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (currentSong) playerToggle();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    var nv = Math.min(100, Math.round(audio.volume * 100) + 5);
    playerSetVol(nv);
    document.getElementById('playerVol').value = nv;
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    var nv2 = Math.max(0, Math.round(audio.volume * 100) - 5);
    playerSetVol(nv2);
    document.getElementById('playerVol').value = nv2;
  }
});

function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return n.toLocaleString();
}

function reportPlay(action) {
  if (!currentSong) return;
  fetch('/api/play/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: currentSong.platform, song_id: currentSong.songId, action: action }),
  }).catch(function() {});
}

function startPlayHeartbeat() {
  stopPlayHeartbeat();
  playHeartbeatTimer = setInterval(function() {
    if (currentSong && !audio.paused) {
      reportPlay('heartbeat');
      loadSongStats();  // keep "正在播放" count fresh (client+server cached)
    }
  }, 20000);
}

function stopPlayHeartbeat() {
  if (playHeartbeatTimer) { clearInterval(playHeartbeatTimer); playHeartbeatTimer = null; }
}

function loadSongStats() {
  if (!currentSong) return;
  var cs = currentSong;
  var key = cs.platform + '|' + cs.songId;
  var stats = document.getElementById('playerStats');
  stats.style.display = 'flex';
  var cached = songStatsCache[key];
  if (cached && (Date.now() - cached.ts) < 30000) { renderSongStats(cached.data); return; }
  // Only reset placeholders when actually re-fetching (avoid flicker on refresh)
  ['statPlayCount', 'statCommentCount', 'statSitePlaying', 'statDownloads'].forEach(function(id) {
    document.getElementById(id).textContent = '—';
  });
  document.getElementById('statSitePlayingIcon').textContent = '🔴';
  var url = '/api/song/stats?platform=' + encodeURIComponent(cs.platform) + '&song_id=' + encodeURIComponent(cs.songId);
  if (cs.title) url += '&title=' + encodeURIComponent(cs.title);
  if (cs.artist) url += '&artist=' + encodeURIComponent(cs.artist);
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      songStatsCache[key] = { data: d, ts: Date.now() };
      if (currentSong && currentSong.platform === cs.platform && currentSong.songId === cs.songId) {
        renderSongStats(d);
      }
    })
    .catch(function() {});
}

function renderSongStats(d) {
  if (!d) return;
  document.getElementById('statPlayCount').textContent = (d.play_count > 0) ? fmtCount(d.play_count) : '—';
  document.getElementById('statCommentCount').textContent = (d.comment_count > 0) ? fmtCount(d.comment_count) : '—';
  document.getElementById('statSitePlaying').textContent = fmtCount(d.site_playing);
  document.getElementById('statDownloads').textContent = fmtCount(d.site_downloads);
  document.getElementById('statSitePlayingIcon').textContent = (d.site_playing >= 1) ? '🟢' : '🔴';
}

function openComments() {
  if (!currentSong) return;
  var modal = document.getElementById('commentsModal');
  var body = document.getElementById('commentsModalBody');
  document.getElementById('commentsModalTitle').textContent = '💬 ' + (currentSong.title || '') + ' · 热门评论';
  modal.style.display = 'flex';
  body.innerHTML = '<div style="text-align:center;padding:20px;color:#8c8c8c;"><div class="spinner"></div><p>加载评论中...</p></div>';
  fetch('/api/song/comments?platform=' + encodeURIComponent(currentSong.platform) + '&song_id=' + encodeURIComponent(currentSong.songId))
    .then(function(r) { return r.json(); })
    .then(function(d) { renderComments(d); })
    .catch(function() {
      body.innerHTML = '<div style="text-align:center;padding:20px;color:#8c8c8c;">评论加载失败</div>';
    });
}

function closeComments(e) {
  if (e && e.target && e.target.id !== 'commentsModal') return; // only close on overlay click
  document.getElementById('commentsModal').style.display = 'none';
}

function renderComments(d) {
  var body = document.getElementById('commentsModalBody');
  if (!d || d.unsupported) {
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#8c8c8c;">该平台暂不支持评论查看</div>';
    return;
  }
  var list = d.comments || [];
  if (!list.length) {
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#8c8c8c;">暂无热门评论</div>';
    return;
  }
  var html = '<div class="comments-total">共 ' + fmtCount(d.total) + ' 条评论 · 热评 ' + list.length + ' 条</div>';
  html += list.map(function(c) {
    var avatar = c.avatar
      ? '<img class="comment-avatar" src="' + esc(c.avatar) + '" onerror="this.style.display=\'none\'">'
      : '<span class="comment-avatar comment-avatar-placeholder">🎵</span>';
    return '<div class="comment-item">' +
      '<div class="comment-head">' + avatar +
        '<span class="comment-nick">' + esc(c.nickname || '匿名') + '</span>' +
        '<span class="comment-likes">👍 ' + fmtCount(c.liked) + '</span>' +
      '</div>' +
      '<div class="comment-content">' + esc(c.content || '') + '</div>' +
    '</div>';
  }).join('');
  body.innerHTML = html;
}

function cacheLrc(songId, platform, lang, text) {
  var key = songId + '@' + platform + '@' + lang;
  // Clear previous cache for same key if exists
  if (lrcCache[key]) {
    clearTimeout(lrcCache[key].timer);
    var idx = lrcCacheKeys.indexOf(key);
    if (idx >= 0) lrcCacheKeys.splice(idx, 1);
  }
  // Enforce max 3 entries (FIFO eviction)
  while (lrcCacheKeys.length >= 3) {
    var oldest = lrcCacheKeys.shift();
    clearTimeout(lrcCache[oldest].timer);
    delete lrcCache[oldest];
  }
  // Auto-expire after 30 seconds
  var timer = setTimeout(function() {
    var i = lrcCacheKeys.indexOf(key);
    if (i >= 0) lrcCacheKeys.splice(i, 1);
    delete lrcCache[key];
  }, 30000);
  lrcCache[key] = { text: text, timer: timer };
  lrcCacheKeys.push(key);
}

function getCachedLrc(songId, platform, lang) {
  var key = songId + '@' + platform + '@' + lang;
  var entry = lrcCache[key];
  if (!entry) return null;
  // Consume cache — clear timer and remove entry
  clearTimeout(entry.timer);
  var i = lrcCacheKeys.indexOf(key);
  if (i >= 0) lrcCacheKeys.splice(i, 1);
  delete lrcCache[key];
  return entry.text;
}

function clearSongLrcCache(songId, platform) {
  var prefix = songId + '@' + platform + '@';
  for (var k in lrcCache) {
    if (lrcCache.hasOwnProperty(k) && k.indexOf(prefix) === 0) {
      clearTimeout(lrcCache[k].timer);
      var i = lrcCacheKeys.indexOf(k);
      if (i >= 0) lrcCacheKeys.splice(i, 1);
      delete lrcCache[k];
    }
  }
}

// Global raw lyrics cache — preloaded when a song plays, shared with preview/download
// Key: "songId@platform" → {lines:[{time,text}], loaded:bool, raw:string}
var lyricsDataCache = {};

function getLyricsCacheKey(songId, platform) {
  return songId + '@' + platform;
}

function parseLrcToLines(lrcText) {
  if (!lrcText) return [];
  var lines = lrcText.split('\n');
  var result = [];
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (match) {
      var mins = parseInt(match[1], 10);
      var secs = parseInt(match[2], 10);
      var ms = parseInt(match[3], 10);
      if (match[3].length === 2) ms *= 10;
      var time = mins * 60 + secs + ms / 1000;
      var text = match[4].trim();
      if (text) result.push({ time: time, text: text });
    }
  }
  return result;
}

async function ensureLyricsLoaded(songId, platform) {
  var key = getLyricsCacheKey(songId, platform);
  if (lyricsDataCache[key] && lyricsDataCache[key].loaded) {
    return lyricsDataCache[key];
  }

  // Mark as loading to prevent duplicate requests
  if (!lyricsDataCache[key]) {
    lyricsDataCache[key] = { lines: [], loaded: false, raw: '' };
  }

  try {
    var resp = await fetch('/api/lyrics/' + platform + '/' + songId);
    var data = await resp.json();
    var lrcText = (data && data.lyric) ? data.lyric : '';
    var lines = parseLrcToLines(lrcText);
    lyricsDataCache[key] = { lines: lines, loaded: true, raw: lrcText };
    return lyricsDataCache[key];
  } catch(e) {
    lyricsDataCache[key] = { lines: [], loaded: true, raw: '' };
    return lyricsDataCache[key];
  }
}

function updatePlayerLyrics(currentTime) {
  var elCur = document.getElementById('playerLyricsCurrent');
  var elNext = document.getElementById('playerLyricsNext');
  if (!elCur || !elNext) return;
  if (!currentSong) { elCur.textContent = ''; elNext.textContent = ''; return; }

  var key = getLyricsCacheKey(currentSong.songId, currentSong.platform);
  var cache = lyricsDataCache[key];
  if (!cache || !cache.loaded || !cache.lines.length) {
    elCur.textContent = ''; elNext.textContent = ''; return;
  }

  var lines = cache.lines;
  var curIdx = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].time) { curIdx = i; break; }
  }

  var curText = curIdx >= 0 ? lines[curIdx].text : '';
  var nextText = (curIdx >= 0 && curIdx + 1 < lines.length) ? lines[curIdx + 1].text : '';

  // ── Current line: two-step non-linear scroll ──
  if (elCur.dataset.text !== curText) {
    // Step 1 — exit: slide up + fade out (fast)
    elCur.style.opacity = '0';
    elCur.style.transform = 'translateY(-14px)';
    elCur.style.transitionDuration = '0.14s';

    setTimeout(function() {
      // Step 2 — entry: slide from below + overshoot settle
      elCur.dataset.text = curText;
      elCur.textContent = curText;
      elCur.style.transform = 'translateY(10px)';
      elCur.style.transitionDuration = '0.28s';
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          elCur.style.opacity = '1';
          elCur.style.transform = 'translateY(0)';
        });
      });
    }, 150);
  }

  // ── Next line: dimmer, staggered behind current ──
  if (elNext.dataset.text !== nextText) {
    setTimeout(function() {
      elNext.dataset.text = nextText;
      elNext.style.opacity = '0';
      elNext.style.transform = 'translateY(8px)';
      elNext.style.transitionDuration = '0.12s';
      elNext.textContent = nextText;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          elNext.style.opacity = '';   // back to CSS default (0.45)
          elNext.style.transform = 'translateY(0)';
          elNext.style.transitionDuration = '0.28s';
        });
      });
    }, 40);  // slight stagger after current line starts
  }
}

// ============================================================
// Video / Audio Extraction
// ============================================================

let extractInfo = null;   // cached video info from /api/extract/info
let extractToken = null;  // download token from /api/extract/download
let extractLoading = false;
let extractMode = 'audio'; // 'audio' or 'video'

function toggleExtractSection() {
  var section = document.getElementById('extractSection');
  section.classList.toggle('open');
  if (section.classList.contains('open')) {
    setTimeout(function() {
      document.getElementById('extractUrl').focus();
    }, 400);
  }
}

// Mode switch — audio / video
function switchExtractMode(mode, btn) {
  extractMode = mode;
  document.querySelectorAll('.extract-mode-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');

  var fmtSel = document.getElementById('extractFormat');
  var qualSel = document.getElementById('extractQuality');
  var dlBtn = document.getElementById('btnDownloadExtract');

  if (mode === 'video') {
    // Video: formats → MP4, quality → resolution
    fmtSel.innerHTML = '<option value="mp4">MP4</option><option value="mkv">MKV</option><option value="webm">WebM</option>';
    qualSel.innerHTML = '<option value="480">480p</option><option value="720" selected>720p</option><option value="1080">1080p</option>';
    dlBtn.innerHTML = '⬇ 下载视频';
  } else {
    // Audio: formats → MP3/M4A, quality → bitrate
    fmtSel.innerHTML = '<option value="mp3">MP3</option><option value="m4a">M4A</option><option value="opus">Opus</option><option value="aac">AAC</option>';
    qualSel.innerHTML = '<option value="192">192kbps</option><option value="256">256kbps</option><option value="320">320kbps</option>';
    dlBtn.innerHTML = '⬇ 下载音频';
  }
}

// Click hint tag
document.getElementById('extractHints').addEventListener('click', function(e) {
  var tag = e.target.closest('.hint-tag');
  if (!tag) return;
  var domain = tag.dataset.url || '';
  document.getElementById('extractUrl').placeholder = '粘贴 ' + domain + ' 视频链接...';
  document.getElementById('extractUrl').focus();
});

async function startExtract() {
  var url = document.getElementById('extractUrl').value.trim();
  if (!url) { toast('请先粘贴视频链接'); return; }
  if (!url.startsWith('http')) { toast('请输入有效的视频链接'); return; }

  var section = document.getElementById('extractSection');
  if (!section.classList.contains('open')) {
    section.classList.add('open');
  }

  var btn = document.getElementById('btnExtract');
  var status = document.getElementById('extractStatus');
  var result = document.getElementById('extractResult');
  var progress = document.getElementById('extractProgress');

  if (extractLoading) return;
  extractLoading = true;
  extractInfo = null;
  extractToken = null;

  btn.disabled = true;
  btn.textContent = '⏳ 解析中...';
  status.textContent = '正在解析视频信息...';
  status.className = 'extract-status loading';
  result.style.display = 'none';
  progress.style.display = 'none';

  try {
    var resp = await fetch('/api/extract/info', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: url}),
    });
    var data = await resp.json();

    if (!data.success) {
      status.innerHTML = '<div>❌ ' + (data.error || '解析失败').replace(/\n/g, '<br>') + '</div><div style="margin-top:6px;font-size:12px;color:#ffa39e;">💡 请点击 <b>🔍 解析</b> 重新再试一下</div>';
      status.className = 'extract-status error';
      btn.disabled = false;
      btn.textContent = '🔍 重试';
      extractLoading = false;
      return;
    }

    extractInfo = data;
    status.textContent = '';
    status.className = 'extract-status';

    // Show result card
    result.style.display = '';
    document.getElementById('extractThumb').src = data.thumbnail || '';
    document.getElementById('extractThumb').style.display = data.thumbnail ? '' : 'none';
    document.getElementById('extractTitle').textContent = data.title || '未知标题';
    document.getElementById('extractArtist').textContent = (data.uploader ? 'UP主: ' + data.uploader : '') +
      (data.platform_name ? '  |  ' + data.platform_icon + ' ' + data.platform_name : '');
    var durText = data.duration ? formatDuration(data.duration) : '';
    document.getElementById('extractExtra').textContent = (durText ? '⏱ ' + durText : '');

    btn.textContent = '✅ 已解析';
    btn.disabled = false;
    extractLoading = false;

    toast('✅ 解析成功: ' + (data.title || '').substring(0, 30));

  } catch(e) {
    status.textContent = '❌ 网络错误: ' + e.message;
    status.className = 'extract-status error';
    btn.disabled = false;
    btn.textContent = '🔍 解析';
    extractLoading = false;
  }
}

async function downloadExtracted() {
  if (!extractInfo) {
    toast('请先解析视频链接');
    return;
  }

  var url = document.getElementById('extractUrl').value.trim();
  var fmt = document.getElementById('extractFormat').value;
  var quality = document.getElementById('extractQuality').value;
  var btn = document.getElementById('btnDownloadExtract');
  var progress = document.getElementById('extractProgress');
  var fill = document.getElementById('extractProgressFill');
  var text = document.getElementById('extractProgressText');
  var status = document.getElementById('extractStatus');

  if (extractLoading) return;
  extractLoading = true;

  var isVideo = extractMode === 'video';
  var label = isVideo ? '视频' : '音频';

  btn.disabled = true;
  btn.textContent = '⏳ 提取中...';
  progress.style.display = '';
  fill.style.width = '0%';
  text.textContent = '正在下载' + label + '...';
  status.textContent = '';
  status.className = 'extract-status';

  var progressInterval = setInterval(function() {
    var cur = parseFloat(fill.style.width) || 0;
    if (cur < 90) {
      cur += Math.random() * 6;
      if (cur > 90) cur = 90;
      fill.style.width = cur + '%';
      if (isVideo) {
        text.textContent = '下载中... ' + Math.round(cur) + '%（视频较大，请耐心等待）';
      } else {
        text.textContent = '提取中... ' + Math.round(cur) + '%';
      }
    }
  }, 800);

  try {
    var resp = await fetch('/api/extract/download', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: url, format: fmt, quality: quality, mode: extractMode}),
    });
    var data = await resp.json();

    clearInterval(progressInterval);

    if (!data.success) {
      fill.style.width = '0%';
      text.innerHTML = '❌ ' + (data.error || '提取失败').replace(/\n/g, '<br>') + '<br><span style="font-size:11px;color:#ffa39e;">💡 点击 <b>⬇ 重新下载</b> 再试一下</span>';
      status.innerHTML = '<div>❌ ' + (data.error || '提取失败').replace(/\n/g, '<br>') + '</div><div style="margin-top:6px;font-size:12px;color:#ffa39e;">💡 请点击 <b>⬇ 重新下载</b> 再试一下</div>';
      status.className = 'extract-status error';
      btn.disabled = false;
      btn.textContent = '⬇ 重试';
      extractLoading = false;
      return;
    }

    extractToken = data.token;
    fill.style.width = '100%';
    text.textContent = '✅ 完成！正在下载文件...';

    var a = document.createElement('a');
    a.href = '/api/extract/result?token=' + data.token;
    a.download = data.filename || (label + '.' + (data.ext || 'mp3'));
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    status.textContent = '✅ 下载成功: ' + (data.title || '');
    status.className = 'extract-status';
    btn.disabled = false;
    btn.textContent = '⬇ 重新下载';
    toast('✅ ' + label + '提取成功！');

  } catch(e) {
    clearInterval(progressInterval);
    fill.style.width = '0%';
    text.textContent = '❌ 网络错误: ' + e.message;
    status.textContent = '❌ 网络错误: ' + e.message;
    status.className = 'extract-status error';
    btn.disabled = false;
    btn.textContent = '⬇ 下载' + label;
  } finally {
    extractLoading = false;
  }
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  if (m >= 60) {
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
  }
  return m + ':' + s.toString().padStart(2, '0');
}

// ============================================================
// Pause State Management
// ============================================================
function _isSitePaused() {
  return localStorage.getItem('kata_paused') === '1';
}

function applyPausedState() {
  localStorage.setItem('kata_paused', '1');

  // Hide container + platform bar + player
  var container = document.querySelector('.container');
  if (container) container.style.display = 'none';
  var platformBar = document.querySelector('.platform-bar');
  if (platformBar) platformBar.style.display = 'none';
  var playerBar = document.getElementById('playerBar');
  if (playerBar) playerBar.classList.remove('visible');
  // Pause any playing audio
  audio.pause();

  // Disable search input
  var searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.disabled = true;
    searchInput.placeholder = '网站因某些原因暂停使用';
    searchInput.style.cursor = 'not-allowed';
    searchInput.style.opacity = '0.5';
  }

  // Disable about button
  var aboutBtn = document.querySelector('.about-btn');
  if (aboutBtn) {
    aboutBtn.style.pointerEvents = 'none';
    aboutBtn.style.opacity = '0.4';
    aboutBtn.title = '网站暂停使用中';
  }

  // Show paused banner
  _showPausedBanner();
}

function removePausedState() {
  localStorage.removeItem('kata_paused');

  var container = document.querySelector('.container');
  if (container) container.style.display = '';
  var platformBar = document.querySelector('.platform-bar');
  if (platformBar) platformBar.style.display = '';

  var searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.disabled = false;
    searchInput.placeholder = '搜索歌曲、歌手...';
    searchInput.style.cursor = '';
    searchInput.style.opacity = '';
    setTimeout(function() { searchInput.focus(); }, 100);
  }

  var aboutBtn = document.querySelector('.about-btn');
  if (aboutBtn) {
    aboutBtn.style.pointerEvents = '';
    aboutBtn.style.opacity = '';
    aboutBtn.title = '';
  }

  var banner = document.getElementById('pausedBanner');
  if (banner) banner.remove();
}

function _showPausedBanner() {
  var existing = document.getElementById('pausedBanner');
  if (existing) return;
  var banner = document.createElement('div');
  banner.id = 'pausedBanner';
  banner.className = 'paused-banner';
  banner.innerHTML =
    '<div class="paused-icon">⏸</div>' +
    '<div class="paused-text">网站因某些原因暂停使用</div>' +
    '<div class="paused-subtitle">请稍后再访问</div>';
  var platformBar = document.querySelector('.platform-bar');
  if (platformBar) {
    platformBar.parentNode.insertBefore(banner, platformBar);
  } else {
    document.body.appendChild(banner);
  }
}

// ── Cross-tab sync via localStorage storage event ──
window.addEventListener('storage', function(e) {
  if (e.key === 'kata_paused') {
    if (e.newValue === '1') {
      applyPausedState();
    } else if (e.newValue === null || e.newValue === undefined) {
      removePausedState();
    }
  }
});

// ── Same-tab sync via custom events (fired from admin panel) ──
window.addEventListener('kata-paused', function() { applyPausedState(); });
window.addEventListener('kata-resumed', function() { removePausedState(); });

// ── Initial pause check on page load ──
(function _checkInitialPauseState() {
  // Fast path: check localStorage first
  if (localStorage.getItem('kata_paused') === '1') {
    applyPausedState();
  }
  // Server-side confirmation (async)
  fetch('/api/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.paused) {
        applyPausedState();
      } else if (localStorage.getItem('kata_paused') === '1') {
        // Server says not paused but localStorage says yes — sync up
        removePausedState();
      }
    })
    .catch(function() {
      // Network error — trust localStorage
    });
})();

// ── Periodic pause state polling (every 30s) — so ALL users see
//    the paused/resumed state change without needing to refresh ──
setInterval(function() {
  fetch('/api/admin/pause-status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.paused && !_isSitePaused()) {
        applyPausedState();
      } else if (!data.paused && _isSitePaused()) {
        removePausedState();
      }
    })
    .catch(function() { /* ignore network errors */ });
}, 30000);

// ── SessionStorage-based cache persistence (clears on tab close, survives refresh) ──
(function _restoreCachesFromSession() {
  try {
    var saved = sessionStorage.getItem('kata_searchCache');
    if (saved) {
      var parsed = JSON.parse(saved);
      for (var k in parsed) {
        if (parsed.hasOwnProperty(k)) searchCache[k] = parsed[k];
      }
    }
    var cr = sessionStorage.getItem('kata_coverRetry');
    if (cr) {
      var crParsed = JSON.parse(cr);
      for (var k in crParsed) {
        if (crParsed.hasOwnProperty(k)) coverRetryMap[k] = crParsed[k];
      }
    }
    var lrc = sessionStorage.getItem('kata_lyricsData');
    if (lrc) {
      var lrcParsed = JSON.parse(lrc);
      for (var k in lrcParsed) {
        if (lrcParsed.hasOwnProperty(k) && !lyricsDataCache[k]) {
          lyricsDataCache[k] = lrcParsed[k];
        }
      }
    }
  } catch(e) {}
})();

window.addEventListener('beforeunload', function() {
  try {
    sessionStorage.setItem('kata_searchCache', JSON.stringify(searchCache));
    sessionStorage.setItem('kata_coverRetry', JSON.stringify(coverRetryMap));
    sessionStorage.setItem('kata_lyricsData', JSON.stringify(lyricsDataCache));
  } catch(e) {}
});

// ============================================================
// Init
// ============================================================
document.getElementById('searchInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    if (_isSitePaused()) {
      toast('网站因某些原因暂停使用');
      return;
    }
    hideSuggest();
    doSearch(1);
  }
});

// ── 搜索建议 / 热门搜索 ──
var suggestTimer = null;
function showSuggest(items, isHot) {
  var el = document.getElementById('searchSuggest');
  if (!el) return;
  if (!items || !items.length) { el.style.display = 'none'; return; }
  var html = '<div class="ss-title">' + (isHot ? '🔥 热门搜索' : '🔍 搜索建议') + '</div>';
  html += items.map(function(s, i) {
    return '<div class="ss-item" data-q="' + esc(s) + '"><span class="ss-idx">' + (i + 1) + '</span><span>' + esc(s) + '</span></div>';
  }).join('');
  el.innerHTML = html;
  el.style.display = '';
}
function hideSuggest() { var el = document.getElementById('searchSuggest'); if (el) el.style.display = 'none'; }
function loadHotSearches() {
  fetch('/api/search/hot').then(function(r){ return r.json(); }).then(function(d){ showSuggest(d.hot || [], true); }).catch(function(){});
}
function loadSuggestions(q) {
  fetch('/api/search/suggest?q=' + encodeURIComponent(q)).then(function(r){ return r.json(); }).then(function(d){ showSuggest(d.suggestions || [], false); }).catch(function(){});
}
(function initSearchSuggest() {
  var si = document.getElementById('searchInput');
  var ss = document.getElementById('searchSuggest');
  if (!si || !ss) return;
  si.addEventListener('focus', function() { if (!si.value.trim()) loadHotSearches(); });
  si.addEventListener('input', function() {
    clearTimeout(suggestTimer);
    var q = si.value.trim();
    if (!q) { loadHotSearches(); return; }
    suggestTimer = setTimeout(function() { loadSuggestions(q); }, 250);
  });
  si.addEventListener('blur', function() { setTimeout(hideSuggest, 200); });
  ss.addEventListener('mousedown', function(e) {
    var item = e.target.closest('.ss-item');
    if (!item) return;
    si.value = item.getAttribute('data-q');
    hideSuggest();
    doSearch(1);
  });
})();
document.getElementById('platformTabs').addEventListener('click', function(e) {
  const b = e.target.closest('.platform-tab');
  if (!b) return;
  document.querySelectorAll('.platform-tab').forEach(function(t) { t.classList.remove('active'); });
  b.classList.add('active');
  var newPlatform = b.dataset.platform;

  // Queue tab — show queue view instead of search
  if (newPlatform === 'queue') {
    curPlatform = 'queue';
    showQueueTabView();
    return;
  }

  // Same platform — nothing to do
  if (newPlatform === curPlatform) return;
  curPlatform = newPlatform;

  // Hide queue tab view, restore search views
  document.getElementById('queueTabView').style.display = 'none';
  var sortBar = document.querySelector('.search-bar');
  if (sortBar) sortBar.style.display = '';
  document.getElementById('songList').style.display = '';
  document.getElementById('resultCount').style.display = '';

  if (!curQuery) return;

  // Abort any in-flight search from a previously-selected platform so its
  // response can't overwrite the list we're about to render from cache.
  if (searchAbortController) {
    searchAbortController.abort();
  }

  // Use cached results if this query+platform was fetched before
  if (searchCache[curQuery] && searchCache[curQuery][newPlatform]) {
    var cached = searchCache[curQuery][newPlatform];
    playlist = cached.songs;
    curTotal = cached.total;
    curPage = cached.page || 1;

    // Sync any covers that resolved after the initial cache was stored
    for (var i = 0; i < playlist.length; i++) {
      var s = playlist[i];
      if (!s.cover || !s.cover.startsWith('http')) {
        var ck = s.id + '@' + s.platform;
        var cc = coverRetryMap[ck];
        if (cc && cc !== 'failed') {
          s.cover = cc;
        }
      }
    }

    document.getElementById('loadingArea').style.display = 'none';
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('ncmZone').style.display = 'none';
    renderSongs(cached.songs);
    if (currentSong) updatePlayingIndicator(currentSong.songId);
    document.getElementById('resultCount').textContent = curTotal ? '找到 ' + curTotal + ' 首' : '';
    renderPagination(curPage);
    document.getElementById('songList').classList.remove('skeleton-list');
    return;
  }

  // Cache miss — fetch from server
  doSearch(1);
});

const ncmZ = document.getElementById('ncmZone');
ncmZ.addEventListener('dragover', function(e) { e.preventDefault(); ncmZ.classList.add('drag-over'); });
ncmZ.addEventListener('dragleave', function() { ncmZ.classList.remove('drag-over'); });
ncmZ.addEventListener('drop', function(e) {
  e.preventDefault(); ncmZ.classList.remove('drag-over');
  if (e.dataTransfer.files.length) { document.getElementById('ncmFile').files = e.dataTransfer.files; uploadNcm(); }
});
ncmZ.addEventListener('click', function() { document.getElementById('ncmFile').click(); });
document.getElementById('ncmFile').addEventListener('change', uploadNcm);

audio.addEventListener('timeupdate', function() {
  const pct = audio.duration ? (audio.currentTime/audio.duration)*100 : 0;
  const seek = document.getElementById('playerSeek');
  seek.value = pct;
  seek.style.setProperty('--seek-pct', pct + '%');
  document.getElementById('playerCurTime').textContent = fmtTime(audio.currentTime);
  // Update scrolling lyrics in player bar
  updatePlayerLyrics(audio.currentTime);
  // Update lyrics modal highlight + auto-scroll
  updateLyricsModalHighlight(audio.currentTime);
});
audio.addEventListener('loadedmetadata', function() {
  document.getElementById('playerDur').textContent = fmtTime(audio.duration);
});
audio.addEventListener('play', function() { document.getElementById('playerPlayBtn').textContent = '⏸'; reportPlay('play'); startPlayHeartbeat(); recordPlay(currentSong); });
audio.addEventListener('pause', function() { document.getElementById('playerPlayBtn').textContent = '▶️'; reportPlay('pause'); stopPlayHeartbeat(); });
audio.addEventListener('ended', function() {
  reportPlay('ended');
  stopPlayHeartbeat();
  if (playMode === 'single') {
    audio.currentTime = 0;
    audio.play().catch(function(){});
    return;
  }
  playerNext();
});
audio.addEventListener('error', function() {
  // Stream proxy may return 404 if no audio source is available
  if (audio.src && audio.src.includes('/api/stream/')) {
    audio.src = '';  // prevent endless retry
    document.getElementById('playerBar').classList.remove('loading');
    toast('⚠ 暂无可用音源，请尝试下载');
  }
});
audio.volume = 0.7;

// Lazy-load more queue items on scroll
document.getElementById('queueList').addEventListener('scroll', function() {
  if (queueRenderLimit < playQueue.length) {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 30) {
      queueRenderLimit += 20;
      renderQueuePanel();
    }
  }
});

// Dismissible runtime warning
(function() {
  if (localStorage.getItem('warnDismissed') === '1') {
    var w = document.getElementById('runtimeWarning');
    if (w) w.style.display = 'none';
  }
})();

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      playerToggle();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      audio.currentTime = Math.max(0, audio.currentTime - 5);
      toast('⏪ -5s');
      break;
    case 'ArrowRight':
      e.preventDefault();
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      toast('⏩ +5s');
      break;
    case 'ArrowUp':
      e.preventDefault();
      audio.volume = Math.min(1, audio.volume + 0.1);
      document.getElementById('playerVol').value = audio.volume * 100;
      localStorage.setItem('playerVolume', audio.volume);
      break;
    case 'ArrowDown':
      e.preventDefault();
      audio.volume = Math.max(0, audio.volume - 0.1);
      document.getElementById('playerVol').value = audio.volume * 100;
      localStorage.setItem('playerVolume', audio.volume);
      break;
    case 'Escape':
      e.preventDefault();
      closeLyricsModal();
      closeAbout(e);
      break;
    case 'Slash':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }
      break;
  }
});

// Volume persistence
(function() {
  var saved = localStorage.getItem('playerVolume');
  if (saved !== null) {
    var v = parseFloat(saved);
    if (!isNaN(v) && v >= 0 && v <= 1) {
      audio.volume = v;
      document.getElementById('playerVol').value = Math.round(v * 100);
    }
  }
})();

// ============================================================
// Helpers
// ============================================================
function toast(m, ms) { ms = ms || 2500; const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){t.classList.remove('show');}, ms); }
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

const coverRetryMap = {};
async function retryCover(img, songId, platform) {
  const row = img.closest('.song-row');
  const titleEl = row ? row.querySelector('.title') : null;
  const metaEl = row ? row.querySelector('.meta') : null;
  const title = titleEl ? titleEl.textContent.trim() : '';
  const artist = metaEl ? metaEl.textContent.trim() : '';
  await fetchCoverForSong(songId, platform, title, artist);
  const key = songId + '@' + platform;
  if (coverRetryMap[key] && coverRetryMap[key] !== 'failed') {
    if (img.tagName === 'IMG') {
      img.src = coverRetryMap[key];
    } else {
      var newImg = document.createElement('img');
      newImg.className = 'song-cover';
      newImg.src = coverRetryMap[key];
      newImg.loading = 'lazy';
      img.parentNode.replaceChild(newImg, img);
    }
  } else {
    coverRetryMap[key] = 'failed';
  }
}
function fmtTime(s) { if (!s||isNaN(s)) return '00:00'; const m=Math.floor(s/60), sec=Math.floor(s%60); return m+':'+sec.toString().padStart(2,'0'); }

function switchSort(sort, btn) {
  curSort = sort;
  curSection = 'search';
  document.querySelectorAll('.search-bar .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('searchInput').placeholder = '搜索歌曲、歌手...';
  // Restore search view
  document.getElementById('queueTabView').style.display = 'none';
  var sortBar = document.querySelector('.search-bar');
  if (sortBar) sortBar.style.display = '';
  document.getElementById('ncmZone').style.display = 'none';
  document.getElementById('songList').style.display = '';
  document.getElementById('emptyState').style.display = (playlist && playlist.length) ? 'none' : 'block';
  document.getElementById('pagination').style.display = curTotal > 20 ? 'flex' : 'none';
  document.getElementById('resultCount').style.display = '';
  // Re-sort and re-render if we have results
  if (playlist && playlist.length) {
    // Sync any cached covers into playlist before rendering
    for (var i = 0; i < playlist.length; i++) {
      var s = playlist[i];
      if (!s.cover || !s.cover.startsWith('http')) {
        var key = s.id + '@' + s.platform;
        var cached = coverRetryMap[key];
        if (cached && cached !== 'failed') {
          s.cover = cached;
        }
      }
    }
    renderSongs(playlist);
    if (currentSong) updatePlayingIndicator(currentSong.songId);
  }
}
function switchSection(s) {
  curSection = s;
  var isNcm = s === 'ncm';
  document.querySelectorAll('.search-bar .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  if (isNcm) {
    var ncmBtn = document.querySelector('.search-bar .mode-btn:not([data-sort])');
    if (ncmBtn) ncmBtn.classList.add('active');
  } else {
    var activeSortBtn = document.querySelector('.search-bar .mode-btn[data-sort="'+curSort+'"]');
    if (activeSortBtn) activeSortBtn.classList.add('active');
  }
  document.getElementById('queueTabView').style.display = 'none';
  var sortBar = document.querySelector('.search-bar');
  if (sortBar) sortBar.style.display = isNcm ? 'none' : '';
  document.getElementById('ncmZone').style.display = isNcm ? 'block' : 'none';
  document.getElementById('songList').style.display = isNcm ? 'none' : '';
  document.getElementById('emptyState').style.display = isNcm ? 'none' : (playlist && playlist.length ? 'none' : 'block');
  document.getElementById('pagination').style.display = isNcm ? 'none' : (curTotal > 20 ? 'flex' : 'none');
  document.getElementById('resultCount').style.display = isNcm ? 'none' : '';
  if (!isNcm) document.getElementById('searchInput').focus();
}

// ============================================================
// Search
// ============================================================
async function doSearch(page) {
  if (_isSitePaused()) {
    toast('网站因某些原因暂停使用');
    return;
  }
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;

  // Clear cache when searching for a different song
  if (q !== curQuery) {
    searchCache = {};
  }

  // ── Race-condition guard: capture platform at call time ──
  // When the user rapidly switches tabs, multiple doSearch calls fire in
  // parallel.  The last-clicked platform must win and stale responses must
  // be discarded so the list never shows the wrong platform's results.
  const platform = curPlatform;

  // Abort any still-in-flight search from the previously-selected platform
  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();

  curQuery = q; curPage = page; curSection = 'search';
  document.getElementById('queueTabView').style.display = 'none';
  var sortBar = document.querySelector('.search-bar');
  if (sortBar) sortBar.style.display = '';
  document.getElementById('songList').style.display = '';
  document.getElementById('resultCount').style.display = '';
  document.getElementById('loadingArea').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('ncmZone').style.display = 'none';

  var skeletonHtml = '';
  for (var i = 0; i < 5; i++) {
    skeletonHtml += '<li class="song-item"><div class="skeleton-row">' +
      '<div class="skeleton-cover"></div>' +
      '<div style="flex:1">' +
        '<div class="skeleton-line medium" style="margin-bottom:6px"></div>' +
        '<div class="skeleton-line short"></div>' +
      '</div></div></li>';
  }
  document.getElementById('songList').innerHTML = skeletonHtml;
  document.getElementById('songList').classList.add('skeleton-list');

  try {
    const resp = await fetch('/api/search?q='+encodeURIComponent(q)+'&platform='+platform+'&filter=name&page='+page, {
      signal: searchAbortController.signal
    });
    const data = await resp.json();

    // ── Guard: platform may have changed while the fetch was in flight ──
    if (curPlatform !== platform) return;

    if (data.error) { document.getElementById('songList').innerHTML='<div class="error-box"><h3>搜索失败</h3><p>'+esc(data.error)+'</p></div>'; return; }
    playlist = data.songs;
    renderSongs(data.songs);
    if (currentSong) updatePlayingIndicator(currentSong.songId);
    curTotal = data.total || 0;
    document.getElementById('resultCount').textContent = curTotal ? '找到 '+curTotal+' 首' : '';
    renderPagination(page);

    // Cache results for this query+platform (use captured platform, not live curPlatform)
    if (!searchCache[q]) searchCache[q] = {};
    searchCache[q][platform] = {songs: data.songs, total: data.total, page: page};
  } catch(e) {
    if (e.name === 'AbortError') return;  // silently discard aborted requests
    if (curPlatform === platform) {
      document.getElementById('songList').innerHTML = '<div class="error-box"><h3>搜索失败</h3><p>'+esc(e.message)+'</p></div>';
    }
  } finally {
    // Only clean up skeleton if this platform is still active —
    // a newer request may have already set up its own skeleton.
    if (curPlatform === platform) {
      document.getElementById('loadingArea').style.display = 'none';
      document.getElementById('songList').classList.remove('skeleton-list');
    }
  }
}

function fmtHeat(n) {
  if (!n || n < 1) return '';
  if (n >= 1000000) return (n/1000000).toFixed(1).replace(/\.0$/,'')+'M';
  if (n >= 1000) return (n/1000).toFixed(1).replace(/\.0$/,'')+'k';
  return n.toLocaleString();
}

function proxyCoverUrl(url) {
  if (!url || !url.startsWith('http')) return '';
  // Proxy covers through backend to bypass CDN Referer checks
  return '/api/cover?url=' + encodeURIComponent(url);
}

function renderSongs(songs) {
  const list = document.getElementById('songList');
  if (!songs.length) { list.innerHTML='<div class="empty"><div class="icon">😕</div><p>无结果</p></div>'; return; }

  // Sort by heat if requested
  var sorted = songs.slice();
  if (curSort === 'heat') {
    sorted.sort(function(a, b) { return (b.heat||0) - (a.heat||0); });
  }

  // Pre-compute original index map (O(n)) to avoid O(n²) indexOf in the map callback
  var idxMap = new Map();
  for (var si = 0; si < songs.length; si++) { idxMap.set(songs[si], si); }

  list.innerHTML = sorted.map(function(s,i) {
    var idx = idxMap.get(s);  // original index for toggleSong
    var coverHtml;
    if (s.cover && s.cover.startsWith('http')) {
      // Try direct CDN first, fall back to proxy on error
      var proxyUrl = proxyCoverUrl(s.cover);
      coverHtml = '<img class="song-cover" src="'+esc(s.cover)+'" loading="lazy" onerror="if(this.src!==\''+esc(proxyUrl)+'\'){this.src=\''+esc(proxyUrl)+'\';}">';
    } else {
      coverHtml = '<div class="song-cover" style="display:flex;align-items:center;justify-content:center;color:#595959;font-size:18px;font-weight:bold;flex-shrink:0">🎵</div>';
    }
    var heatHtml = (s.heat && s.heat > 0) ? '<span class="song-heat">🔥 '+fmtHeat(s.heat)+'</span>' : '';
    return '<li class="song-item" id="song-'+s.id+'">'+
      '<div class="song-row" onclick="toggleSong(\''+s.id+'\',\''+s.platform+'\','+idx+')">'+
        '<span class="song-idx">'+(i+1)+'</span>'+
        coverHtml+
        '<div class="song-info">'+
          '<div class="title">'+esc(s.title)+'</div>'+
          '<div class="meta">'+esc(s.artist)+'</div>'+
        '</div>'+
        heatHtml+
        (s.url ? '<span class="song-direct-tag" title="有直链，可直接下载">⚡ 直链</span>' : '')+
        '<span class="song-platform-tag">'+esc(s.platform_name||s.platform)+'</span>'+
        '<span class="song-arrow">▼</span>'+
      '</div>'+
      '<div class="song-detail" id="detail-'+s.id+'"><div style="text-align:center;padding:12px;color:#595959;">加载中...</div></div>'+
    '</li>';
  }).join('');
  // Auto-fetch missing covers
  songs.forEach(function(s) {
    if (!s.cover || !s.cover.startsWith('http')) {
      fetchCoverForSong(s.id, s.platform, s.title, s.artist);
    }
  });
}

async function fetchCoverForSong(songId, platform, title, artist) {
  const key = songId + '@' + platform;
  if (coverRetryMap[key]) return;
  try {
    let url = '/api/song/'+platform+'/'+songId;
    if (title) url += '?title='+encodeURIComponent(title)+'&artist='+encodeURIComponent(artist||'');
    const resp = await fetch(url);
    const d = await resp.json();
    if (d.cover && d.cover.startsWith('http')) {
      coverRetryMap[key] = d.cover;
      var proxyUrl = proxyCoverUrl(d.cover);
      // Also update playlist entry so re-renders pick up the cover
      for (var pi = 0; pi < playlist.length; pi++) {
        if (playlist[pi].id === songId && playlist[pi].platform === platform) {
          playlist[pi].cover = d.cover;
          break;
        }
      }
      // Also update search cache so re-visiting this platform has covers
      if (searchCache[curQuery] && searchCache[curQuery][platform]) {
        for (var ci = 0; ci < searchCache[curQuery][platform].songs.length; ci++) {
          if (searchCache[curQuery][platform].songs[ci].id === songId) {
            searchCache[curQuery][platform].songs[ci].cover = d.cover;
            break;
          }
        }
      }
      // Update visible DOM elements
      document.querySelectorAll('#song-'+songId+' .song-cover').forEach(function(el) {
        if (el.tagName === 'IMG') {
          el.src = d.cover;
          el.onerror = function() {
            if (this.src !== proxyUrl) this.src = proxyUrl;
          };
        } else {
          var img = document.createElement('img');
          img.className = 'song-cover';
          img.src = d.cover;
          img.loading = 'lazy';
          img.alt = title || '';
          img.onerror = function() {
            if (this.src !== proxyUrl) this.src = proxyUrl;
          };
          el.parentNode.replaceChild(img, el);
        }
      });
    }
  } catch(e) {}
}

// ── Shared detail-panel builder (used by toggleSong + expandQueueSong) ──
// Eliminates 4× duplicated HTML template + event-binding blocks.
function buildDetailPanel(detailEl, songId, platform, song, detailId, stopProp) {
  if (detailEl.dataset.loaded === '1') return;
  var lrc = song.lyric || '';
  var link = song.link || '#';
  detailEl.innerHTML = '<div>'+
    '<div class="detail-actions">'+
      '<button class="btn btn-primary dl-btn">⬇ 下载 MP3</button>'+
      '<select class="quality-select" title="下载音质">'+
        '<option value="lossless">无损 FLAC</option>'+
        '<option value="exhigh">高 320k</option>'+
        '<option value="standard">标准 128k</option>'+
      '</select>'+
      '<button class="btn btn-outline btn-sm lrc-btn">📝 下载LRC歌词</button>'+
      '<select class="lrc-lang-select">'+
        '<option value="">不翻译</option>'+
        '<option value="zh">翻译为中文</option>'+
        '<option value="en">翻译为英文</option>'+
      '</select>'+
      '<button class="btn btn-outline btn-sm preview-btn">👁 预览歌词</button>'+
      '<button class="btn btn-outline btn-sm fav-btn">'+ (isFavorite(song) ? '⭐ 已收藏' : '☆ 收藏') +'</button>'+
    '</div>'+
    '<div class="lrc-progress" id="lrc-progress-'+detailId+'"><div class="bar"></div><div class="label">翻译中...</div></div>'+
    '<div class="detail-url">ID: '+songId+' | <a href="'+link+'" target="_blank">源页面 ↗</a></div>'+
    '<div class="lyrics-panel" id="lyrics-'+detailId+'"'+(lrc?' data-fetched="1"':'')+'>'+(lrc?esc(lrc).replace(/\n/g,'<br>'):'')+'</div>'+
    '</div>';
  detailEl.dataset.loaded = '1';

  var title = song.title, artist = song.artist;
  var wrap = stopProp
    ? function(fn) { return function(e) { e.stopPropagation(); fn(); }; }
    : function(fn) { return fn; };

  detailEl.querySelector('.dl-btn').addEventListener('click', wrap(function() {
    var qsel = detailEl.querySelector('.quality-select');
    downloadSong(songId, platform, title, artist, song.url || song.source_url || '', qsel ? qsel.value : 'lossless');
  }));
  detailEl.querySelector('.lrc-btn').addEventListener('click', wrap(function() {
    downloadLrc(songId, platform, title, artist, detailId);
  }));
  detailEl.querySelector('.preview-btn').addEventListener('click', wrap(function() {
    fetchAndPreviewLyrics(songId, platform, detailId);
  }));
  detailEl.querySelector('.fav-btn').addEventListener('click', wrap(function() {
    toggleFavorite(song);
    detailEl.querySelector('.fav-btn').textContent = isFavorite(song) ? '⭐ 已收藏' : '☆ 收藏';
  }));
}

async function toggleSong(songId, platform, idx, shouldAutoPlay) {
  const item = document.getElementById('song-'+songId);
  const detail = document.getElementById('detail-'+songId);

  // If already expanded, just collapse — never interrupt playback
  if (item.classList.contains('expanded')) { item.classList.remove('expanded'); return; }

  // If clicking the currently playing song, just expand to show actions
  // without interrupting playback
  var isCurrentSong = currentSong && currentSong.songId === songId;
  if (isCurrentSong) {
    document.querySelectorAll('.song-item.expanded').forEach(function(e){e.classList.remove('expanded');});
    item.classList.add('expanded');
    // Load detail panel if not already loaded
    buildDetailPanel(detail, songId, platform, playlist[idx], songId, false);
    item.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  // Different song clicked — full stop + play flow
  // Stop any currently playing audio and reset state
  audio.pause();
  audio.src = '';
  document.getElementById('playerPlayBtn').textContent = '▶️';

  document.querySelectorAll('.song-item.expanded').forEach(function(e){e.classList.remove('expanded');});
  item.classList.add('expanded');

  // Show player bar and update info
  document.getElementById('playerBar').classList.add('visible');
  var container = document.querySelector('.container');
  if (container) container.classList.add('player-visible');
  playIdx = idx;
  // Auto-populate queue from search results when no imported playlist is active
  if (!queueFromImport && playlist.length > 0) {
    playQueue = playlist.slice();
    queueIdx = idx;
    queueRenderLimit = 50;
    renderQueuePanel();
  }
  var song = playlist[idx];
  if (song) {
    currentSong = {songId: songId, platform: platform, title: song.title, artist: song.artist, cover: song.cover||'', duration: song.duration||0, url: song.url||''};
    loadSongStats();
    document.getElementById('playerTitle').textContent = song.title || 'Unknown';
    document.getElementById('playerArtist').textContent = song.artist || 'Unknown';
    var durMs = song.duration || 0;
    document.getElementById('playerDur').textContent = fmtTime(durMs / 1000);
    document.getElementById('playerCurTime').textContent = '00:00';
    document.getElementById('playerSeek').value = 0;
    document.getElementById('playerSeek').style.setProperty('--seek-pct', '0%');
    if (song.cover && song.cover.startsWith('http')) {
      var playerCover = document.getElementById('playerCover');
      var proxyUrl = proxyCoverUrl(song.cover);
      playerCover.src = song.cover;
      playerCover.onerror = function() {
        if (this.src !== proxyUrl) this.src = proxyUrl;
      };
    } else {
      loadPlayerCover(songId, platform);
    }
  }

  updatePlayingIndicator(songId);

  // Preload lyrics in background for instant preview/download
  ensureLyricsLoaded(songId, platform);

  buildDetailPanel(detail, songId, platform, playlist[idx], songId, false);

  if (shouldAutoPlay !== false) {
    playCurrentSong(true);
    var songEl = document.getElementById('song-'+songId);
    if (songEl) songEl.scrollIntoView({behavior:'smooth',block:'center'});
  }
}

function toggleLyrics(songId) { document.getElementById('lyrics-'+songId).classList.toggle('show'); }

async function fetchAndPreviewLyrics(songId, platform, detailId) {
  var modal = document.getElementById('lyricsModal');
  var titleEl = document.getElementById('lyricsModalTitle');
  var bodyEl = document.getElementById('lyricsModalBody');

  // Find song info from playlist or queue
  detailId = detailId || songId;
  var songTitle = '', songArtist = '';
  for (var i = 0; i < playlist.length; i++) {
    if (playlist[i].id === songId && playlist[i].platform === platform) {
      songTitle = playlist[i].title || '';
      songArtist = playlist[i].artist || '';
      break;
    }
  }
  if (!songTitle) {
    for (var i = 0; i < playQueue.length; i++) {
      if (playQueue[i].id === songId && playQueue[i].platform === platform) {
        songTitle = playQueue[i].title || '';
        songArtist = playQueue[i].artist || '';
        break;
      }
    }
  }

  // Check if translation language is selected in the detail dropdown
  var detailEl = document.getElementById('detail-'+detailId);
  if (!detailEl) detailEl = document.getElementById('detail-'+songId);
  var sel = detailEl ? detailEl.querySelector('.lrc-lang-select') : null;
  var translateLang = sel ? sel.value : '';

  // Show modal with loading state
  var loadingMsg = translateLang ? '正在翻译歌词...' : '加载歌词中...';
  titleEl.textContent = (songTitle ? songTitle + ' - ' + songArtist : '歌词预览');
  bodyEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#8c8c8c;"><div class="spinner"></div><p>'+loadingMsg+'</p></div>';
  modal.classList.add('show');

  try {
    var lrcText = '';

    if (translateLang) {
      // Build translation URL (same pattern as downloadLrc)
      var url = '/api/lrc/'+platform+'/'+songId;
      if (songTitle && songTitle !== 'Unknown') {
        url += '?title='+encodeURIComponent(songTitle)+'&artist='+encodeURIComponent(songArtist||'');
      }
      url += (url.indexOf('?')>=0 ? '&' : '?') + 'translate='+encodeURIComponent(translateLang);

      // Show translation progress bar
      bodyEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#8c8c8c;">'+
        '<div class="spinner"></div>'+
        '<p>正在翻译歌词，请耐心等待...</p>'+
        '<div class="lrc-progress active" style="max-width:240px;margin:12px auto 0"><div class="bar"></div><div class="label" style="display:block">翻译中...</div></div>'+
        '</div>';

      var resp = await fetch(url);
      if (!resp.ok) {
        var errData = null;
        try { errData = await resp.json(); } catch(e) {}
        throw new Error((errData && errData.error) || '翻译失败 (HTTP '+resp.status+')');
      }
      var blob = await resp.blob();
      lrcText = await blob.text();

      // Cache for potential download
      cacheLrc(songId, platform, translateLang, lrcText);

      // Update title to show translation language
      var langLabel = translateLang==='zh' ? '中文' : '英文';
      titleEl.textContent = (songTitle ? songTitle + ' - ' + songArtist : '歌词预览') + ' [' + langLabel + ']';
    } else {
      // No translation — use global lyrics cache if available
      var cacheEntry = await ensureLyricsLoaded(songId, platform);
      lrcText = cacheEntry.raw || '暂无歌词';
    }

    var lines = parseLrcToLines(lrcText);
    if (lines.length) {
      bodyEl.innerHTML = renderLyricsLines(lines);
    } else {
      bodyEl.innerHTML = (lrcText && lrcText !== '暂无歌词')
        ? esc(lrcText).replace(/\n/g, '<br>')
        : '<div style="text-align:center;padding:40px 20px;color:#8c8c8c;">暂无歌词</div>';
    }
  } catch(e) {
    bodyEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#ffa39e;">加载失败: '+esc(e.message)+'</div>';
  }
}

function closeLyricsModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('lyricsModal').classList.remove('show');
}

function renderLyricsLines(lines) {
  var html = '<div class="lrc-lines">';
  for (var i = 0; i < lines.length; i++) {
    html += '<div class="lrc-line" data-time="' + lines[i].time + '" data-idx="' + i + '" onclick="seekToLyric(' + lines[i].time + ')">' + esc(lines[i].text) + '</div>';
  }
  html += '</div>';
  return html;
}
function seekToLyric(time) { if (audio.src) audio.currentTime = time; }
function updateLyricsModalHighlight(currentTime) {
  var modal = document.getElementById('lyricsModal');
  if (!modal.classList.contains('show')) return;
  var lines = modal.querySelectorAll('.lrc-line');
  if (!lines.length) return;
  var idx = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= parseFloat(lines[i].getAttribute('data-time'))) { idx = i; break; }
  }
  if (idx < 0) return;
  var prev = modal.querySelector('.lrc-line.active');
  if (prev && parseInt(prev.getAttribute('data-idx'), 10) === idx) return;
  if (prev) prev.classList.remove('active');
  lines[idx].classList.add('active');
  lines[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function downloadLrc(songId, platform, title, artist, detailId) {
  // Find the associated language selector (supports both search & queue detail IDs)
  detailId = detailId || songId;
  var detailEl = document.getElementById('detail-'+detailId);
  if (!detailEl) detailEl = document.getElementById('detail-'+songId);
  var sel = detailEl ? detailEl.querySelector('.lrc-lang-select') : null;
  var translateLang = sel ? sel.value : '';

  var url = '/api/lrc/'+platform+'/'+songId;
  if (title && title !== 'Unknown') url += '?title='+encodeURIComponent(title)+'&artist='+encodeURIComponent(artist||'');
  if (translateLang) url += '&translate='+encodeURIComponent(translateLang);

  if (translateLang) {
    var progressEl = document.getElementById('lrc-progress-'+detailId);
    if (!progressEl) progressEl = document.getElementById('lrc-progress-'+songId);
    var langLabel = translateLang==='zh' ? '中文' : '英文';

    // Check if translation is already cached from preview
    var cached = getCachedLrc(songId, platform, translateLang);
    if (cached) {
      // Use cached translation — skip server round-trip
      if (progressEl) {
        progressEl.classList.add('active');
        progressEl.querySelector('.label').textContent = '使用缓存，开始下载...';
      }
      var cBlob = new Blob([cached], { type: 'text/plain;charset=utf-8' });
      var ca = document.createElement('a');
      ca.href = URL.createObjectURL(cBlob);
      ca.download = (title && title !== 'Unknown' ? title : 'song') + '.lrc';
      document.body.appendChild(ca); ca.click(); document.body.removeChild(ca);
      URL.revokeObjectURL(ca.href);
      if (progressEl) { progressEl.classList.remove('active'); }
      toast('✅ 翻译完成 ('+langLabel+')，LRC 已下载（使用缓存）');
      return;
    }

    // Cache miss — clear any stale cache for this song (different lang) and fetch fresh
    clearSongLrcCache(songId, platform);

    if (progressEl) {
      progressEl.classList.add('active');
      progressEl.querySelector('.label').textContent = '翻译中...';
    }

    try {
      var resp = await fetch(url);
      if (!resp.ok) {
        var errData = null;
        try { errData = await resp.json(); } catch(e) {}
        throw new Error((errData && errData.error) || '翻译失败 (HTTP '+resp.status+')');
      }
      var blob = await resp.blob();

      if (progressEl) {
        progressEl.querySelector('.label').textContent = '翻译完成，开始下载...';
        await new Promise(function(r) { setTimeout(r, 400); });
      }

      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      var disp = resp.headers.get('Content-Disposition')||'';
      var fname = null;
      var starMatch = disp.match(/filename\*=UTF-8''([^;]*)/);
      if (starMatch) {
        try { fname = decodeURIComponent(starMatch[1]); } catch(e) { fname = null; }
      }
      if (!fname) {
        var plainMatch = disp.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        fname = plainMatch ? plainMatch[1].replace(/['"]/g,'') : 'song.lrc';
      }
      a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      toast('✅ 翻译完成 ('+langLabel+')，LRC 已下载');
    } catch(e) {
      toast('❌ 翻译失败: '+e.message);
    } finally {
      if (progressEl) progressEl.classList.remove('active');
    }
  } else {
    // No translation — try global lyrics cache first, fall back to direct download
    var cacheKey = getLyricsCacheKey(songId, platform);
    var rawCache = lyricsDataCache[cacheKey];
    if (rawCache && rawCache.loaded && rawCache.raw) {
      // Use cached raw lyrics — skip server round-trip
      var rBlob = new Blob([rawCache.raw], { type: 'text/plain;charset=utf-8' });
      var ra = document.createElement('a');
      ra.href = URL.createObjectURL(rBlob);
      ra.download = (title && title !== 'Unknown' ? title : 'song') + '.lrc';
      document.body.appendChild(ra); ra.click(); document.body.removeChild(ra);
      URL.revokeObjectURL(ra.href);
      toast('📝 LRC 歌词已下载（使用缓存）');
    } else {
      // Fall back to direct server download
      var a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('📝 LRC 歌词下载已开始');
    }
  }
}

// ============================================================
// Player
// ============================================================
async function playSong(songId, platform, title, artist, cover) {
  toast('正在获取音源...');
  try {
    // Stream audio through our server proxy (bypasses CDN referrer blocking)
    var streamUrl = '/api/stream/' + songId + '?platform=' + platform;
    if (title) streamUrl += '&title=' + encodeURIComponent(title);
    if (artist) streamUrl += '&artist=' + encodeURIComponent(artist);
    audio.src = streamUrl;
    audio.play().catch(function(e){toast('播放失败: '+e.message)});
    document.getElementById('playerTitle').textContent = title;
    document.getElementById('playerArtist').textContent = artist;
    if (cover && cover.startsWith('http')) {
      var playerCover = document.getElementById('playerCover');
      var proxyUrl = proxyCoverUrl(cover);
      playerCover.src = cover;
      playerCover.onerror = function() {
        if (this.src !== proxyUrl) this.src = proxyUrl;
      };
    } else {
      loadPlayerCover(songId, platform);
    }
    toast('▶ 正在播放: ' + title);
  } catch(e) {
    toast('❌ 获取音源失败: ' + e.message);
  }
}

async function loadPlayerCover(songId, platform) {
  try {
    const resp = await fetch('/api/song/'+platform+'/'+songId);
    const d = await resp.json();
    if (d.cover && d.cover.startsWith('http')) {
      var playerCover = document.getElementById('playerCover');
      var proxyUrl = proxyCoverUrl(d.cover);
      playerCover.src = d.cover;
      playerCover.onerror = function() {
        if (this.src !== proxyUrl) this.src = proxyUrl;
      };
    }
  } catch(e) {}
}

async function playerToggle() {
  // If no song source loaded yet, load the current song first
  if (!audio.src || audio.src === window.location.href) {
    if (!currentSong) { toast('请先选择一首歌曲'); return; }
    await playCurrentSong();
    return;
  }
  if (audio.paused) {
    // Apply seek bar position before playing
    var seek = document.getElementById('playerSeek');
    if (audio.duration && seek.value > 0) {
      audio.currentTime = (seek.value / 100) * audio.duration;
    }
    audio.play().catch(function(e){toast('播放失败: '+e.message)});
  } else {
    audio.pause();
  }
}

async function playCurrentSong(silent) {
  if (!currentSong) return;
  var cs = currentSong;
  if (!silent) toast('正在获取音源...');
  // Clear old lyrics display & preload lyrics for this song
  document.getElementById('playerLyricsCurrent').textContent = '';
  document.getElementById('playerLyricsNext').textContent = '';
  ensureLyricsLoaded(cs.songId, cs.platform);
  document.getElementById('playerBar').classList.add('loading');
  try {
    // Stream audio through our own server so the browser never hits the CDN
    // directly (NetEase CDN blocks requests without the right Referer header).
    var streamUrl = '/api/stream/' + cs.songId + '?platform=' + cs.platform;
    if (cs.title) streamUrl += '&title=' + encodeURIComponent(cs.title);
    if (cs.artist) streamUrl += '&artist=' + encodeURIComponent(cs.artist);
    if (cs.url) streamUrl += '&url=' + encodeURIComponent(cs.url);
    audio.src = streamUrl;
    var seek = document.getElementById('playerSeek');
    var seekPct = parseFloat(seek.value) || 0;
    if (seekPct > 0) {
      await new Promise(function(resolve) {
        var timeout = setTimeout(resolve, 4000);
        var onMeta = function() {
          clearTimeout(timeout);
          audio.removeEventListener('loadedmetadata', onMeta);
          audio.currentTime = (seekPct / 100) * audio.duration;
          resolve();
        };
        audio.addEventListener('loadedmetadata', onMeta);
      });
    }
    audio.play().catch(function(e){ if (!silent) toast('播放失败: '+e.message); });
    document.getElementById('playerTitle').textContent = cs.title;
    document.getElementById('playerArtist').textContent = cs.artist;
    if (!silent) toast('▶ 正在播放: ' + cs.title);
    updatePlayingIndicator(cs.songId);
  } catch(e) {
    if (!silent) toast('❌ 获取失败，请再次点击播放按钮重试');
  } finally {
    document.getElementById('playerBar').classList.remove('loading');
  }
}

function playerSeekTo(v) {
  document.getElementById('playerSeek').style.setProperty('--seek-pct', v+'%');
  if (audio.duration) {
    audio.currentTime = (v/100)*audio.duration;
    document.getElementById('playerCurTime').textContent = fmtTime(audio.currentTime);
  } else {
    // Show seek preview even before audio is loaded
    var dur = currentSong && currentSong.duration ? currentSong.duration / 1000 : 0;
    if (dur) document.getElementById('playerCurTime').textContent = fmtTime((v/100)*dur);
  }
}
function playerSetVol(v) { audio.volume = v/100; }

function updatePlayingIndicator(songId) {
  document.querySelectorAll('.song-item.playing').forEach(function(el) {
    el.classList.remove('playing');
  });
  if (songId) {
    var el = document.getElementById('song-'+songId);
    if (el) el.classList.add('playing');
  }
}

var scrollTicking = false;
window.addEventListener('scroll', function() {
  if (!scrollTicking) {
    window.requestAnimationFrame(function() {
      var btn = document.getElementById('backToTop');
      if (btn) {
        if (window.scrollY > 400) {
          btn.classList.add('visible');
        } else {
          btn.classList.remove('visible');
        }
      }
      scrollTicking = false;
    });
    scrollTicking = true;
  }
}, { passive: true });

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function playerPrev() {
  // When queue is active, navigate the queue
  if (playQueue.length > 0) {
    if (queueIdx <= 0) { toast('已是第一首'); return; }
    queueIdx--;
    var qs = playQueue[queueIdx];
    await playFromQueue(queueIdx);
    return;
  }
  // Fall back to search results navigation
  var idx = -1;
  if (currentSong) {
    for (var i = 0; i < playlist.length; i++) {
      if (playlist[i].id === currentSong.songId && playlist[i].platform === currentSong.platform) {
        idx = i; break;
      }
    }
  }
  if (idx < 0 && playIdx >= 0) idx = playIdx;
  if (idx <= 0 || !playlist.length) { toast('已是第一首'); return; }
  var prev = playlist[idx - 1];
  await toggleSong(prev.id, prev.platform, idx - 1, false);
  var el = document.getElementById('song-'+prev.id);
  if (el) el.scrollIntoView({behavior:'smooth',block:'center'});
  playerToggle();
}
async function playerNext() {
  // When queue is active, navigate the queue
  if (playQueue.length > 0) {
    if (playMode === 'shuffle') {
      if (playQueue.length === 1) {
        audio.currentTime = 0;
        audio.play().catch(function(){});
        return;
      }
      var newIdx = queueIdx;
      while (newIdx === queueIdx) {
        newIdx = Math.floor(Math.random() * playQueue.length);
      }
      queueIdx = newIdx;
    } else if (queueIdx >= playQueue.length - 1) {
      // List loop — back to beginning
      queueIdx = 0;
    } else {
      queueIdx++;
    }
    await playFromQueue(queueIdx);
    return;
  }
  // Fall back to search results navigation
  var idx = -1;
  if (currentSong) {
    for (var i = 0; i < playlist.length; i++) {
      if (playlist[i].id === currentSong.songId && playlist[i].platform === currentSong.platform) {
        idx = i; break;
      }
    }
  }
  if (idx < 0 && playIdx >= 0) idx = playIdx;
  if (idx < 0 || idx >= playlist.length - 1 || !playlist.length) { toast('已是最后一首'); return; }
  var next = playlist[idx + 1];
  await toggleSong(next.id, next.platform, idx + 1, false);
  var el = document.getElementById('song-'+next.id);
  if (el) el.scrollIntoView({behavior:'smooth',block:'center'});
  playerToggle();
}

// ============================================================
// Play Queue — import playlists and manage the play queue
// ============================================================

function toggleQueuePanel() {
  var panel = document.getElementById('queuePanel');
  if (panel.classList.contains('show')) {
    panel.classList.remove('show');
  } else {
    panel.classList.add('show');
    renderQueuePanel();
  }
  updatePanelStack();
}

function renderQueuePanel() {
  var list = document.getElementById('queueList');
  var count = document.getElementById('queueCount');
  var btn = document.getElementById('playerQueueBtn');

  if (!playQueue.length) {
    list.innerHTML = '<div class="queue-empty">队列为空 · 搜索歌曲或导入歌单</div>';
    count.textContent = '';
    btn.classList.remove('has-queue');
    return;
  }

  count.textContent = playQueue.length + ' 首';
  btn.classList.add('has-queue');
  updateQueueTabBadge();

  // Lazy render: show up to queueRenderLimit items, load more on scroll
  var limit = Math.min(queueRenderLimit, playQueue.length);
  var html = '';
  for (var i = 0; i < limit; i++) {
    var s = playQueue[i];
    var isPlaying = (i === queueIdx);
    var coverHtml;
    if (s.cover && s.cover.startsWith('http')) {
      coverHtml = '<img class="queue-cover-sm" src="' + esc(s.cover) + '" loading="lazy" onerror="this.style.display=\'none\'">';
    } else {
      coverHtml = '<div class="queue-cover-sm" style="display:flex;align-items:center;justify-content:center;font-size:14px">🎵</div>';
    }
    var durStr = s.duration ? fmtTime(s.duration / 1000) : '';
    html += '<div class="queue-item' + (isPlaying ? ' playing' : '') + '" onclick="playFromQueue(' + i + ')" title="点击播放">' +
      '<span class="queue-idx">' + (i + 1) + '</span>' +
      coverHtml +
      '<div class="queue-info">' +
        '<div class="q-title">' + esc(s.title) + '</div>' +
        '<div class="q-artist">' + esc(s.artist) + '</div>' +
      '</div>' +
      '<span class="queue-tag">' + esc(s.platform_name || s.platform) + '</span>' +
      (durStr ? '<span class="queue-dur">' + durStr + '</span>' : '') +
      '<button class="queue-remove" onclick="event.stopPropagation();removeFromQueue(' + i + ')" title="移除">×</button>' +
    '</div>';
  }
  // "Load more" indicator when there are more items
  if (playQueue.length > limit) {
    var remaining = playQueue.length - limit;
    html += '<div class="queue-load-more" id="queueLoadMore" onclick="loadMoreQueue()">' +
      '📋 显示更多 (' + remaining + ' 首剩余)...</div>';
  }
  list.innerHTML = html;

  // Scroll to current playing item
  if (queueIdx >= 0) {
    setTimeout(function() {
      var items = list.querySelectorAll('.queue-item');
      if (items[queueIdx]) {
        items[queueIdx].scrollIntoView({behavior: 'smooth', block: 'nearest'});
      }
    }, 100);
  }
}

function loadMoreQueue() {
  queueRenderLimit += 20;
  renderQueuePanel();
}

// ============================================================
// Queue Tab View — full-screen queue with batch download
// ============================================================

function updateQueueTabBadge() {
  var badge = document.getElementById('queueTabBadge');
  if (badge) {
    if (playQueue.length > 0) {
      badge.textContent = playQueue.length;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

function showQueueTabView() {
  // Hide search / NCM / sort-bar / pagination
  document.getElementById('loadingArea').style.display = 'none';
  document.getElementById('songList').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('ncmZone').style.display = 'none';
  document.getElementById('pagination').style.display = 'none';
  document.getElementById('resultCount').style.display = 'none';
  var sortBar = document.querySelector('.search-bar');
  if (sortBar) sortBar.style.display = 'none';
  // Show queue tab view
  var view = document.getElementById('queueTabView');
  view.style.display = '';
  renderQueueTabView();
}

function renderQueueTabView() {
  var count = document.getElementById('queueTabCount');
  var list = document.getElementById('queueTabList');
  count.textContent = playQueue.length + ' 首';
  updateQueueTabBadge();

  if (!playQueue.length) {
    list.innerHTML = '<div class="empty"><div class="icon">📋</div><p>队列为空</p><p style="font-size:12px;color:#434343">搜索歌曲播放，或导入歌单来填充队列</p></div>';
    document.getElementById('btnBatchSongs').disabled = true;
    document.getElementById('btnBatchLyrics').disabled = true;
    return;
  }

  document.getElementById('btnBatchSongs').disabled = false;
  document.getElementById('btnBatchLyrics').disabled = false;

  var html = '';
  for (var i = 0; i < playQueue.length; i++) {
    var s = playQueue[i];
    var isPlaying = (i === queueIdx);
    var qid = 'queue-' + i;
    var coverHtml;
    if (s.cover && s.cover.startsWith('http')) {
      var proxyUrl = proxyCoverUrl(s.cover);
      coverHtml = '<img class="song-cover" src="' + esc(s.cover) + '" loading="lazy" onerror="if(this.src!==\'' + esc(proxyUrl) + '\'){this.src=\'' + esc(proxyUrl) + '\';}">';
    } else {
      coverHtml = '<div class="song-cover" style="display:flex;align-items:center;justify-content:center;font-size:14px">🎵</div>';
    }
    var durStr = s.duration ? fmtTime(s.duration / 1000) : '';
    var heatHtml = (s.heat && s.heat > 0) ? '<span class="song-heat">🔥 ' + fmtHeat(s.heat) + '</span>' : '';
    html += '<li class="song-item' + (isPlaying ? ' playing' : '') + '" id="' + qid + '">' +
      '<div class="song-row" onclick="expandQueueSong(' + i + ')">' +
        '<span class="song-idx">' + (i + 1) + '</span>' +
        coverHtml +
        '<div class="song-info">' +
          '<div class="title">' + esc(s.title) + '</div>' +
          '<div class="meta">' + esc(s.artist) + '</div>' +
        '</div>' +
        heatHtml +
        '<span class="song-platform-tag">' + esc(s.platform_name || s.platform) + '</span>' +
        (durStr ? '<span class="song-dur" style="font-size:11px;color:#595959;flex-shrink:0">' + durStr + '</span>' : '') +
        '<span class="song-arrow">▼</span>' +
      '</div>' +
      '<div class="song-detail" id="detail-' + qid + '"><div style="text-align:center;padding:12px;color:#595959;">加载中...</div></div>' +
    '</li>';
  }
  list.innerHTML = html;
}

function expandQueueSong(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  var s = playQueue[idx];
  var qid = 'queue-' + idx;
  var item = document.getElementById(qid);
  var detail = document.getElementById('detail-' + qid);
  if (!item || !detail) return;

  if (item.classList.contains('expanded')) {
    item.classList.remove('expanded');
    return;
  }

  // Collapse others
  document.querySelectorAll('#queueTabList .song-item.expanded').forEach(function(e) { e.classList.remove('expanded'); });
  item.classList.add('expanded');

  // If clicking the currently playing song, just expand without interrupting playback
  if (queueIdx === idx) {
    buildDetailPanel(detail, s.id, s.platform, s, qid, true);
    ensureLyricsLoaded(s.id, s.platform);
    return;
  }

  // Different song — play it
  playFromQueue(idx);

  // Populate detail section (one-time)
  buildDetailPanel(detail, s.id, s.platform, s, qid, true);

  // Preload lyrics
  ensureLyricsLoaded(s.id, s.platform);
}

async function batchDownloadSongs() {
  if (!playQueue.length) { toast('队列为空'); return; }
  await runBatchDownload('songs');
}

async function batchDownloadLyrics() {
  if (!playQueue.length) { toast('队列为空'); return; }
  await runBatchDownload('lyrics');
}

var batchCancelToken = null;

async function runBatchDownload(mode) {
  var prog = document.getElementById('batchProgress');
  var fill = document.getElementById('batchProgressFill');
  var text = document.getElementById('batchProgressText');
  var cancelBtn = document.getElementById('btnBatchCancel');
  var btnSongs = document.getElementById('btnBatchSongs');
  var btnLyrics = document.getElementById('btnBatchLyrics');

  btnSongs.disabled = true;
  btnLyrics.disabled = true;
  prog.style.display = '';
  cancelBtn.style.display = '';
  fill.style.width = '0%';
  text.textContent = '准备中...';

  var songs = playQueue.map(function(s) {
    return {id: s.id, platform: s.platform, title: s.title, artist: s.artist};
  });

  try {
    var endpoint = mode === 'songs' ? '/api/batch/download-songs' : '/api/batch/download-lyrics';
    var label = mode === 'songs' ? '歌曲' : '歌词';
    var resp = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({songs: songs}),
    });
    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {error: 'HTTP ' + resp.status}; });
      text.textContent = '❌ ' + (err.error || '请求失败');
      return;
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var doneData = null;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, {stream: true});
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;
        var msg = null;
        try { msg = JSON.parse(line); } catch(e) { continue; }

        if (msg.cancelled) {
          text.textContent = '⚠ 已取消' + (msg.msg ? ': ' + msg.msg : '');
          fill.style.width = '0%';
          return;
        }
        if (msg.done) {
          doneData = msg;
          break;
        }
        if (msg.phase === 'download') {
          var pct = Math.round(((msg.index + 1) / msg.total) * 90);  // 0-90% for download phase
          fill.style.width = pct + '%';
          text.textContent = '下载 ' + label + ': ' + msg.title + ' (' + (msg.index + 1) + '/' + msg.total + ')  ✓' + msg.successCount + ' ✗' + msg.failCount;
        } else if (msg.packing) {
          fill.style.width = '95%';
          text.textContent = '📦 正在打包...';
        }
      }
      if (doneData) break;
    }

    if (!doneData) return;

    if (doneData.error) {
      text.textContent = '❌ ' + doneData.error;
      return;
    }

    // Reset bar for packing phase
    fill.style.width = '0%';
    text.textContent = '📦 打包完成，正在准备下载...';
    batchCancelToken = doneData.token;

    // Download the zip
    fill.style.width = '100%';
    if (doneData.cancelled) {
      text.textContent = '⚠ 已取消，仅下载了 ' + doneData.success + ' / ' + doneData.total + ' 首';
      toast('⚠ 已取消，已下载 ' + doneData.success + ' 首');
    } else {
      text.textContent = '✅ 下载完成！成功 ' + doneData.success + ' / ' + doneData.total;
      toast('✅ 批量下载完成！');
    }
    var a = document.createElement('a');
    a.href = '/api/batch/download-result?token=' + doneData.token + '&name=' + encodeURIComponent(doneData.filename);
    a.download = doneData.filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } catch(e) {
    text.textContent = '❌ ' + e.message;
  } finally {
    batchCancelToken = null;
    btnSongs.disabled = false;
    btnLyrics.disabled = false;
    cancelBtn.style.display = 'none';
  }
}

function cancelBatchDownload() {
  if (!batchCancelToken) return;
  fetch('/api/batch/cancel', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: batchCancelToken}),
  }).catch(function(){});
  document.getElementById('batchProgressText').textContent = '⚠ 正在取消...';
}

async function playFromQueue(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  queueIdx = idx;
  var s = playQueue[idx];

  // Stop current playback
  audio.pause();
  audio.src = '';
  document.getElementById('playerPlayBtn').textContent = '▶️';

  // ── yt-dlp song without platform match → try video extractor ──
  var isYtdl = s.platform === 'ytdl';

  if (isYtdl && !s.source_url) {
    toast('⚠ 该歌曲暂无可用音源，请尝试手动搜索下载');
    document.getElementById('playerBar').classList.remove('loading');
    return;
  }

  // Show player bar
  document.getElementById('playerBar').classList.add('visible');
  var container = document.querySelector('.container');
  if (container) container.classList.add('player-visible');

  // Set current song info
  currentSong = {songId: s.id, platform: s.platform, title: s.title, artist: s.artist, cover: s.cover || '', duration: s.duration || 0, url: s.url || ''};
  loadSongStats();
  document.getElementById('playerTitle').textContent = s.title || 'Unknown';
  document.getElementById('playerArtist').textContent = s.artist || 'Unknown';
  document.getElementById('playerDur').textContent = s.duration ? fmtTime(s.duration / 1000) : '00:00';
  document.getElementById('playerCurTime').textContent = '00:00';
  document.getElementById('playerSeek').value = 0;
  document.getElementById('playerSeek').style.setProperty('--seek-pct', '0%');
  document.getElementById('playerLyricsCurrent').textContent = '';
  document.getElementById('playerLyricsNext').textContent = '';

  // Load cover
  if (s.cover && s.cover.startsWith('http')) {
    var playerCover = document.getElementById('playerCover');
    var proxyUrl = proxyCoverUrl(s.cover);
    playerCover.src = s.cover;
    playerCover.onerror = function() { if (this.src !== proxyUrl) this.src = proxyUrl; };
  } else {
    loadPlayerCover(s.id, s.platform);
  }

  // Update queue panel
  renderQueuePanel();

  // ── Stream or extract audio ──
  document.getElementById('playerBar').classList.add('loading');

  if (isYtdl) {
    // yt-dlp song: extract audio via video extractor
    toast('⏳ 正在从 ' + (s.platform_name || '外站') + ' 获取音源...');
    try {
      var extResp = await fetch('/api/extract/info', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: s.source_url}),
      });
      var extData = await extResp.json();
      if (!extData.success) {
        toast('⚠ 无法获取音源: ' + (extData.error || '未知错误'));
        document.getElementById('playerBar').classList.remove('loading');
        return;
      }
      var dlResp = await fetch('/api/extract/download', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: s.source_url, format: 'mp3', quality: '192', mode: 'audio'}),
      });
      var dlData = await dlResp.json();
      if (!dlData.success) {
        toast('⚠ 获取音源失败');
        document.getElementById('playerBar').classList.remove('loading');
        return;
      }
      audio.src = '/api/extract/result?token=' + dlData.token;
      audio.play().catch(function(e) { toast('播放失败: ' + e.message); });
      toast('▶ ' + s.title + ' - ' + s.artist);
    } catch(e) {
      toast('⚠ 获取音源失败: ' + e.message);
    } finally {
      document.getElementById('playerBar').classList.remove('loading');
    }
  } else {
    // Normal platform song — stream via proxy
    try {
      var streamUrl = '/api/stream/' + s.id + '?platform=' + s.platform;
      if (s.title) streamUrl += '&title=' + encodeURIComponent(s.title);
      if (s.artist) streamUrl += '&artist=' + encodeURIComponent(s.artist);
      audio.src = streamUrl;
      audio.play().catch(function(e) { toast('播放失败: ' + e.message); });
      toast('▶ ' + s.title + ' - ' + s.artist);
    } catch(e) {
      toast('❌ 获取音源失败');
    } finally {
      document.getElementById('playerBar').classList.remove('loading');
    }
  }

  // Update search result highlight if the song is visible
  updatePlayingIndicator(s.id);
  // Also update queue tab view's playing indicator if it's visible
  if (curPlatform === 'queue') {
    var qtl = document.getElementById('queueTabList');
    if (qtl) {
      qtl.querySelectorAll('.song-item.playing').forEach(function(el) { el.classList.remove('playing'); });
      var qItem = document.getElementById('queue-' + idx);
      if (qItem) qItem.classList.add('playing');
    }
  }
}

function removeFromQueue(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  var removed = playQueue[idx];
  playQueue.splice(idx, 1);
  // Adjust current index
  if (idx < queueIdx) queueIdx--;
  else if (idx === queueIdx) {
    // Removed the currently playing song
    if (playQueue.length === 0) {
      queueIdx = -1;
      queueFromImport = false;
      queueRenderLimit = 50;
      audio.pause(); audio.src = '';
      document.getElementById('playerPlayBtn').textContent = '▶️';
      document.getElementById('playerBar').classList.remove('loading');
    } else if (queueIdx >= playQueue.length) {
      queueIdx = playQueue.length - 1;
      playFromQueue(queueIdx);
    } else {
      playFromQueue(queueIdx);
    }
  }
  renderQueuePanel();
  toast('已移除: ' + (removed.title || ''));
}

function clearQueue() {
  var popup = document.getElementById('clearConfirm');
  if (popup) popup.classList.toggle('show');
}

function confirmClearQueue() {
  document.getElementById('clearConfirm').classList.remove('show');
  playQueue = [];
  queueIdx = -1;
  queueFromImport = false;
  queueRenderLimit = 50;
  audio.pause();
  audio.src = '';
  document.getElementById('playerPlayBtn').textContent = '▶️';
  document.getElementById('playerBar').classList.remove('loading');
  currentSong = null;
  renderQueuePanel();
  document.getElementById('queuePanel').classList.remove('show');
  toast('队列已清空');
}

function cancelClearQueue() {
  document.getElementById('clearConfirm').classList.remove('show');
}

function cyclePlayMode() {
  var modes = ['list', 'single', 'shuffle'];
  var icons = {list: '🔁', single: '🔂', shuffle: '🔀'};
  var labels = {list: '列表循环', single: '单曲循环', shuffle: '随机播放'};
  var idx = modes.indexOf(playMode);
  idx = (idx + 1) % modes.length;
  playMode = modes[idx];
  // Update the player-bar mode button
  var modeBtn = document.getElementById('playerModeBtn');
  if (modeBtn) modeBtn.textContent = icons[playMode];
  toast('播放模式: ' + labels[playMode]);
}

// ============================================================

async function importPlaylist() {
  var url = document.getElementById('importUrl').value.trim();
  var status = document.getElementById('importStatus');
  var progress = document.getElementById('importProgress');
  var progressText = document.getElementById('importProgressText');
  var progressFill = document.getElementById('importProgressFill');
  if (!url) { status.textContent = '请输入歌单链接'; status.className = 'queue-import-status error'; return; }

  status.textContent = '正在识别歌单链接...';
  status.className = 'queue-import-status loading';
  progress.style.display = '';
  progressFill.style.width = '10%';
  progressText.textContent = '正在解析...';

  // Simulate progress while waiting (yt-dlp extraction can take 10-60s)
  var progInterval = setInterval(function() {
    var cur = parseFloat(progressFill.style.width) || 10;
    if (cur < 85) {
      cur += Math.random() * 3;
      progressFill.style.width = Math.min(cur, 85) + '%';
      if (cur > 50) progressText.textContent = '正在提取歌单（大型歌单可能需要等待）...';
    }
  }, 1000);

  try {
    var resp = await fetch('/api/playlist/import?url=' + encodeURIComponent(url));
    var data = await resp.json();
    clearInterval(progInterval);

    if (data.error) {
      progressFill.style.width = '0%';
      progress.style.display = 'none';
      status.innerHTML = '❌ ' + esc(data.error).replace(/\n/g, '<br>');
      status.className = 'queue-import-status error';
      return;
    }

    progressFill.style.width = '95%';
    progressText.textContent = '✅ 导入完成，正在加载到播放队列...';

    // Replace queue with imported songs
    playQueue = data.songs;
    queueIdx = 0;
    queueFromImport = true;
    queueRenderLimit = 50;
    renderQueuePanel();
    renderQueueTabView();

    // Show queue panel + switch to queue tab if user is viewing it
    document.getElementById('queuePanel').classList.add('show');
    if (curPlatform === 'queue') showQueueTabView();

    // Start playing first song
    await playFromQueue(0);

    // Close import dialog
    closeImportDialog();

    progressFill.style.width = '100%';
    setTimeout(function() { progress.style.display = 'none'; }, 600);

    status.textContent = '';
    status.className = 'queue-import-status';

    // Build toast with useful info
    var toastMsg = '✅ 已导入 ' + data.total + ' 首';
    if (data.cross_matched) {
      toastMsg += '（' + data.cross_matched + ' 首已匹配平台音源）';
    }
    toastMsg += ' (' + (data.platform_name || data.platform) + ')';
    toast(toastMsg);
  } catch(e) {
    clearInterval(progInterval);
    progressFill.style.width = '0%';
    progress.style.display = 'none';
    status.textContent = '❌ 导入失败: ' + e.message;
    status.className = 'queue-import-status error';
  }
}

function showImportDialog() {
  document.getElementById('importOverlay').classList.add('show');
  document.getElementById('importUrl').value = '';
  document.getElementById('importStatus').textContent = '';
  document.getElementById('importStatus').className = 'queue-import-status';
  document.getElementById('importProgress').style.display = 'none';
  document.getElementById('importProgressFill').style.width = '0%';
  setTimeout(function() { document.getElementById('importUrl').focus(); }, 200);
}

function closeImportDialog(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('importOverlay').classList.remove('show');
  // Reset progress bar
  document.getElementById('importProgress').style.display = 'none';
  document.getElementById('importProgressFill').style.width = '0%';
}

// ============================================================
// Download
// ============================================================
async function downloadSong(songId, platform, title, artist, sourceUrl, quality) {
  // ── yt-dlp songs: use video extractor to download audio ──
  sourceUrl = sourceUrl || '';
  if (platform === 'ytdl') {
    if (!sourceUrl) {
      // Find the source_url from playQueue or playlist
      for (var qi = 0; qi < playQueue.length; qi++) {
        if (playQueue[qi].id === songId) { sourceUrl = playQueue[qi].source_url || ''; break; }
      }
      if (!sourceUrl) {
        for (var pi = 0; pi < playlist.length; pi++) {
          if (playlist[pi].id === songId) { sourceUrl = playlist[pi].source_url || ''; break; }
        }
      }
    }
    if (!sourceUrl) { toast('⚠ 该歌曲无源链接，无法下载'); return; }

    toast('⏳ 正在从外站提取音频...');
    try {
      var dlResp = await fetch('/api/extract/download', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: sourceUrl, format: 'mp3', quality: '192', mode: 'audio'}),
      });
      var dlData = await dlResp.json();
      if (!dlData.success) { toast('⚠ ' + (dlData.error || '提取失败')); return; }
      var a = document.createElement('a');
      a.href = '/api/extract/result?token=' + dlData.token;
      a.download = dlData.filename || (title + '.mp3');
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('✅ 下载成功: ' + (dlData.title || title));
    } catch(e) { toast('❌ 下载失败: ' + e.message); }
    return;
  }

  toast('正在获取下载链接，请耐心等待...');
  try {
    let url = '/api/download/'+platform+'/'+songId;
    var qs = [];
    if (title && title !== 'Unknown') qs.push('title='+encodeURIComponent(title)+'&artist='+encodeURIComponent(artist||''));
    if (sourceUrl) qs.push('url='+encodeURIComponent(sourceUrl));
    if (quality) qs.push('quality='+encodeURIComponent(quality));
    if (qs.length) url += '?'+qs.join('&');
    const resp = await fetch(url);
    const contentType = resp.headers.get('Content-Type') || '';

    if (resp.ok && (contentType.includes('audio') || contentType.includes('octet-stream'))) {
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const disp = resp.headers.get('Content-Disposition')||'';
      // RFC 5987: filename*=UTF-8''percent-encoded — prefer over ASCII filename=
      var fname = null;
      var starMatch = disp.match(/filename\*=UTF-8''([^;]*)/);
      if (starMatch) {
        try { fname = decodeURIComponent(starMatch[1]); } catch(e) { fname = null; }
      }
      if (!fname) {
        var plainMatch = disp.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        fname = plainMatch ? plainMatch[1].replace(/['"]/g,'') : 'song.mp3';
      }
      a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('✅ 下载成功！');
    } else if (!resp.ok) {
      const err = await resp.json();
      toast('❌ '+((err||{}).error||'下载失败')+': '+(err.detail||''));
    } else {
      toast('⚠ 未知响应格式');
    }
  } catch(e) { toast('❌ 下载失败: '+e.message); }
}

// ============================================================
// NCM Upload
// ============================================================
async function uploadNcm() {
  const files = document.getElementById('ncmFile').files;
  if (!files.length) return;
  for (const file of files) {
    const fd = new FormData(); fd.append('file', file);
    try {
      const resp = await fetch('/api/ncm/decrypt', {method:'POST', body:fd});
      if (resp.ok) {
        const blob = await resp.blob(), a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name.replace('.ncm','.mp3');
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        toast('✅ '+file.name+' 解密成功');
      } else { const e = await resp.json(); toast('❌ '+file.name+': '+e.error); }
    } catch(e) { toast('❌ '+file.name+': '+e.message); }
  }
  document.getElementById('ncmFile').value = '';
}

function renderPagination(page) {
  const pg = document.getElementById('pagination');
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(curTotal / perPage));
  if (totalPages <= 1) { pg.style.display = 'none'; return; }

  let html = '<button '+(page<=1?'disabled':'')+' onclick="doSearch('+(page-1)+')">‹ 上一页</button>';
  const pagesToShow = [];
  if (totalPages <= 8) {
    for (let i=1; i<=totalPages; i++) pagesToShow.push(i);
  } else {
    pagesToShow.push(1,2,3);
    if (page > 4) pagesToShow.push('...');
    for (let i=Math.max(4, page-1); i<=Math.min(totalPages-3, page+1); i++) pagesToShow.push(i);
    if (page < totalPages-3) pagesToShow.push('...');
    pagesToShow.push(totalPages-1, totalPages);
  }

  for (const p of pagesToShow) {
    if (p === '...') {
      html += '<span style="padding:6px 4px;color:#595959">…</span>';
    } else {
      html += '<button class="'+(p===page?'active':'')+'" onclick="doSearch('+p+')">'+p+'</button>';
    }
  }

  html += '<input type="number" id="jumpPage" min="1" max="'+totalPages+'" value="'+page+'" style="width:50px;text-align:center;background:#1f1f1f;color:#d9d9d9;border:1px solid #333;border-radius:16px;padding:6px 8px;font-size:12px" onkeydown="if(event.key===\'Enter\'){const v=parseInt(this.value); if(v>=1)doSearch(v)}">'+
    '<button onclick="var v=parseInt(document.getElementById(\'jumpPage\').value); if(v>=1)doSearch(v)" style="padding:6px 12px;background:#fa8c16;color:#fff;border:none;border-radius:16px;cursor:pointer;font-size:12px">跳转</button>';

  html += '<button '+(page>=totalPages?'disabled':'')+' onclick="doSearch('+(page+1)+')">下一页 ›</button>';
  pg.innerHTML = html;
  pg.style.display = 'flex';
}
function openAbout() {
  if (_isSitePaused()) {
    toast('网站因某些原因暂停使用');
    return;
  }
  document.getElementById('aboutOverlay').classList.add('show');
}
function closeAbout(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('aboutOverlay').classList.remove('show');
}
