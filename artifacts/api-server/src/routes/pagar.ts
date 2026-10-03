import { Router, type IRouter } from "express";
import {
  createPagarPayment,
  forwardPagarWebhook,
  getPagarPayment,
  listPagarPayments,
  listPagarWebhookEvents,
  processPagarWebhook,
  reconcilePagarPayment,
  retryPagarWebhookForwarding,
  processDebitoPayWebhook,
  processMozPaymentWebhook,
  processPaysuiteWebhook,
  verifyDebitoPayWebhook,
  verifyMozPaymentWebhook,
  verifyPaysuiteWebhook,
  verifyPagarWebhook,
} from "../services/pagar";

const router: IRouter = Router();

router.post("/pagar/webhook", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.header("pagar-signature") || "";
  const eventId = req.header("pagar-event-id") || "";
  const eventType = req.header("pagar-event-type") || "";
  if (!eventId || !eventType || !verifyPagarWebhook(rawBody, signature)) {
    return res.status(401).json({ error: "Webhook inválido." });
  }
  try {
    const result = await processPagarWebhook(eventId, eventType, rawBody);
    if (result.forwardingStatus === "pending" || result.forwardingStatus === "failed") {
      await forwardPagarWebhook(result, { force: result.duplicate });
    }
    return res.sendStatus(204);
  } catch {
    return res.status(500).json({ error: "Webhook não processado." });
  }
});

router.post("/debitopay/webhook", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.header("x-webhook-signature")
    || req.header("x-debitopay-signature")
    || req.header("x-signature")
    || "";
  if (!verifyDebitoPayWebhook(rawBody, signature)) {
    return res.status(401).json({ error: "Webhook Debito Pay inválido." });
  }
  try {
    const result = await processDebitoPayWebhook(rawBody);
    if (result.forwardingStatus === "pending" || result.forwardingStatus === "failed") {
      await forwardPagarWebhook(result, { force: result.duplicate });
    }
    return res.sendStatus(204);
  } catch {
    return res.status(500).json({ error: "Webhook Debito Pay não processado." });
  }
});

router.post("/paysuite/webhook", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.header("x-signature") || "";
  if (!verifyPaysuiteWebhook(rawBody, signature)) {
    return res.status(401).json({ error: "Webhook Paysuite inválido." });
  }
  try {
    const result = await processPaysuiteWebhook(rawBody);
    if (result.forwardingStatus === "pending" || result.forwardingStatus === "failed") {
      await forwardPagarWebhook(result, { force: result.duplicate });
    }
    return res.sendStatus(204);
  } catch {
    return res.status(500).json({ error: "Webhook Paysuite não processado." });
  }
});

router.post("/mozpayment/webhook", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!process.env.MOZPAYMENT_WEBHOOK_SECRET?.trim()) {
    return res.status(503).json({ error: "Webhook MozPayment ainda não está configurado." });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "O corpo do webhook MozPayment não é JSON válido." });
  }
  const records = webhookRecords(payload);
  const authenticators = [
    req.header("x-webhook-signature"),
    req.header("x-mozpayment-signature"),
    req.header("x-signature"),
    req.header("x-webhook-secret"),
    req.header("x-mozpayment-secret"),
    req.header("authorization"),
    ...records.flatMap((record) =>
      ["webhook_secret", "webhookSecret", "_webhook_secret", "secret"]
        .map((key) => record[key])
        .filter((value): value is string => typeof value === "string"),
    ),
  ].filter((value): value is string => Boolean(value));
  if (!verifyMozPaymentWebhook(rawBody, authenticators)) {
    return res.status(401).json({ error: "Assinatura do webhook MozPayment inválida." });
  }

  try {
    const result = await processMozPaymentWebhook(rawBody);
    if (result.forwardingStatus === "pending" || result.forwardingStatus === "failed") {
      await forwardPagarWebhook(result, { force: result.duplicate });
    }
    return res.sendStatus(204);
  } catch (error) {
    const errorStatus = (error as { status?: unknown })?.status;
    if (errorStatus === 400 || errorStatus === 409) {
      return res.status(errorStatus).json({ error: error instanceof Error ? error.message : "Evento MozPayment inválido." });
    }
    return res.status(500).json({ error: "Webhook MozPayment não processado." });
  }
});

router.post(["/pagar/internal/payments", "/debitopay/internal/payments", "/paysuite/internal/payments", "/vpay/internal/payments", "/mozpayment/internal/payments"], async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Origem não autorizada." });
  }
  try {
    const payment = await createPagarPayment(req.body);
    return res.status(202).json({
      paymentId: payment.pagar_operation_id,
      status: payment.status,
      reference: payment.pagar_reference,
      checkoutUrl: payment.checkout_url || null,
      provider: payment.provider,
    });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Pagamento inválido." });
  }
});

router.post(["/pagar/internal/payments/:localTransactionId/reconcile", "/debitopay/internal/payments/:localTransactionId/reconcile", "/paysuite/internal/payments/:localTransactionId/reconcile", "/vpay/internal/payments/:localTransactionId/reconcile", "/mozpayment/internal/payments/:localTransactionId/reconcile"], async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Origem não autorizada." });
  }
  try {
    const payment = await reconcilePagarPayment(String(req.params.localTransactionId));
    return res.json({
      paymentId: payment.pagar_operation_id,
      status: payment.status,
      reference: payment.pagar_reference,
      provider: payment.provider,
    });
  } catch (error) {
    const errorStatus = (error as { status?: unknown })?.status;
    const status = errorStatus === 404 || errorStatus === 409 ? errorStatus : errorStatus === 501 ? 501 : 502;
    return res.status(status).json({ error: error instanceof Error ? error.message : "Não foi possível reconciliar o pagamento." });
  }
});

router.get(["/pagar/payments/:id", "/debitopay/payments/:id", "/paysuite/payments/:id", "/vpay/payments/:id"], async (req, res) => {
  try { return res.json(await getPagarPayment({ id: String(req.params.id) })); } catch { return res.status(502).json({ error: "Não foi possível consultar o pagamento." }); }
});

router.get(["/pagar/payments", "/debitopay/payments", "/paysuite/payments"], async (req, res) => {
  try { return res.json(await listPagarPayments({ status: String(req.query.status || ""), cursor: String(req.query.cursor || ""), limit: String(req.query.limit || "") })); } catch { return res.status(502).json({ error: "Não foi possível consultar os pagamentos." }); }
});

router.get(["/pagar/admin/webhook-deliveries", "/debitopay/admin/webhook-deliveries", "/paysuite/admin/webhook-deliveries", "/mozpayment/admin/webhook-deliveries"], async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  try {
    return res.json({ events: await listPagarWebhookEvents() });
  } catch {
    return res.status(502).json({ error: "Não foi possível consultar os encaminhamentos." });
  }
});

router.post(["/pagar/admin/webhook-deliveries/:eventId/retry", "/debitopay/admin/webhook-deliveries/:eventId/retry", "/paysuite/admin/webhook-deliveries/:eventId/retry", "/mozpayment/admin/webhook-deliveries/:eventId/retry"], async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  try {
    return res.json({ event: await retryPagarWebhookForwarding(String(req.params.eventId)) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Nova tentativa recusada." });
  }
});

export default router;

function webhookRecords(payload: unknown) {
  const records: Record<string, unknown>[] = [];
  const queue: unknown[] = [payload];
  const seen = new Set<object>();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    records.push(record);
    for (const key of ["data", "payment", "transaction", "payload"]) {
      if (record[key] && typeof record[key] === "object") queue.push(record[key]);
    }
  }
  return records;
}