"""
Video Audio Extractor — powered by yt-dlp + ffmpeg.

Supports extracting audio from 1000+ video sites including:
  - Bilibili (bilibili.com)
  - Douyin / TikTok (douyin.com)
  - Xiaohongshu (xiaohongshu.com)
  - YouTube (youtube.com)
  - Weibo, Kuaishou, and many more.

Dependencies:
    pip install yt-dlp
    ffmpeg must be installed and on PATH (or set FFMPEG_PATH env var)

Usage:
    >>> from platforms.video_extractor import VideoExtractor
    >>> extractor = VideoExtractor()
    >>> info = extractor.get_info("https://www.bilibili.com/video/BV1xx411c7mD")
    >>> print(info["title"], info["duration"])
    >>> audio_path = extractor.extract_audio("https://www.bilibili.com/video/BV1xx411c7mD")
"""

import atexit
import os
import sys
import json
import tempfile
import hashlib
import threading
import time
import re
import urllib.parse
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Optional yt-dlp import
# ---------------------------------------------------------------------------
try:
    import yt_dlp
    from yt_dlp.utils import DownloadError, ExtractorError, UnsupportedError
    _HAS_YTDLP = True
except ImportError:
    _HAS_YTDLP = False
    yt_dlp = None
    DownloadError = Exception
    ExtractorError = Exception
    UnsupportedError = Exception

from core.utils import log, sanitize_filename, build_filename

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Where extracted audio files are stored temporarily
# In production (RENDER=true): /tmp/downloads
# In development: user's Downloads folder
_EXTRACT_DIR = Path(
    "/tmp/downloads" if os.environ.get("RENDER", "").lower() == "true"
    else str(Path.home() / "Downloads")
)
_EXTRACT_DIR.mkdir(parents=True, exist_ok=True)

# Max audio file size to keep in memory cache (bytes)
_MAX_CACHE_SIZE = 200 * 1024 * 1024  # 200 MB

# In-memory token → filepath store (like batch download)
_extract_store: dict[str, str] = {}      # token → filepath
_extract_store_ts: dict[str, float] = {}  # token → timestamp
_extract_store_info: dict[str, dict] = {}  # token → video info
_EXTRACT_TTL = 3600  # 1 hour


def _cleanup_extract_store():
    """Remove expired extracted audio files and stale cookie temp files."""
    now = time.time()
    stale = [t for t, ts in _extract_store_ts.items() if now - ts > _EXTRACT_TTL]
    for t in stale:
        path = _extract_store.pop(t, None)
        _extract_store_ts.pop(t, None)
        _extract_store_info.pop(t, None)
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except Exception:
                pass
    # Also clean up cookie temp files older than the TTL
    _cleanup_cookie_files()


# ---------------------------------------------------------------------------
# Platform URL patterns
# ---------------------------------------------------------------------------
PLATFORM_PATTERNS = [
    ("bilibili", "B站", "🎬", re.compile(r"bilibili\.com|b23\.tv|b22\.top", re.I)),
    ("douyin", "抖音", "🎵", re.compile(r"douyin\.com|tiktok\.com|iesdouyin\.com", re.I)),
    ("xiaohongshu", "小红书", "📕", re.compile(r"xiaohongshu\.com|xhslink\.com", re.I)),
    ("youtube", "YouTube", "▶️", re.compile(r"youtube\.com|youtu\.be", re.I)),
    ("weibo", "微博", "📢", re.compile(r"weibo\.com|weibo\.cn|t\.cn", re.I)),
    ("kuaishou", "快手", "⚡", re.compile(r"kuaishou\.com|chenzhongtech\.com", re.I)),
    ("vimeo", "Vimeo", "🎞️", re.compile(r"vimeo\.com", re.I)),
    ("dailymotion", "Dailymotion", "📺", re.compile(r"dailymotion\.com", re.I)),
]


def detect_platform(url: str) -> tuple[str, str, str]:
    """Return (platform_key, display_name, icon) from URL."""
    for key, name, icon, pattern in PLATFORM_PATTERNS:
        if pattern.search(url):
            return (key, name, icon)
    return ("unknown", "未知平台", "🔗")


# ---------------------------------------------------------------------------
# URL pre-processing — resolve short links, clean tracking params
# ---------------------------------------------------------------------------

# Known short-link domains that need HTTP redirect resolution
_SHORT_LINK_DOMAINS = {
    "b23.tv", "b22.top",
    "v.douyin.com",
    "xhslink.com",
    "t.cn",
    "youtu.be",
}

_TRACKING_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "spm", "scm", "track_id", "share_id", "source", "from_source",
    "share_source", "share_medium", "share_plat", "share_tag",
    "timestamp", "unique_k", "_t", "ref", "clicktime",
]


def _clean_url(url: str) -> str:
    """Strip tracking parameters and normalize the URL."""
    parsed = urllib.parse.urlparse(url)
    query_params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    cleaned = {k: v for k, v in query_params.items()
               if k.lower() not in _TRACKING_PARAMS}
    new_query = urllib.parse.urlencode(cleaned, doseq=True)
    return urllib.parse.urlunparse(parsed._replace(query=new_query, fragment=""))


# ---------------------------------------------------------------------------
# Platform-specific cookie helpers
# ---------------------------------------------------------------------------

# Cache fresh guest cookies per domain (avoids re-fetching every request)
_cookie_cache: dict[str, tuple[float, str]] = {}  # domain → (timestamp, cookie_string)
_COOKIE_TTL = 300  # 5 minutes


