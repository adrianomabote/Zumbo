import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hasDatabase, pool } from "@workspace/db";

const DEFAULT_BASE_URL = "https://api.pagar.co.mz/api/v1";
const terminalStates = new Set(["PAID", "FAILED", "CANCELLED", "REFUNDED"]);
const knownPaymentStates = new Set([
  "PAID",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "PENDING",
  "PROCESSING",
  "RECONCILIATION_REQUIRED",
]);
const forwardableEventTypes = new Set(["payment.succeeded", "payment.failed"]);
const forwardingStatuses = new Set(["pending", "forwarding", "failed", "delivered"]);

type PaymentProvider = "pagar" | "debitopay" | "paysuite";

function activeProvider(): PaymentProvider {
  if (process.env.PAYMENT_PROVIDER === "paysuite") return "paysuite";
  return process.env.PAYMENT_PROVIDER === "debitopay" ? "debitopay" : "pagar";
}

function providerName() {
  if (activeProvider() === "paysuite") return "Paysuite";
  return activeProvider() === "debitopay" ? "Debito Pay" : "Pagar";
}

function normalizeDebitoPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("258") ? `+${digits}` : `+258${digits}`;
}

function normalizePaysuiteStatus(status: string | undefined) {
  if (!status) return undefined;
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "PAID", "CONFIRMED"].includes(status)) return "PAID";
  if (["FAILED", "DECLINED", "EXPIRED", "CANCELLED", "CANCELED", "REFUNDED", "CHARGEBACK"].includes(status)) {
    return status === "REFUNDED" ? "REFUNDED" : "FAILED";
  }
  if (["PENDING", "PROCESSING", "AUTHORIZED", "AWAITING_CUSTOMER"].includes(status)) return "PENDING";
  return undefined;
}

function debitoAmountMultiplier() {
  const value = Number(process.env.DEBITO_AMOUNT_MULTIPLIER || "1");
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function debitoProviderAmount(amountMzn: number) {
  return amountMzn * debitoAmountMultiplier();
}

function extractProviderOperation(data: Record<string, unknown>) {
  const candidate = [data.payment, data.transaction, data.data, data].find(
    (value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  ) || data;
  return candidate;
}

function providerOperationId(operation: Record<string, unknown>) {
  for (const key of ["id", "payment_id", "paymentId", "transaction_id", "transactionId"]) {
    if (typeof operation[key] === "string" && operation[key]) return operation[key] as string;
  }
  return undefined;
}

function providerReference(operation: Record<string, unknown>) {
  for (const key of ["reference", "order_reference", "orderReference", "merchant_reference"]) {
    if (typeof operation[key] === "string" && operation[key]) return operation[key] as string;
  }
  return undefined;
}

function providerStatus(operation: Record<string, unknown>) {
  const raw = operation.status ?? operation.payment_status ?? operation.paymentStatus;
  return typeof raw === "string" ? raw.trim().toUpperCase() : undefined;
}

function normalizeDebitoStatus(status: string | undefined) {
  if (!status) return undefined;
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "PAID", "CONFIRMED"].includes(status)) return "PAID";
  if (["FAILED", "DECLINED", "EXPIRED", "CANCELLED", "CANCELED", "REFUNDED", "CHARGEBACK"].includes(status)) return status === "REFUNDED" ? "REFUNDED" : "FAILED";
  if (["PENDING", "PROCESSING", "AUTHORIZED", "AWAITING_CUSTOMER"].includes(status)) return "PENDING";
  return undefined;
}

function providerAmount(operation: Record<string, unknown>) {
  for (const key of ["amountMzn", "amount", "value"]) {
    if (typeof operation[key] === "number" && Number.isFinite(operation[key])) return operation[key] as number;
  }
  return undefined;
}

function providerAmountMatches(value: number | undefined, localAmountMzn: number) {
  if (value === undefined) return true;
  return activeProvider() === "debitopay"
    ? value === localAmountMzn || value === debitoProviderAmount(localAmountMzn)
    : value === localAmountMzn;
}

