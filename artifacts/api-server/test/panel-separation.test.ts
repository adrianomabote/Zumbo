import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const bridgeDirectory = await mkdtemp(path.join(os.tmpdir(), "net-servicos-panel-"));
const bridgePort = await findFreePort();
const masterKey = "gw-master-panel-test-key";
const adminPassword = "panel-test-admin-pass";
const gatewayTransactionId = "GATEWAY-ONLY-PANEL-SENTINEL";
const externalReference = "PRIVATE-EXTERNAL-REFERENCE-SENTINEL";
const externalDescription = "PRIVATE-DESCRIPTION-SENTINEL";
const callbackUrl = "https://callbacks.example.test/PRIVATE-CALLBACK-SENTINEL";

let bridgeProcess: ChildProcess | undefined;
let bridgeOutput = "";
let baseUrl: string;
let adminCookie: string;
let apiProxyProcess: ChildProcess | undefined;
let apiProxyOutput = "";
let apiProxyBaseUrl: string;

async function findFreePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForBridge() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ping`);
      if (response.ok) return;
    } catch {
      // The bridge needs a moment to load its local stores.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O bridge do painel não ficou pronto: ${bridgeOutput}`);
}

function bundleRecord(txId: string) {
  return {
    txId,
    type: "bundle",
    phone: "841112223",
    beneficiaryPhone: "841112223",
    bundleId: "n04",
    bundleLabel: "780 MB",
    amount: 20,
    method: "mpesa",
    status: "succeeded",
    sourceId: `source-${txId}`,
    ts: "2026-08-26T10:00:00.000Z",
  };
}

function gatewayRecord(txId: string, status: string, amount: number, extra: Record<string, unknown> = {}) {
  return {
    txId,
    type: "gateway",
    phone: "861112223",
    beneficiaryPhone: null,
    bundleId: null,
    bundleLabel: "Gateway: Canal privado",
    amount,
    method: "emola",
    status,
    sourceId: `source-${txId}`,
    ts: "2026-08-26T11:00:00.000Z",
    gwKeyId: "private-panel-test",
    ...extra,
  };
}

async function panelRequest(filter: string, page?: number) {
  const query = new URLSearchParams({ filter });
  if (page !== undefined) query.set("page", String(page));
  const response = await fetch(`${baseUrl}/admin/office?${query}`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(response.status, 200);
  return response.text();
}

async function technicalRequest(page?: number, limit?: number, authorization = `Bearer ${adminPassword}`) {
  const query = new URLSearchParams();
  if (page !== undefined) query.set("page", String(page));
  if (limit !== undefined) query.set("limit", String(limit));
  return fetch(`${baseUrl}/api/transactions?${query}`, {
    headers: { authorization },
  });
}

async function proxiedTechnicalRequest(
  page?: number,
  limit?: number,
  authorization = `Bearer ${adminPassword}`,
) {
  const query = new URLSearchParams();
  if (page !== undefined) query.set("page", String(page));
  if (limit !== undefined) query.set("limit", String(limit));
  return fetch(`${apiProxyBaseUrl}/api/legacy/api/transactions?${query}`, {
    headers: { authorization },
  });
}

async function exportRequest(type: string, cookie = adminCookie) {
  return fetch(`${baseUrl}/admin/history/export?type=${encodeURIComponent(type)}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

async function stopBridge() {
  const processToStop = bridgeProcess;
  bridgeProcess = undefined;
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    processToStop.once("exit", () => resolve());
    processToStop.kill("SIGTERM");
  });
}

before(async () => {
  const megabyteOrders = Array.from({ length: 1_001 }, (_, index) =>
    bundleRecord(index === 1_000 ? "MEGA-LAST-PAGE-SENTINEL" : `mega-panel-${index}`),
  );
  await writeFile(
    path.join(bridgeDirectory, "orders.json"),
    JSON.stringify([
      bundleRecord("MEGA-FIRST-PAGE-SENTINEL"),
      ...megabyteOrders.slice(1),
      gatewayRecord(gatewayTransactionId, "succeeded", 777, {
        extRef: externalReference,
        extDesc: externalDescription,
        callbackUrl,
      }),
      gatewayRecord("GATEWAY-PENDING-PANEL-SENTINEL", "pending", 888),
    ]),
  );
  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    path.join(bridgeDirectory, "zumbopay-bridge.js"),
  );

  baseUrl = `http://127.0.0.1:${bridgePort}`;
  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      NODE_ENV: "production",
      NET_SERVICOS_PAYMENT_MODE: "mock",
      ADMIN_PASS: adminPassword,
      SESSION_SECRET: "panel-test-session-secret",
      PAGAR_API_KEY: "panel-test-api-key",
      PAGAR_SIGNING_SECRET: "panel-test-signing-secret",
      PAGAR_WEBHOOK_SECRET: "panel-test-webhook-secret",
      GW_MASTER_KEY: masterKey,
      GW_MASTER_SECRET: "panel-test-master-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProcess.stdout?.on("data", (chunk: Buffer) => {
    bridgeOutput += chunk.toString();
  });
  bridgeProcess.stderr?.on("data", (chunk: Buffer) => {
    bridgeOutput += chunk.toString();
  });
  await waitForBridge();

  const login = await fetch(`${baseUrl}/admin/office`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: adminPassword }),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  adminCookie = setCookie.split(";", 1)[0];

  const apiProxyPort = await findFreePort();
  const tsxEntry = fileURLToPath(new URL("../../../scripts/node_modules/tsx/dist/cli.mjs", import.meta.url));
  const proxyRunner = path.join(bridgeDirectory, "api-proxy-runner.ts");
  await writeFile(
    proxyRunner,
    [
      `import app from ${JSON.stringify(fileURLToPath(new URL("../src/app.ts", import.meta.url)))};`,
      `const server = app.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("proxy-ready"));`,
      `const shutdown = () => server.close(() => process.exit(0));`,
      `process.on("SIGTERM", shutdown);`,
      `process.on("SIGINT", shutdown);`,
    ].join("\n"),
  );

  apiProxyBaseUrl = `http://127.0.0.1:${apiProxyPort}`;
  apiProxyOutput = "";
  apiProxyProcess = spawn(process.execPath, [tsxEntry, proxyRunner], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(apiProxyPort),
      LEGACY_BRIDGE_PORT: String(bridgePort),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProxyProcess.stdout?.on("data", (chunk: Buffer) => {
    apiProxyOutput += chunk.toString();
  });
  apiProxyProcess.stderr?.on("data", (chunk: Buffer) => {
    apiProxyOutput += chunk.toString();
  });

  const proxyProcess = apiProxyProcess;
  const proxyDeadline = Date.now() + 10_000;
  while (Date.now() < proxyDeadline) {
    if (proxyProcess.exitCode !== null || proxyProcess.signalCode !== null) {
      throw new Error(`O proxy principal terminou antes de ficar pronto: ${apiProxyOutput}`);
    }
    try {
      const response = await fetch(`${apiProxyBaseUrl}/api/legacy/ping`);
      if (response.ok) break;
    } catch {
      // The proxy needs a moment to start listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (proxyProcess.exitCode !== null || proxyProcess.signalCode !== null) {
    throw new Error(`O proxy principal terminou antes de ficar pronto: ${apiProxyOutput}`);
  }
});

