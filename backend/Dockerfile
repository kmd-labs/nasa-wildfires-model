# docker build -t wildfires-api backend && docker run -p 8000:8000 --env-file .env -v firms-cache:/cache wildfires-api
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# burned area (MCD64A1 / VNP64A1 HDF4 tiles) for /api/burned-area and the seam test; manylinux wheel, no build
# tools needed. The endpoint also needs EARTHDATA_TOKEN at runtime (Cloud Run secret), see issue #88.
RUN pip install --no-cache-dir "pyhdf==0.11.7"
COPY . backend
ENV FIRMS_CACHE_DIR=/cache
# v4: fixed nominal-MODIS unit with the orbit-drift law (docs/harmonization.md); v1 stays the code default
ENV HARMONIZATION=v4
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
