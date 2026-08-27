import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { default as app } from "../src/app.ts";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("publica a documentação OpenAPI do agente sem segredos internos", async () => {
  const response = await fetch(`${baseUrl}/api/ussd-agent/openapi.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const document = await response.json() as {
    servers: Array<{ url: string }>;
    paths: Record<string, unknown>;
    info: { title: string };
  };

  assert.equal(document.info.title, "Megabyte USSD Agent API");
  assert.equal(document.servers[0]?.url, "https://megabyte.live/api");
  assert.equal(document.paths["/ussd-agent/pair"], undefined);
  assert.ok(document.paths["/ussd-agent/deliveries/lease"]);
  assert.ok(document.paths["/ussd-agent/deliveries/{id}/report"]);
  assert.equal(document.paths["/ussd-agent/internal/paid-deliveries"], undefined);
  assert.equal(document.paths["/ussd-agent/admin/deliveries"], undefined);
});

test("o endpoint de informação aponta para a documentação", async () => {
  const response = await fetch(`${baseUrl}/api/ussd-agent`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "Net Serviços USSD Agent",
    docs: "/api/ussd-agent/openapi.json",
    authentication: "none",
    lease: "POST /api/ussd-agent/deliveries/lease",
    report: "POST /api/ussd-agent/deliveries/{id}/report",
  });
});