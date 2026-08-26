import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";

const testId = randomUUID();
const queueDirectory = await mkdtemp(path.join(os.tmpdir(), "net-servicos-delivery-"));
const bridgeDirectory = await mkdtemp(path.join(os.tmpdir(), "net-servicos-bridge-"));
const queueFile = path.join(queueDirectory, "deliveries.json");
const bridgePort = await findFreePort();
const recoveryTxId = `delivery-test-recovery-${testId}`;

process.env.DELIVERY_QUEUE_FILE = queueFile;
process.env.PAGAR_BRIDGE_PORT = String(bridgePort);
process.env.PAGAR_WEBHOOK_SECRET = "delivery-webhook-test-secret";
process.env.SESSION_SECRET = "delivery-test-secret";

const {
  leaseNextDelivery,
  listDeliveries,
  reportDelivery,
} = await import("../src/services/delivery-queue.ts");
const { ensurePagarTables } = await import("../src/services/pagar.ts");
const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;
let bridgeProcess: ChildProcess;

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
      const response = await fetch(`http://127.0.0.1:${bridgePort}/ping`);
      if (response.ok) return;
    } catch {
      // The bridge needs a moment to load its local stores.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The test bridge did not become ready.");
}

function orderRecord(txId: string, reference: string, phone: string, beneficiaryPhone?: string) {
  return {
    txId,
    type: "bundle",
    phone,
    beneficiaryPhone: beneficiaryPhone || null,
    bundleId: "n04",
    bundleLabel: "780 MB",
    amount: 20,
    method: "mpesa",
    status: "pending",
    sourceId: `source-${txId}`,
    pagarRef: reference,
    ts: new Date().toISOString(),
  };
}

async function insertPendingOperation(txId: string, operationId: string, reference: string) {
  await pool!.query(
    `INSERT INTO pagar_operations
      (internal_id, pagar_operation_id, pagar_reference, type, amount_mzn, status,
       idempotency_key, source_id, local_transaction_id, title, method, payer_phone)
     VALUES ($1,$2,$3,'payment',20,'PENDING',$4,$5,$1,'Teste PAID','MPESA','841112223')`,
    [txId, operationId, reference, `delivery-test-${txId}`, `delivery-source-${txId}`],
  );
}

async function webhookRequest(eventId: string, operationId: string, reference: string) {
  const rawBody = JSON.stringify({
    data: {
      id: operationId,
      reference,
      status: "PAID",
      amountMzn: 20,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", process.env.PAGAR_WEBHOOK_SECRET!)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return fetch(`${baseUrl}/api/pagar/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "pagar-event-id": eventId,
      "pagar-event-type": "payment.succeeded",
      "pagar-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  });
}

async function adminRequest(method: string, endpoint: string) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { "x-internal-delivery-key": process.env.SESSION_SECRET! },
  });
  return { response, data: await response.json() };
}

async function pagarAdminRequest(method: string, endpoint: string) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { "x-internal-payment-key": process.env.SESSION_SECRET! },
  });
  return { response, data: await response.json() };
}

async function startBridge(mainApiPort: number) {
  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      MAIN_API_PORT: String(mainApiPort),
      NODE_ENV: "production",
      NET_SERVICOS_PAYMENT_MODE: "mock",
      PAGAR_API_KEY: "test-api-key",
      PAGAR_SIGNING_SECRET: "test-signing-secret",
      ADMIN_PASS: "test-admin-pass",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForBridge();
}

async function stopBridge() {
  const processToStop = bridgeProcess;
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    processToStop.once("exit", () => resolve());
    processToStop.kill("SIGTERM");
  });
}

before(async () => {
  await ensurePagarTables();
  const selfTxId = `delivery-test-self-${testId}`;
  const otherTxId = `delivery-test-other-${testId}`;
  await writeFile(
    path.join(bridgeDirectory, "orders.json"),
    JSON.stringify([
      orderRecord(selfTxId, `net-${selfTxId}`, "841112223"),
      orderRecord(otherTxId, `net-${otherTxId}`, "841112223", "852223334"),
      orderRecord(recoveryTxId, `net-${recoveryTxId}`, "841112223"),
    ]),
  );
  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    path.join(bridgeDirectory, "zumbopay-bridge.js"),
  );

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await startBridge(address.port);
});

after(async () => {
  await stopBridge();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool?.query("DELETE FROM pagar_webhook_events WHERE event_id LIKE $1", [`delivery-test-%`]);
  await pool?.query("DELETE FROM pagar_operations WHERE internal_id LIKE $1", [`delivery-test-%`]);
  await pool?.end();
  await rm(queueDirectory, { recursive: true, force: true });
  await rm(bridgeDirectory, { recursive: true, force: true });
});

