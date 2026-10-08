"""Pack LibreOffice's per-sheet CSV exports into the `sheets` artifact.

The artifact is plain text only: sheet names and cell text AS DISPLAYED. No
formatting, formulas, macros or links can be carried by it.

    {"sheets": [{"name": str, "csv": str, "totalRows": int, "truncated": bool}]}
"""
import csv
import io
import json

from . import config
from .errors import ConvertError


def _pack_sheet(path: str) -> tuple[str, int, bool]:
    """Re-serialize the first rows/cols of one CSV; count every row."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    total = 0
    truncated = False
    csv.field_size_limit(config.SHEET_MAX_BYTES)
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        try:
            for row in csv.reader(f):
                total += 1
                if total <= config.SHEET_MAX_ROWS:
                    if len(row) > config.SHEET_MAX_COLS:
                        truncated = True
                        row = row[: config.SHEET_MAX_COLS]
                    writer.writerow(row)
                else:
                    truncated = True
        except csv.Error:
            raise ConvertError(ConvertError.UNCONVERTIBLE)
    return out.getvalue(), total, truncated


def build_artifact(sheets: list[tuple[str, str]]) -> bytes:
    """`sheets` is [(display name, csv path)] in workbook order."""
    if not sheets:
        raise ConvertError(ConvertError.UNCONVERTIBLE)
    items = []
    clipped = False
    for name, path in sheets[: config.SHEET_MAX_SHEETS]:
        text, total, truncated = _pack_sheet(path)
        items.append({"name": name[:255], "csv": text, "totalRows": total, "truncated": truncated})
    if len(sheets) > config.SHEET_MAX_SHEETS:
        clipped = True
    body = json.dumps({"sheets": items, "moreSheets": clipped}, ensure_ascii=False).encode("utf-8")
    if len(body) > config.SHEET_MAX_BYTES:
        raise ConvertError(ConvertError.LIMIT)
    return body
