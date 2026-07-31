from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"
_SENSITIVE_PARTS = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "api_key",
    "apikey",
    "private_key",
    "credential",
)
_BEARER = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passwd|secret|token|authorization|api[_-]?key|credential)"
    r"\s*[:=]\s*([^\s,;]+)"
)


def is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_PARTS)


def redact_text(value: str, max_length: int | None = None) -> str:
    redacted = _BEARER.sub(f"Bearer {REDACTED}", value)
    redacted = _ASSIGNMENT.sub(lambda match: f"{match.group(1)}={REDACTED}", redacted)
    if max_length is not None and len(redacted) > max_length:
        return f"{redacted[:max_length]}… ({len(redacted)} chars)"
    return redacted


def redact_value(value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        return {
            str(key): REDACTED if is_sensitive_key(str(key)) else redact_value(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item, depth + 1) for item in value]
    if isinstance(value, tuple):
        return [redact_value(item, depth + 1) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def safe_preview(value: str, max_length: int = 240) -> str:
    return redact_text(value, max_length=max_length)
