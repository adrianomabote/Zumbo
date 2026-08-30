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

router.post("/pagar/internal/payments", async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Origem não autorizada." });
  }
  try {
    const payment = await createPagarPayment(req.body);
    return res.status(202).json({ paymentId: payment.pagar_operation_id, status: payment.status, reference: payment.pagar_reference });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Pagamento inválido." });
  }
});

router.post("/pagar/internal/payments/:localTransactionId/reconcile", async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Origem não autorizada." });
  }
  try {
    const payment = await reconcilePagarPayment(req.params.localTransactionId);
    return res.json({
      paymentId: payment.pagar_operation_id,
      status: payment.status,
      reference: payment.pagar_reference,
    });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Não foi possível reconciliar o pagamento." });
  }
});

router.get("/pagar/payments/:id", async (req, res) => {
  try { return res.json(await getPagarPayment({ id: req.params.id })); } catch { return res.status(502).json({ error: "Não foi possível consultar o pagamento." }); }
});

router.get("/pagar/payments", async (req, res) => {
  try { return res.json(await listPagarPayments({ status: String(req.query.status || ""), cursor: String(req.query.cursor || ""), limit: String(req.query.limit || "") })); } catch { return res.status(502).json({ error: "Não foi possível consultar os pagamentos." }); }
});

router.get("/pagar/admin/webhook-deliveries", async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  try {
    return res.json({ events: await listPagarWebhookEvents() });
  } catch {
    return res.status(502).json({ error: "Não foi possível consultar os encaminhamentos." });
  }
});

router.post("/pagar/admin/webhook-deliveries/:eventId/retry", async (req, res) => {
  if (!process.env.SESSION_SECRET || req.header("x-internal-payment-key") !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  try {
    return res.json({ event: await retryPagarWebhookForwarding(req.params.eventId) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Nova tentativa recusada." });
  }
});

export default router;