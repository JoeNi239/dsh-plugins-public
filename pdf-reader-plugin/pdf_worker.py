"""Long-lived PDF worker for the DSH PDF reader plugin.

Speaks newline-delimited JSON on stdin/stdout. One reply line per request:

  request : {"id": <number>, "op": "info"|"page", ...}
  reply   : {"id": <number>, "ok": true, ...} | {"id": <number>, "ok": false, "error": "..."}

Only PyMuPDF is required. Documents stay open between calls so page turns are fast.
"""

import base64
import json
import os
import sys
import traceback
from collections import OrderedDict

import fitz

# Documents are opened from memory so the worker never holds a file handle:
# renaming or deleting a PDF keeps working while the reader is open.
DOCS = OrderedDict()
MAX_DOCS = 3
MAX_SPANS = 8000


def get_doc(path):
    key = os.path.normcase(os.path.abspath(path))
    info = os.stat(path)
    cached = DOCS.get(key)
    if cached and cached[0] == info.st_mtime_ns and cached[1] == info.st_size:
        DOCS.move_to_end(key)
        return cached[2]
    if cached:
        try:
            cached[2].close()
        except Exception:
            pass
        del DOCS[key]
    with open(path, "rb") as handle:
        data = handle.read()
    doc = fitz.open(stream=data, filetype="pdf")
    DOCS[key] = (info.st_mtime_ns, info.st_size, doc)
    while len(DOCS) > MAX_DOCS:
        _, (_, _, evicted) = DOCS.popitem(last=False)
        try:
            evicted.close()
        except Exception:
            pass
    return doc


def doc_info(doc, path):
    title = ""
    try:
        title = (doc.metadata or {}).get("title") or ""
    except Exception:
        title = ""
    width = height = 0.0
    if doc.page_count:
        rect = doc[0].rect
        width, height = rect.width, rect.height
    return {
        "path": path,
        "pages": doc.page_count,
        "title": title.strip() or os.path.splitext(os.path.basename(path))[0],
        "width": round(width, 2),
        "height": round(height, 2),
        "encrypted": bool(doc.needs_pass),
    }


