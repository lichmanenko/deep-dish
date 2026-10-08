FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
ENV DD_DB=/data/deepdish.db
EXPOSE 8687
VOLUME ["/data"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8687"]
