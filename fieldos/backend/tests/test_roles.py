"""Role normalisation and manager-gate tests."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core.roles import (
    is_manager_or_admin,
    normalize_role,
    require_manager_or_admin,
    strip_client_role_fields,
)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("manager", "manager"),
        ("Manager", "manager"),
        (" MANAGER ", "manager"),
        ("admin", "admin"),
        ("Admin", "admin"),
        ("administrator", "admin"),
        ("Administrator", "admin"),
        ("staff", "staff"),
        ("Field Staff", "staff"),
        ("", "staff"),
        (None, "staff"),
        ("unknown-role", "staff"),
    ],
)
def test_normalize_role(raw, expected) -> None:
    assert normalize_role(raw) == expected


@pytest.mark.parametrize(
    "raw,ok",
    [
        ("manager", True),
        ("Manager", True),
        (" manager ", True),
        ("admin", True),
        ("Admin", True),
        ("administrator", True),
        ("staff", False),
        ("Field Staff", False),
        ("", False),
        (None, False),
    ],
)
def test_is_manager_or_admin_casing_and_whitespace(raw, ok) -> None:
    assert is_manager_or_admin(raw) is ok


def test_require_manager_or_admin_accepts_display_manager() -> None:
    assert require_manager_or_admin({"role": "Manager", "email": "manager@nativegrace.com"}) == "manager"
    assert require_manager_or_admin({"role": "Admin", "email": "admin@nativegrace.com"}) == "admin"


def test_require_manager_or_admin_rejects_staff_and_missing() -> None:
    with pytest.raises(HTTPException) as staff_exc:
        require_manager_or_admin({"role": "Field Staff", "email": "alex@nativegrace.com"})
    assert staff_exc.value.status_code == 403

    with pytest.raises(HTTPException) as missing_exc:
        require_manager_or_admin({"email": "nobody@nativegrace.com"})
    assert missing_exc.value.status_code == 403


def test_strip_client_role_fields_ignores_frontend_role() -> None:
    cleaned = strip_client_role_fields(
        {
            "delivery_id": "DLV-1",
            "actor_role": "admin",
            "role": "Manager",
            "user_role": "admin",
            "expected_version": 1,
        }
    )
    assert "actor_role" not in cleaned
    assert "role" not in cleaned
    assert "user_role" not in cleaned
    assert cleaned["delivery_id"] == "DLV-1"
    assert cleaned["expected_version"] == 1


def test_rates_apps_forbidden_remap_preserves_non_role_messages() -> None:
    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import _raise_from_rates_apps

    with pytest.raises(HTTPException) as role_exc:
        _raise_from_rates_apps(
            AppsScriptError("Forbidden: manager or admin role required.", http_status=403)
        )
    assert role_exc.value.status_code == 403
    assert role_exc.value.detail == "Manager or admin role required."

    with pytest.raises(HTTPException) as other_exc:
        _raise_from_rates_apps(
            AppsScriptError("Forbidden: job is not assigned to this staff member.", http_status=403)
        )
    assert other_exc.value.status_code == 403
    assert "not assigned" in str(other_exc.value.detail).lower()
