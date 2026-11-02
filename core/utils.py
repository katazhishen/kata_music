"""General utility functions."""

import re
import os
import logging
from pathlib import Path

# Pre-compiled regexes
_ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*]')


def sanitize_filename(name: str) -> str:
    """Remove or replace characters illegal in Windows/Mac filenames."""
    name = _ILLEGAL_CHARS_RE.sub("_", name)
    name = name.strip(". ")
    if not name:
        name = "unknown"
    # Limit length to avoid path-too-long issues
    if len(name) > 200:
        name = name[:200]
    return name


def build_filename(artist: str, title: str, ext: str) -> str:
    """Build a clean filename: 'Artist - Title.ext'."""
    artist = sanitize_filename(artist) if artist else "Unknown Artist"
    title = sanitize_filename(title) if title else "Unknown Title"
    ext = ext[1:] if ext.startswith(".") else ext
    return f"{artist} - {title}.{ext}"


def format_duration(ms: int) -> str:
    """Convert milliseconds to mm:ss string."""
    seconds = ms // 1000
    minutes = seconds // 60
    seconds = seconds % 60
    return f"{minutes:02d}:{seconds:02d}"


def format_size(size_bytes: int) -> str:
    """Convert bytes to human-readable string."""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def setup_logger(name: str = "music_dl", level: int = logging.INFO) -> logging.Logger:
    """Create a console + rotating-file logger."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        formatter = logging.Formatter(
            "[%(asctime)s] %(levelname)s %(name)s: %(message)s"
        )
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        logger.addHandler(handler)

        # Rotating file handler so server logs persist across restarts
        try:
            from logging.handlers import RotatingFileHandler
            log_dir = Path(__file__).parent.parent / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            fh = RotatingFileHandler(
                log_dir / "app.log", maxBytes=5 * 1024 * 1024, backupCount=3,
                encoding="utf-8",
            )
            fh.setFormatter(formatter)
            logger.addHandler(fh)
        except Exception:
            pass  # never let logging setup break the app
    logger.setLevel(level)
    return logger


# Default logger instance
log = setup_logger()
