FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py sqlite_backups.py .
ENV DD_DB=/data/deepdish.db DD_BACKUP_DIR=/data/backups DD_BACKUP_STAGING_DIR=/data/.backup-staging
EXPOSE 8687
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["python", "/app/sqlite_backups.py", "check"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8687"]
