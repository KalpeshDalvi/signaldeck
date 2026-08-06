import os
import random
import time
from flask import Flask, jsonify, request
import requests

app = Flask(__name__)

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
    response.raise_for_status()
    return jsonify(status="accepted", inventory=response.json())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
