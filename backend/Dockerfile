# docker build -f backend/Dockerfile -t wildfires-api . && docker run -p 8000:8000 --env-file .env -v firms-cache:/cache wildfires-api
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
ENV FIRMS_CACHE_DIR=/cache
EXPOSE 8000
CMD ["uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "8000"]
