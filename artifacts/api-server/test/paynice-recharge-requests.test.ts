import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const bridgeDirectory = await mkdtemp(join(tmpdir(), "megabyte-paynice-recharge-"));
const adminPassword = "paynice-recharge-test-admin";
const expectedCheckouts: Record<number, string> = {
  20: "https://paynice.online/c/recarga-de-20-qvgle",
  50: "https://paynice.online/c/recarga-de-50-biong",
  100: "https://paynice.online/c/recarga-de-100-jtv1x",
  250: "https://paynice.online/c/recarga-de-250-yrcne",
  500: "https://paynice.online/c/recarga-de-500-9b82p",
  1000: "https://paynice.online/c/recarga-de-1000-5ip1g",
  2000: "https://paynice.online/c/recarga-de-2000-yxn65",
  5000: "https://paynice.online/c/recarga-de-5000-muzo1",
};

let bridgeProcess: ChildProcess | undefined;
let bridgeOutput = "";
let baseUrl: string;
let adminCookie: string;
let userCookie: string;

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
  throw new Error(`O bridge PayNice não ficou pronto: ${bridgeOutput}`);
}

async function postJson(path: string, body: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    join(bridgeDirectory, "zumbopay-bridge.js"),
  );
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      DATABASE_URL: "",
      PORT: String(port),
      NODE_ENV: "development",
      NET_SERVICOS_PAYMENT_MODE: "test",
      NET_SERVICOS_DATA_DIR: bridgeDirectory,
      ADMIN_PASS: adminPassword,
      PAGAR_WEBHOOK_SECRET: "paynice-recharge-test-webhook",
      SESSION_SECRET: "paynice-recharge-test-session",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProcess.stdout?.on("data", (chunk: Buffer) => { bridgeOutput += chunk.toString(); });
  bridgeProcess.stderr?.on("data", (chunk: Buffer) => { bridgeOutput += chunk.toString(); });
  await waitForBridge();

  const login = await fetch(`${baseUrl}/admin/office`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: adminPassword }),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const adminSetCookie = login.headers.get("set-cookie");
  assert.ok(adminSetCookie);
  adminCookie = adminSetCookie.split(";", 1)[0];

  const registration = await postJson("/api/auth/register", {
    name: "Teste PayNice",
    phone: "841112223",
    password: "test-password-123",
  });
  assert.equal(registration.status, 201);
  const userSetCookie = registration.headers.get("set-cookie");
  assert.ok(userSetCookie);
  userCookie = userSetCookie.split(";", 1)[0];
});

after(async () => {
  await stopBridge();
  await rm(bridgeDirectory, { recursive: true, force: true });
});

test("cria pedidos de recarga autenticados com os links PayNice e aprovação administrativa", async () => {
  const unauthenticated = await postJson("/api/recharge/checkout", { amount: 20 });
  assert.equal(unauthenticated.status, 401);

  const invalidAmount = await postJson("/api/recharge/checkout", { amount: 75 }, userCookie);
  assert.equal(invalidAmount.status, 400);

  const storefront = await fetch(`${baseUrl}/megas`);
  assert.equal(storefront.status, 200);
  const storefrontHtml = await storefront.text();
  assert.match(storefrontHtml, /Após concluir o pagamento, o saldo da sua conta será actualizado em até 5 minutos\./);

  for (const [amount, checkoutUrl] of Object.entries(expectedCheckouts)) {
    const response = await postJson("/api/recharge/checkout", { amount: Number(amount) }, userCookie);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, checkoutUrl });
  }

  const unauthorisedApproval = await postJson(
    "/admin/recharge-requests/approve",
    { txId: "unknown" },
  );
  assert.equal(unauthorisedApproval.status, 401);

  const orderResponse = await fetch(`${baseUrl}/admin/orders.json`, { headers: { cookie: adminCookie } });
  assert.equal(orderResponse.status, 200);
  const orders = await orderResponse.json() as Array<Record<string, unknown>>;
  const requests = orders.filter((order) => order.type === "paynice-recharge");
  assert.equal(requests.length, Object.keys(expectedCheckouts).length);
  assert.ok(requests.every((order) => order.status === "pending"));

  const pendingPanel = await fetch(`${baseUrl}/admin/office?filter=recharge-requests`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(pendingPanel.status, 200);
  const panelHtml = await pendingPanel.text();
  assert.match(panelHtml, /Pedidos de Recarga/);
  assert.match(panelHtml, /Aprovar e creditar saldo/);
  assert.match(panelHtml, /Rejeitar/);
  assert.match(panelHtml, /841112223/);

  const request20 = requests.find((order) => order.amount === 20);
  const request50 = requests.find((order) => order.amount === 50);
  assert.ok(request20?.txId);
  assert.ok(request50?.txId);

  const approved = await postJson(
    "/admin/recharge-requests/approve",
    { txId: request20.txId },
    adminCookie,
  );
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), { ok: true, status: "succeeded" });

  const rejectApprovedRequest = await postJson(
    "/admin/recharge-requests/reject",
    { txId: request20.txId },
    adminCookie,
  );
  assert.equal(rejectApprovedRequest.status, 409);

  const duplicateApproval = await postJson(
    "/admin/recharge-requests/approve",
    { txId: request20.txId },
    adminCookie,
  );
  assert.equal(duplicateApproval.status, 409);

  const rejected = await postJson(
    "/admin/recharge-requests/reject",
    { txId: request50.txId },
    adminCookie,
  );
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { ok: true, status: "rejected" });

  const request100 = requests.find((order) => order.amount === 100);
  assert.ok(request100?.txId);
  const concurrentDecisions = await Promise.all([
    postJson("/admin/recharge-requests/approve", { txId: request100.txId }, adminCookie),
    postJson("/admin/recharge-requests/reject", { txId: request100.txId }, adminCookie),
  ]);
  assert.deepEqual(concurrentDecisions.map((response) => response.status).sort(), [200, 409]);

  const userResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: userCookie } });
  assert.equal(userResponse.status, 200);
  const user = await userResponse.json() as { balance: number };
  const concurrentRequestWasApproved = concurrentDecisions.some((response) => response.status === 200) &&
    (await responseBodyStatus(baseUrl, adminCookie, request100.txId)) === "succeeded";
  assert.equal(user.balance, concurrentRequestWasApproved ? 120 : 20, "só pedidos aprovados devem ser creditados");

  const finalOrdersResponse = await fetch(`${baseUrl}/admin/orders.json`, { headers: { cookie: adminCookie } });
  const finalOrders = await finalOrdersResponse.json() as Array<Record<string, unknown>>;
  assert.equal(finalOrders.find((order) => order.txId === request20.txId)?.status, "succeeded");
  assert.equal(finalOrders.find((order) => order.txId === request50.txId)?.status, "rejected");
});

async function responseBodyStatus(baseUrl: string, adminCookie: string, txId: unknown) {
  const response = await fetch(`${baseUrl}/admin/orders.json`, { headers: { cookie: adminCookie } });
  const orders = await response.json() as Array<Record<string, unknown>>;
  return orders.find((order) => order.txId === txId)?.status;
}