test("PAID Para Mim reaches the account number and repeated equivalent webhooks keep one delivery", async () => {
  const txId = `delivery-test-self-${testId}`;
  const operationId = `pagar-self-${testId}`;
  const reference = `net-${txId}`;
  await insertPendingOperation(txId, operationId, reference);

  assert.equal((await webhookRequest(`delivery-test-self-event-${testId}`, operationId, reference)).status, 204);
  let deliveries = await listDeliveries();
  let delivery = deliveries.find((candidate) => candidate.paymentId === txId);
  assert.ok(delivery);
  assert.equal(delivery.beneficiaryPhone, "841112223");
  assert.match(delivery.ussdSequence.at(-1), /841112223/);

  assert.equal((await webhookRequest(`delivery-test-self-event-${testId}`, operationId, reference)).status, 204);
  assert.equal((await webhookRequest(`delivery-test-self-equivalent-${testId}`, operationId, reference)).status, 204);
  deliveries = await listDeliveries();
  assert.equal(deliveries.filter((candidate) => candidate.paymentId === txId).length, 1);
  delivery = deliveries.find((candidate) => candidate.paymentId === txId);
  assert.equal(delivery.beneficiaryPhone, "841112223");

  const leased = await leaseNextDelivery("self-agent");
  assert.ok(leased);
  assert.equal(leased.id, delivery.id);
  await reportDelivery("self-agent", leased.id, {
    status: "completed",
    confirmationReference: "SELF-DELIVERY-OK",
  });
});

test("PAID Para Outro keeps the informed beneficiary and failed delivery can be retried from the panel", async () => {
  const txId = `delivery-test-other-${testId}`;
  const operationId = `pagar-other-${testId}`;
  const reference = `net-${txId}`;
  await insertPendingOperation(txId, operationId, reference);

  assert.equal((await webhookRequest(`delivery-test-other-event-${testId}`, operationId, reference)).status, 204);
  const created = (await listDeliveries()).find((candidate) => candidate.paymentId === txId);
  assert.ok(created);
  assert.equal(created.beneficiaryPhone, "852223334");
  assert.match(created.ussdSequence.at(-1), /852223334/);

  const leased = await leaseNextDelivery("other-agent");
  assert.ok(leased);
  assert.equal(leased.id, created.id);
  await reportDelivery("other-agent", leased.id, {
    status: "failed",
    reason: "USSD indisponível no momento.",
  });

  const panelAfterFailure = await adminRequest("GET", "/api/ussd-agent/admin/deliveries");
  const panelDelivery = panelAfterFailure.data.deliveries.find(
    (candidate: { id: string }) => candidate.id === leased.id,
  );
  assert.equal(panelDelivery.status, "failed");
  assert.equal(panelDelivery.failureReason, "USSD indisponível no momento.");

  const retried = await adminRequest(
    "POST",
    `/api/ussd-agent/admin/deliveries/${encodeURIComponent(leased.id)}/retry`,
  );
  assert.equal(retried.response.status, 200);
  assert.equal(retried.data.delivery.status, "queued");
  assert.equal(retried.data.delivery.failureReason, undefined);

  const leasedAgain = await leaseNextDelivery("other-agent");
  assert.ok(leasedAgain);
  assert.equal(leasedAgain.id, leased.id);
  assert.equal(leasedAgain.beneficiaryPhone, "852223334");
  assert.match(leasedAgain.ussdSequence.at(-1), /852223334/);
});

test("retries a confirmed webhook after the bridge becomes unavailable without duplicating delivery", async () => {
  const operationId = `pagar-recovery-${testId}`;
  const reference = `net-${recoveryTxId}`;
  const eventId = `delivery-test-recovery-event-${testId}`;
  await insertPendingOperation(recoveryTxId, operationId, reference);

  await stopBridge();
  assert.equal((await webhookRequest(eventId, operationId, reference)).status, 204);

  const failedForwarding = (await pagarAdminRequest("GET", "/api/pagar/admin/webhook-deliveries")).data.events.find(
    (event: { eventId: string }) => event.eventId === eventId,
  );
  assert.ok(failedForwarding);
  assert.equal(failedForwarding.forwardingStatus, "failed");
  assert.equal(failedForwarding.forwardingAttempts, 1);
  assert.match(failedForwarding.forwardingLastError, /fetch failed|ECONNREFUSED|connect/i);
  assert.ok(failedForwarding.forwardingNextRetryAt);
  assert.ok(new Date(failedForwarding.forwardingNextRetryAt).getTime() > Date.now());

  await startBridge(Number(new URL(baseUrl).port));
  assert.equal((await webhookRequest(eventId, operationId, reference)).status, 204);

  const deliveredForwarding = (await pagarAdminRequest("GET", "/api/pagar/admin/webhook-deliveries")).data.events.find(
    (event: { eventId: string }) => event.eventId === eventId,
  );
  assert.ok(deliveredForwarding);
  assert.equal(deliveredForwarding.forwardingStatus, "delivered");
  assert.equal(deliveredForwarding.forwardingAttempts, 2);
  assert.equal(deliveredForwarding.forwardingLastError, undefined);
  assert.equal(deliveredForwarding.forwardingNextRetryAt, undefined);

  const deliveries = (await listDeliveries()).filter((delivery) => delivery.paymentId === recoveryTxId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].beneficiaryPhone, "841112223");
});