"""Generate small, valid Office fixtures with LibreOffice itself.

Run INSIDE the converter image (it needs soffice):

    docker run --rm --tmpfs /tmp -v "$PWD/tests:/tests:ro" -v "$OUT:/fx" \
        doc-converter:dev python /tests/make_fixtures.py /fx

Sources are flat-ODF XML; each is converted to the legacy and OOXML formats.
"""
import os
import subprocess
import sys

NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'office:version="1.3"'
)

FODT = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document {NS} office:mimetype="application/vnd.oasis.opendocument.text">
<office:body><office:text>
<text:p>FIXTURE-DOC-MARKER Hello from a Word document.</text:p>
<text:p>Second paragraph with ünïcode.</text:p>
</office:text></office:body></office:document>"""

FODS = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document {NS} office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:automatic-styles>
<style:style style:name="ta_hidden" style:family="table"><style:table-properties table:display="false"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
<table:table table:name="Zulu"><table:table-row>
<table:table-cell office:value-type="string"><text:p>FIXTURE-SHEET-MARKER</text:p></table:table-cell>
<table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>
<table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>
<table:table-cell table:formula="=B1+C1" office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell>
</table:table-row></table:table>
<table:table table:name="Beta ünï"><table:table-row>
<table:table-cell office:value-type="string"><text:p>second sheet, with comma</text:p></table:table-cell>
</table:table-row></table:table>
<table:table table:name="Hidden" table:style-name="ta_hidden"><table:table-row>
<table:table-cell office:value-type="string"><text:p>HIDDEN-SHEET-MARKER</text:p></table:table-cell>
</table:table-row></table:table>
</office:spreadsheet></office:body></office:document>"""

FODP = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document {NS} office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:body><office:presentation>
<draw:page draw:name="s1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>FIXTURE-SLIDE-MARKER slide one</text:p></draw:text-box></draw:frame></draw:page>
<draw:page draw:name="s2"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>slide two</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document>"""

TARGETS = {
    "fixture.fodt": [("doc", "doc:MS Word 97"), ("docx", "docx")],
    "fixture.fods": [("xls", "xls:MS Excel 97"), ("xlsx", "xlsx")],
    "fixture.fodp": [("ppt", "ppt:MS PowerPoint 97"), ("pptx", "pptx")],
}


def main(out: str) -> None:
    os.makedirs(out, exist_ok=True)
    for src, body in (("fixture.fodt", FODT), ("fixture.fods", FODS), ("fixture.fodp", FODP)):
        with open(os.path.join(out, src), "w", encoding="utf-8") as f:
            f.write(body)
        for ext, flt in TARGETS[src]:
            subprocess.run(
                ["soffice", "--headless", "--norestore", "-env:UserInstallation=file:///tmp/fxprofile",
                 "--convert-to", flt, "--outdir", out, os.path.join(out, src)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
    print(sorted(os.listdir(out)))


if __name__ == "__main__":
    main(sys.argv[1])
