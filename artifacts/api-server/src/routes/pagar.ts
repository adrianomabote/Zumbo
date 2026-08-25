import { Router, type IRouter } from "express";
import { createPagarPayment, getPagarPayment, listPagarPayments, processPagarWebhook, verifyPagarWebhook } from "../services/pagar";

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
    await processPagarWebhook(eventId, eventType, rawBody);
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

router.get("/pagar/payments/:id", async (req, res) => {
  try { return res.json(await getPagarPayment({ id: req.params.id })); } catch { return res.status(502).json({ error: "Não foi possível consultar o pagamento." }); }
});

router.get("/pagar/payments", async (req, res) => {
  try { return res.json(await listPagarPayments({ status: String(req.query.status || ""), cursor: String(req.query.cursor || ""), limit: String(req.query.limit || "") })); } catch { return res.status(502).json({ error: "Não foi possível consultar os pagamentos." }); }
});

export default router;