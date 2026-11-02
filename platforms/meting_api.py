"""Meting API wrapper — multi-platform music search + direct audio URL.

Meting (api.i-meto.com) is a long-running public music meta API. Its search
endpoint returns each song with an authenticated, directly-downloadable
``url`` field (verified to resolve to ``audio/mpeg``).

Server mapping (app platform -> Meting server name):
    netease -> netease
    qq      -> tencent
    kugou   -> kugou
    kuwo    -> kuwo
"""

from __future__ import annotations

import re
from urllib.parse import quote

import requests

METING_BASE = "https://api.i-meto.com/meting/api"

# app platform -> Meting server name
SERVER_MAP = {
    "netease": "netease",
    "qq": "tencent",
    "kugou": "kugou",
    "kuwo": "kuwo",
}

_HEADERS = {"User-Agent": "Mozilla/5.0"}

_ID_RE = re.compile(r"[?&]id=(\d+)")


def meting_extract_id(url: str) -> str:
    """Extract the numeric song id from a Meting ``url``/``pic``/``lrc`` field."""
    m = _ID_RE.search(url or "")
    return m.group(1) if m else ""


def meting_search(query: str, platform: str = "netease", page: int = 1, limit: int = 20) -> list[dict]:
    """Search Meting for songs. Returns the raw JSON list, or [] on failure."""
    server = SERVER_MAP.get(platform)
    if not server:
        return []
    try:
        resp = requests.get(
            METING_BASE,
            params={
                "server": server,
                "type": "search",
                "id": query,
                "limit": limit,
                "page": page,
            },
            headers=_HEADERS,
            timeout=15,
        )
        data = resp.json()
        if not isinstance(data, list):
            return []
        return data
    except Exception:
        return []
