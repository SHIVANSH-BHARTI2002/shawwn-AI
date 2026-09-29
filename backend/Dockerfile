# shawwn backend image.
#
# Builds the lightweight core (FastAPI + retrieval + deterministic fallbacks).
# The heavy ML stack (BGE-M3 / BGE reranker) is optional: to enable full mode,
# add a layer installing requirements-ml.txt and set SHAWWN_LIGHT_MODE=false.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps kept minimal.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Uncomment to bake in full-mode ML dependencies (large image):
# COPY requirements-ml.txt .
# RUN pip install -r requirements-ml.txt

COPY app ./app
COPY evaluation ./evaluation

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
