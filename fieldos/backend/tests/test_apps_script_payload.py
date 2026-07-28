"""Allowlist / secret-stripping tests for Apps Script delivery transport."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.services.apps_script_payload import (
    FORBIDDEN_APPS_SCRIPT_KEYS,
    assert_no_forbidden_apps_script_keys,
    build_apps_script_delivery_payload,
    rejected_forbidden_key_names,
)


def test_build_payload_excludes_secrets_and_keeps_allowed() -> None:
    source = {
        "delivery_id": "DLV-1",
        "job_sheet_id": "21759f5d",
        "document_type": "Client Job Summary",
        "recipient_email": "client@example.com",
        "actor_role": "Manager",
        "staff_id": "STAFF-MGR001",
        "expected_version": 2,
        "webhook_secret": "SHOULD-NOT-PASS",
        "smtp_password": "nope",
        "api_key": "nope",
        "access_token": "nope",
        "refresh_token": "nope",
        "client_secret": "nope",
        "private_key": "nope",
        "pdf_bytes": b"%PDF",
        "email_body": "secret body",
        "body": "also secret",
        "settings": {"DOCUMENT_EMAIL_ENABLED": True},
        "provider_config": {"smtp_password": "x"},
        "confirm_send": True,  # not on create allowlist
    }
    out = build_apps_script_delivery_payload("create_delivery_draft", source)
    assert out["delivery_id"] == "DLV-1"
    assert out["job_sheet_id"] == "21759f5d"
    assert out["actor_role"] == "manager"
    assert out["staff_id"] == "STAFF-MGR001"
    for key in (
        "webhook_secret",
        "smtp_password",
        "api_key",
        "access_token",
        "refresh_token",
        "client_secret",
        "private_key",
        "pdf_bytes",
        "email_body",
        "body",
        "settings",
        "provider_config",
        "confirm_send",
    ):
        assert key not in out
    # Source must not be mutated.
    assert source["webhook_secret"] == "SHOULD-NOT-PASS"
    assert source["actor_role"] == "Manager"


def test_record_outcome_allowlist_and_drive_file_id() -> None:
    out = build_apps_script_delivery_payload(
        "record_delivery_outcome",
        {
            "delivery_id": "DLV-2",
            "status": "Sent",
            "checksum": "abc",
            "template_version": "3G.1",
            "idempotency_key": "k1",
            "actor_role": "admin",
            "drive_file_id": "FILE123",
            "smtp_password": "x",
            "pdf_base64": "eee",
        },
    )
    assert out["drive_file_id"] == "FILE123"
    assert out["actor_role"] == "admin"
    assert "smtp_password" not in out
    assert "pdf_base64" not in out


def test_frontend_role_normalised_from_source_actor_role_only() -> None:
    out = build_apps_script_delivery_payload(
        "get_delivery",
        {"delivery_id": "DLV-1", "actor_role": " Admin ", "role": "staff"},
    )
    assert out["actor_role"] == "admin"
    assert "role" not in out


def test_preflight_rejects_forbidden_keys() -> None:
    with pytest.raises(HTTPException) as exc:
        assert_no_forbidden_apps_script_keys(
            {"delivery_id": "DLV-1", "webhook_secret": "x"},
            action="get_delivery",
        )
    assert exc.value.status_code == 500
    assert "webhook_secret" in str(exc.value.detail)


def test_rejected_key_names_covers_nested_provider_blobs() -> None:
    names = rejected_forbidden_key_names(
        {
            "api_key": "x",
            "settings": {"a": 1},
            "provider_config": {},
            "delivery_id": "DLV-1",
        }
    )
    assert "api_key" in names
    assert "settings" in names
    assert "provider_config" in names
    assert "delivery_id" not in names
    assert "webhook_secret" in FORBIDDEN_APPS_SCRIPT_KEYS


def test_none_values_dropped() -> None:
    out = build_apps_script_delivery_payload(
        "validate_delivery",
        {
            "delivery_id": "DLV-1",
            "expected_version": None,
            "actor_role": "manager",
            "staff_id": "STAFF-MGR001",
        },
    )
    assert out["delivery_id"] == "DLV-1"
    assert "expected_version" not in out
