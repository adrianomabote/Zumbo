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
const restartRecoveryTxId = `delivery-test-restart-recovery-${testId}`;
const concurrentTxId = `delivery-test-concurrent-${testId}`;

process.env.DELIVERY_QUEUE_FILE = queueFile;
process.env.PAGAR_BRIDGE_PORT = String(bridgePort);
process.env.PAGAR_WEBHOOK_SECRET = "delivery-webhook-test-secret";
process.env.SESSION_SECRET = "delivery-test-secret";

const {
  leaseNextDelivery,
  listDeliveries,
  reportDelivery,
} = await import("../src/services/delivery-queue.ts");
const {
  ensurePagarTables,
  forwardPagarWebhook,
  getPagarWebhookEvent,
  startPagarWebhookRetryWorker,
} = await import("../src/services/pagar.ts");
const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;
let bridgeProcess: ChildProcess;
let apiProcess: ChildProcess | undefined;
let apiProcessOutput = "";
let hangingBridge: Server | undefined;
let delayedBridge: Server | undefined;
let delayedBridgeRequestCount = 0;
let delayedBridgeRequestSeen: Promise<void>;
let releaseDelayedBridgeRequest: () => void;
let stopPagarWebhookRetryWorker: (() => void) | undefined;

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

async function startHangingBridge() {
  hangingBridge = createServer((request, response) => {
    if (request.url === "/ping") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (request.url === "/internal/pagar-event") {
      request.resume();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    hangingBridge!.once("error", reject);
    hangingBridge!.listen(bridgePort, "127.0.0.1", () => resolve());
  });
}

async function stopHangingBridge() {
  const processToStop = hangingBridge;
  hangingBridge = undefined;
  if (!processToStop) return;
  await new Promise<void>((resolve, reject) => {
    processToStop.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startDelayedBridge() {
  let resolveRequestSeen!: () => void;
  delayedBridgeRequestSeen = new Promise((resolve) => {
    resolveRequestSeen = resolve;
  });
  let releaseRequest!: () => void;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  releaseDelayedBridgeRequest = releaseRequest;
  delayedBridgeRequestCount = 0;
  delayedBridge = createServer(async (request, response) => {
    if (request.url === "/ping") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (request.url !== "/internal/pagar-event") {
      response.writeHead(404);
      response.end();
      return;
    }

    request.resume();
    delayedBridgeRequestCount += 1;
    resolveRequestSeen();
    await requestReleased;

    const enqueueResponse = await fetch(`${baseUrl}/api/ussd-agent/internal/paid-deliveries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-delivery-key": process.env.SESSION_SECRET!,
      },
      body: JSON.stringify({
        paymentId: concurrentTxId,
        idempotencyKey: `order-${concurrentTxId}`,
        beneficiaryPhone: "841112223",
        packageLabel: "780 MB",
        ussdSequence: ["*111#", "Enviar pacote 780 MB para 841112223"],
      }),
    });
    const body = await enqueueResponse.text();
    response.writeHead(enqueueResponse.ok ? 200 : 502, { "content-type": "application/json" });
    response.end(body);
  });
  const port = await findFreePort();
  await new Promise<void>((resolve, reject) => {
    delayedBridge!.once("error", reject);
    delayedBridge!.listen(port, "127.0.0.1", () => resolve());
  });
  process.env.PAGAR_BRIDGE_PORT = String(port);
}

async function stopDelayedBridge() {
  const processToStop = delayedBridge;
  delayedBridge = undefined;
  if (!processToStop) return;
  await new Promise<void>((resolve, reject) => {
    processToStop.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startApiProcess() {
  const apiPort = await findFreePort();
  const legacyBridgePort = await findFreePort();
  const tsxEntry = fileURLToPath(new URL("../../../scripts/node_modules/tsx/dist/cli.mjs", import.meta.url));
  const apiEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  apiProcessOutput = "";
  apiProcess = spawn(process.execPath, [tsxEntry, apiEntry], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(apiPort),
      LEGACY_BRIDGE_PORT: String(legacyBridgePort),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout?.on("data", (chunk: Buffer) => {
    apiProcessOutput += chunk.toString();
  });
  apiProcess.stderr?.on("data", (chunk: Buffer) => {
    apiProcessOutput += chunk.toString();
  });

  const child = apiProcess;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`O processo da API terminou antes de ficar pronto: ${apiProcessOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/pagar/admin/webhook-deliveries`, {
        headers: { "x-internal-payment-key": process.env.SESSION_SECRET! },
      });
      if (response.ok) return apiPort;
    } catch {
      // The API needs a moment to start its bridge and database worker.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O processo da API não ficou pronto: ${apiProcessOutput}`);
}

async function stopApiProcess() {
  const processToStop = apiProcess;
  apiProcess = undefined;
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    processToStop.once("exit", finish);
    processToStop.kill("SIGTERM");
    const forceStop = setTimeout(() => {
      if (processToStop.exitCode === null && processToStop.signalCode === null) {
        processToStop.kill("SIGKILL");
      }
    }, 10_000);
    forceStop.unref();
  });
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

async function insertInterruptedForwarding(eventId: string, operationId: string, reference: string) {
  await pool!.query(
    `INSERT INTO pagar_webhook_events
      (event_id, event_type, operation_id, reference, payment_status,
       forwarding_status, forwarding_attempts, forwarding_last_error,
       forwarding_next_retry_at, forwarding_started_at, forwarding_updated_at)
     VALUES ($1,'payment.succeeded',$2,$3,'PAID','forwarding',1,
             'Tentativa interrompida pelo reinício do servidor.',
             NULL, now() - interval '3 minutes', now() - interval '3 minutes')`,
    [eventId, operationId, reference],
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

async function waitForForwarding(eventId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = (await pagarAdminRequest("GET", "/api/pagar/admin/webhook-deliveries")).data.events.find(
      (candidate: { eventId: string }) => candidate.eventId === eventId,
    );
    if (event?.forwardingStatus === "delivered") return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O encaminhamento ${eventId} não foi entregue pelo worker.`);
}

async function waitForForwardingStatus(eventId: string, status: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const event = (await pagarAdminRequest("GET", "/api/pagar/admin/webhook-deliveries")).data.events.find(
      (candidate: { eventId: string }) => candidate.eventId === eventId,
    );
    if (event?.forwardingStatus === status) return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`O encaminhamento ${eventId} não chegou ao estado ${status}.`);
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
      orderRecord(restartRecoveryTxId, `net-${restartRecoveryTxId}`, "841112223"),
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
  stopPagarWebhookRetryWorker = startPagarWebhookRetryWorker(25);
});

after(async () => {
  stopPagarWebhookRetryWorker?.();
  await stopApiProcess();
  await stopHangingBridge();
  await stopDelayedBridge();
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

test("worker retries a confirmed webhook after the bridge becomes unavailable without duplicating delivery", async () => {
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
  const confirmedOperation = await pool!.query(
    "SELECT status FROM pagar_operations WHERE internal_id = $1",
    [recoveryTxId],
  );
  assert.equal(confirmedOperation.rows[0]?.status, "PAID");

  await startBridge(Number(new URL(baseUrl).port));
  await pool!.query(
    "UPDATE pagar_webhook_events SET forwarding_next_retry_at = now() - interval '1 second' WHERE event_id = $1",
    [eventId],
  );

  const deliveredForwarding = await waitForForwarding(eventId);
  assert.ok(deliveredForwarding);
  assert.equal(deliveredForwarding.forwardingStatus, "delivered");
  assert.equal(deliveredForwarding.forwardingAttempts, 2);
  assert.equal(deliveredForwarding.forwardingLastError, undefined);
  assert.equal(deliveredForwarding.forwardingNextRetryAt, undefined);

  const deliveries = (await listDeliveries()).filter((delivery) => delivery.paymentId === recoveryTxId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].beneficiaryPhone, "841112223");
});

test("worker recovers an interrupted forwarding after server restart without duplicating delivery", async () => {
  const operationId = `pagar-restart-recovery-${testId}`;
  const reference = `net-${restartRecoveryTxId}`;
  const eventId = `delivery-test-restart-recovery-event-${testId}`;

  await insertPendingOperation(restartRecoveryTxId, operationId, reference);
  await pool!.query(
    "UPDATE pagar_operations SET status = 'PAID', confirmed_at = now() WHERE internal_id = $1",
    [restartRecoveryTxId],
  );

  stopPagarWebhookRetryWorker?.();
  stopPagarWebhookRetryWorker = undefined;
  await stopBridge();
  await startHangingBridge();
  await insertInterruptedForwarding(eventId, operationId, reference);

  const interrupted = await pool!.query(
    `SELECT forwarding_status, forwarding_attempts, forwarding_started_at
       FROM pagar_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  assert.equal(interrupted.rows[0]?.forwarding_status, "forwarding");
  assert.equal(interrupted.rows[0]?.forwarding_attempts, 1);
  assert.ok(interrupted.rows[0]?.forwarding_started_at);

  // The first API process claims the stale event and is stopped while its
  // forwarding request is still in flight.
  await startApiProcess();
  const forwardingWhileProcessRuns = await waitForForwardingStatus(eventId, "forwarding");
  assert.equal(forwardingWhileProcessRuns.forwardingStatus, "forwarding");
  await stopApiProcess();
  await stopHangingBridge();

  await pool!.query(
    `UPDATE pagar_webhook_events
        SET forwarding_started_at = now() - interval '3 minutes',
            forwarding_next_retry_at = NULL
      WHERE event_id = $1`,
    [eventId],
  );
  await startBridge(Number(new URL(baseUrl).port));

  // A distinct API process initializes a fresh worker and recovers the stale
  // forwarding from PostgreSQL.
  await startApiProcess();

  const deliveredForwarding = await waitForForwarding(eventId);
  assert.equal(deliveredForwarding.forwardingStatus, "delivered");
  assert.equal(deliveredForwarding.forwardingAttempts, 3);
  assert.equal(deliveredForwarding.forwardingLastError, undefined);
  assert.equal(deliveredForwarding.forwardingNextRetryAt, undefined);

  const deliveries = (await listDeliveries()).filter(
    (delivery) => delivery.paymentId === restartRecoveryTxId,
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].beneficiaryPhone, "841112223");
});

test("concurrent workers reclaim one stale forwarding with one bridge delivery", async () => {
  const operationId = `pagar-concurrent-${testId}`;
  const reference = `net-${concurrentTxId}`;
  const eventId = `delivery-test-concurrent-event-${testId}`;

  await insertPendingOperation(concurrentTxId, operationId, reference);
  await stopBridge();
  await startDelayedBridge();
  await insertInterruptedForwarding(eventId, operationId, reference);

  const event = await getPagarWebhookEvent(eventId);
  assert.ok(event);
  const firstForwarding = forwardPagarWebhook(event);
  const secondForwarding = forwardPagarWebhook(event);
  await delayedBridgeRequestSeen;

  releaseDelayedBridgeRequest();
  const [firstResult, secondResult] = await Promise.all([firstForwarding, secondForwarding]);

  assert.equal(delayedBridgeRequestCount, 1);
  assert.deepEqual(
    [firstResult?.forwardingStatus, secondResult?.forwardingStatus].sort(),
    ["delivered", "forwarding"],
  );
  const finalEvent = await getPagarWebhookEvent(eventId);
  assert.equal(finalEvent?.forwardingStatus, "delivered");
  assert.equal(finalEvent?.forwardingAttempts, 2);

  const deliveries = (await listDeliveries()).filter((delivery) => delivery.paymentId === concurrentTxId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].beneficiaryPhone, "841112223");

  await stopDelayedBridge();
  process.env.PAGAR_BRIDGE_PORT = String(bridgePort);
  await startBridge(Number(new URL(baseUrl).port));
});
