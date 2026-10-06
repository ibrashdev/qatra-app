// A stand-in for the backend, used only by the e2e run: it lets the real /api/* rewrite be exercised.
// It answers E01, E11 as a visitor would be answered (no session, 401), and the three reads the built screens make on load (E14 catalog,
// E18 today with a plan, E19 progress) with fixed synthetic data, so a screen opened directly renders without a failed request.
// Every other path gets the error envelope. No cookies and no state: specs that need a flow route-intercept the calls themselves.
import { createServer } from "node:http";
import { catalog, progress, today } from "./stub-data.mjs";

const port = Number(process.env.STUB_BACKEND_PORT ?? 3101);

const READS = new Map([
  ["/api/catalog", catalog],
  ["/api/today", today],
  ["/api/progress", progress],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://stub.invalid");
  if (request.method === "GET" && READS.has(url.pathname)) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Stub-Backend": "1" });
    response.end(JSON.stringify(READS.get(url.pathname)));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Stub-Backend": "1",
    });
    response.end(JSON.stringify({ status: "ok", version: "e2e-stub", time: new Date().toISOString() }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/me") {
    response.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Stub-Backend": "1" });
    response.end(JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required.", details: {} } }));
    return;
  }
  // The settings screen asks whether the account is a content manager (AD-00). The real server answers 200 to every signed-in account; the stub knows no
  // session and no manager, so it answers 200 false, and the row is not shown. Specs that need a manager route-intercept the call (stubAdminApi).
  if (request.method === "GET" && url.pathname === "/api/admin/access") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Stub-Backend": "1" });
    response.end(JSON.stringify({ contentManager: false }));
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
