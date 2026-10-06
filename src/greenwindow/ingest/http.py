"""Shared HTTP session with retries (spec 6.1)."""

from __future__ import annotations

import time
from typing import Any

import requests

USER_AGENT = "greenwindow/0.1 (+https://github.com/nivesh22/greenwindow)"
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = USER_AGENT


def get_json(url: str, params: dict[str, Any] | None = None, tries: int = 4, timeout: float = 60) -> Any:
    """GET and decode JSON. Retries 429/5xx/network errors with exponential backoff; raises on other 4xx."""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = _SESSION.get(url, params=params, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code} from {url}")
            else:
                r.raise_for_status()
                return r.json()
        except (requests.ConnectionError, requests.Timeout) as e:
            last = e
        if attempt < tries - 1:
            time.sleep(2**attempt)
    raise RuntimeError(f"GET {url} failed after {tries} tries: {last}")
