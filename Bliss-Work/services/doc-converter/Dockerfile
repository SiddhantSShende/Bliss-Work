# syntax=docker/dockerfile:1

# Office Document Sandbox. Converts untrusted DOC/DOCX/XLS/XLSX/PPT/PPTX bytes
# into a preview artifact (PDF, or a JSON of sheet cell text) with LibreOffice
# headless. It is the ONLY place in BlissWork that opens an Office file.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, like every other service image (it needs
# no sibling packages; this keeps Jenkins and the CI image-scan matrix uniform):
#
#     docker build -f services/doc-converter/Dockerfile -t doc-converter .
#
# Runtime isolation (internal-only network, read-only rootfs, tmpfs /tmp, no
# env_file, no secrets, dropped capabilities, cpu/memory/pids limits) is declared
# in docker-compose*.yml, not here — see the `doc-converter` service.
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive

# --no-install-recommends keeps the JRE (and with it every Java-based feature)
# out of the image. Fonts are the metric-compatible set so layout matches Word.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /tmp appuser

WORKDIR /app
COPY services/doc-converter/app ./app
# Pre-seeded LibreOffice profile (macros, Java and link updates disabled). It is
# copied into a fresh per-job profile; the image copy is read-only at runtime.
COPY services/doc-converter/profile-template /opt/profile-template

USER appuser

EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9000/healthz', timeout=2).status == 200 else 1)"]

CMD ["python", "-m", "app"]
