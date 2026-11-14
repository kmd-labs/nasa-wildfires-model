"""HTTP API for the web app.

    uvicorn backend.server:app --port 8000          (or: python -m backend serve)

GET /api/health
GET /api/calendar?bbox=W,S,E,N&from=YYYY-MM&to=YYYY-MM
    200  harmonized calendar and a summary of the selected period
    202  {"status": "downloading", "progress": {"done", "total"}}: the area is being fetched from FIRMS for
         the first time; ask again with the same URL
GET /api/hotspots.csv?bbox=W,S,E,N&from=YYYY-MM-DD&to=YYYY-MM-DD
    200  CSV of the hot spots found in the search, 202 as above

`CORS_ORIGINS` (comma-separated, default http://localhost:4200) lists the origins of the web app.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .firms import FirmsError
from .service import BadRequest, CalendarService, NotReady

app = FastAPI(title="KMD Labs burning-activity calendar", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:4200").split(","),
                   allow_methods=["GET"], allow_headers=["*"])
service = CalendarService()

BBOX = Query(..., description="W,S,E,N in decimal degrees", examples=["-8.11,40.00,-7.62,40.43"])
FROM = Query(None, alias="from", description="first day or month, YYYY-MM-DD or YYYY-MM")
TO = Query(None, alias="to", description="last day or month, YYYY-MM-DD or YYYY-MM")


def _guard(call):
    try:
        return call()
    except NotReady as exc:
        return JSONResponse({"status": "downloading", "progress": exc.progress}, status_code=202, headers={"Retry-After": "5"})
    except BadRequest as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except FirmsError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "firmsKeyConfigured": service.client.online,
            "cachedRegions": [{"bbox": list(r.bbox), "rows": r.manifest.get("rows", 0), "dataThrough": r.manifest.get("dataThrough")}
                              for r in service.store.regions()]}


@app.get("/api/calendar")
def calendar(bbox: str = BBOX, date_from: str | None = FROM, date_to: str | None = TO):
    return _guard(lambda: service.calendar(bbox, date_from, date_to))


@app.get("/api/hotspots.csv")
def hotspots_csv(bbox: str = BBOX, date_from: str | None = FROM, date_to: str | None = TO):
    return _guard(lambda: Response(service.hotspots_csv(bbox, date_from, date_to), media_type="text/csv",
                                   headers={"Content-Disposition": 'attachment; filename="hotspots.csv"'}))
