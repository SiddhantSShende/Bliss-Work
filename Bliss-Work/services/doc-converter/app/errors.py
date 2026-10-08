"""Closed set of failure codes. These — and nothing else — leave the sandbox.

No LibreOffice stderr, path, filename or document text is ever returned or
logged: a hostile document controls all of it.
"""


class ConvertError(Exception):
    UNSUPPORTED = "unsupported"
    TOO_LARGE = "too_large"
    UNCONVERTIBLE = "unconvertible"
    LIMIT = "limit"
    TIMEOUT = "timeout"
    BUSY = "busy"
    INTERNAL = "internal"

    STATUS = {
        UNSUPPORTED: 415,
        TOO_LARGE: 413,
        UNCONVERTIBLE: 422,
        LIMIT: 422,
        TIMEOUT: 422,
        BUSY: 503,
        INTERNAL: 500,
    }

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code

    @property
    def status(self) -> int:
        return self.STATUS[self.code]