after(async () => {
  const processToStop = apiProxyProcess;
  apiProxyProcess = undefined;
  if (processToStop && processToStop.exitCode === null && processToStop.signalCode === null) {
    await new Promise<void>((resolve) => {
      processToStop.once("exit", () => resolve());
      processToStop.kill("SIGTERM");
    });
  }
  await stopBridge();
  await rm(bridgeDirectory, { recursive: true, force: true });
});

test("mantém todo o histórico Megabyte, incluindo mais de 1.000 registos", async () => {
  const firstPage = await panelRequest("all", 1);
  const lastPage = await panelRequest("all", 21);

  assert.match(firstPage, /<div class="stat-num">1001<\/div>/);
  assert.match(firstPage, /Página 1 de 21/);
  assert.match(firstPage, /MEGA-FIRST-PAGE-SENTINEL/);
  assert.doesNotMatch(firstPage, /MEGA-LAST-PAGE-SENTINEL/);
  assert.match(lastPage, /Página 21 de 21/);
  assert.match(lastPage, /MEGA-LAST-PAGE-SENTINEL/);
});

test("mantém transacções do gateway fora dos totais e da lista Megabyte", async () => {
  const megabyteView = await panelRequest("all");
  const gatewayView = await panelRequest("gateway-transactions");

  assert.match(megabyteView, /<div class="stat-num">1001<\/div>/);
  assert.doesNotMatch(megabyteView, new RegExp(gatewayTransactionId));
  assert.doesNotMatch(megabyteView, /Gateway confirmado/);
  assert.match(gatewayView, /<div class="stat-num">2<\/div>/);
  assert.match(gatewayView, new RegExp(gatewayTransactionId));
  assert.doesNotMatch(gatewayView, /MEGA-FIRST-PAGE-SENTINEL/);
});

