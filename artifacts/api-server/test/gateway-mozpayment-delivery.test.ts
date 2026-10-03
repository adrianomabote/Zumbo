import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const bridgeDirectory = await mkdtemp(path.join(os.tmpdir(), "net-servicos-mozpayment-gateway-"));
const masterKey = "gw-master-mozpayment-gateway-test-key";
const sessionSecret = "mozpayment-gateway-test-session";

let bridgeProcess: ChildProcess | undefined;
let bridgeOutput = "";
let baseUrl: string;
let apiServer: Server | undefined;
let paymentRequest: Record<string, unknown> | undefined;
let deliveryRequest: Record<string, unknown> | undefined;

async function findFreePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function readJson(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitForBridge() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ping`);
      if (response.ok) return;
    } catch {
      // O bridge pode precisar de alguns instantes para iniciar.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O bridge MozPayment não ficou pronto: ${bridgeOutput}`);
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
  const apiPort = await findFreePort();
  apiServer = createServer(async (request, response) => {
    try {
      const body = await readJson(request);
      if (request.method === "POST" && request.url === "/api/mozpayment/internal/payments") {
        paymentRequest = body;
        response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({
          paymentId: "mozpayment-gateway-payment-test",
          status: "PAID",
          reference: body.reference,
          provider: "mozpayment",
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/ussd-agent/internal/paid-deliveries") {
        assert.equal(request.headers["x-internal-delivery-key"], sessionSecret);
        deliveryRequest = body;
        response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({
          delivery: { id: "mozpayment-gateway-delivery-test", status: "queued" },
        }));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: error instanceof Error ? error.message : "mock server error",
      }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    apiServer?.once("error", reject);
    apiServer?.listen(apiPort, "0.0.0.0", () => resolve());
  });

  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    path.join(bridgeDirectory, "zumbopay-bridge.js"),
  );
  const bridgePort = await findFreePort();
  baseUrl = `http://127.0.0.1:${bridgePort}`;
  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      DATABASE_URL: "",
      PORT: String(bridgePort),
      MAIN_API_PORT: String(apiPort),
      SITE_URL: "https://megabyte.example.test",
      NODE_ENV: "production",
      PAYMENT_PROVIDER: "mozpayment",
      NET_SERVICOS_PAYMENT_MODE: "live",
      NET_SERVICOS_DATA_DIR: bridgeDirectory,
      ADMIN_PASS: "mozpayment-gateway-test-admin",
      SESSION_SECRET: sessionSecret,
      MOZPAYMENT_WALLET_ID: "mozpayment-test-wallet",
      MOZPAYMENT_WEBHOOK_SECRET: "mozpayment-test-webhook-secret",
      GW_MASTER_KEY: masterKey,
      GW_MASTER_SECRET: "mozpayment-gateway-test-master-secret",
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
});

after(async () => {
  await stopBridge();
  if (apiServer?.listening) {
    await new Promise<void>((resolve) => apiServer?.close(() => resolve()));
  }
  await rm(bridgeDirectory, { recursive: true, force: true });
});

test("MozPayment Gateway cobra exactamente 10 MT e inicia a entrega USSD", async () => {
  const docsResponse = await fetch(`${baseUrl}/gateway/docs`);
  assert.equal(docsResponse.status, 200);
  const docs = await docsResponse.text();
  assert.match(docs, /MozPayment C2B/);
  assert.match(docs, /Recarga \[valor\] MT/);
  assert.match(docs, /entre 10 e 40000 MT/);
  assert.match(docs, /entrega USSD em fila automaticamente/i);

  const belowMinimum = await fetch(`${baseUrl}/gateway/api/pay`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": masterKey },
    body: JSON.stringify({ phone: "841234567", amount: 9 }),
  });
  assert.equal(belowMinimum.status, 400);
  assert.equal(paymentRequest, undefined);

  const createResponse = await fetch(`${baseUrl}/gateway/api/pay`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": masterKey },
    body: JSON.stringify({
      phone: "841234567",
      amount: 10,
      reference: "MozPayment exact-value gateway test",
    }),
  });
  assert.equal(createResponse.status, 202, bridgeOutput);
  const created = await createResponse.json() as Record<string, unknown>;
  assert.equal(created.ok, true);
  assert.equal(created.status, "succeeded");
  assert.equal(created.method, "mpesa");
  assert.equal(Number(created.megabytes) > 0, true);
  assert.equal(paymentRequest?.amountMzn, 10);
  assert.equal(paymentRequest?.method, "MPESA");
  assert.equal(paymentRequest?.payerPhone, "841234567");
  assert.equal(paymentRequest?.title, "Recarga 10 MT");
  assert.equal(paymentRequest?.description, "Recarga 10 MT");
  assert.equal(deliveryRequest?.beneficiaryPhone, "841234567");
  assert.equal(deliveryRequest?.paymentId, created.txId);
  assert.equal(deliveryRequest?.packageLabel, `${created.megabytes} MB`);
  assert.equal(created.deliveryStatus, "queued");

  const statusResponse = await fetch(`${baseUrl}/gateway/api/status/${encodeURIComponent(String(created.txId))}`, {
    headers: { "x-api-key": masterKey },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as Record<string, unknown>;
  assert.equal(status.status, "succeeded");
  assert.equal(status.amount, 10);
  assert.equal(status.megabytes, created.megabytes);
  assert.equal(status.deliveryStatus, "queued");
});