def _fetch_guest_cookies(url: str) -> str:
    """Get fresh guest cookies for Douyin/TikTok by simulating a real browser visit.

    Visits the video page itself (not just homepage) with mobile UA to collect
    all cookies that the platform's JavaScript would normally set.

    For Douyin specifically, also injects a synthetic s_v_web_id (verified visitor
    ID) since the real one is only set by JavaScript execution.
    """
    import requests as _req
    import uuid
    import random

    parsed = urllib.parse.urlparse(url)
    domain = parsed.netloc.lower().replace("www.", "")
    homepage = f"{parsed.scheme}://{parsed.netloc}/"

    # Check cache
    now = time.time()
    if domain in _cookie_cache:
        ts, cookies = _cookie_cache[domain]
        if now - ts < _COOKIE_TTL:
            return cookies

    try:
        sess = _req.Session()

        # Step 1: Visit homepage to get initial cookies
        sess.get(
            homepage,
            headers={
                "User-Agent": _USER_AGENTS[1],  # Android Chrome
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
            },
            timeout=15,
            allow_redirects=True,
        )

        # Step 2: Visit the actual video page to get video-specific cookies
        sess.get(
            url,
            headers={
                "User-Agent": _USER_AGENTS[1],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": homepage,
            },
            timeout=15,
            allow_redirects=True,
        )

        # Step 3: Build Netscape cookie file
        netscape_lines = ["# Netscape HTTP Cookie File"]

        # Add synthetic cookies that Douyin expects (set by JS, not HTTP)
        if "douyin.com" in domain:
            # Generate a valid-looking s_v_web_id
            ver_id = f"verify_{random.randint(1000000000000000, 9999999999999999)}_{uuid.uuid4().hex[:16]}"
            synthetic = {
                ".douyin.com": [
                    ("s_v_web_id", ver_id, "/", int(now) + 86400 * 365),
                    ("msToken", uuid.uuid4().hex.upper()[:48], "/", int(now) + 86400 * 7),
                ]
            }
            for cookie_domain, cookies in synthetic.items():
                for name, value, path, expires in cookies:
                    netscape_lines.append(
                        f"{cookie_domain}\tTRUE\t{path}\tFALSE\t{expires}\t{name}\t{value}"
                    )

        # Add real cookies from the session
        for cookie in sess.cookies:
            c_domain = cookie.domain if cookie.domain.startswith(".") else f".{cookie.domain}"
            domain_flag = "TRUE"
            path = cookie.path or "/"
            secure = "TRUE" if cookie.secure else "FALSE"
            expires = str(int(cookie.expires)) if cookie.expires else "0"
            netscape_lines.append(
                f"{c_domain}\t{domain_flag}\t{path}\t{secure}\t{expires}\t{cookie.name}\t{cookie.value}"
            )

        cookie_str = "\n".join(netscape_lines)
        _cookie_cache[domain] = (now, cookie_str)
        log.info(f"[cookies] Got {len(sess.cookies)} real + synthetic cookies for {domain}")
        return cookie_str

    except Exception as e:
        log.debug(f"[cookies] Failed to get cookies for {domain}: {e}")

        # Fallback: provide minimal synthetic cookies
        if "douyin.com" in domain:
            ver_id = f"verify_{random.randint(1000000000000000, 9999999999999999)}_{uuid.uuid4().hex[:16]}"
            lines = [
                "# Netscape HTTP Cookie File",
                f".douyin.com\tTRUE\t/\tFALSE\t{int(now)+86400*365}\ts_v_web_id\t{ver_id}",
                f".douyin.com\tTRUE\t/\tFALSE\t{int(now)+86400*7}\tmsToken\t{uuid.uuid4().hex.upper()[:48]}",
            ]
            cookie_str = "\n".join(lines)
            _cookie_cache[domain] = (now, cookie_str)
            log.info(f"[cookies] Using synthetic fallback cookies for {domain}")
            return cookie_str

        return ""


# List of temp cookie files to clean up at exit
_temp_cookie_files: list[str] = []


def _cleanup_cookie_files():
    """Delete all temp cookie files that were created during extraction."""
    for f in list(_temp_cookie_files):
        try:
            if os.path.isfile(f):
                os.unlink(f)
                log.debug(f"[extract] Cleaned up cookie file: {f[:60]}")
        except Exception:
            pass
    _temp_cookie_files.clear()


# Register atexit so cookie files don't accumulate across server restarts
atexit.register(_cleanup_cookie_files)


def _inject_cookies(opts: dict, url: str) -> None:
    """Mutate opts dict to add a cookiefile for cookie-requiring platforms."""
    parsed = urllib.parse.urlparse(url)
    domain = parsed.netloc.lower().replace("www.", "")

    _COOKIE_PLATFORMS = ("douyin.com", "tiktok.com", "xiaohongshu.com", "xhslink.com")
    if any(d in domain for d in _COOKIE_PLATFORMS):
        cookie_str = _fetch_guest_cookies(url)
        if cookie_str:
            tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".cookies", delete=False, encoding="utf-8")
            tmp.write(cookie_str)
            tmp.close()
            opts["cookiefile"] = tmp.name
            _temp_cookie_files.append(tmp.name)

        # 小红书 anti-bot: add a short delay after cookie fetch so the
        # platform's rate limiting cools down before yt-dlp's request.
        # Without this, the first yt-dlp attempt almost always fails.
        if "xiaohongshu.com" in domain or "xhslink.com" in domain:
            _COOKIE_COOLDOWN = 2.0
            log.info(f"[extract] Waiting {_COOKIE_COOLDOWN}s for 小红书 rate-limit cooldown...")
            time.sleep(_COOKIE_COOLDOWN)


def _normalize_url(url: str) -> str:
    """Convert non-standard platform URLs to standard video URL format.

    This fixes URLs like:
        douyin.com/jingxuan?modal_id=XXX  →  douyin.com/video/XXX
        douyin.com/user/xxx?modal_id=YYY  →  douyin.com/video/YYY
    """
    parsed = urllib.parse.urlparse(url)
    domain = parsed.netloc.lower().replace("www.", "")
    path = parsed.path.rstrip("/")
    query = urllib.parse.parse_qs(parsed.query)

    # ── Douyin / TikTok ──
    if "douyin.com" in domain:
        # /jingxuan?modal_id=XXX → /video/XXX
        # /user/XXX?modal_id=YYY → /video/YYY
        # /search/XXX?modal_id=YYY → /video/YYY
        if "modal_id" in query:
            video_id = query["modal_id"][0]
            new_url = f"https://www.douyin.com/video/{video_id}"
            log.info(f"[normalize] Douyin modal_id → video: ...modal_id={video_id[:8]}...")
            return _clean_url(new_url)
        # /note/XXX is a valid format already
        # /video/XXX is already standard

    # ── Xiaohongshu ──
    if "xiaohongshu.com" in domain:
        # /explore/XXX?xsec_token=... → strip tracking, keep /explore/XXX
        # xhslink.com handled by _resolve_short_link
        cleaned = _clean_url(url)
        return cleaned

    # ── Bilibili ──
    if "bilibili.com" in domain or "b23.tv" in domain:
        # b23.tv short links → resolve via _resolve_short_link
        # Already handled downstream, just clean tracking params
        return _clean_url(url)

    # ── Weibo ──
    if "weibo.com" in domain or "weibo.cn" in domain:
        return _clean_url(url)

    return _clean_url(url)


