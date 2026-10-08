"""Pre-checks that run BEFORE LibreOffice starts. Nothing here inflates data."""
import zipfile

from . import config
from .errors import ConvertError
from .spec import Spec


def check_magic(path: str, spec: Spec) -> None:
    with open(path, "rb") as f:
        head = f.read(len(spec.magic))
    if head != spec.magic:
        raise ConvertError(ConvertError.UNSUPPORTED)


def check_zip(path: str) -> None:
    """Reject zip bombs from the central directory alone.

    `ZipFile` reads only the directory, so the declared sizes are inspected
    without decompressing a byte. Declared sizes can lie, which is why the
    cgroup memory limit, the tmpfs size and RLIMIT_FSIZE exist as well.
    """
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ConvertError(ConvertError.UNCONVERTIBLE)
    with zf:
        infos = zf.infolist()
        if len(infos) > config.ZIP_MAX_ENTRIES:
            raise ConvertError(ConvertError.LIMIT)
        total = 0
        for i in infos:
            if i.flag_bits & 0x1:  # entry-level encryption
                raise ConvertError(ConvertError.UNCONVERTIBLE)
            total += i.file_size
            if total > config.ZIP_MAX_UNCOMPRESSED:
                raise ConvertError(ConvertError.LIMIT)
            if i.compress_size == 0:
                if i.file_size > 1024 * 1024:
                    raise ConvertError(ConvertError.LIMIT)
            elif i.file_size / i.compress_size > config.ZIP_MAX_RATIO and i.file_size > 1024 * 1024:
                raise ConvertError(ConvertError.LIMIT)
