"""Global test configuration: never read a developer/operator .env file during tests."""

from app.config import Settings

Settings.model_config["env_file"] = None