function requirePool() {
  if (!hasDatabase || !pool) {
    throw new Error("Pagamentos indisponíveis: PostgreSQL não configurado.");
  }
  return pool;
}

export type PagarMethod = "MPESA" | "EMOLA";
export type PagarWebhookForwardingStatus = "not_required" | "pending" | "forwarding" | "failed" | "delivered";

export interface PagarPaymentInput {
  localTransactionId: string;
  sourceId: string;
  reference: string;
  title: string;
  description: string;
  amountMzn: number;
  method: PagarMethod;
  payerPhone: string;
  idempotencyKey: string;
}

function config() {
  if (activeProvider() === "paysuite") {
    const apiKey = process.env.PAYSUITE_API_KEY;
    if (!apiKey) {
      throw new Error("Paysuite API não está configurada no servidor.");
    }
    return {
      provider: "paysuite" as const,
      baseUrl: process.env.PAYSUITE_API_BASE_URL || "https://paysuite.tech/api/v1",
      apiKey,
    };
  }

  if (activeProvider() === "debitopay") {
    const apiKey = process.env.DEBITO_API_KEY;
    const baseUrl = process.env.DEBITO_API_BASE_URL;
    const merchantId = process.env.DEBITO_MERCHANT_ID;
    const walletCode = process.env.DEBITO_WALLET_CODE;
    if (!apiKey || !baseUrl || !merchantId || !walletCode) {
      throw new Error("Debito Pay API não está configurada no servidor.");
    }
    return { provider: "debitopay" as const, baseUrl, apiKey, merchantId, walletCode };
  }

  const apiKey = process.env.PAGAR_API_KEY;
  const signingSecret = process.env.PAGAR_SIGNING_SECRET;
  if (!apiKey || !signingSecret) {
    throw new Error("Pagar API não está configurada no servidor.");
  }
  return {
    provider: "pagar" as const,
    baseUrl: process.env.PAGAR_API_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
    signingSecret,
  };
}

function safeMessage(status: number, data: unknown) {
  const body = data as { safeMessage?: unknown; message?: unknown; error?: unknown; requestId?: unknown };
  const message = typeof body?.safeMessage === "string"
    ? body.safeMessage
    : typeof body?.message === "string"
      ? body.message
      : `Pedido ${providerName()} recusado.`;
  return {
    message,
    requestId: typeof body?.requestId === "string" ? body.requestId : undefined,
    error: typeof body?.error === "string" ? body.error : undefined,
    status,
  };
}

async function parseResponse(response: Response) {
  const rawText = await response.text();
  let data: unknown = {};
  if (rawText.trim()) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { message: rawText.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const failure = safeMessage(response.status, data);
    console.error(`[${providerName()}] resposta recusada`, JSON.stringify({
      status: failure.status,
      message: failure.message,
      error: failure.error,
      requestId: failure.requestId,
    }));
    const error = new Error(failure.message);
    Object.assign(error, failure);
    throw error;
  }
  return data as Record<string, unknown>;
}

async function request(method: "GET" | "POST", endpoint: string, body?: Record<string, unknown>, idempotencyKey?: string) {
  const configuration = config();
  const { baseUrl, apiKey } = configuration;
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${endpoint}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (configuration.provider === "paysuite") {
    headers["Content-Type"] = "application/json";
  } else if (configuration.provider === "debitopay") {
    Object.assign(headers, {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey || "",
    });
  } else if (rawBody !== undefined) {
    const { signingSecret } = configuration;
    const timestamp = Date.now().toString();
    const nonce = randomBytes(18).toString("base64url");
    const hash = createHash("sha256").update(rawBody).digest("hex");
    const canonical = [timestamp, nonce, method, url.pathname, hash].join("\n");
    const signature = createHmac("sha256", signingSecret).update(canonical).digest("hex");
    Object.assign(headers, {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey || "",
      "X-Pagar-Timestamp": timestamp,
      "X-Pagar-Nonce": nonce,
      "X-Pagar-Signature": `v1=${signature}`,
    });
  }
  const response = await fetch(url, { method, headers, body: rawBody, signal: AbortSignal.timeout(15_000) });
  return parseResponse(response);
}

