# FaceID Platform — web app + face engine, ready for Cloudflare Tunnel (see deploy/cloudflare.md)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# dlib-bin ships a prebuilt manylinux wheel (only needs libstdc++), so no compiler or CMake is required.
COPY requirements-web.txt .
RUN pip install -r requirements-web.txt dlib-bin numpy \
 && pip install --no-deps face_recognition face_recognition_models

COPY web ./web

RUN useradd --system --uid 10001 faceid && mkdir -p /data /app/instance && chown -R faceid /data /app/instance
USER faceid
VOLUME ["/data"]

ENV PORT=5000 WEB_DATABASE=/data/web.db PRELOAD_FACE=1 TRUST_PROXY=1 WEB_CONCURRENCY=2
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "exec gunicorn --preload -w ${WEB_CONCURRENCY} -b 0.0.0.0:${PORT} --timeout 60 --access-logfile - web.wsgi:app"]
