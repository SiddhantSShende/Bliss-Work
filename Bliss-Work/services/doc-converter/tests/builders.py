"""Hand-built hostile documents for the in-image tests.

Everything is built from text/zip so the tests need no binary blobs, and each
hostile feature is aimed at a canary the test can observe.
"""
import io
import zipfile


def _zip(entries: list[tuple[str, str]], stored_first: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            if name == stored_first:
                zf.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_STORED)
            else:
                zf.writestr(name, data)
    return buf.getvalue()


def macro_odt(canary_path: str, event: str) -> bytes:
    """An ODT with a Basic macro bound to a document-open event.

    The macro writes `canary_path`. If it ever runs, the file exists.
    """
    ns = (
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        'xmlns:dom="http://www.w3.org/2001/xml-events" '
        'xmlns:ooo="http://openoffice.org/2004/office"'
    )
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content {ns} office:version="1.2">
<office:scripts><office:event-listeners>
<script:event-listener script:language="ooo:script" script:event-name="{event}" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document" xlink:type="simple"/>
</office:event-listeners></office:scripts>
<office:body><office:text><text:p>macro document</text:p></office:text></office:body></office:document-content>"""
    manifest = """<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/script-lc.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/Standard/script-lb.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"""
    lc = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">
<library:library library:name="Standard" xlink:href="$(USER)/basic/Standard/script-lb.xml" xlink:type="simple" library:link="false"/>
</library:libraries>"""
    lb = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
<library:element library:name="Module1"/>
</library:library>"""
    module = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Main
  Dim n As Integer
  n = FreeFile
  Open "{canary_path}" For Output As #n
  Print #n, "ran"
  Close #n
End Sub
</script:module>"""
    return _zip(
        [
            ("mimetype", "application/vnd.oasis.opendocument.text"),
            ("content.xml", content),
            ("META-INF/manifest.xml", manifest),
            ("Basic/script-lc.xml", lc),
            ("Basic/Standard/script-lb.xml", lb),
            ("Basic/Standard/Module1.xml", module),
        ],
        stored_first="mimetype",
    )


_CT_DOCX = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/>
</Relationships>"""


def docx_with_links(image_url: str, include_path: str) -> bytes:
    """A DOCX with a remote linked picture AND an INCLUDETEXT field on a local file."""
    document = f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:r><w:t>DOCX-LINKS-MARKER</w:t></w:r></w:p>
<w:p><w:fldSimple w:instr=' INCLUDETEXT "{include_path}" '><w:r><w:t>placeholder</w:t></w:r></w:fldSimple></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="x"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
<pic:nvPicPr><pic:cNvPr id="1" name="x"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:link="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>"""
    doc_rels = f"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{image_url}" TargetMode="External"/>
</Relationships>"""
    return _zip(
        [
            ("[Content_Types].xml", _CT_DOCX),
            ("_rels/.rels", _RELS.format(target="word/document.xml")),
            ("word/document.xml", document),
            ("word/_rels/document.xml.rels", doc_rels),
        ]
    )


def xlsx_with_formulas(*formulas: str) -> bytes:
    """An XLSX whose formula cells carry NO cached value, so LibreOffice must
    evaluate them (or not) on load. Cell A1 is a plain marker string."""
    cells = "".join(
        f'<c r="B{i + 1}"><f>{f}</f></c>' for i, f in enumerate(formulas)
    )
    sheet = f"""<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSX-FORMULA-MARKER</t></is></c></row>
{''.join(f'<row r="{i + 2}"><c r="A{i + 2}" t="inlineStr"><is><t>f{i}</t></is></c>' + f'<c r="B{i + 2}"><f>{f}</f></c></row>' for i, f in enumerate(formulas))}
</sheetData></worksheet>"""
    del cells
    wb = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"""
    wb_rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    ct = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
    return _zip(
        [
            ("[Content_Types].xml", ct),
            ("_rels/.rels", _RELS.format(target="xl/workbook.xml")),
            ("xl/workbook.xml", wb),
            ("xl/_rels/workbook.xml.rels", wb_rels),
            ("xl/worksheets/sheet1.xml", sheet),
        ]
    )
