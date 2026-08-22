import { Router, type IRouter, type Request } from "express";
import {
  authenticateDevice,
  enqueuePaidDelivery,
  leaseNextDelivery,
  listDeliveries,
  listDeviceDeliveries,
  pairDevice,
  reportDelivery,
  retryDelivery,
} from "../services/delivery-queue";

const router: IRouter = Router();

function bearerToken(request: Request) {
  const value = request.header("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

router.get("/ussd-agent", (_req, res) => {
  return res.json({
    ok: true,
    service: "Net Serviços USSD Agent",
    pairing: "POST /api/ussd-agent/pair",
  });
});

async function requireDevice(request: Request) {
  return authenticateDevice(bearerToken(request));
}

router.post("/ussd-agent/pair", async (req, res) => {
  try {
    const result = await pairDevice(String(req.body?.name ?? ""), String(req.body?.pairingCode ?? ""));
    res.status(201).json(result);
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Emparelhamento recusado." });
  }
});

router.post("/ussd-agent/deliveries/lease", async (req, res) => {
  const device = await requireDevice(req);
  if (!device) return res.status(401).json({ error: "Dispositivo não autorizado." });
  return res.json({ delivery: await leaseNextDelivery(device.id) });
});

router.get("/ussd-agent/deliveries", async (req, res) => {
  const device = await requireDevice(req);
  if (!device) return res.status(401).json({ error: "Dispositivo não autorizado." });
  return res.json({ deliveries: await listDeviceDeliveries(device.id) });
});

router.post("/ussd-agent/deliveries/:id/report", async (req, res) => {
  const device = await requireDevice(req);
  if (!device) return res.status(401).json({ error: "Dispositivo não autorizado." });
  try {
    const delivery = await reportDelivery(device.id, req.params.id, {
      status: req.body?.status,
      confirmationReference: req.body?.confirmationReference,
      reason: req.body?.reason,
    });
    return res.json({ delivery });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Reporte inválido." });
  }
});

router.get("/ussd-agent/admin/deliveries", async (req, res) => {
  const expected = process.env.SESSION_SECRET;
  if (!expected || req.header("x-internal-delivery-key") !== expected) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  const deliveries = await listDeliveries();
  return res.json({ deliveries });
});

router.post("/ussd-agent/admin/deliveries/:id/retry", async (req, res) => {
  const expected = process.env.SESSION_SECRET;
  if (!expected || req.header("x-internal-delivery-key") !== expected) {
    return res.status(401).json({ error: "Acção administrativa não autorizada." });
  }
  try {
    return res.json({ delivery: await retryDelivery(req.params.id) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Nova tentativa recusada." });
  }
});

router.post("/ussd-agent/internal/paid-deliveries", async (req, res) => {
  const expected = process.env.SESSION_SECRET;
  if (!expected || req.header("x-internal-delivery-key") !== expected) {
    return res.status(401).json({ error: "Origem de pagamento não autorizada." });
  }
  const body = req.body ?? {};
  if (!body.paymentId || !body.idempotencyKey || !body.beneficiaryPhone || !body.packageLabel) {
    return res.status(400).json({ error: "Dados do pagamento confirmado incompletos." });
  }
  const delivery = await enqueuePaidDelivery({
    paymentId: String(body.paymentId),
    idempotencyKey: String(body.idempotencyKey),
    beneficiaryPhone: String(body.beneficiaryPhone),
    packageLabel: String(body.packageLabel),
    ussdSequence: Array.isArray(body.ussdSequence) ? body.ussdSequence.map(String) : ["*111#"],
  });
  return res.status(201).json({ delivery });
});

router.post("/ussd-agent/simulations", async (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "A simulação não está disponível em produção." });
  }
  const delivery = await enqueuePaidDelivery({
    paymentId: `simulated-${Date.now()}`,
    idempotencyKey: `simulated-${Date.now()}`,
    beneficiaryPhone: "841234567",
    packageLabel: "380 MB",
    ussdSequence: ["*111#", "Seleccionar oferta de dados", "Confirmar 380 MB para 841234567"],
  });
  return res.status(201).json({ delivery });
});

export default router;