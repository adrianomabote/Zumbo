import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DeliveryStatus =
  | "queued"
  | "leased"
  | "manual_intervention"
  | "completed"
  | "failed";

export interface DeliveryEvent {
  at: string;
  status: DeliveryStatus;
  detail: string;
}

export interface Delivery {
  id: string;
  idempotencyKey: string;
  paymentId: string;
  beneficiaryPhone: string;
  packageLabel: string;
  ussdSequence: string[];
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  deviceId?: string;
  leaseExpiresAt?: string;
  confirmationReference?: string;
  failureReason?: string;
  events: DeliveryEvent[];
  createdAt: string;
  updatedAt: string;
}

interface AgentDevice {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: string;
  lastSeenAt: string;
}

interface StoredQueue {
  deliveries: Delivery[];
  devices: AgentDevice[];
}

const dataPath = path.resolve(process.cwd(), "legacy", "ussd-deliveries.json");
let state: StoredQueue = { deliveries: [], devices: [] };
let initialized = false;
let enqueueQueue = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function makeId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

async function persist() {
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(state, null, 2), "utf8");
}

async function ensureLoaded() {
  if (initialized) return;
  initialized = true;
  try {
    const file = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(file) as StoredQueue;
    state = {
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
    };
  } catch {
    await persist();
  }
}

function appendEvent(delivery: Delivery, status: DeliveryStatus, detail: string) {
  delivery.status = status;
  delivery.updatedAt = now();
  delivery.events.push({ at: delivery.updatedAt, status, detail });
}

export async function pairDevice(name: string, pairingCode: string) {
  await ensureLoaded();
  const expectedCode = process.env.NET_SERVICOS_AGENT_PAIRING_CODE ?? "00220022a1";
  if (pairingCode !== expectedCode) {
    throw new Error("Código de emparelhamento inválido.");
  }

  const id = makeId("device");
  const token = randomBytes(32).toString("base64url");
  const device: AgentDevice = {
    id,
    name: name.trim().slice(0, 64) || "Telefone Vodacom",
    tokenHash: hashToken(token),
    pairedAt: now(),
    lastSeenAt: now(),
  };
  state.devices.push(device);
  await persist();
  return { device: { id: device.id, name: device.name, pairedAt: device.pairedAt }, token };
}

export async function authenticateDevice(token?: string) {
  await ensureLoaded();
  if (!token) return null;
  const device = state.devices.find((candidate) => candidate.tokenHash === hashToken(token));
  if (!device) return null;
  device.lastSeenAt = now();
  await persist();
  return device;
}

async function enqueuePaidDeliveryLocked(input: {
  idempotencyKey: string;
  paymentId: string;
  beneficiaryPhone: string;
  packageLabel: string;
  ussdSequence: string[];
}) {
  await ensureLoaded();
  const existing = state.deliveries.find(
    (delivery) => delivery.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return existing;

  const timestamp = now();
  const delivery: Delivery = {
    id: makeId("delivery"),
    idempotencyKey: input.idempotencyKey,
    paymentId: input.paymentId,
    beneficiaryPhone: input.beneficiaryPhone,
    packageLabel: input.packageLabel,
    ussdSequence: input.ussdSequence,
    status: "queued",
    attempts: 0,
    maxAttempts: 2,
    events: [{ at: timestamp, status: "queued", detail: "Pagamento confirmado; entrega enfileirada." }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.deliveries.push(delivery);
  await persist();
  return delivery;
}

export function enqueuePaidDelivery(input: {
  idempotencyKey: string;
  paymentId: string;
  beneficiaryPhone: string;
  packageLabel: string;
  ussdSequence: string[];
}) {
  const work = enqueueQueue.then(() => enqueuePaidDeliveryLocked(input));
  enqueueQueue = work.then(() => undefined, () => undefined);
  return work;
}

export async function leaseNextDelivery(deviceId: string) {
  await ensureLoaded();
  const expiredLease = state.deliveries.find(
    (delivery) =>
      delivery.status === "leased" &&
      delivery.leaseExpiresAt &&
      new Date(delivery.leaseExpiresAt).getTime() < Date.now(),
  );
  if (expiredLease) {
    expiredLease.deviceId = undefined;
    expiredLease.leaseExpiresAt = undefined;
    appendEvent(expiredLease, "queued", "Lease expirou sem confirmação; devolvido à fila.");
  }

  const delivery = state.deliveries.find(
    (candidate) =>
      candidate.status === "queued" &&
      candidate.attempts < candidate.maxAttempts,
  );
  if (!delivery) {
    await persist();
    return null;
  }

  delivery.deviceId = deviceId;
  delivery.attempts += 1;
  delivery.leaseExpiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
  appendEvent(delivery, "leased", `Entregue exclusivamente ao dispositivo ${deviceId}.`);
  await persist();
  return delivery;
}

export async function listDeviceDeliveries(deviceId: string) {
  await ensureLoaded();
  return state.deliveries.filter((delivery) => delivery.deviceId === deviceId);
}

export async function listDeliveries() {
  await ensureLoaded();
  return [...state.deliveries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function reportDelivery(
  deviceId: string,
  deliveryId: string,
  report: {
    status: "completed" | "failed" | "manual_intervention";
    confirmationReference?: string;
    reason?: string;
  },
) {
  await ensureLoaded();
  const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
  if (!delivery || delivery.deviceId !== deviceId) {
    throw new Error("Entrega não encontrada para este dispositivo.");
  }
  const isLeasedOrManual =
    delivery.status === "leased" || delivery.status === "manual_intervention";
  if (!isLeasedOrManual) {
    throw new Error("A entrega não está disponível para reporte.");
  }
  if (delivery.status === "manual_intervention" && report.status === "manual_intervention") {
    throw new Error("A entrega já está em intervenção manual.");
  }
  if (report.status === "completed" && !report.confirmationReference?.trim()) {
    throw new Error("Uma referência de confirmação é obrigatória para concluir.");
  }

  delivery.leaseExpiresAt = undefined;
  if (report.status === "completed") {
    delivery.confirmationReference = report.confirmationReference?.trim();
    appendEvent(delivery, "completed", "Confirmação USSD registada pelo agente.");
  } else if (report.status === "failed") {
    delivery.failureReason = report.reason?.trim() || "Falha reportada pelo agente.";
    appendEvent(delivery, "failed", delivery.failureReason);
  } else {
    delivery.failureReason = report.reason?.trim() || "Intervenção manual necessária.";
    appendEvent(delivery, "manual_intervention", delivery.failureReason);
  }
  await persist();
  return delivery;
}

export async function retryDelivery(deliveryId: string) {
  await ensureLoaded();
  const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
  if (!delivery || !["failed", "manual_intervention"].includes(delivery.status)) {
    throw new Error("Esta entrega não pode ser repetida.");
  }
  if (delivery.attempts >= delivery.maxAttempts) {
    throw new Error("Limite de tentativas atingido.");
  }
  delivery.deviceId = undefined;
  delivery.leaseExpiresAt = undefined;
  appendEvent(delivery, "queued", "Nova tentativa autorizada pelo painel.");
  await persist();
  return delivery;
}