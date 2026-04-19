#!/usr/bin/env python3
"""PDF decrypt service — POST /decrypt {pdf_b64, passwords:[]} -> {pdf_b64}
Tries qpdf first (fast), falls back to pikepdf (handles more edge cases).
"""
import base64, io, json, os, subprocess, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import pikepdf
except ImportError:
    pikepdf = None

PORT = int(os.environ.get("PORT", 5680))


def decrypt(pdf_bytes: bytes, passwords: list[str]) -> bytes:
    if not passwords:
        return pdf_bytes

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        inpath = f.name

    result = pdf_bytes
    try:
        for pw in passwords:
            try:
                r = subprocess.run(
                    ["qpdf", f"--password={pw}", "--decrypt", inpath, "-"],
                    capture_output=True, timeout=30,
                )
                if r.returncode == 0 and r.stdout and r.stdout != pdf_bytes:
                    return r.stdout
            except Exception:
                pass

        if pikepdf is not None:
            for pw in passwords:
                try:
                    pdf = pikepdf.open(io.BytesIO(pdf_bytes), password=pw)
                    out = io.BytesIO()
                    pdf.save(out)
                    dec = out.getvalue()
                    if dec != pdf_bytes:
                        return dec
                except Exception:
                    pass
    finally:
        try:
            os.unlink(inpath)
        except OSError:
            pass

    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok","service":"synccc-decryptor"}')

    def do_POST(self):
        if self.path != "/decrypt":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        pdf_bytes = base64.b64decode(body["pdf_b64"])
        passwords = body.get("passwords") or []

        result = decrypt(pdf_bytes, passwords)

        resp = json.dumps({"pdf_b64": base64.b64encode(result).decode()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"synccc decryptor on :{PORT}")
    server.serve_forever()
