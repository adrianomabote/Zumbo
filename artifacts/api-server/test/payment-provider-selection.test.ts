import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createVpayHostedOrder,
  getPagarPayment,
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