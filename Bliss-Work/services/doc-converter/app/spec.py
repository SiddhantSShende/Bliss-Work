"""What each supported kind is, and how LibreOffice must open it.

The import filter is PINNED per kind. Left to auto-detection LibreOffice picks
an import filter from the file's CONTENT, which would expose every importer it
has (RTF, ODF, SVG, ...) to hostile bytes. A file whose content does not match
its pinned filter simply fails to open — it fails closed.
"""
from dataclasses import dataclass

OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
ZIP_MAGIC = b"PK\x03\x04"

PDF = "pdf"
SHEETS = "sheets"

# Calc CSV export: UTF-8, "," / '"', header line 1, cell content AS DISPLAYED,
# no formulas, and the last token -1 = every sheet to its own file.
CSV_FILTER = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1"


@dataclass(frozen=True)
class Spec:
    kind: str
    magic: bytes
    infilter: str
    artifact: str  # PDF | SHEETS
    convert_to: str

    @property
    def is_zip(self) -> bool:
        return self.magic == ZIP_MAGIC


SPECS = {
    "doc": Spec("doc", OLE_MAGIC, "MS Word 97", PDF, "pdf:writer_pdf_Export"),
    "docx": Spec("docx", ZIP_MAGIC, "MS Word 2007 XML", PDF, "pdf:writer_pdf_Export"),
    "ppt": Spec("ppt", OLE_MAGIC, "MS PowerPoint 97", PDF, "pdf:impress_pdf_Export"),
    "pptx": Spec("pptx", ZIP_MAGIC, "Impress MS PowerPoint 2007 XML", PDF, "pdf:impress_pdf_Export"),
    "xls": Spec("xls", OLE_MAGIC, "MS Excel 97", SHEETS, CSV_FILTER),
    "xlsx": Spec("xlsx", ZIP_MAGIC, "Calc MS Excel 2007 XML", SHEETS, CSV_FILTER),
}
