"""Canonical FieldOS roles and permission helpers."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status


def normalize_role(role: str | None) -> str:
    r = (role or "").strip().lower()
    if r in ("admin", "administrator"):
        return "admin"
    if r in ("manager", "mgr"):
        return "manager"
    if r in ("staff", "field staff", "field_staff", "technician", ""):
        return "staff"
    return "staff"


def is_manager_or_admin(role: str | None) -> bool:
    return normalize_role(role) in ("manager", "admin")


def require_manager_or_admin(claims: dict[str, Any]) -> str:
    role = claims.get("role")
    if not is_manager_or_admin(role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Manager or admin role required.",
        )
    return normalize_role(str(role or ""))


def actor_identity(claims: dict[str, Any]) -> str:
    return str(claims.get("email") or claims.get("sub") or "").strip()
