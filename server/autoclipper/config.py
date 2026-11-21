"""Settings from environment variables. Secrets never leave the server: they are not logged or returned by the API."""
import os


def _env(name, default=""):
    """Env value with stray spaces/line breaks removed (pasted secrets often carry them)."""
    return str(os.environ.get(name, default)).strip()
from dataclasses import dataclass, field


def _f(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


@dataclass
class Config:
    data_dir: str = field(default_factory=lambda: _env("AC_DATA_DIR", "/data"))
    admin_token: str = field(default_factory=lambda: _env("AC_ADMIN_TOKEN", ""))
    allowed_origins: str = field(default_factory=lambda: _env("AC_ALLOWED_ORIGINS", "https://creatorai-jd.github.io,http://localhost"))
    openai_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY", ""))
    openai_base: str = field(default_factory=lambda: _env("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    model: str = field(default_factory=lambda: _env("AC_MODEL", "gpt-4o-mini"))
    twitch_id: str = field(default_factory=lambda: _env("TWITCH_CLIENT_ID", ""))
    twitch_secret: str = field(default_factory=lambda: _env("TWITCH_CLIENT_SECRET", ""))
    youtube_key: str = field(default_factory=lambda: _env("YOUTUBE_API_KEY", ""))
    upload_post_key: str = field(default_factory=lambda: _env("UPLOAD_POST_API_KEY", ""))
    webhook_url: str = field(default_factory=lambda: _env("AC_NOTIFY_WEBHOOK", ""))
    daily_budget: float = field(default_factory=lambda: _f("AC_DAILY_BUDGET_USD", 5))
    monthly_budget: float = field(default_factory=lambda: _f("AC_MONTHLY_BUDGET_USD", 60))
    workers: int = field(default_factory=lambda: int(_env("AC_WORKERS", "2")))
    max_live_sessions: int = field(default_factory=lambda: int(_env("AC_MAX_LIVE", "3")))
    public_url: str = field(default_factory=lambda: _env("AC_PUBLIC_URL", ""))
    # endpoints are configurable so tests (and other providers) can point elsewhere
    twitch_api: str = field(default_factory=lambda: _env("AC_TWITCH_API", "https://api.twitch.tv/helix"))
    twitch_auth: str = field(default_factory=lambda: _env("AC_TWITCH_AUTH", "https://id.twitch.tv/oauth2/token"))
    kick_api: str = field(default_factory=lambda: _env("AC_KICK_API", "https://kick.com/api"))
    youtube_api: str = field(default_factory=lambda: _env("AC_YOUTUBE_API", "https://www.googleapis.com/youtube/v3"))
    upload_post_api: str = field(default_factory=lambda: _env("AC_UPLOAD_POST_API", "https://api.upload-post.com/api"))

    @property
    def media_dir(self):
        return os.path.join(self.data_dir, "media")

    @property
    def db_path(self):
        return os.path.join(self.data_dir, "autoclipper.db")

    def public(self):
        """What the control panel may see: which integrations are configured, never the values."""
        return {
            "openai": bool(self.openai_key), "twitch": bool(self.twitch_id and self.twitch_secret), "youtube": bool(self.youtube_key),
            "upload_post": bool(self.upload_post_key), "webhook": bool(self.webhook_url), "model": self.model,
            "daily_budget": self.daily_budget, "monthly_budget": self.monthly_budget, "workers": self.workers, "max_live_sessions": self.max_live_sessions,
        }


CFG = Config()


def reload():
    global CFG
    CFG = Config()
    return CFG
