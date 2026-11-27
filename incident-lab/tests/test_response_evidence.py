import importlib.util
from pathlib import Path
from threading import Thread
import unittest
from unittest.mock import patch
from wsgiref.simple_server import make_server

from opentelemetry import trace
from opentelemetry._logs import SeverityNumber, set_logger_provider
from opentelemetry.exporter.otlp.proto.common._internal._log_encoder import encode_logs
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def load_lab_service(name):
    path = Path(__file__).resolve().parents[1] / name / "app.py"
    spec = importlib.util.spec_from_file_location(f"lab_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CheckoutResponseEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.span_exporter = InMemorySpanExporter()
        cls.log_exporter = InMemoryLogExporter()
        tracer = TracerProvider()
        tracer.add_span_processor(SimpleSpanProcessor(cls.span_exporter))
        logger = LoggerProvider(resource=Resource.create({"service.name": "checkout"}))
        logger.add_log_record_processor(SimpleLogRecordProcessor(cls.log_exporter))
        set_logger_provider(logger)

        cls.checkout = load_lab_service("checkout")
        inventory = load_lab_service("inventory")
        cls.server = make_server("127.0.0.1", 0, inventory.app)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.inventory_url = f"http://127.0.0.1:{cls.server.server_port}"
        FlaskInstrumentor().instrument_app(cls.checkout.app, tracer_provider=tracer)
        RequestsInstrumentor().instrument(tracer_provider=tracer)

    @classmethod
    def tearDownClass(cls):
        RequestsInstrumentor().uninstrument()
        FlaskInstrumentor().uninstrument_app(cls.checkout.app)
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def setUp(self):
        self.span_exporter.clear()
        self.log_exporter.clear()

    def checkout_with_mode(self, mode):
        with patch.object(self.checkout, "INVENTORY_URL", self.inventory_url):
            return self.checkout.app.test_client().post("/checkout", headers={"x-failure-mode": mode})

    def test_actual_dependency_failure_emits_one_correlated_response_mapping(self):
        self.assertEqual(self.checkout_with_mode("dependency-error").status_code, 500)
        spans = self.span_exporter.get_finished_spans()
        server = next(span for span in spans if span.kind == trace.SpanKind.SERVER)
        dependency = next(span for span in spans if span.kind == trace.SpanKind.CLIENT)
        self.assertEqual(dependency.parent.span_id, server.context.span_id)
        self.assertEqual(dependency.context.trace_id, server.context.trace_id)
        self.assertEqual(dependency.attributes["http.status_code"], 500)

        logs = self.log_exporter.get_finished_logs()
        self.assertEqual(len(logs), 1)
        event = logs[0].log_record
        self.assertEqual(event.trace_id, server.context.trace_id)
        self.assertEqual(event.span_id, server.context.span_id)
        self.assertEqual(event.severity_number, SeverityNumber.ERROR)
        self.assertLessEqual(dependency.end_time, event.timestamp)
        self.assertLessEqual(event.timestamp, server.end_time)
        packet = encode_logs(logs).resource_logs[0]
        serialized = packet.scope_logs[0].log_records[0]
        attributes = {item.key: item.value for item in serialized.attributes}
        resource = {item.key: item.value for item in packet.resource.attributes}
        self.assertEqual(resource["service.name"].string_value, "checkout")
        self.assertEqual(attributes["signaldeck.event.name"].string_value, "dependency_error_mapped_to_http_response")
        self.assertEqual(attributes["signaldeck.dependency.status_code"].int_value, 500)
        self.assertEqual(attributes["http.response.status_code"].int_value, 500)
        self.assertEqual(serialized.trace_id.hex(), f"{server.context.trace_id:032x}")
        self.assertEqual(serialized.span_id.hex(), f"{server.context.span_id:016x}")

    def test_healthy_and_local_failures_emit_no_dependency_mapping(self):
        healthy = self.checkout_with_mode("none")
        self.assertEqual(healthy.status_code, 200)
        self.assertEqual(healthy.get_json()["status"], "accepted")
        self.assertEqual(self.checkout_with_mode("error").status_code, 500)
        self.assertEqual(self.log_exporter.get_finished_logs(), ())
