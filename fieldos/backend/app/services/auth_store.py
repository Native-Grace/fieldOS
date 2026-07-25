"""Local auth user store (bcrypt hashes). Replaceable later."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.core.security import hash_password, verify_password

logger = get_logger(__name__)


class AuthUserStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = Path(settings.auth_users_file)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_demo_user()

    def _load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self, users: list[dict[str, Any]]) -> None:
        self.path.write_text(json.dumps(users, indent=2), encoding="utf-8")

    def _ensure_demo_user(self) -> None:
        users = self._load()
        users = self._upsert_demo(
            users,
            email=self.settings.demo_staff_email.lower(),
            staff_id=self.settings.demo_staff_id,
            staff_name=self.settings.demo_staff_name,
            role=self.settings.demo_staff_role,
            password=self.settings.demo_staff_password,
        )
        if self.settings.demo_manager_enabled:
            users = self._upsert_demo(
                users,
                email=self.settings.demo_manager_email.lower(),
                staff_id=self.settings.demo_manager_id,
                staff_name=self.settings.demo_manager_name,
                role="Manager",
                password=self.settings.demo_manager_password,
            )
        self._save(users)

    def _upsert_demo(
        self,
        users: list[dict[str, Any]],
        *,
        email: str,
        staff_id: str,
        staff_name: str,
        role: str,
        password: str,
    ) -> list[dict[str, Any]]:
        for user in users:
            if user.get("email", "").lower() != email:
                continue
            changed = False
            if str(user.get("staff_id")) != str(staff_id):
                user["staff_id"] = staff_id
                changed = True
            if str(user.get("staff_name") or "") != str(staff_name):
                user["staff_name"] = staff_name
                changed = True
            if str(user.get("role") or "") != str(role):
                user["role"] = role
                changed = True
            if changed:
                log_extra(logger, 20, "Updated demo auth user identity", email=email, role=role)
            return users
        users.append(
            {
                "staff_id": staff_id,
                "staff_name": staff_name,
                "email": email,
                "role": role,
                "is_active": True,
                "password_hash": hash_password(password),
            }
        )
        log_extra(logger, 20, "Seeded demo auth user", email=email, role=role)
        return users

    def authenticate(self, email: str, password: str) -> dict[str, Any] | None:
        email_l = email.lower().strip()
        for user in self._load():
            if user.get("email", "").lower() != email_l:
                continue
            if not user.get("is_active", True):
                return None
            if verify_password(password, user["password_hash"]):
                return {k: v for k, v in user.items() if k != "password_hash"}
            return None
        return None

    def get_by_staff_id(self, staff_id: str) -> dict[str, Any] | None:
        for user in self._load():
            if str(user.get("staff_id")) == str(staff_id):
                return {k: v for k, v in user.items() if k != "password_hash"}
        return None
