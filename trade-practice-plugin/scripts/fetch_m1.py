#!/usr/bin/env python3
"""
XAUUSD / GBPUSD 1m → workspace monthly CSV (plugin never imports this).

Sole data source: HistData.com (ASCII 1-minute bar quotes).
  GET download page → tk → POST get.php.
  Timestamps are US Eastern local time (EST/EDT) in practice; we add 7h to
  the source label so the CSV matches MT5 server time (GMT+2 winter, GMT+3
  summer). The chart/practice/chat therefore all show MT5 time.

Progress: .trade-practice/state/<SYMBOL>-1m-fetch.json
Log:       .trade-practice/logs/<SYMBOL>-1m-fetch.log
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
from pathlib import Path

# Source labels are US Eastern local time. Treat them as fixed UTC-5 (the
# original conversion) and add 2h more → source label + 7h = MT5 server time.
HISTDATA_EST = timezone(timedelta(hours=-5))
SERVER_SHIFT = timedelta(hours=2)
HISTDATA_PAGE = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{pair}/{year}{month_path}"
HISTDATA_GET = "https://www.histdata.com/get.php"
HISTDATA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

CSV_HEADER = "openTime,open,high,low,close,volume"


def log_line(log_path: Path, msg: str) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"[{datetime.now(timezone.utc).isoformat()}] {msg}\n")
    print(msg, flush=True)


def write_progress(state_path: Path, payload: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    payload["updatedAt"] = datetime.now(timezone.utc).isoformat()
    state_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def normalize_open_time(open_time: str) -> str:
    """One canonical key per server-time minute: YYYY-MM-DDTHH:MM:SSZ (no millis)."""
    dt = datetime.fromisoformat(str(open_time).strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    epoch = int(dt.astimezone(timezone.utc).timestamp())
    epoch -= epoch % 60
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def row_to_csv_line(open_time: str, o, h, l, c, vol) -> dict:
    return {
        "openTime": normalize_open_time(open_time),
        "open": f"{float(o):.5f}",
        "high": f"{float(h):.5f}",
        "low": f"{float(l):.5f}",
        "close": f"{float(c):.5f}",
        "volume": str(int(float(vol)) if vol else 0),
    }


def merge_month_file(csv_path: Path, rows: list[dict]) -> int:
    existing: dict[str, dict] = {}
    if csv_path.exists():
        text = csv_path.read_text(encoding="utf-8")
        lines = text.replace("\ufeff", "").splitlines()
        start = 1 if lines and lines[0].lower().startswith("opentime") else 0
        for line in lines[start:]:
            parts = line.split(",")
            if len(parts) < 5:
                continue
            try:
                key = normalize_open_time(parts[0].strip())
            except ValueError:
                continue
            existing[key] = {
                "openTime": key,
                "open": parts[1],
                "high": parts[2],
                "low": parts[3],
                "close": parts[4],
                "volume": parts[5] if len(parts) > 5 else "0",
            }
    added = 0
    for row in rows:
        key = normalize_open_time(row["openTime"])
        normalized = {**row, "openTime": key}
        if key not in existing:
            added += 1
        existing[key] = normalized
    if added == 0 and csv_path.exists():
        # Nothing new: keep the file and its mtime, so the chart does not reload
        # (and a practice session is not interrupted) after a no-op update.
        return 0
    ordered = sorted(existing.values(), key=lambda r: r["openTime"])
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    body = [CSV_HEADER] + [
        ",".join([r["openTime"], r["open"], r["high"], r["low"], r["close"], r["volume"]]) for r in ordered
    ]
    csv_path.write_text("\n".join(body) + "\n", encoding="utf-8")
    return added


def month_key_from_open_time(open_time: str) -> str:
    dt = datetime.fromisoformat(open_time.replace("Z", "+00:00"))
    return f"{dt.year:04d}-{dt.month:02d}"


def _histdata_opener() -> urllib.request.OpenerDirector:
    jar = CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def download_histdata_zip(pair: str, year: int, month: int | None = None) -> bytes | None:
    """month is 1–12 for current-year monthly packs; None for full calendar year."""
    pair_lower = pair.lower()
    month_path = f"/{month}" if month else ""
    page_url = HISTDATA_PAGE.format(pair=pair_lower, year=year, month_path=month_path)
    datemonth = f"{year}{month:02d}" if month else str(year)

    opener = _histdata_opener()
    page_req = urllib.request.Request(page_url, headers={"User-Agent": HISTDATA_UA})
    with opener.open(page_req, timeout=90) as resp:
        html = resp.read().decode("utf-8", "replace")

    m = re.search(r'name="tk"\s+value="([^"]+)"', html) or re.search(
        r'id="tk"\s+value="([^"]+)"', html
    )
    if not m:
        return None
    tk = m.group(1)

    post_data = urllib.parse.urlencode(
        {
            "tk": tk,
            "date": str(year),
            "datemonth": datemonth,
            "platform": "ASCII",
            "timeframe": "M1",
            "fxpair": pair.upper(),
        }
    ).encode("utf-8")
    post_req = urllib.request.Request(
        HISTDATA_GET,
        data=post_data,
        headers={
            "User-Agent": HISTDATA_UA,
            "Referer": page_url,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with opener.open(post_req, timeout=180) as resp:
        blob = resp.read()
    if len(blob) < 4 or blob[:2] != b"PK":
        return None
    return blob


def parse_histdata_zip(blob: bytes) -> list[dict]:
    rows: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith((".csv", ".txt")))
        text = zf.read(name).decode("utf-8", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("<"):
            continue
        parts = line.split(";")
        if len(parts) < 5:
            continue
        dt_est = datetime.strptime(parts[0], "%Y%m%d %H%M%S").replace(tzinfo=HISTDATA_EST)
        server_time = dt_est.astimezone(timezone.utc) + SERVER_SHIFT
        open_time = normalize_open_time(server_time.isoformat())
        rows.append(
            row_to_csv_line(
                open_time,
                parts[1],
                parts[2],
                parts[3],
                parts[4],
                parts[5] if len(parts) > 5 else 0,
            )
        )
    return rows


def bucket_rows_by_month(rows: list[dict]) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = {}
    for row in rows:
        key = month_key_from_open_time(row["openTime"])
        buckets.setdefault(key, []).append(row)
    return buckets


def backfill_histdata(
    workspace: Path,
    state_path: Path,
    log_path: Path,
    pair: str,
    from_year: int,
    to_year: int | None,
    only_months: set[str] | None = None,
) -> int:
    symbol = pair.upper()
    data_root = workspace / ".trade-practice" / "data" / symbol / "1m"
    now = datetime.now(timezone.utc)
    end_year = to_year if to_year is not None else now.year
    total_bars = 0

    write_progress(
        state_path,
        {
            "symbol": symbol,
            "interval": "1m",
            "running": True,
            "mode": "histdata",
            "fromYear": from_year,
            "toYear": end_year,
            "lastMessage": "HistData 下载中…",
        },
    )

    def month_wanted(month_key: str) -> bool:
        return only_months is None or month_key in only_months

    def year_wanted(year: int) -> bool:
        if only_months is None:
            return True
        prefix = f"{year}-"
        return any(m.startswith(prefix) for m in only_months)

    current_year = now.year
    for year in range(from_year, end_year + 1):
        if year < current_year:
            if not year_wanted(year):
                continue
            label = str(year)
            log_line(log_path, f"histdata {symbol} {label} (year zip)")
            write_progress(
                state_path,
                {
                    "symbol": symbol,
                    "interval": "1m",
                    "running": True,
                    "mode": "histdata",
                    "currentPeriod": label,
                    "lastMessage": f"下载 {label}…",
                },
            )
            blob = download_histdata_zip(symbol, year, None)
            if not blob:
                log_line(log_path, f"  skip {label}: no zip")
                continue
            rows = parse_histdata_zip(blob)
            log_line(log_path, f"  parsed {len(rows)} bars")
            for month_key, month_rows in bucket_rows_by_month(rows).items():
                if not month_wanted(month_key):
                    continue
                added = merge_month_file(data_root / f"{month_key}.csv", month_rows)
                total_bars += added
                log_line(log_path, f"  {month_key}: +{added} (file {len(month_rows)} in zip)")
            time.sleep(2)
            continue

        if year > current_year:
            continue

        for month in range(1, 13):
            if month > now.month:
                break
            label = f"{year}-{month:02d}"
            if not month_wanted(label):
                continue
            log_line(log_path, f"histdata {symbol} {label} (month zip)")
            write_progress(
                state_path,
                {
                    "symbol": symbol,
                    "interval": "1m",
                    "running": True,
                    "mode": "histdata",
                    "currentPeriod": label,
                    "lastMessage": f"下载 {label}…",
                },
            )
            blob = download_histdata_zip(symbol, year, month)
            if not blob:
                log_line(log_path, f"  skip {label}: no zip")
                continue
            rows = parse_histdata_zip(blob)
            month_key = f"{year}-{month:02d}"
            added = merge_month_file(data_root / f"{month_key}.csv", rows)
            total_bars += added
            log_line(log_path, f"  {month_key}: +{added} ({len(rows)} bars)")
            time.sleep(2)

    def count_bars_in_store() -> int:
        total = 0
        if not data_root.exists():
            return 0
        for path in sorted(data_root.glob("????-??.csv")):
            lines = path.read_text(encoding="utf-8").splitlines()
            if lines and lines[0].lower().startswith("opentime"):
                total += len(lines) - 1
            else:
                total += len(lines)
        return total

    store_total = count_bars_in_store()
    jan_path = data_root / "2020-01.csv"
    jan_count = 0
    if jan_path.exists():
        jan_count = sum(1 for _ in jan_path.read_text(encoding="utf-8").splitlines()) - 1

    msg = (
        f"HistData 完成：本次新增 {total_bars} 根；"
        f"工作区 {symbol}/1m 合计约 {store_total} 根（2020-01 约 {jan_count} 行）"
    )
    log_line(log_path, msg)
    write_progress(
        state_path,
        {
            "symbol": symbol,
            "interval": "1m",
            "running": False,
            "mode": "histdata",
            "totalBars": store_total,
            "addedBars": total_bars,
            "proved2020_01": jan_count > 1000,
            "lastMessage": msg,
            "sampleSource": "histdata.com",
            "csvFormat": "openTime,open,high,low,close,volume (MT5 server time ISO8601 Z)",
        },
    )
    return 0 if store_total > 0 else 1


def prove_2020_01(workspace: Path, state_path: Path, log_path: Path) -> int:
    """Smoke-test: download HistData 2020-01 and ensure real 1m bars land on disk."""
    data_root = workspace / ".trade-practice" / "data" / "XAUUSD" / "1m"
    write_progress(
        state_path,
        {
            "symbol": "XAUUSD",
            "interval": "1m",
            "running": True,
            "mode": "prove-2020-01",
            "lastMessage": "HistData 下载 2020-01…",
            "sampleSource": "histdata.com",
        },
    )
    log_line(log_path, "prove: HistData XAUUSD 2020-01")
    blob = download_histdata_zip("XAUUSD", 2020, 1)
    if not blob:
        write_progress(
            state_path,
            {"symbol": "XAUUSD", "interval": "1m", "running": False, "lastMessage": "prove 失败：HistData 无数据"},
        )
        return 1
    rows = parse_histdata_zip(blob)
    jan_rows = [r for r in rows if r["openTime"].startswith("2020-01")]
    if not jan_rows:
        write_progress(
            state_path,
            {"symbol": "XAUUSD", "interval": "1m", "running": False, "lastMessage": "prove 失败：无 2020-01 bar"},
        )
        return 1
    csv_path = data_root / "2020-01.csv"
    added = merge_month_file(csv_path, jan_rows)
    total = len(jan_rows)
    msg = f"prove OK: 2020-01 写入 {added} 新行（共 {total} 根 1m）→ {csv_path}"
    log_line(log_path, msg)
    write_progress(
        state_path,
        {
            "symbol": "XAUUSD",
            "interval": "1m",
            "running": False,
            "mode": "prove-2020-01",
            "proved2020_01": True,
            "totalBars": total,
            "lastMessage": msg,
            "sampleSource": "histdata.com",
        },
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch 1m OHLC from HistData.com into monthly CSV")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--prove", action="store_true", help="仅验证 HistData 2020-01 可写入")
    parser.add_argument(
        "--histdata",
        action="store_true",
        default=True,
        help="从 HistData.com 拉取 M1（默认）",
    )
    parser.add_argument("--pair", default="XAUUSD", help="HistData 品种，如 XAUUSD / GBPUSD")
    parser.add_argument("--from-year", type=int, default=2020, dest="from_year")
    parser.add_argument("--to-year", type=int, default=None, dest="to_year")
    parser.add_argument(
        "--only-months",
        default="",
        help="逗号分隔 YYYY-MM，仅拉取这些月份（由 update-check 生成）",
    )
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    state_path = workspace / ".trade-practice" / "state" / "XAUUSD-1m-fetch.json"
    log_path = workspace / ".trade-practice" / "logs" / "XAUUSD-1m-fetch.log"

    if args.prove:
        return prove_2020_01(workspace, state_path, log_path)

    sym = args.pair.upper()
    state_path = workspace / ".trade-practice" / "state" / f"{sym}-1m-fetch.json"
    log_path = workspace / ".trade-practice" / "logs" / f"{sym}-1m-fetch.log"
    only = {m.strip() for m in args.only_months.split(",") if m.strip()}
    return backfill_histdata(
        workspace,
        state_path,
        log_path,
        sym,
        args.from_year,
        args.to_year,
        only if only else None,
    )


if __name__ == "__main__":
    sys.exit(main())
