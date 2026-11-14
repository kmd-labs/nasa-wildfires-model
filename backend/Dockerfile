# docker build -t wildfires-api backend && docker run -p 8000:8000 --env-file .env -v firms-cache:/cache wildfires-api
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY . backend
ENV FIRMS_CACHE_DIR=/cache
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
