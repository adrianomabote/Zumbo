import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const bridgeDirectory = await mkdtemp(join(tmpdir(), "megabyte-recharge-initiation-"));
const sessionSecret = "recharge-initiation-test-session";

let bridgeProcess: ChildProcess | undefined;
let bridgeOutput = "";
let apiServer: Server | undefined;
let baseUrl: string;
let userCookie: string;
let providerDelayMs = 0;
let providerResponse: { statusCode: number; body: Record<string, unknown> } = {
  statusCode: 202,
  body: { provider: "mozpayment", status: "PENDING", reference: "recharge-test-reference" },
};
const paymentRequests: Array<Record<string, unknown>> = [];

async function findFreePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readJson(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function stopBridge() {
  const processToStop = bridgeProcess;
  bridgeProcess = undefined;
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  const exited = once(processToStop, "exit");
  processToStop.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (processToStop.exitCode === null && processToStop.signalCode === null) processToStop.kill("SIGKILL");
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
  throw new Error(`O bridge não ficou pronto: ${bridgeOutput}`);
}

async function postRecharge(amount: number) {
  return fetch(`${baseUrl}/api/recharge/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: userCookie },
    body: JSON.stringify({ amount, paymentPhone: "+258 84 111 2223" }),
  });
}

before(async () => {
  const apiPort = await findFreePort();
  apiServer = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/mozpayment/internal/payments") {
      response.writeHead(404).end();
      return;
    }
    const body = await readJson(request);
    paymentRequests.push(body);
    const selectedResponse = providerResponse;
    if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    response.writeHead(selectedResponse.statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(selectedResponse.body));
  });
  await new Promise<void>((resolve, reject) => {
    apiServer?.once("error", reject);
    apiServer?.listen(apiPort, "127.0.0.1", resolve);
  });

  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    join(bridgeDirectory, "zumbopay-bridge.js"),
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
      NODE_ENV: "production",
      NET_SERVICOS_PAYMENT_MODE: "live",
      NET_SERVICOS_DATA_DIR: bridgeDirectory,
      PAYMENT_PROVIDER: "mozpayment",
      MOZPAYMENT_WALLET_ID: "mock-wallet-id",
      ADMIN_PASS: "recharge-initiation-test-admin",
      SESSION_SECRET: sessionSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProcess.stdout?.on("data", (chunk: Buffer) => { bridgeOutput += chunk.toString(); });
  bridgeProcess.stderr?.on("data", (chunk: Buffer) => { bridgeOutput += chunk.toString(); });
  await waitForBridge();

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Teste de recarga",
      phone: "861112223",
      password: "test-password-123",
    }),
  });
  assert.equal(registration.status, 201, bridgeOutput);
  const setCookie = registration.headers.get("set-cookie");
  assert.ok(setCookie);
  userCookie = setCookie.split(";", 1)[0];
});

after(async () => {
  await stopBridge();
  if (apiServer?.listening) {
    await new Promise<void>((resolve) => apiServer?.close(() => resolve()));
  }
  await rm(bridgeDirectory, { recursive: true, force: true });
});

test("only reports an M-Pesa request as sent after the provider accepts it", async () => {
  providerDelayMs = 100;
  const startedAt = Date.now();
  const response = await postRecharge(20);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(response.status, 201, bridgeOutput);
  assert.ok(elapsedMs >= 70, `A API respondeu antes do provedor: ${elapsedMs}ms`);
  assert.equal(paymentRequests.length, 1);
  assert.equal(paymentRequests[0].amountMzn, 20);
  assert.equal(paymentRequests[0].method, "MPESA");
  assert.equal(paymentRequests[0].payerPhone, "841112223");
  assert.equal(paymentRequests[0].title, "Recarga 20 MT");
  assert.equal(paymentRequests[0].description, "Recarga 20 MT");

  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.requestState, "submitted");
  assert.equal(result.paymentPhone, "841112223");
  assert.equal(result.status, "pending");
  assert.equal(result.testMode, false);
});

test("reports an ambiguous provider result without claiming the PIN request arrived", async () => {
  providerDelayMs = 0;
  providerResponse = {
    statusCode: 202,
    body: {
      provider: "mozpayment",
      status: "RECONCILIATION_REQUIRED",
      reference: "recharge-uncertain-reference",
    },
  };
  const response = await postRecharge(50);
  assert.equal(response.status, 201, bridgeOutput);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.requestState, "unknown");
  assert.equal(result.status, "pending");
});

test("returns a provider rejection instead of showing a sent-request state", async () => {
  providerResponse = {
    statusCode: 400,
    body: { error: "Cobrança recusada pelo provedor." },
  };
  const response = await postRecharge(75);
  assert.equal(response.status, 502, bridgeOutput);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.error, "Cobrança recusada pelo provedor.");
  assert.equal(paymentRequests.length, 3);
});
