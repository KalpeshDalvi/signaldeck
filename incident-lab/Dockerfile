FROM python:3.12-slim

ARG SERVICE
ENV SERVICE=${SERVICE}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ${SERVICE}/app.py /app/app.py

RUN useradd --create-home --uid 10001 appuser
USER 10001

EXPOSE 8080
CMD ["opentelemetry-instrument", "gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "app:app"]
