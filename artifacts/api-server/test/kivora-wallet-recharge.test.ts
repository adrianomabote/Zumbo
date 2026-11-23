import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const bridgeDirectory = await mkdtemp(join(tmpdir(), "megabyte-kivora-recharge-"));
const adminPassword = "kivora-recharge-test-admin";

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
  throw new Error(`O bridge Kivora não ficou pronto: ${bridgeOutput}`);
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

async function waitForRecharge(txId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/admin/orders.json`, { headers: { cookie: adminCookie } });
    const orders = await response.json() as Array<Record<string, unknown>>;
    const order = orders.find((candidate) => candidate.txId === txId);
    if (order?.status === "succeeded") return order;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`A recarga ${txId} não foi concluída no modo de teste: ${bridgeOutput}`);
}

before(async () => {
  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    join(bridgeDirectory, "zumbopay-bridge.js"),
  );
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: "",
    PORT: String(port),
    NODE_ENV: "development",
    NET_SERVICOS_PAYMENT_MODE: "test",
    NET_SERVICOS_DATA_DIR: bridgeDirectory,
    ADMIN_PASS: adminPassword,
    SESSION_SECRET: "kivora-recharge-test-session",
  };
  delete env.PAYMENT_PROVIDER;

  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env,
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
    name: "Teste Kivora",
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

test("Kivora é o provedor padrão e aceita recargas com M-Pesa sem exibir texto e-Mola", async () => {
  const webhookStatusRes = await fetch(`${baseUrl}/api/webhook-status`);
  assert.equal(webhookStatusRes.status, 200);
  const webhookStatus = await webhookStatusRes.json() as { url: string | null };
  assert.match(String(webhookStatus.url), /\/api\/kivora\/webhook$/);

  const docsRes = await fetch(`${baseUrl}/gateway/docs`);
  assert.equal(docsRes.status, 200);
  const docsHtml = await docsRes.text();
  assert.match(docsHtml, /Kivora/i);
  assert.doesNotMatch(docsHtml, /e-Mola/i);

  const invalidPrefix = await postJson("/api/recharge/checkout", {
    amount: 20,
    paymentPhone: "821112223",
  }, userCookie);
  assert.equal(invalidPrefix.status, 400);

  const mpesaRes = await postJson("/api/recharge/checkout", {
    amount: 20,
    paymentPhone: "+258 84 111 2223",
  }, userCookie);
  assert.equal(mpesaRes.status, 201);
  const mpesaResult = await mpesaRes.json() as Record<string, unknown>;
  assert.equal(mpesaResult.method, "mpesa");
  assert.equal(mpesaResult.paymentPhone, "841112223");
  const mpesaOrder = await waitForRecharge(String(mpesaResult.txId));
  assert.equal(mpesaOrder.pagarProvider, "kivora");

  const emolaRes = await postJson("/api/recharge/checkout", {
    amount: 50,
    paymentPhone: "861112223",
  }, userCookie);
  assert.equal(emolaRes.status, 201);
  const emolaResult = await emolaRes.json() as Record<string, unknown>;
  assert.equal(emolaResult.method, "emola");
  assert.equal(emolaResult.paymentPhone, "861112223");
  const emolaOrder = await waitForRecharge(String(emolaResult.txId));
  assert.equal(emolaOrder.pagarProvider, "kivora");

  const userRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: userCookie } });
  const user = await userRes.json() as { balance: number };
  assert.equal(user.balance, 70);

  const storefrontHtml = await (await fetch(`${baseUrl}/megas`)).text();
  assert.match(storefrontHtml, /Número M-Pesa para confirmar/);
  assert.doesNotMatch(storefrontHtml, /e-Mola/i);
  const storefrontScript = [...storefrontHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("normalizeRechargePaymentPhone"));
  assert.ok(storefrontScript);
  const phoneNormalizerSource = storefrontScript.match(/function normalizeRechargePaymentPhone\(value\) \{[\s\S]*?\n\}/)?.[0];
  const submitRechargeSource = storefrontScript.match(/async function submitRecharge\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(phoneNormalizerSource && submitRechargeSource);

  const formElements: Record<string, any> = {
    "rech-err": { style: { display: "none" }, textContent: "" },
    "recharge-payment-phone": { value: "+258 84 111 2223" },
    "rech-btn": { disabled: false, textContent: "" },
    "recharge-selection": { style: { display: "" } },
    "recharge-checkout": { style: { display: "none" } },
    "recharge-payment-notice": { textContent: "" },
  };
  let submitted: Record<string, unknown> | undefined;
  const submitRecharge = new Function(
    "document",
    "fetch",
    "listenRecharge",
    `${phoneNormalizerSource};
    let selectedRechargeAmount = 50;
    function isValidRechargeAmount(amount) {
      return Number.isInteger(amount) && amount >= 20 && amount <= 40000;
    }
    ${submitRechargeSource};
    return submitRecharge;`,
  )(
    { getElementById: (id: string) => formElements[id] },
    async (_url: string, request: { body: string }) => {
      submitted = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          txId: "kivora-ui-test",
          method: "mpesa",
          paymentPhone: "841112223",
          requestState: "submitted",
        }),
      };
    },
    () => {},
  ) as () => Promise<void>;
  await submitRecharge();
  assert.deepEqual(submitted, { amount: 50, paymentPhone: "841112223" });
  assert.match(formElements["recharge-payment-notice"].textContent, /Pedido M-Pesa enviado para 841112223/);
});

test("Erro de recarga Kivora (ex. saldo insuficiente / PIN incorrecto) chega via SSE e abre a folha #s-recharge-fail", async () => {
  const http = await import("node:http");
  let lastReference = "kivora-fail-ref-1";
  const mockPagar = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw) as { reference?: string };
        if (parsed.reference) lastReference = parsed.reference;
      } catch {
        // ignore
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: "PENDING",
        reference: lastReference,
        operationId: "pay_kivora_fail_1",
        provider: "kivora",
      }));
    });
  });
  await new Promise<void>((resolve) => mockPagar.listen(0, "127.0.0.1", resolve));
  const mockAddr = mockPagar.address();
  assert.ok(mockAddr && typeof mockAddr !== "string");

  const livePort = await findFreePort();
  const liveDir = await mkdtemp(join(tmpdir(), "megabyte-kivora-fail-"));
  await copyFile(
    fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url)),
    join(liveDir, "zumbopay-bridge.js"),
  );
  const liveProc = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: liveDir,
    env: {
      ...process.env,
      DATABASE_URL: "",
      PORT: String(livePort),
      NODE_ENV: "development",
      NET_SERVICOS_PAYMENT_MODE: "live",
      NET_SERVICOS_DATA_DIR: liveDir,
      ADMIN_PASS: adminPassword,
      SESSION_SECRET: "kivora-fail-session",
      KIVORA_API_KEY: "sk_test_mock",
      MAIN_API_PORT: String(mockAddr.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const liveBaseUrl = `http://127.0.0.1:${livePort}`;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const ping = await fetch(`${liveBaseUrl}/ping`);
        if (ping.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const reg = await fetch(`${liveBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cliente Erro", phone: "842223334", password: "test-password-123" }),
    });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.get("set-cookie")!.split(";", 1)[0];

    const checkout = await fetch(`${liveBaseUrl}/api/recharge/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ amount: 100, paymentPhone: "842223334" }),
    });
    assert.equal(checkout.status, 201);
    const created = await checkout.json() as { txId: string; status: string };
    assert.equal(created.status, "pending");

    const expectedReason = "O PIN M-Pesa está incorrecto. Verifique o seu PIN e tente novamente.";
    const eventRes = await fetch(`${liveBaseUrl}/internal/pagar-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-payment-key": "kivora-fail-session",
      },
      body: JSON.stringify({
        eventType: "payment.failed",
        reference: lastReference,
        operationId: "pay_kivora_fail_1",
        failureReason: expectedReason,
      }),
    });
    assert.equal(eventRes.status, 200);

    const sseRes = await fetch(`${liveBaseUrl}/events/${created.txId}`);
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const sseText = new TextDecoder().decode(value);
    assert.match(sseText, /"status":"failed"/);
    assert.ok(sseText.includes(expectedReason));

    // Verifica que shShow('recharge-fail') abre #overlay e #sheet na UI
    const storefrontHtml = await (await fetch(`${liveBaseUrl}/megas`)).text();
    const storefrontScript = [...storefrontHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((s) => s.includes("function shShow("));
    assert.ok(storefrontScript);
    const shShowSource = storefrontScript.match(/function shShow\(s\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(shShowSource);

    const classes = (initial: string[] = []) => {
      const set = new Set(initial);
      return {
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
        has: (c: string) => set.has(c),
      };
    };
    const overlayEl = { classList: classes() };
    const sheetEl = { classList: classes() };
    const failEl = { style: { display: "none" } };
    const domMap: Record<string, any> = {
      overlay: overlayEl,
      sheet: sheetEl,
      "s-recharge-fail": failEl,
    };
    const shShow = new Function(
      "document",
      "setTimeout",
      `${shShowSource}; return shShow;`,
    )(
      { getElementById: (id: string) => domMap[id] || { style: { display: "" } } },
      (fn: () => void) => fn(),
    ) as (s: string) => void;

    shShow("recharge-fail");
    assert.equal(failEl.style.display, "block");
    assert.equal(overlayEl.classList.has("open"), true);
    assert.equal(sheetEl.classList.has("open"), true);
  } finally {
    liveProc.kill("SIGTERM");
    await new Promise<void>((resolve) => mockPagar.close(() => resolve()));
    await rm(liveDir, { recursive: true, force: true });
  }
});

test("Recarga Kivora em produção funciona sem bloqueio 503, mesmo sem SESSION_SECRET, ADMIN_PASS ou PostgreSQL", async () => {
  const http = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const kivoraRequests: Array<Record<string, unknown>> = [];
  const kivoraMock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/c2b") {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        kivoraRequests.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "kivora-live-op-1",
          reference: parsed.reference,
          status: "PENDING",
          amount: parsed.amount,
          currency: "MZN",
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => kivoraMock.listen(0, "127.0.0.1", resolve));
  const kivoraAddr = kivoraMock.address();
  assert.ok(kivoraAddr && typeof kivoraAddr !== "string");

  const apiPort = await findFreePort();
  const legacyPort = await findFreePort();
  const runDir = await mkdtemp(join(tmpdir(), "megabyte-kivora-full-"));
  const tsxCli = fileURLToPath(new URL("../../../scripts/node_modules/tsx/dist/cli.mjs", import.meta.url));
  const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const webhookSecret = "kivora-live-whsec-test";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(apiPort),
    LEGACY_BRIDGE_PORT: String(legacyPort),
    PAGAR_BRIDGE_PORT: String(legacyPort),
    NODE_ENV: "production",
    NET_SERVICOS_PAYMENT_MODE: "live",
    NET_SERVICOS_DATA_DIR: runDir,
    PAYMENT_PROVIDER: "kivora",
    KIVORA_API_BASE_URL: `http://127.0.0.1:${kivoraAddr.port}`,
    KIVORA_API_KEY: "kv_live_test_key",
    KIVORA_WEBHOOK_SECRET: webhookSecret,
  };
  delete env.DATABASE_URL;
  delete env.SESSION_SECRET;
  delete env.ADMIN_PASS;

  let fullOut = "";
  const serverProc = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout?.on("data", (c: Buffer) => { fullOut += c.toString(); });
  serverProc.stderr?.on("data", (c: Buffer) => { fullOut += c.toString(); });

  const fullBase = `http://127.0.0.1:${apiPort}`;
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${fullBase}/api/legacy/ping`);
        if (res.ok) { ready = true; break; }
      } catch {
        // aguarda arranque
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.equal(ready, true, `Servidor completo não iniciou: ${fullOut}`);

    const regRes = await fetch(`${fullBase}/api/legacy/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cliente Live", phone: "848060353", password: "password-segura-1" }),
    });
    assert.equal(regRes.status, 201, fullOut);
    const cookie = regRes.headers.get("set-cookie")!.split(";", 1)[0].replace(/;\s*Path=.*/i, "");

    const checkoutRes = await fetch(`${fullBase}/api/legacy/api/recharge/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ amount: 50, paymentPhone: "848060353" }),
    });
    assert.equal(checkoutRes.status, 201, fullOut);
    const checkout = await checkoutRes.json() as { txId: string; status: string; requestState: string };
    assert.equal(checkout.status, "pending");
    assert.equal(checkout.requestState, "submitted");
    assert.equal(kivoraRequests.length, 1);
    assert.equal(kivoraRequests[0].phone, "848060353");
    assert.equal(kivoraRequests[0].amount, 50);

    const whBody = JSON.stringify({
      id: "evt_kivora_live_1",
      type: "payment.completed",
      data: {
        id: "kivora-live-op-1",
        reference: kivoraRequests[0].reference,
        status: "COMPLETED",
        amount: 50,
        currency: "MZN",
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", webhookSecret).update(`${ts}.${whBody}`).digest("hex");
    const whRes = await fetch(`${fullBase}/api/kivora/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kivora-signature": `t=${ts},v1=${sig}`,
      },
      body: whBody,
    });
    assert.equal(whRes.status, 204, fullOut);

    const meRes = await fetch(`${fullBase}/api/legacy/api/auth/me`, { headers: { cookie } });
    assert.equal(meRes.status, 200);
    const user = await meRes.json() as { balance: number };
    assert.equal(user.balance, 50);

    const buyRes = await fetch(`${fullBase}/api/legacy/api/buy-credit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ bundleId: "n05", purchaseFor: "self" }),
    });
    assert.equal(buyRes.status, 200);
    const bought = await buyRes.json() as { ok: boolean; newBalance: number };
    assert.equal(bought.ok, true);
    assert.equal(bought.newBalance, 25);
  } finally {
    serverProc.kill("SIGTERM");
    await new Promise<void>((resolve) => kivoraMock.close(() => resolve()));
    await rm(runDir, { recursive: true, force: true });
  }
});

test("createKivoraC2BPayment propaga erro real de configuração quando falta KIVORA_API_KEY", async () => {
  const { createKivoraC2BPayment } = await import("../src/services/pagar.ts");
  const prevKey = process.env.KIVORA_API_KEY;
  delete process.env.KIVORA_API_KEY;
  try {
    await assert.rejects(
      () => createKivoraC2BPayment({
        reference: "cfg-err-1",
        amountMzn: 20,
        payerPhone: "848060353",
        description: "Teste",
        method: "MPESA",
      }),
      /Kivora API não está configurada no servidor/,
    );
  } finally {
    if (prevKey !== undefined) process.env.KIVORA_API_KEY = prevKey;
  }
});


