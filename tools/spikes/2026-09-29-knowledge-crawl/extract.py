"""Stage 3 extractors for PDF, Office (DOCX/PPTX/XLSX/HWPX), HWP and text files.

Reads [{"id", "path", "ext"}] as JSON on stdin; writes one JSON line per file:
{"id", "excerpts": [{"locator", "text", "kind"}], "error"}. Files are opened read-only.
"""
import json
import re
import subprocess
import sys
import zipfile
from xml.etree import ElementTree

MAX = 1200
sys.stdout.reconfigure(encoding="utf-8")


def chunks(text, locator, kind="text"):
    """Split on blank lines, then pack paragraphs up to MAX characters."""
    out, buf = [], ""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\r\n\s*\r\n", text) if p.strip()]
    for p in paragraphs:
        while len(p) > MAX:
            cut = max(p.rfind(". ", 0, MAX), p.rfind("\n", 0, MAX), MAX // 2)
            out.append(p[: cut + 1].strip())
            p = p[cut + 1 :].strip()
        if buf and len(buf) + len(p) + 1 > MAX:
            out.append(buf)
            buf = ""
        buf = (buf + "\n" + p).strip()
    if buf:
        out.append(buf)
    parts = [c for c in out if len(re.sub(r"\s", "", c)) >= 4]
    suffix = len(parts) > 1
    return [
        {"locator": f"{locator}#{i + 1}" if suffix else locator, "text": c, "kind": kind}
        for i, c in enumerate(parts)
    ]


def xml_paragraphs(data, paragraph_tag, text_tag):
    root = ElementTree.fromstring(data)
    lines = []
    for p in root.iter():
        if p.tag.endswith("}" + paragraph_tag):
            line = "".join(t.text or "" for t in p.iter() if t.tag.endswith("}" + text_tag))
            if line.strip():
                lines.append(line)
    return lines


def pdf(path):
    import pymupdf as fitz

    out = []
    with fitz.open(path) as document:
        for index, page in enumerate(document):
            out += chunks(page.get_text(), f"p{index + 1}", "page")
            for annot in page.annots() or []:
                info = annot.info
                content = (info.get("content") or "").strip()
                if content:
                    who = info.get("title") or ""
                    out.append({"locator": f"p{index + 1}/annot", "kind": "annotation",
                                "text": f"[{annot.type[1]} · {who} · {info.get('modDate') or info.get('creationDate') or ''}] {content}"})
    return out


def docx(path):
    with zipfile.ZipFile(path) as z:
        out = chunks("\n\n".join(xml_paragraphs(z.read("word/document.xml"), "p", "t")), "body")
        if "word/comments.xml" in z.namelist():
            for line in xml_paragraphs(z.read("word/comments.xml"), "p", "t"):
                out.append({"locator": "comment", "text": line, "kind": "comment"})
    return out


def pptx(path):
    out = []
    with zipfile.ZipFile(path) as z:
        slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                        key=lambda n: int(re.findall(r"\d+", n)[-1]))
        for name in slides:
            number = re.findall(r"\d+", name)[-1]
            out += chunks("\n".join(xml_paragraphs(z.read(name), "p", "t")), f"slide{number}", "slide")
            notes = f"ppt/notesSlides/notesSlide{number}.xml"
            if notes in z.namelist():
                out += chunks("\n".join(xml_paragraphs(z.read(notes), "p", "t")), f"slide{number}/notes", "notes")
    return out


def xlsx(path):
    import openpyxl

    out = []
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in book.worksheets:
        rows = []
        for row in sheet.iter_rows(values_only=True):
            cells = [str(v).strip() for v in row if v is not None and str(v).strip()]
            if cells:
                rows.append("\t".join(cells))
        out += chunks("\n\n".join(rows), f"sheet:{sheet.title}", "sheet")
    book.close()
    return out


def hwpx(path):
    out = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if re.match(r"Contents/section\d+\.xml$", n)):
            out += chunks("\n\n".join(xml_paragraphs(z.read(name), "p", "t")), name.split("/")[-1][:-4])
    return out


def hwp(path):
    import os, shutil, sysconfig

    tool = shutil.which("hwp5txt") or os.path.join(sysconfig.get_path("scripts", f"{os.name}_user"), "hwp5txt.exe")
    text = subprocess.run([tool, path], capture_output=True, timeout=120).stdout.decode("utf-8", "replace")
    return chunks(text, "body")


def plain(path):
    raw = open(path, "rb").read()
    for encoding in ("utf-8", "cp949"):
        try:
            return chunks(raw.decode(encoding), "body")
        except UnicodeDecodeError:
            pass
    return chunks(raw.decode("utf-8", "replace"), "body")


HANDLERS = {"pdf": pdf, "docx": docx, "pptx": pptx, "xlsx": xlsx, "xlsm": xlsx, "hwpx": hwpx, "hwp": hwp,
            "txt": plain, "csv": plain}

for item in json.load(sys.stdin):
    handler = HANDLERS.get(item["ext"])
    try:
        excerpts = handler(item["path"]) if handler else None
        error = None if handler else "unsupported"
    except Exception as exc:  # one bad file must not stop the run
        excerpts, error = [], f"{type(exc).__name__}: {str(exc)[:200]}"
    print(json.dumps({"id": item["id"], "excerpts": excerpts or [], "error": error}, ensure_ascii=False), flush=True)
