import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMozPaymentC2B,
  createVpayHostedOrder,
  getPagarPayment,
  parseMozPaymentC2BResponse,
  validatePagarPaymentInput,
  vpayOperationIdentityMatches,
  vpayOperationAmountMatches,
  vpayResponseStatus,
} from "../src/services/pagar.ts";

test("Vpay paid amounts must match one of the accepted MZN amount representations", () => {
  assert.equal(vpayOperationAmountMatches({ amount: 25 }, 25), true);
  assert.equal(vpayOperationAmountMatches({ amount: 2500 }, 25), true);
  assert.equal(vpayOperationAmountMatches({ data: { order: { amountMzn: 25, payment: { amount: 2500 } } } }, 25), true);
  assert.equal(vpayOperationAmountMatches({ data: { order: { amountMzn: 25, payment: { amount: 2400 } } } }, 25), false);
  assert.equal(vpayOperationAmountMatches({ amount: 2499 }, 25), false);
  assert.equal(vpayOperationAmountMatches({ amountMzn: 2500 }, 25), false);
  assert.equal(vpayOperationAmountMatches({ total_mzn: 2500 }, 25), false);
  assert.equal(vpayOperationAmountMatches({}, 25), undefined);
});

test("Vpay PAID confirmation requires one consistent status and the matching order ID", () => {
  const matchingOrder = { data: { order: { orderId: "order-25", status: "PAID" } } };
  assert.equal(vpayOperationIdentityMatches(matchingOrder, "order-25"), true);
  assert.equal(vpayOperationIdentityMatches(matchingOrder, "another-order"), false);
  assert.equal(vpayOperationIdentityMatches({ data: { order: { status: "PAID" } } }, "order-25"), false);
  assert.equal(vpayResponseStatus(matchingOrder), "PAID");
  assert.equal(vpayResponseStatus({ status: "PENDING", data: { order: { status: "PAID" } } }), undefined);
  assert.equal(vpayResponseStatus({ data: { order: { status: "COMPLETED" } } }), undefined);
});