def _resolve_short_link(url: str) -> str:
    """Follow HTTP redirects for known short-link domains to resolve
    the real video URL before handing it to yt-dlp.
    """
    parsed = urllib.parse.urlparse(url)
    domain = parsed.netloc.lower().replace("www.", "")

    # Only pre-resolve known short-link domains
    if not any(d in domain for d in _SHORT_LINK_DOMAINS):
        return url  # already cleaned by _normalize_url

    try:
        import requests as _req
        resp = _req.head(
            url,
            allow_redirects=True,
            timeout=10,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                    "Version/17.0 Mobile/15E148 Safari/604.1"
                ),
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
        )
        resolved = resp.url
        if resolved and resolved != url and len(resolved) > 20:
            log.info(f"[extract] Resolved short link: {url[:60]} → {resolved[:80]}")
            return _normalize_url(resolved)
    except Exception:
        pass

    return url


# ---------------------------------------------------------------------------
# Common yt-dlp User-Agents (rotated to reduce blocking)
# ---------------------------------------------------------------------------
_USER_AGENTS = [
    # iPhone Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    # Android Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    # Windows Chrome
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    # Mac Safari
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
]


def _make_ydl_opts(extra: dict = None) -> dict:
    """Build a base yt-dlp options dict with sensible defaults."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 60,
        "nocheckcertificate": True,
        "noplaylist": True,
        # Ignore format warnings for unusual extensions (html, etc.)
        "ignore_no_formats_error": True,
        # Don't skip "unusual" extensions — handle them ourselves
        "compat_opts": set(),
        "http_headers": {
            "User-Agent": _USER_AGENTS[int(time.time()) % len(_USER_AGENTS)],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
            "Accept-Encoding": "gzip, deflate",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
        # Allow more extractors to try
        "force_generic_extractor": False,
        "extract_flat": False,
        # Don't raise on "unusual" extensions
        "allow_unplayable_formats": True,
    }

    if extra:
        opts.update(extra)

    return opts


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Douyin direct extractor — disabled: Douyin is fully client-side rendered
# and requires login-level cookies even for public content.  We keep the
# URL normalization (modal_id → video/) and fall through to yt-dlp with
# impersonation + guest cookies.  yt-dlp may still fail on Douyin for now.
# ---------------------------------------------------------------------------

def _douyin_not_supported(url: str) -> dict:
    return {
        "success": False,
        "error": (
            "抖音视频提取暂不支持。\n"
            "原因：抖音要求浏览器Cookie验证，即使公开视频也需要。\n"
            "临时方案：\n"
            "  1. 用手机下载抖音视频\n"
            "  2. 使用「NCM解密」旁边的上传功能提取音频\n"
            "  3. 或在浏览器中打开视频后用录屏工具录制"
        ),
    }


# ---------------------------------------------------------------------------
# Bilibili direct API extractor (bypasses yt-dlp, works when extractor is stale)
# ---------------------------------------------------------------------------

# B站 URL patterns
_RE_BILIBILI_BV = re.compile(r"BV[a-zA-Z0-9]{10}")
_RE_BILIBILI_AV = re.compile(r"av(\d+)", re.I)
_RE_BILIBILI_VIDEO = re.compile(r"bilibili\.com/video/(BV[a-zA-Z0-9]{10}|av\d+)", re.I)
_RE_BILIBILI_B23 = re.compile(r"(b23\.tv|b22\.top)/(\w+)", re.I)

# Max download size for B站 direct downloads (matches yt-dlp's 500MB limit)
_BILI_MAX_SIZE = 500 * 1024 * 1024

_BILI_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def _parse_bilibili_id(url: str) -> tuple[Optional[str], Optional[str]]:
    """Extract (bvid, aid) from a B站 URL. Returns (None, None) if not a B站 video URL."""
    # BV号 (preferred)
    m = _RE_BILIBILI_BV.search(url)
    if m:
        bvid = m.group(0)
        # Also try to extract aid from URL
        av_match = _RE_BILIBILI_AV.search(url)
        aid = av_match.group(1) if av_match else None
        return (bvid, aid)

    # AV号
    m = _RE_BILIBILI_AV.search(url)
    if m:
        return (None, m.group(1))

    return (None, None)


def bilibili_get_info(url: str) -> dict:
    """Get B站 video metadata using official API (no yt-dlp needed).

    Flow:
        1. Parse BV/AV id from URL
        2. POST https://api.bilibili.com/x/web-interface/view → title, cover, duration, cid
        3. Return standard info dict

    This is a FALLBACK used when yt-dlp's bilibili extractor is outdated.
    """
    import requests as _req

    bvid, aid = _parse_bilibili_id(url)
    if not bvid and not aid:
        return {"success": False, "error": "无法从链接中提取 B站视频 ID (BV/AV号)"}

    try:
        # Step 1: Get video info via B站官方 API
        params = {}
        if bvid:
            params["bvid"] = bvid
        else:
            params["aid"] = aid

        resp = _req.get(
            "https://api.bilibili.com/x/web-interface/view",
            params=params,
            headers=_BILI_HEADERS,
            timeout=15,
        )
        data = resp.json()

        if data.get("code") != 0:
            code = data.get("code", -1)
            msg = data.get("message", "未知错误")
            error_map = {
                -400: "请求参数错误",
                -403: "权限不足，视频可能为私密",
                -404: "视频不存在，可能已被删除",
                62002: "视频不可见（私密或审核中）",
                62004: "视频不存在",
            }
            hint = error_map.get(code, msg)
            return {"success": False, "error": f"B站 API 返回错误 (code={code}): {hint}"}

        video_data = data.get("data", {})
        if not video_data:
            return {"success": False, "error": "B站返回数据为空，视频可能不存在"}

        title = video_data.get("title", "未知标题")
        duration = video_data.get("duration", 0)  # seconds
        owner = video_data.get("owner", {})
        uploader = owner.get("name", "")
        pic = video_data.get("pic", "")
        desc = video_data.get("desc", "")[:300]
        cid = video_data.get("cid", 0)
        actual_bvid = video_data.get("bvid", bvid or "")

        # Determine available audio quality from stat
        stat = video_data.get("stat", {})
        view_count = stat.get("view", 0)

        return {
            "success": True,
            "id": actual_bvid or f"av{aid}",
            "title": title,
            "description": desc,
            "duration": duration,
            "thumbnail": pic,
            "uploader": uploader,
            "webpage_url": url,
            "extractor": "bilibili_direct",
            "platform": "bilibili",
            "platform_name": "B站",
            "platform_icon": "🎬",
            "audio_formats": [{
                "format_id": "direct_mp4",
                "ext": "m4a",
                "abr": 128,
                "filesize": 0,
                "acodec": "aac",
            }],
            "has_audio": True,
            "strategy": "bilibili_api",
            # Internal: needed for extract_audio
            "_cid": cid,
            "_bvid": actual_bvid or bvid,
            "_aid": aid,
        }

    except _req.exceptions.Timeout:
        return {"success": False, "error": "连接 B站 API 超时，请检查网络"}
    except _req.exceptions.ConnectionError:
        return {"success": False, "error": "无法连接到 B站 API，请检查网络连接"}
    except Exception as e:
        log.error(f"[bilibili] get_info failed: {e}")
        return {"success": False, "error": f"B站解析失败: {str(e)[:200]}"}


def bilibili_extract(
    url: str,
    output_dir: str,
    mode: str = "audio",
    preferred_format: str = "mp3",
    preferred_quality: str = "192",
) -> dict:
    """Download B站 video or audio using B站 official DASH API + ffmpeg.

    Args:
        url: B站 video URL
        output_dir: where to save output
        mode: 'audio' (MP3/M4A only) or 'video' (MP4 with video+audio)
        preferred_format: audio→'mp3'/'m4a', video→'mp4'
        preferred_quality: audio→bitrate('192'/'256'/'320'), video→height('720'/'1080')

    Steps (audio):
        1. Parse BV/AV → 2. Get cid from view API → 3. Get DASH audio URL
        → 4. Download → 5. ffmpeg → MP3

    Steps (video):
        1. Parse BV/AV → 2. Get cid → 3. Get DASH video+audio URLs
        → 4. Download both → 5. ffmpeg merge → MP4
    """
    import requests as _req
    import shutil
    import subprocess

    bvid, aid = _parse_bilibili_id(url)
    if not bvid and not aid:
        return {"success": False, "error": "无法从链接中提取 B站视频 ID"}

    try:
        # Step 1: Get video info + cid
        params = {"bvid": bvid} if bvid else {"aid": aid}
        resp = _req.get(
            "https://api.bilibili.com/x/web-interface/view",
            params=params, headers=_BILI_HEADERS, timeout=15,
        )
        data = resp.json()
        if data.get("code") != 0:
            return {"success": False, "error": f"B站 API 错误: {data.get('message', '未知')}"}

        video_data = data["data"]
        cid = video_data.get("cid", 0)
        title = video_data.get("title", "Unknown")
        uploader = video_data.get("owner", {}).get("name", "")
        pic = video_data.get("pic", "")
        duration = video_data.get("duration", 0)
        actual_bvid = video_data.get("bvid", bvid or "")

        if not cid:
            return {"success": False, "error": "无法获取视频分片 ID (cid)"}

        # Step 2: Get DASH stream URLs (fnval=16 + fourk=1)
        play_resp = _req.get(
            "https://api.bilibili.com/x/player/playurl",
            params={
                "bvid": actual_bvid or bvid, "cid": cid,
                "qn": 0, "fnval": 16, "fnver": 0, "fourk": 1,
            },
            headers=_BILI_HEADERS, timeout=15,
        )
        play_data = play_resp.json()
        if play_data.get("code") != 0:
            return {"success": False, "error": f"获取播放地址失败: {play_data.get('message', '未知')}"}

        dash = play_data.get("data", {}).get("dash", {})
        if not dash:
            return {"success": False, "error": "该视频不支持 DASH 流（可能是老视频）"}

        audio_streams = dash.get("audio", [])
        if not audio_streams:
            return {"success": False, "error": "该视频没有可用音频流"}

        title_safe = sanitize_filename(title)[:100]
        ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH", "ffmpeg")

        # ── Audio mode ──
        if mode == "audio":
            audio_streams.sort(key=lambda x: x.get("bandwidth", 0), reverse=True)
            best_audio = audio_streams[0]
            audio_url = best_audio.get("baseUrl") or best_audio.get("base_url", "")
            if not audio_url:
                return {"success": False, "error": "无法获取音频流地址"}

            log.info(f"[bilibili:audio] {title[:40]}, {best_audio.get('bandwidth',0)//1000}kbps")

            # Download audio
            mime = best_audio.get("mimeType", "audio/mp4")
            raw_ext = "webm" if "webm" in mime else "m4a"
            raw_path = os.path.join(output_dir, f"{title_safe}_raw.{raw_ext}")

            audio_resp = _req.get(audio_url, headers={**_BILI_HEADERS, "Range": "bytes=0-"},
                                  stream=True, timeout=120)
            audio_resp.raise_for_status()
            total_size = 0
            with open(raw_path, "wb") as f:
                for chunk in audio_resp.iter_content(8192):
                    if chunk:
                        f.write(chunk)
                        total_size += len(chunk)
                        if total_size > _BILI_MAX_SIZE:
                            try: os.unlink(raw_path)
                            except Exception: pass
                            return {"success": False, "error": "音频文件超过 500MB 上限，请尝试低音质"}

            if total_size < 1024:
                try: os.unlink(raw_path)
                except Exception: pass
                return {"success": False, "error": "下载的音频文件过小，请重试"}

            log.info(f"[bilibili:audio] Downloaded {total_size} bytes")

            # Convert to MP3
            out_ext = preferred_format if preferred_format in ("mp3", "m4a", "aac", "opus") else "mp3"
            out_path = os.path.join(output_dir, f"{title_safe}.{out_ext}")
            bitrate_map = {"192": "192k", "256": "256k", "320": "320k"}
            audio_bitrate = bitrate_map.get(preferred_quality, "192k")

            codec_map = {"mp3": "libmp3lame", "m4a": "aac", "aac": "aac", "opus": "libopus"}
            acodec = codec_map.get(out_ext, "libmp3lame")

            ffmpeg_cmd = [
                ffmpeg, "-y", "-i", raw_path,
                "-codec:a", acodec, "-b:a", audio_bitrate,
                "-metadata", f"title={title}",
                "-metadata", f"artist={uploader}",
                out_path,
            ]
            result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=120)
            try: os.unlink(raw_path)
            except Exception: pass

            if result.returncode != 0:
                log.warning(f"[bilibili:audio] ffmpeg failed: {result.stderr[:200]}")
                # Fall back to raw
                if os.path.exists(raw_path): os.rename(raw_path, out_path)
                if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
                    return {"success": False, "error": "音频转换失败"}

            return {
                "success": True, "filepath": out_path, "mode": "audio",
                "filename": os.path.basename(out_path), "title": title,
                "duration": duration, "filesize": os.path.getsize(out_path),
                "ext": out_ext, "thumbnail": pic, "uploader": uploader,
                "extractor": "bilibili_direct", "webpage_url": url,
            }

        # ── Video mode ──
        else:
            # Pick best video + audio streams
            video_streams = dash.get("video", [])
            if not video_streams:
                return {"success": False, "error": "该视频没有可用的视频流"}

            # Filter by target quality
            target_height = int(preferred_quality) if preferred_quality.isdigit() else 720
            # Sort video streams by quality (closest to target)
            video_streams.sort(key=lambda x: (
                abs(x.get("height", 0) or x.get("width", 0) or 0 - target_height),
                -(x.get("bandwidth", 0))
            ))
            best_video = video_streams[0]
            video_url = best_video.get("baseUrl") or best_video.get("base_url", "")

            audio_streams.sort(key=lambda x: x.get("bandwidth", 0), reverse=True)
            best_audio = audio_streams[0]
            audio_url = best_audio.get("baseUrl") or best_audio.get("base_url", "")

            if not video_url or not audio_url:
                return {"success": False, "error": "无法获取视频/音频流地址"}

            v_height = best_video.get("height", "?")
            log.info(f"[bilibili:video] {title[:30]}, {v_height}p, video={best_video.get('bandwidth',0)//1000}k, audio={best_audio.get('bandwidth',0)//1000}k")

            # Download video stream
            v_mime = best_video.get("mimeType", "video/mp4")
            v_raw_ext = "webm" if "webm" in v_mime else "mp4"
            v_raw_path = os.path.join(output_dir, f"{title_safe}_v.{v_raw_ext}")

            v_resp = _req.get(video_url, headers={**_BILI_HEADERS, "Range": "bytes=0-"},
                              stream=True, timeout=180)
            v_resp.raise_for_status()
            v_size = 0
            with open(v_raw_path, "wb") as f:
                for chunk in v_resp.iter_content(65536):
                    if chunk:
                        f.write(chunk)
                        v_size += len(chunk)
                        if v_size > _BILI_MAX_SIZE:
                            try: os.unlink(v_raw_path)
                            except Exception: pass
                            return {"success": False, "error": "视频流超过 500MB 上限，请尝试低画质"}
            log.info(f"[bilibili:video] Video stream: {v_size} bytes")

            # Download audio stream
            a_mime = best_audio.get("mimeType", "audio/mp4")
            a_raw_ext = "webm" if "webm" in a_mime else "m4a"
            a_raw_path = os.path.join(output_dir, f"{title_safe}_a.{a_raw_ext}")

            a_resp = _req.get(audio_url, headers={**_BILI_HEADERS, "Range": "bytes=0-"},
                              stream=True, timeout=120)
            a_resp.raise_for_status()
            a_size = 0
            with open(a_raw_path, "wb") as f:
                for chunk in a_resp.iter_content(65536):
                    if chunk:
                        f.write(chunk)
                        a_size += len(chunk)
                        if a_size > _BILI_MAX_SIZE:
                            for p in (v_raw_path, a_raw_path):
                                try: os.unlink(p)
                                except Exception: pass
                            return {"success": False, "error": "音频流超过 500MB 上限，请重试"}
            log.info(f"[bilibili:video] Audio stream: {a_size} bytes")

            if v_size < 1024 or a_size < 1024:
                for p in (v_raw_path, a_raw_path):
                    try: os.unlink(p)
                    except Exception: pass
                return {"success": False, "error": "下载的视频/音频流过小，请重试"}

            # Merge video + audio with ffmpeg (fast stream copy)
            out_path = os.path.join(output_dir, f"{title_safe}.mp4")
            merge_cmd = [
                ffmpeg, "-y",
                "-i", v_raw_path, "-i", a_raw_path,
                "-c:v", "copy", "-c:a", "aac",
                "-b:a", "192k",
                "-metadata", f"title={title}",
                "-metadata", f"artist={uploader}",
                "-movflags", "+faststart",
                out_path,
            ]
            result = subprocess.run(merge_cmd, capture_output=True, text=True, timeout=180)

            # Clean up raw files
            for p in (v_raw_path, a_raw_path):
                try: os.unlink(p)
                except Exception: pass

            if result.returncode != 0:
                log.warning(f"[bilibili:video] ffmpeg merge failed: {result.stderr[:200]}")
                return {"success": False, "error": "视频合并失败（ffmpeg 错误）"}

            if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                return {
                    "success": True, "filepath": out_path, "mode": "video",
                    "filename": os.path.basename(out_path), "title": title,
                    "duration": duration, "filesize": os.path.getsize(out_path),
                    "ext": "mp4", "thumbnail": pic, "uploader": uploader,
                    "extractor": "bilibili_direct", "webpage_url": url,
                }

            return {"success": False, "error": "视频合并后输出文件无效"}

    except _req.exceptions.Timeout:
        return {"success": False, "error": "B站请求超时，请检查网络"}
    except Exception as e:
        log.error(f"[bilibili] extract failed: {e}")
        return {"success": False, "error": f"B站提取失败: {str(e)[:200]}"}


# ---------------------------------------------------------------------------
# VideoExtractor (yt-dlp based, with B站 direct API fallback)
# ---------------------------------------------------------------------------
class VideoExtractor:
    """Extract audio from video URLs using yt-dlp."""

    def __init__(self):
        self._check_dependencies()

    @staticmethod
    def _check_dependencies():
        if not _HAS_YTDLP:
            raise RuntimeError(
                "yt-dlp is not installed. Run: pip install yt-dlp"
            )

    @staticmethod
    def _find_ffmpeg() -> Optional[str]:
        """Locate ffmpeg binary. Checks env var first, then PATH."""
        env_path = os.environ.get("FFMPEG_PATH", "")
        if env_path and os.path.isfile(env_path):
            return env_path

        import shutil
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            return ffmpeg

        if sys.platform == "win32":
            common = [
                r"C:\ffmpeg\bin\ffmpeg.exe",
                r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\ffmpeg\bin\ffmpeg.exe"),
            ]
            for p in common:
                if os.path.isfile(p):
                    return p

        return None

    # ------------------------------------------------------------------
    # Error message translation
    # ------------------------------------------------------------------
    @staticmethod
    def _translate_error(msg: str, url: str = "") -> str:
        """Turn yt-dlp errors into user-friendly Chinese messages,
        with platform-specific hints."""
        msg_lower = msg.lower()
        platform_key, platform_name, _ = detect_platform(url)

        # -- "html extension unusual" — the error the user reported --
        if "html" in msg_lower and ("unusual" in msg_lower or "extension" in msg_lower):
            if platform_key == "douyin":
                return (
                    "❌ 抖音链接解析失败，该链接可能已失效或为私密视频。\n"
                    "💡 请确认：\n"
                    "  1. 链接是完整的视频分享链接（非主页/个人页链接）\n"
                    "  2. 视频没有被删除或设为私密\n"
                    "  3. 尝试从抖音 App 重新复制分享链接"
                )
            elif platform_key == "xiaohongshu":
                return (
                    "❌ 小红书链接解析失败，该平台需要 Cookie 才能提取。\n"
                    "💡 临时方案：将视频下载到手机后用「NCM 解密」功能提取音频"
                )
            elif platform_key == "bilibili":
                return (
                    "❌ B站链接解析失败，请确认链接格式。\n"
                    "💡 支持的格式：\n"
                    "  • https://www.bilibili.com/video/BVxxxxxx\n"
                    "  • https://www.bilibili.com/video/av123456\n"
                    "  • https://b23.tv/xxxxx"
                )
            elif platform_key == "youtube":
                return (
                    "❌ YouTube 链接解析失败。\n"
                    "💡 请确认视频是否为公开视频，且链接完整"
                )
            else:
                return (
                    "❌ 链接解析失败：页面返回了非视频内容。\n"
                    "💡 可能原因：\n"
                    "  1. 该平台需要登录/Cookie 才能访问\n"
                    "  2. 视频已被删除或设为私密\n"
                    "  3. 链接不是直接指向视频页面（如主页、个人页）\n"
                    "  4. 该平台暂不支持视频提取"
                )

        # -- Common errors --
        if "no video formats" in msg_lower and "youtube" in msg_lower:
            return (
                "❌ YouTube 未找到可用视频格式。\n"
                "💡 该视频可能：\n"
                "  1. 有地区限制或年龄限制\n"
                "  2. 为私有/未列出视频\n"
                "  3. 已被删除或下架\n"
                "💡 请尝试点击「重新下载」重试，或更换视频链接"
            )
        if "no video formats" in msg_lower:
            if platform_key == "xiaohongshu":
                return (
                    "❌ 小红书未找到可下载的视频格式。\n"
                    "💡 请点击「重新下载」再试一次（首次可能因平台限流失败）"
                )
            return (
                "❌ 未找到可下载的视频格式。\n"
                "💡 请点击「重新下载」重试，或尝试切换提取模式"
            )
        if "private video" in msg_lower or "private" in msg_lower:
            return "该视频为私密视频，无法访问"
        if "video unavailable" in msg_lower or "unavailable" in msg_lower:
            return "视频不可用，可能已被删除或下架"
        if "login required" in msg_lower or "login" in msg_lower:
            if platform_key == "douyin":
                return "抖音视频提取需要登录，暂不支持（平台限制）"
            return "该平台需要登录才能访问此视频"
        if "not a valid url" in msg_lower:
            return "无效的视频链接，请确认链接格式正确"
        if "unsupported url" in msg_lower:
            return "不支持的视频链接格式，目前暂不支持该平台"
        if "georestricted" in msg_lower or "geo" in msg_lower:
            return "该视频有地区限制，无法在当前网络环境访问"
        if "ffmpeg" in msg_lower or "ffprobe" in msg_lower:
            return "缺少 ffmpeg，无法转换音频格式。请联系管理员安装 ffmpeg"
        if "copyright" in msg_lower or "dmca" in msg_lower:
            return "该视频因版权原因无法提取"
        if "age" in msg_lower and ("restrict" in msg_lower or "limit" in msg_lower):
            return "该视频有年龄限制，无法提取"
        if "not found" in msg_lower or "404" in msg or "410" in msg:
            return "视频未找到（404），链接可能已失效"
        if "timed out" in msg_lower or "timeout" in msg_lower:
            return "连接超时，请检查网络后重试"

        # Shorten overly long errors
        if len(msg) > 300:
            msg = msg[:300] + "..."

        return f"提取失败: {msg}"

    # ------------------------------------------------------------------
    # get_info — parse video metadata
    # ------------------------------------------------------------------
    def get_info(self, url: str) -> dict:
        """Extract video metadata without downloading.

        Uses multi-pass approach:
        1. B站 URLs → direct B站 API (fastest, no yt-dlp needed)
        2. Short links → HTTP redirect resolution
        3. yt-dlp with multiple extractor strategies

        Returns:
            dict with keys: success, title, duration, thumbnail, uploader,
                            platform, audio_formats, etc.
        """
        # Pre-process the URL: normalize → resolve short links
        original_url = url
        url = _normalize_url(url)
        if url != original_url:
            log.info(f"[extract] Normalized URL: {original_url[:60]} → {url[:80]}")
        url = _resolve_short_link(url)
        platform_key, platform_name, _ = detect_platform(url)

        # ── Douyin: requires cookies even for public content — show helpful message ──
        if platform_key == "douyin":
            return _douyin_not_supported(url)

        # ── B站: use direct API (bypasses yt-dlp entirely) ──
        if platform_key == "bilibili":
            result = bilibili_get_info(url)
            if result.get("success"):
                log.info(f"[extract] B站 direct API: {result['title'][:60]}")
                return result
            log.info(f"[extract] B站 API failed ({result.get('error','?')}), falling back to yt-dlp...")

        # Build ydl options — strategy 1: normal extraction
        # Inject guest cookies for platforms that need them (小红书 etc.)
        ydl_opts = _make_ydl_opts({"skip_download": True})

        # 小红书/YouTube anti-bot: first attempt often fails with rate limiting.
        # Auto-retry once so the user doesn't have to click the button twice.
        _RETRY_PLATFORMS = ("xiaohongshu", "youtube")
        _MAX_RETRIES = 2 if platform_key in _RETRY_PLATFORMS else 1

        last_error = None

        # Strategy order: each more permissive than the last
        strategies = [
            ("normal", {}),
            ("generic", {"force_generic_extractor": True}),
            ("desktop_ua", {
                "http_headers": {
                    "User-Agent": _USER_AGENTS[2],
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9",
                }
            }),
        ]

        for retry in range(_MAX_RETRIES):
            # Only fetch/inject cookies on first retry to avoid re-fetch
            if retry == 0:
                _inject_cookies(ydl_opts, url)

            for strategy_name, strategy_opts in strategies:
                try:
                    opts = dict(ydl_opts)
                    if "http_headers" in strategy_opts:
                        hh = dict(opts.get("http_headers", {}))
                        hh.update(strategy_opts.pop("http_headers", {}))
                        opts["http_headers"] = hh
                    opts.update(strategy_opts)

                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        if info is None:
                            last_error = "未能解析视频信息"
                            continue
                        if info.get("_type") == "playlist":
                            entries = info.get("entries", [])
                            if entries:
                                info = entries[0]
                            else:
                                last_error = "链接指向播放列表而非单个视频"
                                continue

                        audio_formats = []
                        for fmt in info.get("formats", []):
                            acodec = fmt.get("acodec", "")
                            if acodec and acodec != "none":
                                audio_formats.append({
                                    "format_id": fmt.get("format_id", ""),
                                    "ext": fmt.get("ext", ""),
                                    "abr": fmt.get("abr", 0),
                                    "filesize": fmt.get("filesize", 0),
                                    "acodec": acodec,
                                })

                        platform_key, platform_name, platform_icon = detect_platform(original_url)
                        result = {
                            "success": True,
                            "id": str(info.get("id", "")),
                            "title": info.get("title") or "未知标题",
                            "description": (info.get("description") or "")[:300],
                            "duration": info.get("duration", 0) or 0,
                            "thumbnail": info.get("thumbnail", ""),
                            "uploader": info.get("uploader", ""),
                            "webpage_url": info.get("webpage_url", original_url),
                            "extractor": info.get("extractor", ""),
                            "platform": platform_key,
                            "platform_name": platform_name,
                            "platform_icon": platform_icon,
                            "audio_formats": audio_formats[:5],
                            "has_audio": len(audio_formats) > 0,
                            "strategy": strategy_name,
                        }
                        if strategy_name != "normal":
                            log.info(f"[extract] info resolved with strategy '{strategy_name}': {result['title'][:60]}")
                        return result

                except (DownloadError, ExtractorError) as e:
                    last_error = str(e)
                    if "private video" in str(e).lower() or "video unavailable" in str(e).lower():
                        break
                    continue
                except UnsupportedError as e:
                    last_error = str(e)
                    if strategy_name in ("normal", "generic"):
                        continue
                    return {"success": False, "error": self._translate_error(str(e), original_url)}
                except Exception as e:
                    last_error = str(e)
                    if strategy_name in ("normal", "generic"):
                        continue
                    return {"success": False, "error": self._translate_error(str(e), original_url)}

            # Retry once for 小红书 — the first attempt primes cookies, second succeeds
            if retry < _MAX_RETRIES - 1:
                log.info(f"[extract] Retrying parse for 小红书 (attempt {retry+2}/{_MAX_RETRIES})...")
                time.sleep(1.5)

        return {"success": False, "error": self._translate_error(last_error or "未知错误", original_url)}

    # ------------------------------------------------------------------
    # extract_audio — download and convert
    # ------------------------------------------------------------------
    def extract(
        self,
        url: str,
        mode: str = "audio",
        output_dir: Optional[str] = None,
        preferred_format: str = "mp3",
        preferred_quality: str = "192",
        progress_callback=None,
    ) -> dict:
        """Download audio or video from a URL.

        Args:
            url: Video URL
            mode: 'audio' (MP3/M4A) or 'video' (MP4)
            output_dir: output directory (default: temp)
            preferred_format: audio → 'mp3'/'m4a'; video → 'mp4'
            preferred_quality: audio → bitrate; video → height ('720'/'1080')
            progress_callback: fn(percent, status, info_dict)
        """
        original_url = url
        url = _normalize_url(url)
        url = _resolve_short_link(url)
        platform_key, platform_name, _ = detect_platform(url)
        out_dir = output_dir or str(_EXTRACT_DIR)
        os.makedirs(out_dir, exist_ok=True)

        # ── Douyin: requires cookies even for public content ──
        if platform_key == "douyin":
            return _douyin_not_supported(url)

        # ── B站: use direct API (bypasses yt-dlp) ──
        if platform_key == "bilibili":
            result = bilibili_extract(
                url, out_dir, mode, preferred_format, preferred_quality
            )
            if result.get("success"):
                label = "video" if mode == "video" else "audio"
                log.info(f"[extract] B站 direct {label}: {result['title'][:60]}")
                if progress_callback:
                    progress_callback(100, "done", result)
                return result
            log.info(f"[extract] B站 direct failed ({result.get('error','?')}), falling back to yt-dlp...")

        out_tmpl = os.path.join(out_dir, "%(title).100s.%(ext)s")
        ffmpeg_path = self._find_ffmpeg()

        # ── Video mode: download best video+audio, merge ──
        if mode == "video":
            # Don't explicitly add FFmpegMerger — yt-dlp auto-adds it when
            # bestvideo+bestaudio actually selects multiple formats.  Explicitly
            # adding it causes KeyError('requested_formats') on platforms (like
            # 小红书) that only offer a single combined stream.
            postprocessors = []
            # Standard yt-dlp format: prefer separate streams + merge, fall back
            # to single combined stream.  The * makes the merge optional — avoids
            # "No video formats found" on YouTube (VP9/WebM) and other platforms
            # where the "best" container isn't MP4.
            ytdl_format = "bestvideo*+bestaudio/best"
        else:
            # ── Audio mode: download audio only, extract ──
            ytdl_format = "bestaudio/best"
            postprocessors = []
            if ffmpeg_path:
                postprocessors.append({
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": preferred_format,
                    "preferredquality": preferred_quality,
                })
            else:
                log.warning("[extract] ffmpeg not found — will download best native audio format")

        # Progress tracking
        last_pct = [0]

        def _progress_hook(d):
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                downloaded = d.get("downloaded_bytes", 0)
                if total > 0:
                    pct = int(downloaded / total * 100)
                    if pct != last_pct[0] and progress_callback:
                        last_pct[0] = pct
                        progress_callback(pct, "downloading", {
                            "downloaded": downloaded,
                            "total": total,
                            "speed": d.get("speed", 0),
                            "eta": d.get("eta", 0),
                        })
            elif d["status"] == "finished":
                if progress_callback:
                    progress_callback(100, "processing", {})

        base_opts = _make_ydl_opts({
            "format": ytdl_format,
            "outtmpl": out_tmpl,
            "postprocessors": postprocessors,
            "max_filesize": 500 * 1024 * 1024,
            "progress_hooks": [_progress_hook],
            "merge_output_format": "mp4" if mode == "video" else None,
        })
        # 小红书/YouTube anti-bot: first attempt often fails — auto-retry once
        _RETRY_PLATFORMS = ("xiaohongshu", "youtube")
        _MAX_RETRIES = 2 if platform_key in _RETRY_PLATFORMS else 1

        _inject_cookies(base_opts, url)

        if ffmpeg_path:
            base_opts["ffmpeg_location"] = ffmpeg_path

        strategies = [
            ("normal", {}),
            ("generic", {"force_generic_extractor": True}),
        ]

        last_error = None

        for retry in range(_MAX_RETRIES):
            for strategy_name, strategy_opts in strategies:
                try:
                    opts = dict(base_opts)
                    if "http_headers" in strategy_opts:
                        hh = dict(opts.get("http_headers", {}))
                        hh.update(strategy_opts.pop("http_headers", {}))
                        opts["http_headers"] = hh
                    opts.update(strategy_opts)

                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=True)

                        if info.get("_type") == "playlist":
                            entries = info.get("entries", [])
                            if entries:
                                info = entries[0]
                            else:
                                last_error = "链接指向播放列表而非单个视频"
                                continue

                        title_safe = sanitize_filename(info.get("title", "audio"))[:100]

                        found_path = None
                        if mode == "video":
                            search_exts = ["mp4", "mkv", "webm", "flv", "avi", "mov"]
                        else:
                            search_exts = [preferred_format, "m4a", "opus", "webm", "mp4", "aac", "ogg", "mka", "wav"]
                        for ext in search_exts:
                            candidate = os.path.join(out_dir, f"{title_safe}.{ext}")
                            if os.path.isfile(candidate):
                                found_path = candidate
                                break

                        if not found_path:
                            try:
                                files = sorted(
                                    [f for f in Path(out_dir).iterdir() if f.is_file()],
                                    key=lambda f: f.stat().st_mtime, reverse=True)
                                if files:
                                    for f in files:
                                        if f.suffix.lower().lstrip(".") in search_exts or f.stat().st_size > 1024:
                                            found_path = str(f)
                                            break
                            except Exception:
                                pass

                        if not found_path:
                            last_error = ("视频" if mode == "video" else "音频") + "提取完成但找不到输出文件"
                            continue

                        file_size = os.path.getsize(found_path)

                        result = {
                            "success": True, "mode": mode,
                            "filepath": found_path,
                            "filename": os.path.basename(found_path),
                            "title": info.get("title", "Unknown"),
                            "duration": info.get("duration", 0) or 0,
                            "filesize": file_size,
                            "ext": os.path.splitext(found_path)[1].lstrip("."),
                            "thumbnail": info.get("thumbnail", ""),
                            "uploader": info.get("uploader", ""),
                            "extractor": info.get("extractor", ""),
                            "webpage_url": info.get("webpage_url", original_url),
                        }

                        if progress_callback:
                            progress_callback(100, "done", result)

                        return result

                except (DownloadError, ExtractorError) as e:
                    last_error = str(e)
                    if "private" in str(e).lower() or "unavailable" in str(e).lower():
                        break
                    continue
                except Exception as e:
                    last_error = str(e)
                    continue

            # Retry once for 小红书 — the first attempt primes cookies/is rate-limited
            if retry < _MAX_RETRIES - 1:
                log.info(f"[extract] Retrying download for 小红书 (attempt {retry+2}/{_MAX_RETRIES})...")
                time.sleep(1.5)

        return {"success": False, "error": self._translate_error(last_error or "未知错误", original_url)}


# ---------------------------------------------------------------------------
# Helper: auto-install yt-dlp if missing
# ---------------------------------------------------------------------------
def ensure_ytdlp() -> bool:
    """Try to install yt-dlp via pip if not present. Returns True if available."""
    global _HAS_YTDLP, yt_dlp, DownloadError, ExtractorError, UnsupportedError
    if _HAS_YTDLP:
        return True

    try:
        import subprocess
        log.info("[extract] yt-dlp not found, attempting pip install...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "yt-dlp", "-q"],
            timeout=120,
        )
        import yt_dlp as ydl
        yt_dlp = ydl
        from yt_dlp.utils import DownloadError as _DE, ExtractorError as _EE, UnsupportedError as _UE
        DownloadError = _DE
        ExtractorError = _EE
        UnsupportedError = _UE
        _HAS_YTDLP = True
        log.info("[extract] yt-dlp installed successfully")
        return True
    except Exception as e:
        log.error(f"[extract] Failed to install yt-dlp: {e}")
        return False


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
_extractor_instance: Optional[VideoExtractor] = None


def get_extractor() -> VideoExtractor:
    """Get or create the singleton VideoExtractor instance."""
    global _extractor_instance
    if _extractor_instance is None:
        try:
            _extractor_instance = VideoExtractor()
        except RuntimeError:
            if ensure_ytdlp():
                _extractor_instance = VideoExtractor()
            else:
                raise
    return _extractor_instance
