"""Large fixtures for the measurement run (plan §3.3). Run INSIDE the image:

    docker run --rm --tmpfs /tmp:size=2g -v "$PWD/tests:/app/tests:ro" -v "$OUT:/fx" \
        doc-converter:dev python /app/tests/make_large_fixtures.py /fx
"""
import base64
import os
import random
import struct
import subprocess
import sys
import zlib

from make_fixtures import NS  # noqa: E402  (same directory)


def png(w: int, h: int, seed: int) -> bytes:
    """An incompressible RGB PNG: random noise, so size is ~3*w*h bytes."""
    rnd = random.Random(seed)
    raw = b"".join(b"\x00" + rnd.randbytes(w * 3) for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 0)) + chunk(b"IEND", b""))


def convert(src: str, flt: str, out: str) -> None:
    subprocess.run(["soffice", "--headless", "--norestore", "-env:UserInstallation=file:///tmp/lgprofile",
                    "--convert-to", flt, "--outdir", out, src], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)


def fodt(pages: int) -> str:
    para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. " * 6
    body = "".join(f"<text:p>{i}: {para}</text:p>" for i in range(pages * 40))
    return (f'<?xml version="1.0"?><office:document {NS} office:mimetype="application/vnd.oasis.opendocument.text">'
            f"<office:body><office:text>{body}</office:text></office:body></office:document>")


def fods(rows: int, cols: int, sheets: int) -> str:
    row = "<table:table-row>" + "".join(
        f'<table:table-cell office:value-type="float" office:value="{c}"><text:p>{c}</text:p></table:table-cell>'
        for c in range(cols)) + "</table:table-row>"
    tables = "".join(f'<table:table table:name="S{s}">{row * rows}</table:table>' for s in range(sheets))
    return (f'<?xml version="1.0"?><office:document {NS} office:mimetype="application/vnd.oasis.opendocument.spreadsheet">'
            f"<office:body><office:spreadsheet>{tables}</office:spreadsheet></office:body></office:document>")


def fodp(slides: int, w: int, h: int) -> str:
    pages = []
    for i in range(slides):
        b64 = base64.b64encode(png(w, h, i)).decode()
        pages.append(
            f'<draw:page draw:name="s{i}"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="14cm">'
            f"<draw:image><office:binary-data>{b64}</office:binary-data></draw:image></draw:frame></draw:page>")
    return (f'<?xml version="1.0"?><office:document {NS} office:mimetype="application/vnd.oasis.opendocument.presentation">'
            f'<office:body><office:presentation>{"".join(pages)}</office:presentation></office:body></office:document>')


JOBS = [
    # name, source builder, [(extension, filter)]
    ("doc200p", lambda: fodt(200), "fodt", [("docx", "docx"), ("doc", "doc:MS Word 97")]),
    ("sheet50k", lambda: fods(50000, 20, 1), "fods", [("xlsx", "xlsx"), ("xls", "xls:MS Excel 97")]),
    ("sheet64k_wide", lambda: fods(65000, 250, 1), "fods", [("xlsx", "xlsx"), ("xls", "xls:MS Excel 97")]),
    ("sheets30", lambda: fods(2000, 20, 30), "fods", [("xlsx", "xlsx")]),
    ("deck_img_s", lambda: fodp(6, 1200, 1200), "fodp", [("pptx", "pptx"), ("ppt", "ppt:MS PowerPoint 97")]),
    ("deck_img_l", lambda: fodp(14, 2200, 2200), "fodp", [("pptx", "pptx")]),
    ("deck_img_xl", lambda: fodp(14, 3600, 3600), "fodp", [("pptx", "pptx")]),
]


def main(out: str) -> None:
    os.makedirs(out, exist_ok=True)
    only = set(sys.argv[2:])
    for name, build, ext, targets in JOBS:
        if only and name not in only:
            continue
        src = os.path.join(out, f"{name}.{ext}")
        with open(src, "w", encoding="utf-8") as f:
            f.write(build())
        for e, flt in targets:
            tmp = os.path.join(out, "_t")
            os.makedirs(tmp, exist_ok=True)
            convert(src, flt, tmp)
            os.replace(os.path.join(tmp, f"{name}.{e}"), os.path.join(out, f"{name}.{e}"))
        os.remove(src)
        print(name, {e: os.path.getsize(os.path.join(out, f"{name}.{e}")) for e, _ in targets}, flush=True)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    main(sys.argv[1])