function validateInput(input: PagarPaymentInput) {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(input.reference)) throw new Error("Referência de pagamento inválida.");
  if (input.title.length < 5 || input.title.length > 120) throw new Error("Título de pagamento inválido.");
  if (!Number.isInteger(input.amountMzn) || input.amountMzn < 20 || input.amountMzn > 40_000) {
    throw new Error("O valor deve ser um número inteiro entre 20 e 40000 MZN.");
  }
  const digits = input.payerPhone.replace(/\D/g, "");
  const local = digits.startsWith("258") ? digits.slice(3) : digits;
   const valid = input.method === "MPESA" ? /^(84|85)\d{7}$/.test(local) : /^(86|87)\d{7}$/.test(local);
  if (!valid) throw new Error("O telefone não corresponde ao método de pagamento.");
}

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function isConfigurationError(error: unknown) {
  return error instanceof Error && (
    error.message === "Pagar API não está configurada no servidor." ||
    error.message === "Debito Pay API não está configurada no servidor." ||
    error.message === "Paysuite API não está configurada no servidor."
  );
}

function isUncertainProviderError(error: unknown) {
  if (isConfigurationError(error)) return false;
  const status = errorStatus(error);
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

function normalizePaymentStatus(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

export async function ensurePagarTables() {
  if (!hasDatabase || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagar_operations (
      internal_id text PRIMARY KEY,
      pagar_operation_id text UNIQUE,
      pagar_reference text NOT NULL UNIQUE,
      type text NOT NULL,
      amount_mzn integer NOT NULL,
      status text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      source_id text NOT NULL UNIQUE,
      local_transaction_id text NOT NULL UNIQUE,
      title text NOT NULL,
      method text NOT NULL,
      payer_phone text NOT NULL,
      receipt_number text,
      receipt_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      confirmed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS pagar_webhook_events (
      event_id text PRIMARY KEY,
      event_type text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      operation_id text,
      reference text,
      payment_status text,
      forwarding_status text NOT NULL DEFAULT 'not_required',
      forwarding_attempts integer NOT NULL DEFAULT 0,
      forwarding_last_error text,
      forwarding_next_retry_at timestamptz,
      forwarding_started_at timestamptz,
      forwarding_updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS operation_id text;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS reference text;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS payment_status text;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_status text NOT NULL DEFAULT 'not_required';
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_last_error text;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_next_retry_at timestamptz;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_started_at timestamptz;
    ALTER TABLE pagar_webhook_events ADD COLUMN IF NOT EXISTS forwarding_updated_at timestamptz NOT NULL DEFAULT now();
  `);
}

export async function createPagarPayment(input: PagarPaymentInput) {
  const database = requirePool();
  validateInput(input);
  const existing = await database.query(
    "SELECT internal_id, pagar_operation_id, pagar_reference, amount_mzn, status FROM pagar_operations WHERE local_transaction_id = $1 OR idempotency_key = $2",
    [input.localTransactionId, input.idempotencyKey],
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await database.query(
    `INSERT INTO pagar_operations (internal_id, pagar_reference, type, amount_mzn, status, idempotency_key, source_id, local_transaction_id, title, method, payer_phone)
     VALUES ($1,$2,'payment',$3,'PENDING',$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.localTransactionId, input.reference, input.amountMzn, input.idempotencyKey, input.sourceId, input.localTransactionId, input.title, input.method, input.payerPhone],
  );
  const isDebitoPay = activeProvider() === "debitopay";
  const body = isDebitoPay
    ? {
         action: "process",
        merchant_id: process.env.DEBITO_MERCHANT_ID,
        wallet_code: process.env.DEBITO_WALLET_CODE,
        amount: debitoProviderAmount(input.amountMzn),
        currency: "MZN",
        payment_method: input.method === "MPESA" ? "mpesa" : "emola",
        phone: normalizeDebitoPhone(input.payerPhone),
        reference: input.reference,
        description: input.description,
      }
    : {
        reference: input.reference,
        title: input.title,
        description: input.description,
        amountMzn: input.amountMzn,
        method: input.method,
        payerPhone: input.payerPhone,
      };
  try {
    const data = await request("POST", isDebitoPay ? "/payment-orchestrator" : "/payments", body, input.idempotencyKey);
    const operation = extractProviderOperation(data);
    const status = isDebitoPay
      ? normalizeDebitoStatus(providerStatus(operation))
      : normalizePaymentStatus(operation.status);
    const updated = await database.query(
      "UPDATE pagar_operations SET pagar_operation_id = $1, status = $2 WHERE internal_id = $3 RETURNING *",
      [
         providerOperationId(operation) || null,
        (() => {
           if (isDebitoPay) return status || "RECONCILIATION_REQUIRED";
           return status && knownPaymentStates.has(status) ? status : "RECONCILIATION_REQUIRED";
        })(),
        input.localTransactionId,
      ],
    );
    return updated.rows[0] || inserted.rows[0];
  } catch (error) {
    if (isUncertainProviderError(error)) {
      const recovered = await database.query(
        "UPDATE pagar_operations SET status = 'RECONCILIATION_REQUIRED' WHERE internal_id = $1 RETURNING *",
        [input.localTransactionId],
      );
      return recovered.rows[0] || { ...inserted.rows[0], status: "RECONCILIATION_REQUIRED" };
    }
    await database.query("UPDATE pagar_operations SET status = 'FAILED' WHERE internal_id = $1", [input.localTransactionId]);
    throw error;
  }
}

export async function getPagarPayment(identifier: { id?: string; reference?: string }) {
  if (activeProvider() === "debitopay") {
    const paymentId = identifier.id || identifier.reference;
    if (!paymentId) {
      throw new Error("Identificador Debito Pay em falta.");
    }
    return request(
      "POST",
      "/payment-orchestrator",
      { action: "check-status", payment_id: paymentId },
    );
  }
  const endpoint = identifier.id
    ? `/payments/${encodeURIComponent(identifier.id)}`
    : `/payments/by-reference/${encodeURIComponent(identifier.reference || "")}`;
  return request("GET", endpoint);
}

export async function reconcilePagarPayment(localTransactionId: string) {
  const database = requirePool();
  const localResult = await database.query(
    `SELECT internal_id, pagar_operation_id, pagar_reference, amount_mzn, status
       FROM pagar_operations WHERE internal_id = $1`,
    [localTransactionId],
  );
  const local = localResult.rows[0];
  if (!local) {
    const error = new Error("Operação de pagamento não encontrada.");
    Object.assign(error, { status: 404 });
    throw error;
  }

  const data = await getPagarPayment({
    id: local.pagar_operation_id || undefined,
    reference: local.pagar_reference,
  });
  const operation = extractProviderOperation(data);
  const rawProviderStatus = providerStatus(operation);
  const normalizedProviderStatus = activeProvider() === "debitopay"
    ? normalizeDebitoStatus(rawProviderStatus)
    : normalizePaymentStatus(rawProviderStatus);
  if (!normalizedProviderStatus || (activeProvider() === "pagar" && !knownPaymentStates.has(normalizedProviderStatus))) {
    throw new Error(`O ${providerName()} devolveu um estado de pagamento desconhecido.`);
  }

  const operationId = providerOperationId(operation);
  const reference = providerReference(operation);
  if (local.pagar_operation_id && operationId && local.pagar_operation_id !== operationId) {
    throw new Error("A operação devolvida pelo Pagar não corresponde ao pagamento local.");
  }
  if (local.pagar_reference && reference && local.pagar_reference !== reference) {
    throw new Error("A referência devolvida pelo Pagar não corresponde ao pagamento local.");
  }
  const amount = providerAmount(operation);
  if (!providerAmountMatches(amount, local.amount_mzn)) {
    throw new Error(`O valor devolvido pelo ${providerName()} não corresponde ao pagamento local.`);
  }

  const receipt = (operation.receipt || {}) as Record<string, unknown>;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      "SELECT * FROM pagar_operations WHERE internal_id = $1 FOR UPDATE",
      [localTransactionId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      const error = new Error("Operação de pagamento não encontrada.");
      Object.assign(error, { status: 404 });
      throw error;
    }

    // PAID is monotonic: a late or inconsistent failure response must not
    // undo a payment that the provider already confirmed.
      const nextStatus = current.status === "PAID" && normalizedProviderStatus !== "PAID"
      ? "PAID"
       : normalizedProviderStatus;
    const updated = await client.query(
      `UPDATE pagar_operations
          SET status = $1,
              pagar_operation_id = COALESCE($2, pagar_operation_id),
              receipt_number = COALESCE($3, receipt_number),
              receipt_url = COALESCE($4, receipt_url),
              confirmed_at = CASE WHEN $1 = 'PAID' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END
        WHERE internal_id = $5
        RETURNING *`,
      [
        nextStatus,
        operationId || null,
        typeof receipt.number === "string" ? receipt.number : null,
        typeof receipt.url === "string" ? receipt.url : null,
        localTransactionId,
      ],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPagarPayments(query: { status?: string; cursor?: string; limit?: string }) {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", query.limit);
  return request("GET", `/payments?${params.toString()}`);
}

function parseWebhookSignature(value: string) {
  const parts = Object.fromEntries(value.split(",").map((part) => part.split("=", 2) as [string, string]));
  return { timestamp: parts.t, signature: parts.v1 };
}

export function verifyPagarWebhook(rawBody: Buffer, signatureHeader: string) {
  const secret = process.env.PAGAR_WEBHOOK_SECRET;
  if (!secret) return false;
  const { timestamp, signature } = parseWebhookSignature(signatureHeader);
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp || "") || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300 || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function timingSafeSignature(rawBody: Buffer, signatureHeader: string, secret: string) {
  const normalized = signatureHeader.trim().replace(/^sha256=/i, "").replace(/^v1=/i, "");
  if (!normalized) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const candidates = [
    Buffer.from(normalized, "hex"),
    Buffer.from(normalized, "base64"),
  ];
  return candidates.some((received) => received.length === expected.length && timingSafeEqual(received, expected));
}

export function verifyDebitoPayWebhook(rawBody: Buffer, signatureHeader: string) {
  const secret = process.env.DEBITO_WEBHOOK_SECRET;
  return Boolean(secret && timingSafeSignature(rawBody, signatureHeader, secret));
}

function debitoEventType(payload: Record<string, unknown>, operation: Record<string, unknown>) {
  const raw = payload.event ?? payload.type ?? operation.event ?? operation.type ?? operation.status;
  const event = typeof raw === "string" ? raw.toLowerCase() : "";
  if (event.includes("completed") || event.includes("succeeded") || event === "success" || event === "paid") return "payment.succeeded";
  if (event.includes("failed") || event.includes("declined") || event.includes("expired") || event.includes("cancelled") || event.includes("canceled") || event.includes("refunded") || event.includes("chargeback")) return "payment.failed";
  return "payment.pending";
}

export async function processDebitoPayWebhook(rawBody: Buffer) {
  const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  const operation = extractProviderOperation(payload);
  const eventType = debitoEventType(payload, operation);
  const eventId = [
    payload.event_id,
    payload.eventId,
    payload.id,
    operation.event_id,
    operation.eventId,
    providerOperationId(operation),
  ].find((value): value is string => typeof value === "string" && value.length > 0)
    || createHash("sha256").update(rawBody).digest("hex");
  const normalizedBody = {
    data: {
      id: providerOperationId(operation),
      reference: providerReference(operation),
      status: normalizeDebitoStatus(providerStatus(operation)) || providerStatus(operation),
      amountMzn: providerAmount(operation),
      receipt: operation.receipt,
    },
  };
  return processPagarWebhook(
    String(eventId),
    eventType,
    Buffer.from(JSON.stringify(normalizedBody)),
  );
}

interface PagarWebhookRow {
  event_id: string;
  event_type: string;
  operation_id?: string;
  reference?: string;
  payment_status?: string;
  forwarding_status: PagarWebhookForwardingStatus;
  forwarding_attempts: number;
  forwarding_last_error?: string;
  forwarding_next_retry_at?: Date | string;
  forwarding_updated_at?: Date | string;
}

export interface PagarWebhookEvent {
  eventId: string;
  eventType: string;
  operationId?: string;
  reference?: string;
  status?: string;
  forwardingStatus: PagarWebhookForwardingStatus;
  forwardingAttempts: number;
  forwardingLastError?: string;
  forwardingNextRetryAt?: string;
  forwardingUpdatedAt?: string;
}

function asIso(value: Date | string | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

function webhookEventFromRow(row: PagarWebhookRow): PagarWebhookEvent {
  const forwardingStatus = forwardingStatuses.has(row.forwarding_status)
    ? row.forwarding_status
    : "pending";
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    operationId: row.operation_id || undefined,
    reference: row.reference || undefined,
    status: row.payment_status || undefined,
    forwardingStatus,
    forwardingAttempts: Number(row.forwarding_attempts || 0),
    forwardingLastError: row.forwarding_last_error || undefined,
    forwardingNextRetryAt: asIso(row.forwarding_next_retry_at),
    forwardingUpdatedAt: asIso(row.forwarding_updated_at),
  };
}

function forwardingStatusFor(eventType: string, operationId?: string, reference?: string) {
  return forwardableEventTypes.has(eventType) && (operationId || reference) ? "pending" : "not_required";
}

export async function processPagarWebhook(eventId: string, eventType: string, rawBody: Buffer): Promise<PagarWebhookEvent & { duplicate: boolean }> {
  const database = requirePool();
  const payload = JSON.parse(rawBody.toString("utf8")) as { data?: Record<string, unknown> };
  const data = payload.data || {};
  const operationId = typeof data.id === "string" ? data.id : undefined;
  const reference = typeof data.reference === "string" ? data.reference : undefined;
  const status = typeof data.status === "string" ? data.status : undefined;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const eventInsert = await client.query(
      `INSERT INTO pagar_webhook_events
        (event_id, event_type, operation_id, reference, payment_status, forwarding_status, forwarding_next_retry_at)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6 = 'pending' THEN now() ELSE NULL END)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType, operationId || null, reference || null, status || null, forwardingStatusFor(eventType, operationId, reference)],
    );
    if (!eventInsert.rowCount) {
      const existing = await client.query(
        `SELECT event_id, event_type, operation_id, reference, payment_status,
                forwarding_status, forwarding_attempts, forwarding_last_error,
                forwarding_next_retry_at, forwarding_updated_at
           FROM pagar_webhook_events WHERE event_id = $1`,
        [eventId],
      );
      await client.query("COMMIT");
      return { ...webhookEventFromRow(existing.rows[0]), duplicate: true };
    }
    if (eventType === "payment.succeeded" || eventType === "payment.failed") {
      const current = await client.query(
        "SELECT * FROM pagar_operations WHERE pagar_operation_id = $1 OR pagar_reference = $2 FOR UPDATE",
        [operationId || "", reference || ""],
      );
      const local = current.rows[0];
      const eventAmount = typeof data.amountMzn === "number" ? data.amountMzn : undefined;
      const identifiersMatch = Boolean(local && (operationId || reference));
      const providerStatus = normalizePaymentStatus(status);
      const nextStatus = eventType === "payment.succeeded"
        ? "PAID"
        : eventType === "payment.failed" && (!providerStatus || ["FAILED", "CANCELLED", "REFUNDED"].includes(providerStatus))
          ? providerStatus || "FAILED"
          : undefined;
      if (local && identifiersMatch && nextStatus && providerAmountMatches(eventAmount, local.amount_mzn)) {
        const receipt = (data.receipt || {}) as Record<string, unknown>;
        await client.query(
          `UPDATE pagar_operations
              SET status = CASE WHEN status = 'PAID' AND $1 <> 'PAID' THEN status ELSE $1 END,
                  pagar_operation_id = COALESCE($2,pagar_operation_id),
                  receipt_number = COALESCE($3,receipt_number),
                  receipt_url = COALESCE($4,receipt_url),
                  confirmed_at = CASE WHEN $1 = 'PAID' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END
            WHERE internal_id = $5`,
          [nextStatus, operationId || null, typeof receipt.number === "string" ? receipt.number : null, typeof receipt.url === "string" ? receipt.url : null, local.internal_id],
        );
      }
    }
    await client.query("COMMIT");
    const inserted = await database.query(
      `SELECT event_id, event_type, operation_id, reference, payment_status,
              forwarding_status, forwarding_attempts, forwarding_last_error,
              forwarding_next_retry_at, forwarding_updated_at
         FROM pagar_webhook_events WHERE event_id = $1`,
      [eventId],
    );
    return { ...webhookEventFromRow(inserted.rows[0]), duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function retryDelayMs(attempts: number) {
  return Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

export async function forwardPagarWebhook(event: PagarWebhookEvent, options: { force?: boolean } = {}) {
  const database = requirePool();
  if (!forwardableEventTypes.has(event.eventType) || (!event.operationId && !event.reference)) {
    return event;
  }
  const client = await database.connect();
  const lockKey = `pagar-webhook-forward:${event.eventId}`;
  let lockAcquired = false;
  try {
    // The lock must live for the complete bridge request. A transaction lock
    // would be released before the network call and would not protect against
    // another worker reclaiming a stale forwarding attempt.
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    lockAcquired = true;

    const claimed = await client.query(
      `UPDATE pagar_webhook_events
          SET forwarding_status = 'forwarding',
              forwarding_attempts = forwarding_attempts + 1,
              forwarding_started_at = now(),
              forwarding_updated_at = now(),
              forwarding_last_error = NULL
        WHERE event_id = $1
          AND (
            (
              forwarding_status IN ('pending', 'failed')
              AND ($2 OR forwarding_next_retry_at IS NULL OR forwarding_next_retry_at <= now())
            )
            OR (
              forwarding_status = 'forwarding'
              AND forwarding_started_at < now() - interval '2 minutes'
            )
          )
        RETURNING forwarding_attempts`,
      [event.eventId, Boolean(options.force)],
    );
    if (!claimed.rowCount) return event;

    try {
      const bridgePort = process.env.PAGAR_BRIDGE_PORT || "8099";
      const controller = new AbortController();
      activeForwardingControllers.add(controller);
      try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/internal/pagar-event`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-payment-key": process.env.SESSION_SECRET || "" },
          body: JSON.stringify({
            eventId: event.eventId,
            eventType: event.eventType,
            operationId: event.operationId,
            reference: event.reference,
            status: event.status,
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) throw new Error(`Bridge recusou o encaminhamento (${response.status}).`);
        await client.query(
          `UPDATE pagar_webhook_events
              SET forwarding_status = 'delivered',
                  forwarding_last_error = NULL,
                  forwarding_next_retry_at = NULL,
                  forwarding_started_at = NULL,
                  forwarding_updated_at = now()
            WHERE event_id = $1 AND forwarding_status = 'forwarding'`,
          [event.eventId],
        );
      } finally {
        activeForwardingControllers.delete(controller);
      }
    } catch (error) {
      const attempts = Number(claimed.rows[0]?.forwarding_attempts || 1);
      const reason = error instanceof Error ? error.message : "Não foi possível contactar o bridge.";
      await client.query(
        `UPDATE pagar_webhook_events
            SET forwarding_status = 'failed',
                forwarding_last_error = $2,
                forwarding_next_retry_at = $3,
                forwarding_started_at = NULL,
                forwarding_updated_at = now()
          WHERE event_id = $1 AND forwarding_status = 'forwarding'`,
        [event.eventId, reason.slice(0, 500), new Date(Date.now() + retryDelayMs(attempts))],
      );
    }
    const current = await client.query(
      `SELECT event_id, event_type, operation_id, reference, payment_status,
              forwarding_status, forwarding_attempts, forwarding_last_error,
              forwarding_next_retry_at, forwarding_updated_at
         FROM pagar_webhook_events WHERE event_id = $1`,
      [event.eventId],
    );
    return current.rows[0] ? webhookEventFromRow(current.rows[0]) : event;
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      }
    } finally {
      client.release();
    }
  }
}

export async function getPagarWebhookEvent(eventId: string) {
  const database = requirePool();
  const result = await database.query(
    `SELECT event_id, event_type, operation_id, reference, payment_status,
            forwarding_status, forwarding_attempts, forwarding_last_error,
            forwarding_next_retry_at, forwarding_updated_at
       FROM pagar_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0] ? webhookEventFromRow(result.rows[0]) : undefined;
}

export async function listPagarWebhookEvents() {
  const database = requirePool();
  const result = await database.query(
    `SELECT event_id, event_type, operation_id, reference, payment_status,
            forwarding_status, forwarding_attempts, forwarding_last_error,
            forwarding_next_retry_at, forwarding_updated_at
       FROM pagar_webhook_events
      WHERE forwarding_status <> 'not_required'
      ORDER BY processed_at DESC
      LIMIT 200`,
  );
  return result.rows.map(webhookEventFromRow);
}

export async function retryPagarWebhookForwarding(eventId: string) {
  const database = requirePool();
  const event = await getPagarWebhookEvent(eventId);
  if (!event) throw new Error("Evento de pagamento não encontrado.");
  if (!forwardableEventTypes.has(event.eventType) || (!event.operationId && !event.reference)) {
    throw new Error("Este evento não pode ser encaminhado.");
  }
  await database.query(
    `UPDATE pagar_webhook_events
        SET forwarding_status = 'pending',
            forwarding_last_error = NULL,
            forwarding_next_retry_at = now(),
            forwarding_started_at = NULL,
            forwarding_updated_at = now()
      WHERE event_id = $1 AND forwarding_status <> 'delivered'`,
    [eventId],
  );
  const pending = await getPagarWebhookEvent(eventId);
  return pending ? forwardPagarWebhook(pending, { force: true }) : event;
}

interface ForwardingWorker {
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

let forwardingWorker: ForwardingWorker | undefined;
let forwardingRetryRunning = false;
const activeForwardingControllers = new Set<AbortController>();

function stopForwardingWorker(worker: ForwardingWorker | undefined) {
  const isCurrentWorker = !worker || forwardingWorker === worker;
  if (worker) {
    worker.stopped = true;
    if (worker.timer) clearInterval(worker.timer);
    if (forwardingWorker === worker) forwardingWorker = undefined;
  }

  if (!isCurrentWorker) return;
  for (const controller of activeForwardingControllers) {
    controller.abort();
  }
}

export function stopPagarWebhookRetryWorker() {
  stopForwardingWorker(forwardingWorker);
}

export function startPagarWebhookRetryWorker(intervalMs = 30_000) {
  if (forwardingWorker) {
    const worker = forwardingWorker;
    return () => stopForwardingWorker(worker);
  }
  const worker: ForwardingWorker = { stopped: false };
  forwardingWorker = worker;

  const run = async () => {
    if (worker.stopped) return;
    if (forwardingRetryRunning) return;
    forwardingRetryRunning = true;
    try {
      const due = await requirePool().query(
        `SELECT event_id, event_type, operation_id, reference, payment_status,
                forwarding_status, forwarding_attempts, forwarding_last_error,
                forwarding_next_retry_at, forwarding_updated_at
           FROM pagar_webhook_events
          WHERE (
            (
              forwarding_status IN ('pending', 'failed')
              AND (forwarding_next_retry_at IS NULL OR forwarding_next_retry_at <= now())
            )
            OR (
              forwarding_status = 'forwarding'
              AND forwarding_started_at < now() - interval '2 minutes'
            )
          )
          ORDER BY forwarding_next_retry_at NULLS FIRST, processed_at
          LIMIT 20`,
      );
      for (const row of due.rows) {
        if (worker.stopped) break;
        await forwardPagarWebhook(webhookEventFromRow(row));
      }
    } catch {
      // A later tick will retry after a transient database failure.
    } finally {
      forwardingRetryRunning = false;
    }
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  worker.timer = timer;
  return () => {
    stopForwardingWorker(worker);
  };
}

export function isTerminalPagarStatus(status: string) {
  return terminalStates.has(status);
}