"""Application settings — all secrets from environment."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Prefer process env (Docker Compose). Also load fieldos/.env when uvicorn
    # is started from fieldos/backend (cwd .env is missing; ../.env is the real file).
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    fieldos_env: str = Field(default="development", alias="FIELDOS_ENV")
    fieldos_base_url: str = Field(default="http://localhost:8080", alias="FIELDOS_BASE_URL")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # mock | apps_script
    data_mode: str = Field(default="mock", alias="DATA_MODE")

    jwt_secret: str = Field(default="dev-only-change-me", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    jwt_expire_minutes: int = Field(default=60 * 12, alias="JWT_EXPIRE_MINUTES")

    auth_users_file: str = Field(default="./data/auth_users.json", alias="AUTH_USERS_FILE")
    mock_data_dir: str = Field(default="./data/mock", alias="MOCK_DATA_DIR")
    local_recordings_dir: str = Field(default="./data/recordings", alias="LOCAL_RECORDINGS_DIR")

    # Seeded demo user (hash generated at startup if file missing)
    demo_staff_email: str = Field(default="alex@nativegrace.com", alias="DEMO_STAFF_EMAIL")
    demo_staff_password: str = Field(default="FieldOS-Demo-2026!", alias="DEMO_STAFF_PASSWORD")
    demo_staff_id: str = Field(default="STAFF-DEMO001", alias="DEMO_STAFF_ID")
    demo_staff_name: str = Field(default="Alex Technician", alias="DEMO_STAFF_NAME")

    # Live tbl_job_sheets column mappings (customer_name is API display only; dual-read via projects/customers)
    job_assignment_column: str = Field(default="staff_id", alias="JOB_ASSIGNMENT_COLUMN")
    job_date_column: str = Field(default="date", alias="JOB_DATE_COLUMN")
    job_project_column: str = Field(default="project_id", alias="JOB_PROJECT_COLUMN")
    job_customer_column: str = Field(default="customer_name", alias="JOB_CUSTOMER_COLUMN")
    jobs_default_days: int = Field(default=7, alias="JOBS_DEFAULT_DAYS")

    max_upload_mb: int = Field(default=25, alias="MAX_UPLOAD_MB")
    # Reject header-only / empty WebM stubs (e.g. 18-byte EBML shells) before Drive write.
    min_recording_upload_bytes: int = Field(default=1024, alias="MIN_RECORDING_UPLOAD_BYTES")
    allowed_audio_mimes: str = Field(
        default=(
            "audio/webm,video/webm,audio/wav,audio/x-wav,audio/mpeg,audio/mp3,"
            "audio/mp4,video/mp4,audio/x-m4a,audio/ogg,application/ogg,audio/flac,audio/x-flac"
        ),
        alias="ALLOWED_AUDIO_MIMES",
    )

    spreadsheet_id: str = Field(default="", alias="SPREADSHEET_ID")
    recordings_folder_id: str = Field(default="", alias="RECORDINGS_FOLDER_ID")
    google_application_credentials: str = Field(default="", alias="GOOGLE_APPLICATION_CREDENTIALS")

    apps_script_webapp_url: str = Field(default="", alias="APPS_SCRIPT_WEBAPP_URL")
    apps_script_webhook_secret: str = Field(default="", alias="APPS_SCRIPT_WEBHOOK_SECRET")
    apps_script_timeout_seconds: float = Field(default=30.0, alias="APPS_SCRIPT_TIMEOUT_SECONDS")

    cors_origins: str = Field(default="http://localhost:8080,http://localhost:5173", alias="CORS_ORIGINS")

    @property
    def allowed_mimes(self) -> set[str]:
        return {m.strip().lower() for m in self.allowed_audio_mimes.split(",") if m.strip()}

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def ensure_data_dirs(self) -> None:
        for path in (
            Path(self.auth_users_file).parent,
            Path(self.mock_data_dir),
            Path(self.local_recordings_dir),
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_data_dirs()
    return settings
