"""Application configuration.

All configuration is read from environment variables (optionally loaded from a
`.env` file). The backend is designed to run in two modes:

* **full**   - real BGE-M3 embeddings, real Qdrant, real reranker, real LLM.
* **light**  - deterministic fallbacks (hashing embeddings, in-memory vector
               store, lexical reranker, echo LLM). This mode requires no heavy
               model downloads or external services and is what the test suite
               uses. It is selected automatically when dependencies/services
               are unavailable, or forced via `SHAWWN_LIGHT_MODE=true`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    app_env: str = Field(default="development", alias="APP_ENV")
    backend_host: str = Field(default="0.0.0.0", alias="BACKEND_HOST")
    backend_port: int = Field(default=8000, alias="BACKEND_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # Force deterministic light mode (no heavy models / external services).
    light_mode: bool = Field(default=False, alias="SHAWWN_LIGHT_MODE")

    # --- LLM ---
    # Provider preference: "gemini" | "openai". Falls back to the deterministic
    # extractive provider when no key is configured / in light mode.
    llm_provider: str = Field(default="gemini", alias="LLM_PROVIDER")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-4o-mini", alias="OPENAI_MODEL")
    openai_base_url: str = Field(default="", alias="OPENAI_BASE_URL")
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_model: str = Field(default="gemini-flash-lite-latest", alias="GEMINI_MODEL")
    mistral_api_key: str = Field(default="", alias="MISTRAL_API_KEY")
    mistral_model: str = Field(default="mistral-small-latest", alias="MISTRAL_MODEL")
    # Higher temperature -> more natural, human-like phrasing.
    llm_temperature: float = Field(default=0.4, alias="LLM_TEMPERATURE")

    # --- Qdrant ---
    qdrant_url: str = Field(default="http://localhost:6333", alias="QDRANT_URL")
    qdrant_api_key: str = Field(default="", alias="QDRANT_API_KEY")
    qdrant_collection: str = Field(default="shawwn_chunks", alias="QDRANT_COLLECTION")

    # --- Postgres ---
    postgres_url: str = Field(
        default="sqlite+aiosqlite:///./shawwn.db", alias="POSTGRES_URL"
    )

    # --- Redis ---
    redis_url: str = Field(default="", alias="REDIS_URL")

    # --- Models ---
    embedding_model: str = Field(default="BAAI/bge-m3", alias="EMBEDDING_MODEL")
    reranker_model: str = Field(
        default="BAAI/bge-reranker-base", alias="RERANKER_MODEL"
    )
    embedding_dim: int = Field(default=1024, alias="EMBEDDING_DIM")

    # --- Retrieval ---
    top_k_dense: int = Field(default=10, alias="TOP_K_DENSE")
    top_k_bm25: int = Field(default=10, alias="TOP_K_BM25")
    top_k_rerank: int = Field(default=5, alias="TOP_K_RERANK")
    dense_weight: float = Field(default=0.7, alias="DENSE_WEIGHT")
    bm25_weight: float = Field(default=0.3, alias="BM25_WEIGHT")
    rerank_score_threshold: float = Field(
        default=0.0, alias="RERANK_SCORE_THRESHOLD"
    )

    # --- Chunking ---
    chunk_size: int = Field(default=700, alias="CHUNK_SIZE")
    chunk_overlap: int = Field(default=100, alias="CHUNK_OVERLAP")
    max_context_chars: int = Field(default=12000, alias="MAX_CONTEXT_CHARS")

    # --- Security / CORS ---
    cors_origins: str = Field(
        default="http://localhost:8000,chrome-extension://*", alias="CORS_ORIGINS"
    )
    auth_enabled: bool = Field(default=False, alias="AUTH_ENABLED")
    api_token: str = Field(default="", alias="API_TOKEN")

    # --- Rate limiting (requests per window per client) ---
    rate_limit_enabled: bool = Field(default=True, alias="RATE_LIMIT_ENABLED")
    rate_limit_chat: int = Field(default=30, alias="RATE_LIMIT_CHAT")
    rate_limit_documents: int = Field(default=20, alias="RATE_LIMIT_DOCUMENTS")
    rate_limit_window_seconds: int = Field(
        default=60, alias="RATE_LIMIT_WINDOW_SECONDS"
    )

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def swagger_enabled(self) -> bool:
        return not self.is_production


@lru_cache
def get_settings() -> Settings:
    return Settings()