test("não expõe referência externa, descrição, callback nem copiar na vista gateway", async () => {
  const gatewayView = await panelRequest("gateway-transactions");

  assert.doesNotMatch(gatewayView, new RegExp(externalReference));
  assert.doesNotMatch(gatewayView, new RegExp(externalDescription));
  assert.doesNotMatch(gatewayView, new RegExp(callbackUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(gatewayView, /class="copy-btn"/);
  assert.match(gatewayView, /Referência interna/);
  assert.match(gatewayView, /Histórico do Gateway privado/);
});

test("consulta técnica pagina mais de 1.000 vendas sem incluir operações gateway", async () => {
  const unauthorized = await technicalRequest(undefined, undefined, "");
  assert.equal(unauthorized.status, 401);

  const firstResponse = await technicalRequest(1, 100);
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json();

  assert.deepEqual(Object.keys(firstPage).sort(), ["data", "limit", "ok", "page", "pages", "total"]);
  assert.equal(firstPage.ok, true);
  assert.equal(firstPage.total, 1001);
  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.limit, 100);
  assert.equal(firstPage.pages, 11);
  assert.equal(firstPage.data.length, 100);
  assert.equal(firstPage.data[0].id, "MEGA-FIRST-PAGE-SENTINEL");
  assert.equal(firstPage.data.some((transaction: { type?: string; id?: string }) => transaction.type === "gateway"), false);
  assert.equal(firstPage.data.some((transaction: { id?: string }) => transaction.id === gatewayTransactionId), false);
  assert.deepEqual(Object.keys(firstPage.data[0]).sort(), [
    "activatedAt",
    "amount",
    "beneficiary",
    "bundle",
    "id",
    "method",
    "phone",
    "status",
    "ts",
  ]);

  const lastResponse = await technicalRequest(11, 100);
  assert.equal(lastResponse.status, 200);
  const lastPage = await lastResponse.json();

  assert.equal(lastPage.total, 1001);
  assert.equal(lastPage.page, 11);
  assert.equal(lastPage.pages, 11);
  assert.equal(lastPage.data.length, 1);
  assert.equal(lastPage.data[0].id, "MEGA-LAST-PAGE-SENTINEL");
  assert.equal(lastPage.data.some((transaction: { id?: string }) => transaction.id === gatewayTransactionId), false);
});

test("mantém o filtro técnico através do proxy principal", async () => {
  const unauthorized = await proxiedTechnicalRequest(undefined, undefined, "");
  assert.equal(unauthorized.status, 401);

  const directResponse = await technicalRequest(1, 100);
  assert.equal(directResponse.status, 200);
  const directPayload = await directResponse.json();

  const proxiedResponse = await proxiedTechnicalRequest(1, 100);
  assert.equal(proxiedResponse.status, 200);
  const proxiedPayload = await proxiedResponse.json();

  assert.deepEqual(proxiedPayload, directPayload);
  assert.equal(proxiedPayload.total, 1001);
  assert.equal(
    proxiedPayload.data.some((transaction: { type?: string }) => transaction.type === "gateway"),
    false,
  );
  assert.equal(
    proxiedPayload.data.some((transaction: { id?: string }) => transaction.id === gatewayTransactionId),
    false,
  );
});

test("exporta o histórico Megabyte completo, sem depender da página aberta", async () => {
  const unauthorized = await exportRequest("megabyte", "");
  assert.equal(unauthorized.status, 401);

  const response = await exportRequest("megabyte");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") || "", /historico-megabyte\.csv/);

  const csv = await response.text();
  assert.match(csv, /MEGA-FIRST-PAGE-SENTINEL/);
  assert.match(csv, /MEGA-LAST-PAGE-SENTINEL/);
  assert.doesNotMatch(csv, new RegExp(gatewayTransactionId));
  assert.equal((csv.match(/MEGA-/g) || []).length, 2);
});

test("exporta o histórico Gateway completo e separado do Megabyte", async () => {
  const invalid = await exportRequest("users");
  assert.equal(invalid.status, 400);

  const response = await exportRequest("gateway");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") || "", /historico-gateway\.csv/);

  const csv = await response.text();
  assert.match(csv, new RegExp(gatewayTransactionId));
  assert.doesNotMatch(csv, /MEGA-FIRST-PAGE-SENTINEL/);
  assert.match(csv, new RegExp(externalReference));
});

test("preserva o contrato público de criação e consulta do gateway", async () => {
  const createResponse = await fetch(`${baseUrl}/gateway/api/pay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": masterKey,
    },
    body: JSON.stringify({
      phone: "841234567",
      amount: 50,
      reference: "PUBLIC-CONTRACT-REFERENCE",
      description: "Public contract test",
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.status, "pending");
  assert.equal(created.method, "mpesa");
  assert.equal(typeof created.txId, "string");
  assert.match(created.statusUrl, new RegExp(`/gateway/api/status/${created.txId}$`));

  let statusResponse: Response | undefined;
  let status: Record<string, unknown> = {};
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    statusResponse = await fetch(`${baseUrl}/gateway/api/status/${encodeURIComponent(created.txId)}`, {
      headers: { "x-api-key": masterKey },
    });
    status = await statusResponse.json();
    if (status.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(statusResponse?.status, 200);
  assert.equal(status.ok, true);
  assert.equal(status.txId, created.txId);
  assert.equal(status.status, "succeeded");
  assert.equal(status.amount, 50);
  assert.equal(status.phone, "841234567");
  assert.equal(status.method, "mpesa");
  assert.equal(status.reference, "PUBLIC-CONTRACT-REFERENCE");
});