// A stand-in for the backend, used only by the e2e run: it lets the real /api/* rewrite be exercised.
// It answers E01 and nothing else; every other path gets the error envelope. No data, no cookies.
import { createServer } from "node:http";

const port = Number(process.env.STUB_BACKEND_PORT ?? 3101);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://stub.invalid");
  if (request.method === "GET" && url.pathname === "/api/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Stub-Backend": "1",
    });
    response.end(JSON.stringify({ status: "ok", version: "e2e-stub", time: new Date().toISOString() }));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "X-Stub-Backend": "1" });
  response.end(JSON.stringify({ error: { code: "not_found", message: "Not found.", details: {} } }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stub backend listening on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
