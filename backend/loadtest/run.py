"""Load profile (spec 30): N concurrently active readers, target ~100 API requests/s.

usage: python loadtest/run.py --base http://127.0.0.1:8100 --users 500 --seconds 60 --think 5
Requires the synthetic dataset from loadtest/seed.sql (tokens loadtok-1 … loadtok-2000).
Prints p50/p95/p99 per endpoint and the error rate; writes JSON with --out.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import time
import uuid

import httpx

MIX = [("content", 30), ("progress", 30), ("events", 15), ("home", 10), ("works", 10), ("rankings", 5)]


async def reader(i: int, client: httpx.AsyncClient, args, stats: dict, stop: float, chapters: list[int]):
    h = {"Authorization": f"Bearer loadtok-{i + 1}"}
    rnd = random.Random(i)
    ch = rnd.choice(chapters)
    session_id = None
    seq = 0
    names, weights = zip(*MIX)
    await asyncio.sleep(rnd.random() * args.think)
    while time.monotonic() < stop:
        kind = rnd.choices(names, weights)[0]
        t0 = time.perf_counter()
        try:
            if kind == "content":
                ch = rnd.choice(chapters)
                r = await client.get(f"/api/v1/chapters/{ch}/content", params={"device_id": f"d{i}"}, headers=h)
                if r.status_code == 200:
                    session_id = r.json().get("session_id")
            elif kind == "progress":
                seq += 1
                r = await client.put("/api/v1/reading/progress", headers=h, json={"work_id": ch_work[ch], "chapter_id": ch, "block_id": f"b{rnd.randint(1, 30):09d}", "ratio": rnd.random(), "sequence": seq, "device_id": f"d{i}"})
            elif kind == "events":
                if not session_id:
                    continue
                seq += 1
                r = await client.post("/api/v1/reading/events/batch", headers=h, json={"events": [{"event_id": uuid.uuid4().hex, "session_id": session_id, "sequence": seq, "type": "blocks", "blocks": [f"b{rnd.randint(1, 30):09d}"], "active_seconds": 10}]})
            elif kind == "home":
                r = await client.get("/api/v1/home", headers=h)
            elif kind == "works":
                r = await client.get("/api/v1/works", params={"genre": rnd.choice(["hayotiy", "sevgi", "detektiv", "drama"]), "sort": rnd.choice(["new", "popular"])}, headers=h)
            else:
                r = await client.get("/api/v1/rankings", params={"period": rnd.choice(["today", "week", "month"])}, headers=h)
            ok = r.status_code < 400
        except Exception:
            ok = False
        dt = (time.perf_counter() - t0) * 1000
        s = stats.setdefault(kind, {"lat": [], "err": 0})
        s["lat"].append(dt)
        if not ok:
            s["err"] += 1
        await asyncio.sleep(rnd.expovariate(1 / args.think))


ch_work: dict[int, int] = {}


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 1) if xs else 0.0


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8100")
    ap.add_argument("--users", type=int, default=500)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--think", type=float, default=5.0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    async with httpx.AsyncClient(base_url=args.base, timeout=30, limits=httpx.Limits(max_connections=200, max_keepalive_connections=200)) as client:
        # discover chapters through the public API
        works = []
        cursor = None
        for _ in range(5):
            r = (await client.get("/api/v1/works", params={"limit": 50, "cursor": cursor} if cursor else {"limit": 50})).json()
            works += r["items"]
            cursor = r["next_cursor"]
            if not cursor:
                break
        chapters = []
        for w in works[:120]:
            toc = (await client.get(f"/api/v1/works/{w['code']}/chapters")).json()
            for c in toc:
                ch_work[c["id"]] = w["id"]
                chapters.append(c["id"])
        stats: dict = {}
        started = time.monotonic()
        stop = started + args.seconds
        await asyncio.gather(*(reader(i, client, args, stats, stop, chapters) for i in range(args.users)))
        elapsed = time.monotonic() - started
    total = sum(len(s["lat"]) for s in stats.values())
    errors = sum(s["err"] for s in stats.values())
    report = {
        "users": args.users,
        "seconds": round(elapsed, 1),
        "requests": total,
        "rps": round(total / elapsed, 1),
        "error_rate_pct": round(100 * errors / max(1, total), 3),
        "endpoints": {k: {"n": len(s["lat"]), "p50_ms": pct(s["lat"], 0.5), "p95_ms": pct(s["lat"], 0.95), "p99_ms": pct(s["lat"], 0.99), "mean_ms": round(statistics.fmean(s["lat"]), 1) if s["lat"] else 0, "errors": s["err"]} for k, s in sorted(stats.items())},
    }
    print(json.dumps(report, indent=1))
    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
