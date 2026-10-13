import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const bridgeDirectory = await mkdtemp(join(tmpdir(), "megabyte-emedx-recharge-"));
const adminPassword = "emedx-recharge-test-admin";

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
  throw new Error(`O bridge eMedx não ficou pronto: ${bridgeOutput}`);
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
  bridgeProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      DATABASE_URL: "",
      PORT: String(port),
      NODE_ENV: "development",
      NET_SERVICOS_PAYMENT_MODE: "test",
      NET_SERVICOS_DATA_DIR: bridgeDirectory,
      PAYMENT_PROVIDER: "emedx",
      ADMIN_PASS: adminPassword,
      SESSION_SECRET: "emedx-recharge-test-session",
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
    name: "Teste eMedx",
    phone: "861112223",
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

test("inicia recargas de saldo apenas com M-Pesa e mantém separado o telefone da conta", async () => {
  const unauthenticated = await postJson("/api/recharge/checkout", {
    amount: 20,
    paymentPhone: "841112223",
  });
  assert.equal(unauthenticated.status, 401);

  const invalidAmount = await postJson("/api/recharge/checkout", {
    amount: 19,
    paymentPhone: "841112223",
  }, userCookie);
  assert.equal(invalidAmount.status, 400);

  const fractionalAmount = await postJson("/api/recharge/checkout", {
    amount: 75.5,
    paymentPhone: "841112223",
  }, userCookie);
  assert.equal(fractionalAmount.status, 400);

  const overMaximumAmount = await postJson("/api/recharge/checkout", {
    amount: 40001,
    paymentPhone: "841112223",
  }, userCookie);
  assert.equal(overMaximumAmount.status, 400);

  const emolaPaymentPhone = await postJson("/api/recharge/checkout", {
    amount: 20,
    paymentPhone: "861112223",
  }, userCookie);
  assert.equal(emolaPaymentPhone.status, 400);

  const storefront = await fetch(`${baseUrl}/megas`);
  assert.equal(storefront.status, 200);
  const storefrontHtml = await storefront.text();
  assert.match(storefrontHtml, /recharge-payment-phone/);
  assert.match(storefrontHtml, /id="recharge-payment-phone"[^>]*maxlength="20"/);
  assert.match(storefrontHtml, /data-custom="true"[^>]*>Outro<\/button>/);
  assert.match(storefrontHtml, /id="recharge-custom-amount" type="number"/);
  assert.doesNotMatch(storefrontHtml, />5,000 MT<\/button>/);
  assert.doesNotMatch(storefrontHtml, /paynice\.online\/c\//);
  assert.doesNotMatch(storefrontHtml, /<iframe[^>]*recharge-checkout-frame/i);

  const storefrontScript = [...storefrontHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes("normalizeRechargePaymentPhone"));
  assert.ok(storefrontScript);
  const phoneNormalizerSource = storefrontScript.match(
    /function normalizeRechargePaymentPhone\(value\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(phoneNormalizerSource);
  const normalizeRechargePaymentPhone = new Function(
    `${phoneNormalizerSource}; return normalizeRechargePaymentPhone;`,
  )() as (value: string) => string;
  assert.equal(normalizeRechargePaymentPhone("+258 84 111 2223"), "841112223");
  assert.equal(normalizeRechargePaymentPhone("00258 85 111 2223"), "851112223");
  assert.equal(normalizeRechargePaymentPhone("841112223"), "841112223");

  const openRechargeDialogSource = storefrontScript.match(
    /function openRechargeDialog\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(openRechargeDialogSource);
  const dialogElements: Record<string, any> = {
    "recharge-selection": { style: {} },
    "recharge-checkout": { style: {} },
    "recharge-custom-amount-wrap": { style: {} },
    "recharge-custom-amount": { value: "" },
    "recharge-payment-phone": { value: "841234567" },
    "rech-err": { style: {} },
    "rech-btn": { disabled: false, textContent: "" },
    "recharge-modal": { style: {} },
    "recharge-card": { classList: { add() {}, remove() {} } },
  };
  const openRechargeDialog = new Function(
    "document",
    "setTimeout",
    `const authState = { user: { phone: "841112223" } };
    ${openRechargeDialogSource};
    return openRechargeDialog;`,
  )(
    {
      getElementById: (id: string) => dialogElements[id],
      querySelectorAll: () => [],
    },
    (callback: () => void) => callback(),
  ) as () => void;
  openRechargeDialog();
  assert.equal(dialogElements["recharge-payment-phone"].value, "");
  dialogElements["recharge-payment-phone"].value = "851234567";
  openRechargeDialog();
  assert.equal(dialogElements["recharge-payment-phone"].value, "");

  const submitRechargeSource = storefrontScript.match(
    /async function submitRecharge\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(submitRechargeSource);
  const formElements: Record<string, any> = {
    "rech-err": { style: { display: "none" }, textContent: "" },
    "recharge-payment-phone": { value: "+258 84 111 2223" },
    "rech-btn": { disabled: false, textContent: "" },
    "recharge-selection": { style: { display: "" } },
    "recharge-checkout": { style: { display: "none" } },
    "recharge-payment-notice": { textContent: "" },
  };
  let submittedRecharge: { amount: number; paymentPhone: string } | undefined;
  let checkoutResponse: Record<string, unknown> = {
    txId: "test-recharge",
    paymentPhone: "841112223",
    requestState: "submitted",
  };
  const submitRecharge = new Function(
    "document",
    "fetch",
    "listenRecharge",
    `${phoneNormalizerSource};
    let selectedRechargeAmount = 75;
    function isValidRechargeAmount(amount) {
      return Number.isInteger(amount) && amount >= 20 && amount <= 40000;
    }
    ${submitRechargeSource};
    return submitRecharge;`,
  )(
    { getElementById: (id: string) => formElements[id] },
    async (_url: string, request: { body: string }) => {
      submittedRecharge = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => checkoutResponse,
      };
    },
    () => {},
  ) as () => Promise<void>;
  await submitRecharge();
  assert.deepEqual(submittedRecharge, { amount: 75, paymentPhone: "841112223" });
  assert.equal(formElements["rech-err"].style.display, "none");
  assert.match(formElements["recharge-payment-notice"].textContent, /Pedido M-Pesa enviado para 841112223/);

  checkoutResponse = {
    txId: "test-recharge-preview",
    paymentPhone: "841112223",
    requestState: "simulated",
    testMode: true,
  };
  await submitRecharge();
  assert.match(formElements["recharge-payment-notice"].textContent, /Modo de teste/);
  assert.match(formElements["recharge-payment-notice"].textContent, /nenhum pedido foi enviado ao M-Pesa/);

  checkoutResponse = {
    txId: "test-recharge-unknown",
    paymentPhone: "841112223",
    requestState: "unknown",
  };
  await submitRecharge();
  assert.match(
    formElements["recharge-payment-notice"].textContent,
    /Pedido de recarga registado e em verificação/,
  );
  assert.doesNotMatch(
    formElements["recharge-payment-notice"].textContent,
    /Ainda não foi possível confirmar/,
  );

  const response = await postJson("/api/recharge/checkout", {
    amount: 20,
    paymentPhone: "+258 84 111 2223",
  }, userCookie);
  assert.equal(response.status, 201);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.requestState, "simulated");
  assert.equal(result.testMode, true);
  assert.equal(result.method, "mpesa");
  assert.equal(result.paymentPhone, "841112223");
  assert.equal(typeof result.txId, "string");

  const order = await waitForRecharge(String(result.txId));
  assert.equal(order.type, "recharge");
  assert.equal(order.status, "succeeded");
  assert.equal(order.phone, "861112223");
  assert.equal(order.payerPhone, "841112223");
  assert.equal(order.method, "mpesa");

  const customRechargeResponse = await postJson("/api/recharge/checkout", {
    amount: 75,
    paymentPhone: "841112223",
  }, userCookie);
  assert.equal(customRechargeResponse.status, 201);
  const customRecharge = await customRechargeResponse.json() as Record<string, unknown>;
  assert.equal(customRecharge.requestState, "simulated");
  assert.equal(customRecharge.testMode, true);
  const customOrder = await waitForRecharge(String(customRecharge.txId));
  assert.equal(customOrder.amount, 75);
  assert.equal(customOrder.bundleLabel, "Recarga 75 MT");

  const userResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: userCookie } });
  assert.equal(userResponse.status, 200);
  const user = await userResponse.json() as { balance: number; phone: string };
  assert.equal(user.balance, 95);
  assert.equal(user.phone, "861112223");
});
