import { test } from "node:test";
import assert from "node:assert/strict";
import { getPagarPayment } from "../src/services/pagar.ts";

test("Vpay and unknown providers fail closed instead of falling back to Pagar", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousFetch = globalThis.fetch;
  let providerRequestMade = false;

  globalThis.fetch = (async () => {
    providerRequestMade = true;
    throw new Error("Unexpected payment-provider request");
  }) as typeof fetch;

  try {
    process.env.PAYMENT_PROVIDER = "vpay";
    await assert.rejects(getPagarPayment({ id: "vpay-safety-test" }), /Vpay.*directa/i);
    assert.equal(providerRequestMade, false);

    process.env.PAYMENT_PROVIDER = "unknown-provider";
    await assert.rejects(getPagarPayment({ id: "unknown-provider-safety-test" }), /não suportado/i);
    assert.equal(providerRequestMade, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
  }
});