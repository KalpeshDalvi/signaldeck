import os
import random
import time
from flask import Flask, jsonify, request

app = Flask(__name__)
FAILURE_MODE = os.getenv("FAILURE_MODE", "none")

@app.get("/healthz")
def healthz():
    return jsonify(status="ok", service="inventory")

@app.get("/inventory")
def inventory():
    mode = request.headers.get("x-failure-mode", FAILURE_MODE)

    if mode == "dependency-latency":
        time.sleep(3)
    elif mode == "dependency-error":
        return jsonify(error="simulated inventory dependency failure"), 500
    elif mode == "flaky" and random.random() < 0.35:
        return jsonify(error="simulated inventory timeout"), 504

    return jsonify(item="demo-item", available=True, quantity=42)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