test("Vpay creates a hosted order and polls its documented status endpoint", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousClientId = process.env.VPAY_CLIENT_ID;
  const previousClientSecret = process.env.VPAY_CLIENT_SECRET;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    let body: Record<string, unknown> | undefined;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ url: url.href, method: init.method || "GET", headers, body });
    if (url.pathname === "/v1/auth/token") {
      return new Response(JSON.stringify({ access_token: "unit-test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/v1/orders") {
      return new Response(JSON.stringify({ data: { orderId: "order-test-123" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/v1/orders/order-test-123/status") {
      return new Response(JSON.stringify({ data: { order: { orderId: "order-test-123", status: "pending", amount: 2500 } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected mocked Vpay path: ${url.pathname}`);
  }) as typeof fetch;

  try {
    process.env.PAYMENT_PROVIDER = "vpay";
    process.env.VPAY_CLIENT_ID = "test-client";
    process.env.VPAY_CLIENT_SECRET = "test-secret";

    const hostedOrder = await createVpayHostedOrder({
      sourceId: "source-test-id",
      title: "1024 MB",
      description: "Pacote de teste",
      amountMzn: 25,
      payerPhone: "841234567",
    });
    assert.deepEqual(hostedOrder, {
      orderId: "order-test-123",
      checkoutUrl: "https://checkout.vpay.co.mz/order-test-123",
    });
    const createCall = calls.find((call) => new URL(call.url).pathname === "/v1/orders");
    assert.ok(createCall);
    assert.equal(createCall.method, "POST");
    assert.equal(createCall.headers.get("authorization"), "Bearer unit-test-token");
    assert.deepEqual(createCall.body, {
      source: { source: "api" },
      items: [{
        originProductId: "source-test-id",
        name: "1024 MB",
        quantity: 1,
        price: 25,
      }],
      customer: { name: "Cliente Megabyte", phone: "+258841234567" },
      shippingAddressDisabled: true,
      deliveryInfoDisabled: true,
    });
    const authCall = calls.find((call) => new URL(call.url).pathname === "/v1/auth/token");
    assert.deepEqual(authCall?.body, {
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const status = await getPagarPayment({ id: hostedOrder.orderId });
    assert.deepEqual(status, {
      data: { order: { orderId: "order-test-123", status: "pending", amount: 2500 } },
    });
    assert.ok(calls.some((call) => new URL(call.url).pathname === "/v1/orders/order-test-123/status"));
    assert.equal(calls.filter((call) => new URL(call.url).pathname === "/v1/auth/token").length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
    if (previousClientId === undefined) delete process.env.VPAY_CLIENT_ID;
    else process.env.VPAY_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.VPAY_CLIENT_SECRET;
    else process.env.VPAY_CLIENT_SECRET = previousClientSecret;
  }
});

test("unknown payment providers fail closed instead of falling back to Pagar", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousFetch = globalThis.fetch;
  let providerRequestMade = false;
  globalThis.fetch = (async () => {
    providerRequestMade = true;
    throw new Error("Unexpected payment-provider request");
  }) as typeof fetch;
  try {
    process.env.PAYMENT_PROVIDER = "unknown-provider";
    await assert.rejects(getPagarPayment({ id: "unknown-provider-safety-test" }), /não suportado/i);
    assert.equal(providerRequestMade, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
  }
});

test("MozPayment accepts the storefront's 10 MZN minimum without lowering other provider limits", () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const input = {
    localTransactionId: "moz-minimum-test",
    sourceId: "moz-minimum-source",
    reference: "mozminimumtest",
    title: "Compra teste",
    description: "Teste de validação",
    amountMzn: 10,
    method: "MPESA" as const,
    payerPhone: "841234567",
    idempotencyKey: "moz-minimum-test",
  };

  try {
    process.env.PAYMENT_PROVIDER = "mozpayment";
    for (const amountMzn of [10, 13, 17, 20]) {
      assert.doesNotThrow(() => validatePagarPaymentInput({ ...input, amountMzn }));
    }
    assert.throws(
      () => validatePagarPaymentInput({ ...input, amountMzn: 9 }),
      /entre 10 e 40000 MZN/,
    );

    process.env.PAYMENT_PROVIDER = "vpay";
    assert.throws(
      () => validatePagarPaymentInput({ ...input, amountMzn: 10 }),
      /entre 20 e 40000 MZN/,
    );
  } finally {
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
  }
});

test("MozPayment C2B uses the documented endpoints and requires an explicit JSON success", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousWalletId = process.env.MOZPAYMENT_WALLET_ID;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let responseCode = 200;

  globalThis.fetch = (async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
    calls.push({ url: url.href, headers, body });
    const response = responseCode === 200
      ? { cod: 200, status: "success", transacao: "moz-txn-test-1" }
      : { cod: 409, status: "error", mensagem: "Pagamento rejeitado." };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    process.env.PAYMENT_PROVIDER = "mozpayment";
    process.env.MOZPAYMENT_WALLET_ID = "wallet-test-id";

    const mpesa = await createMozPaymentC2B({
      amountMzn: 25,
      method: "MPESA",
      payerPhone: "+258 841 234 567",
    });
    assert.deepEqual(mpesa, { status: "PAID", operationId: "moz-txn-test-1" });

    responseCode = 409;
    const emola = await createMozPaymentC2B({
      amountMzn: 40,
      method: "EMOLA",
      payerPhone: "868765432",
    });
    assert.deepEqual(emola, { status: "FAILED" });

    assert.deepEqual(calls.map(({ url }) => url), [
      "https://mozpayment.co.mz/api/1.1/wf/pagamentorotativompesa",
      "https://mozpayment.co.mz/api/1.1/wf/pagamentorotativoemola",
    ]);
    assert.deepEqual(calls[0]?.body, {
      carteira: "wallet-test-id",
      numero: "841234567",
      cliente: "Cliente Megabyte",
      valor: "25",
    });
    assert.deepEqual(calls[1]?.body, {
      carteira: "wallet-test-id",
      numero: "868765432",
      cliente: "Cliente Megabyte",
      valor: "40",
    });
    assert.equal(calls[0]?.headers.get("content-type"), "application/json");
    assert.equal(calls[0]?.headers.get("authorization"), null);
    assert.equal(calls[0]?.headers.get("idempotency-key"), null);

    assert.deepEqual(parseMozPaymentC2BResponse({
      cod: 200,
      status: "success",
    }), { status: "RECONCILIATION_REQUIRED" });
    assert.deepEqual(parseMozPaymentC2BResponse({
      cod: "200",
      status: "success",
      transacao: "moz-txn-test-2",
    }), { status: "RECONCILIATION_REQUIRED", operationId: "moz-txn-test-2" });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
    if (previousWalletId === undefined) delete process.env.MOZPAYMENT_WALLET_ID;
    else process.env.MOZPAYMENT_WALLET_ID = previousWalletId;
  }
});