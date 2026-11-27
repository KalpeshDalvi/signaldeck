import os
import random
import time
from flask import Flask, abort, jsonify, request
from opentelemetry._logs import LogRecord, SeverityNumber, get_logger
import requests

app = Flask(__name__)
evidence_logger = get_logger("signaldeck.checkout")

INVENTORY_URL = os.getenv("INVENTORY_URL", "http://inventory:8080")
FAILURE_MODE = os.getenv("FAILURE_MODE", "none")

@app.get("/healthz")
def healthz():
    return jsonify(status="ok", service="checkout")

@app.post("/checkout")
def checkout():
    mode = request.headers.get("x-failure-mode", FAILURE_MODE)

    if mode == "latency":
        time.sleep(2.5)
    elif mode == "error":
        return jsonify(error="simulated checkout failure"), 500
    elif mode == "flaky" and random.random() < 0.5:
        return jsonify(error="simulated intermittent failure"), 503

    response = requests.get(f"{INVENTORY_URL}/inventory", headers={"x-failure-mode": mode}, timeout=5)
    if 500 <= response.status_code < 600:
        evidence_logger.emit(LogRecord(
            timestamp=time.time_ns(),
            severity_number=SeverityNumber.ERROR,
            severity_text="ERROR",
            body="Checkout mapped an inventory response error to HTTP 500",
            attributes={
                "signaldeck.event.name": "dependency_error_mapped_to_http_response",
                "signaldeck.dependency.status_code": response.status_code,
                "http.response.status_code": 500,
            },
        ))
        abort(500)

    response.raise_for_status()
    return jsonify(status="accepted", inventory=response.json())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
