"""Canonical FieldOS roles and permission helpers."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.core.logging import get_logger, log_extra

logger = get_logger(__name__)

# Client-supplied role fields must never authorise delivery / manager actions.
CLIENT_ROLE_KEYS = frozenset({"actor_role", "role", "user_role", "claims_role"})


def normalize_role(role: str | None) -> str:
    """Trim + lowercase; map known labels to staff|manager|admin (least privilege)."""
    r = (role or "").strip().lower()
    if r in ("admin", "administrator"):
        return "admin"
    if r in ("manager", "mgr"):
        return "manager"
    if r in ("staff", "field staff", "field_staff", "technician", ""):
        return "staff"
    return "staff"


def display_role(role: str | None) -> str:
    """Preserve the original display string (trimmed); empty → Field Staff."""
    text = str(role or "").strip()
    return text or "Field Staff"


def is_manager_or_admin(role: str | None) -> bool:
    return normalize_role(role) in ("manager", "admin")


def raw_role_from_claims(claims: dict[str, Any] | None) -> str:
    claims = claims or {}
    # Prefer explicit display claim when present; otherwise JWT role.
    raw = claims.get("role_display")
    if raw is None or str(raw).strip() == "":
        raw = claims.get("role")
    return display_role(raw)


def log_role_authorisation(
    *,
    endpoint: str,
    claims: dict[str, Any] | None,
    authorised: bool,
) -> None:
    claims = claims or {}
    raw = raw_role_from_claims(claims)
    log_extra(
        logger,
        20,
        "Role authorisation",
        endpoint=endpoint,
        authenticated_email=str(claims.get("email") or ""),
        raw_role=raw,
        normalised_role=normalize_role(raw),
        authorised=bool(authorised),
        # never log tokens or Authorization headers
    )


def require_manager_or_admin(claims: dict[str, Any], *, endpoint: str = "") -> str:
    """Authorise from JWT claims only. Returns normalised actor_role (manager|admin)."""
    raw = raw_role_from_claims(claims)
    authorised = is_manager_or_admin(raw)
    if endpoint:
        log_role_authorisation(endpoint=endpoint, claims=claims, authorised=authorised)
    if not authorised:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Manager or admin role required.",
        )
    return normalize_role(raw)


def strip_client_role_fields(body: dict[str, Any] | None) -> dict[str, Any]:
    """Drop any client-supplied role fields before merging authenticated claims."""
    out = dict(body or {})
    for key in CLIENT_ROLE_KEYS:
        out.pop(key, None)
    return out


def actor_identity(claims: dict[str, Any]) -> str:
    return str(claims.get("email") or claims.get("sub") or "").strip()
