FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.lock .
RUN pip install -r requirements.lock
COPY . .
RUN useradd -m -u 1000 app && mkdir -p /app/var/storage && chown -R app /app/var
USER app
EXPOSE 8000
# one image, three processes: api (default), worker (python -m app.workers), bot (python -m app.bot ...)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
