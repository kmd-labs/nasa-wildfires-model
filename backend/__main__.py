"""Command line: python -m backend <command>

    seed      import FIRMS CSVs already on disk (data/raw/firms) as a cached region, no key needed
    fetch     download and cache the full record of a bounding box (needs FIRMS_MAP_KEY)
    calendar  print the API payload for a bounding box and period, optionally save the JSON and the CSV
    serve     start the HTTP API
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .firms import REPO, RegionStore
from .service import CalendarService, parse_bbox


def main() -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO / ".env")
    except ImportError:
        pass
    parser = argparse.ArgumentParser(prog="python -m backend", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("seed", help="import FIRMS CSVs already on disk")
    s.add_argument("--raw", default=str(REPO / "data" / "raw" / "firms"))
    s.add_argument("--bbox", default="-9.6,36.0,3.4,43.8", help="W,S,E,N covered by the files")
    f = sub.add_parser("fetch", help="download the full record of a bounding box")
    f.add_argument("--bbox", required=True)
    c = sub.add_parser("calendar", help="harmonized calendar of a bounding box")
    c.add_argument("--bbox", required=True)
    c.add_argument("--from", dest="date_from")
    c.add_argument("--to", dest="date_to")
    c.add_argument("--json", help="save the payload here")
    c.add_argument("--csv", help="save the hot spots of the search here")
    v = sub.add_parser("serve", help="start the HTTP API")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.command == "seed":
        region = RegionStore().seed(Path(args.raw), parse_bbox(args.bbox))
        print(f"seeded region {region.bbox}: {region.manifest['rows']:,} detections through {region.manifest['dataThrough']}")
    elif args.command == "fetch":
        service = CalendarService()
        if not service.client.online:
            sys.exit("FIRMS_MAP_KEY is not set (.env)")
        region = service.store.get_or_create(parse_bbox(args.bbox))
        outcome = region.sync(service.client, progress=lambda done, total: print(f"\r  {done}/{total} chunks", end="", flush=True))
        print(f"\nregion {region.bbox}: {region.manifest.get('rows', 0):,} detections, {outcome['chunksFetched']} chunks fetched, {len(outcome['failed'])} failed")
        for line in outcome["failed"][:10]:
            print("  failed:", line)
    elif args.command == "calendar":
        service = CalendarService()
        payload = service.calendar(args.bbox, args.date_from, args.date_to, wait=True)
        if args.json:
            Path(args.json).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if args.csv:
            Path(args.csv).write_text(service.hotspots_csv(args.bbox, args.date_from, args.date_to, wait=True), encoding="utf-8")
        summary = {"selection": {k: v for k, v in payload["selection"].items() if k != "cells"}, "cells": len(payload["selection"]["cells"]),
                   "dataThrough": payload["metadata"]["dataThrough"], "h3Resolution": payload["metadata"]["h3Resolution"],
                   "calibration": payload["metadata"]["calibration"], "validation": payload["validation"]}
        print(json.dumps(summary, indent=1, ensure_ascii=False))
    elif args.command == "serve":
        import uvicorn
        uvicorn.run("backend.server:app", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
