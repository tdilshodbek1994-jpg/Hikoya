"""Application configuration.

All values come from environment variables (see ``.env.example``). Nothing secret
has a default value. Product limits from the spec (section 17.4, 27, 11.3) are
project configuration, not Telegram limits.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="HIKOYA_", extra="ignore")

    env: str = "development"  # development | test | production
    debug: bool = False

    database_url: str = "postgresql+asyncpg://hikoya:hikoya@localhost:5432/hikoya"
    db_pool_size: int = 20
    db_max_overflow: int = 20

    # Telegram
    bot_token: str = ""
    bot_username: str = "hikoya_pro_bot"
    miniapp_short_name: str = "app"
    webapp_url: str = "http://localhost:5173"
    webhook_secret: str = ""  # X-Telegram-Bot-Api-Secret-Token
    public_base_url: str = "http://localhost:8000"
    owner_telegram_ids: list[int] = Field(default_factory=list)
    test_telegram_ids: list[int] = Field(default_factory=list)
    telegram_api_base: str = "https://api.telegram.org"
    # Telegram test environment: requests go to /bot<token>/test/<method>
    telegram_test_env: bool = False
    # Optional proxy for Bot API calls when api.telegram.org is not reachable from the server,
    # e.g. "socks5://user:pass@host:1080" or "http://host:3128"
    telegram_proxy: str = ""
    # When False the bot never calls Telegram (dev/test); outgoing calls are recorded.
    telegram_enabled: bool = False

    # Auth
    init_data_max_age_seconds: int = 300
    session_ttl_hours: int = 72
    dev_auth_enabled: bool = False  # NEVER enable in production

    # Storage
    storage_backend: str = "local"  # local | s3
    storage_local_dir: str = "./var/storage"
    s3_endpoint_url: str = ""
    s3_bucket_private: str = ""
    s3_bucket_public: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_region: str = "us-east-1"
    s3_public_base_url: str = ""
    signed_url_ttl_seconds: int = 60
    signing_key: str = "dev-only-change-me"

    # Product limits (MiB)
    limit_image_mib: int = 8
    limit_text_mib: int = 5
    limit_docx_mib: int = 10
    limit_bot_file_mib: int = 16
    limit_upload_media_mib: int = 100
    story_video_max_seconds: int = 60
    # Optional antivirus (clamd INSTREAM). Empty host = scanning disabled.
    clamav_host: str = ""
    clamav_port: int = 3310
    # True: an unreachable scanner rejects the upload; False: upload is stored with av="unavailable"
    clamav_required: bool = False

    # Community
    comment_max_chars: int = 2000
    comment_edit_window_minutes: int = 15
    comment_rate_per_minute: int = 5
    share_quote_max_chars: int = 200

    # Storis
    story_default_hours: int = 24
    story_allowed_hours: list[int] = Field(default_factory=lambda: [24])

    # Billing
    billing_enabled: bool = False  # owner must explicitly enable real payments
    order_ttl_minutes: int = 30

    # Locale
    timezone: str = "Asia/Tashkent"
    quiet_hours_start: str = "22:00"
    quiet_hours_end: str = "09:00"

    # AI (stage C module, optional)
    ai_provider: str = ""  # "" = disabled | "anthropic"
    ai_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_max_tokens: int = 4000
    ai_daily_limit_per_user: int = 20

    # Author royalties (model A: share of single-work sales). 0 = disabled.
    royalty_share_percent: int = 0
    royalty_hold_days: int = 21  # Stars refunds are possible for a while; keep revenue pending

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_production and s.dev_auth_enabled:
        raise RuntimeError("HIKOYA_DEV_AUTH_ENABLED must be false in production")
    if s.is_production and s.signing_key == "dev-only-change-me":
        raise RuntimeError("HIKOYA_SIGNING_KEY must be set in production")
    return s
