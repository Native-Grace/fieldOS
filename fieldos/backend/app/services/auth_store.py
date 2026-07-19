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
        email = self.settings.demo_staff_email.lower()
        for user in users:
            if user.get("email", "").lower() != email:
                continue
            # Resync demo identity from env so DEMO_STAFF_ID changes take effect
            # without deleting the Docker volume auth file.
            changed = False
            if str(user.get("staff_id")) != str(self.settings.demo_staff_id):
                user["staff_id"] = self.settings.demo_staff_id
                changed = True
            if str(user.get("staff_name") or "") != str(self.settings.demo_staff_name):
                user["staff_name"] = self.settings.demo_staff_name
                changed = True
            if changed:
                self._save(users)
                log_extra(logger, 20, "Updated demo auth user identity", email=email)
            return
        users.append(
            {
                "staff_id": self.settings.demo_staff_id,
                "staff_name": self.settings.demo_staff_name,
                "email": email,
                "role": "Field Staff",
                "is_active": True,
                "password_hash": hash_password(self.settings.demo_staff_password),
            }
        )
        self._save(users)
        log_extra(logger, 20, "Seeded demo auth user", email=email)

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
