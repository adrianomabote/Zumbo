import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const bridgeDirectory = await mkdtemp(path.join(os.tmpdir(), "net-servicos-vpay-gateway-"));
const expectedCheckoutUrl = "https://checkout.vpay.co.mz/vpay-order-test-123";
const masterKey = "gw-master-vpay-gateway-test-key";

let bridgeProcess: ChildProcess | undefined;
let bridgeOutput = "";
let baseUrl: string;
let apiServer: Server | undefined;

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
      // O bridge pode precisar de alguns instantes para iniciar.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O bridge Vpay não ficou pronto: ${bridgeOutput}`);
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
  apiServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/api/vpay/internal/payments") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({
        paymentId: "vpay-order-test-123",
        status: "PENDING",
        reference: "gateway-vpay-reference",
        checkoutUrl: expectedCheckoutUrl,
      }));
    });
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
      PAYMENT_PROVIDER: "vpay",
      NET_SERVICOS_PAYMENT_MODE: "live",
      NET_SERVICOS_DATA_DIR: bridgeDirectory,
      ADMIN_PASS: "vpay-gateway-test-admin",
      SESSION_SECRET: "vpay-gateway-test-session",
      VPAY_CLIENT_ID: "vpay-gateway-test-client",
      VPAY_CLIENT_SECRET: "vpay-gateway-test-secret",
      GW_MASTER_KEY: masterKey,
      GW_MASTER_SECRET: "vpay-gateway-test-master-secret",
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

test("Vpay Gateway devolve e permite recuperar o checkout hospedado", async () => {
  const docsResponse = await fetch(`${baseUrl}/gateway/docs`);
  assert.equal(docsResponse.status, 200);
  const docs = await docsResponse.text();
  assert.match(docs, /checkoutUrl/);
  assert.match(docs, /checkout\.vpay\.co\.mz/);
  assert.match(docs, /esta API não os filtra/i);
  assert.doesNotMatch(docs, /pedido de PIN no telemóvel/i);

  const createResponse = await fetch(`${baseUrl}/gateway/api/pay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": masterKey,
    },
    body: JSON.stringify({
      phone: "841234567",
      amount: 50,
      reference: "Vpay gateway checkout contract",
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.status, "pending");
  assert.equal(created.checkoutUrl, expectedCheckoutUrl);
  assert.match(created.statusUrl, new RegExp(`/gateway/api/status/${created.txId}$`));

  const statusResponse = await fetch(`${baseUrl}/gateway/api/status/${encodeURIComponent(created.txId)}`, {
    headers: { "x-api-key": masterKey },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "pending");
  assert.equal(status.checkoutUrl, expectedCheckoutUrl);
});