def op_info(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    return dict(ok=True, **doc_info(doc, path))


def op_page(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    count = doc.page_count
    if count == 0:
        return {"ok": False, "error": "PDF 没有页面"}
    index = int(req.get("page") or 1) - 1
    index = max(0, min(count - 1, index))
    scale = float(req.get("scale") or 2.0)
    scale = max(0.5, min(4.0, scale))
    page = doc[index]
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
    image = base64.b64encode(pix.tobytes("png")).decode("ascii")

    spans = []
    try:
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text") or ""
                    if not text.strip():
                        continue
                    x0, y0, x1, y1 = span["bbox"]
                    spans.append([
                        round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2),
                        round(span.get("size") or (y1 - y0), 2), text,
                    ])
                    if len(spans) >= MAX_SPANS:
                        break
                if len(spans) >= MAX_SPANS:
                    break
            if len(spans) >= MAX_SPANS:
                break
    except Exception:
        spans = []

    try:
        text = page.get_text("text")
    except Exception:
        text = ""

    rect = page.rect
    return {
        "ok": True,
        "page": index + 1,
        "count": count,
        "width": round(rect.width, 2),
        "height": round(rect.height, 2),
        "image": image,
        "spans": spans,
        "text": text,
        "scale": scale,
    }


MARK_OPACITY = 0.42
DEFAULT_MARK_FILL = (1.0, 0.835, 0.29)


def mark_fill(value):
    """RGB (0..1) for one annotation colour; falls back to the reader's yellow."""
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return tuple(max(0.0, min(1.0, float(component))) for component in value)
        except Exception:
            return DEFAULT_MARK_FILL
    return DEFAULT_MARK_FILL


def crop_pixmap(doc, index, clip, scale, marks):
    page = doc[index]
    matrix = fitz.Matrix(scale, scale)
    if not marks:
        return page.get_pixmap(matrix=matrix, clip=clip, alpha=False, colorspace=fitz.csRGB)
    # Draw the reader's highlights on a one-page copy so the cached document
    # stays untouched. The shapes are part of the page render, so the crop sent
    # to the model shows the same colours the reader sees.
    copy = fitz.open()
    try:
        copy.insert_pdf(doc, from_page=index, to_page=index)
        target = copy[0]
        for mark in marks[:80]:
            raw = mark.get("rect") if isinstance(mark, dict) else None
            if not isinstance(raw, (list, tuple)) or len(raw) != 4:
                continue
            try:
                rect = fitz.Rect(*(float(value) for value in raw))
            except Exception:
                continue
            if rect.is_empty or rect.width < 0.5 or rect.height < 0.5:
                continue
            target.draw_rect(
                rect,
                color=None,
                fill=mark_fill(mark.get("color")),
                fill_opacity=MARK_OPACITY,
                width=0,
                overlay=True,
            )
        return target.get_pixmap(matrix=matrix, clip=clip, alpha=False, colorspace=fitz.csRGB)
    finally:
        copy.close()


def op_crop(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    count = doc.page_count
    if count == 0:
        return {"ok": False, "error": "PDF 没有页面"}
    index = int(req.get("page") or 1) - 1
    index = max(0, min(count - 1, index))
    page = doc[index]
    bounds = page.rect
    raw = req.get("rect") or []
    if len(raw) != 4:
        return {"ok": False, "error": "裁剪区域无效"}
    x0, y0, x1, y1 = (float(value) for value in raw)
    clip = fitz.Rect(
        max(bounds.x0, min(x0, x1)),
        max(bounds.y0, min(y0, y1)),
        min(bounds.x1, max(x0, x1)),
        min(bounds.y1, max(y0, y1)),
    )
    if clip.width < 2 or clip.height < 2:
        return {"ok": False, "error": "裁剪区域太小"}
    # Render small regions at higher density, large ones no bigger than ~1800px.
    longest = max(clip.width, clip.height)
    scale = float(req.get("scale") or 0) or min(3.0, max(1.2, 1800.0 / longest))
    scale = max(0.5, min(4.0, scale))
    marks = req.get("marks") if isinstance(req.get("marks"), list) else []
    pix = crop_pixmap(doc, index, clip, scale, marks)
    image = base64.b64encode(pix.tobytes("png")).decode("ascii")
    return {
        "ok": True,
        "page": index + 1,
        "image": image,
        "width": pix.width,
        "height": pix.height,
        "scale": scale,
    }


def op_find(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    needle = (req.get("text") or "").strip()
    if not needle:
        return {"ok": True, "hits": []}
    max_hits = max(1, min(30, int(req.get("max") or 12)))
    # Exact phrase first; long quotes often gain punctuation from the model, so
    # fall back to a shorter prefix before giving up.
    candidates = [needle]
    for length in (120, 80, 48, 24):
        if len(needle) > length:
            candidates.append(needle[:length].rstrip())
    hits = []
    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        for index in range(doc.page_count):
            if len(hits) >= max_hits:
                break
            page = doc[index]
            try:
                rects = page.search_for(candidate)
            except Exception:
                rects = []
            if not rects:
                continue
            key = (index + 1, rects[0].x0, rects[0].y0)
            if key in seen:
                continue
            seen.add(key)
            hits.append({
                "page": index + 1,
                "rects": [
                    [round(rect.x0, 2), round(rect.y0, 2), round(rect.x1, 2), round(rect.y1, 2)]
                    for rect in rects[:10]
                ],
            })
        if hits:
            break
    return {"ok": True, "hits": hits}


def op_text(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    requested = req.get("pages") or []
    if not isinstance(requested, list):
        requested = []
    result = []
    for raw in requested[:4]:
        try:
            number = int(raw)
        except Exception:
            continue
        if number < 1 or number > doc.page_count:
            continue
        try:
            text = doc[number - 1].get_text("text")
        except Exception:
            text = ""
        result.append({"page": number, "text": (text or "").strip()[:8000]})
    return {"ok": True, "pages": result}


def op_search(req):
    path = req["path"]
    doc = get_doc(path)
    if doc.needs_pass:
        return {"ok": False, "error": "PDF 已加密，暂不支持打开"}
    needle = (req.get("query") or req.get("text") or "").strip()
    if not needle:
        return {"ok": True, "hits": []}
    hits = []
    for index in range(doc.page_count):
        if len(hits) >= 6:
            break
        page = doc[index]
        try:
            rects = page.search_for(needle)
        except Exception:
            rects = []
        if not rects:
            continue
        rect = rects[0]
        clip = fitz.Rect(
            max(page.rect.x0, rect.x0 - 40),
            max(page.rect.y0, rect.y0 - 40),
            min(page.rect.x1, rect.x1 + 160),
            min(page.rect.y1, rect.y1 + 40),
        )
        try:
            excerpt = page.get_textbox(clip) or ""
        except Exception:
            excerpt = ""
        excerpt = " ".join(excerpt.split())[:400]
        hits.append({"page": index + 1, "excerpt": excerpt})
    return {"ok": True, "hits": hits}


OPS = {"info": op_info, "page": op_page, "crop": op_crop, "find": op_find, "text": op_text, "search": op_search}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        op = req.get("op")
        handler = OPS.get(op)
        try:
            if handler is None:
                reply = {"ok": False, "error": "unknown op: %s" % op}
            else:
                reply = handler(req)
        except fitz.FileDataError as error:
            reply = {"ok": False, "error": "无法解析 PDF：%s" % error}
        except Exception as error:  # noqa: BLE001 - report to the caller
            traceback.print_exc()
            reply = {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        reply["id"] = rid
        try:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        except BrokenPipeError:
            break
        sys.stdout.flush()


if __name__ == "__main__":
    main()
