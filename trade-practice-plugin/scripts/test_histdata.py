#!/usr/bin/env python3
import re
import urllib.parse
import urllib.request
import zipfile
import io

PAIR = "xauusd"
YEAR = "2020"
PAGE = f"https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{PAIR}/{YEAR}"

req = urllib.request.Request(PAGE, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=90) as resp:
    html = resp.read().decode("utf-8", "replace")
    cookie = resp.headers.get("Set-Cookie") or ""

m = re.search(r'name="tk"\s+value="([^"]+)"', html)
if not m:
    m = re.search(r"id=\"tk\"\s+value=\"([^\"]+)\"", html)
if not m:
    print("tk NOT FOUND")
    print(html[:500])
    raise SystemExit(1)
tk = m.group(1)
print("tk", tk[:24], "...")

# session cookie only first part
session = ""
for part in cookie.split(","):
    if "PHPSESSID" in part or "histdata" in part.lower():
        session = part.split(";")[0].strip()
        break
if not session and cookie:
    session = cookie.split(";")[0].strip()

post_data = urllib.parse.urlencode(
    {
        "tk": tk,
        "date": "2020",
        "datemonth": YEAR,
        "platform": "ASCII",
        "timeframe": "M1",
        "fxpair": PAIR.upper(),
    }
).encode("utf-8")

headers = {
    "User-Agent": "Mozilla/5.0",
    "Referer": PAGE,
    "Content-Type": "application/x-www-form-urlencoded",
}
if session:
    headers["Cookie"] = session

post_req = urllib.request.Request("https://www.histdata.com/get.php", data=post_data, headers=headers, method="POST")
with urllib.request.urlopen(post_req, timeout=120) as resp:
    blob = resp.read()
print("download bytes", len(blob), "magic", blob[:4])

if blob[:2] != b"PK":
    print(blob[:300].decode("utf-8", "replace"))
    raise SystemExit(2)

with zipfile.ZipFile(io.BytesIO(blob)) as zf:
    names = zf.namelist()
    print("zip files", names[:3])
    text = zf.read(names[0]).decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("<")]
    print("sample lines", lines[:3])
    print("total lines", len(lines))
