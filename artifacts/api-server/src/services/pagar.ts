import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";

const DEFAULT_BASE_URL = "https://api.pagar.co.mz/api/v1";
const terminalStates = new Set(["PAID", "FAILED", "CANCELLED", "REFUNDED"]);

export type PagarMethod = "MPESA" | "EMOLA";

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
  const apiKey = process.env.PAGAR_API_KEY;
  const signingSecret = process.env.PAGAR_SIGNING_SECRET;
  if (!apiKey || !signingSecret) {
    throw new Error("Pagar API não está configurada no servidor.");
  }
  return {
    baseUrl: process.env.PAGAR_API_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
    signingSecret,
  };
}

function safeMessage(status: number, data: unknown) {
  const body = data as { safeMessage?: unknown; error?: unknown; requestId?: unknown };
  const message = typeof body?.safeMessage === "string" ? body.safeMessage : "Pedido Pagar recusado.";
  return { message, requestId: typeof body?.requestId === "string" ? body.requestId : undefined, error: typeof body?.error === "string" ? body.error : undefined, status };
}

async function parseResponse(response: Response) {
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = safeMessage(response.status, data);
    const error = new Error(failure.message);
    Object.assign(error, failure);
    throw error;
  }
  return data as Record<string, unknown>;
}

async function request(method: "GET" | "POST", endpoint: string, body?: Record<string, unknown>, idempotencyKey?: string) {
  const { baseUrl, apiKey, signingSecret } = config();
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${endpoint}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (rawBody !== undefined) {
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
  const valid = input.method === "MPESA" ? /^(84|85)\d{7}$/.test(local) : /^86\d{7}$/.test(local);
  if (!valid) throw new Error("O telefone não corresponde ao método de pagamento.");
}

export async function ensurePagarTables() {
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
      processed_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function createPagarPayment(input: PagarPaymentInput) {
  validateInput(input);
  const existing = await pool.query(
    "SELECT internal_id, pagar_operation_id, pagar_reference, amount_mzn, status FROM pagar_operations WHERE local_transaction_id = $1 OR idempotency_key = $2",
    [input.localTransactionId, input.idempotencyKey],
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    `INSERT INTO pagar_operations (internal_id, pagar_reference, type, amount_mzn, status, idempotency_key, source_id, local_transaction_id, title, method, payer_phone)
     VALUES ($1,$2,'payment',$3,'PENDING',$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.localTransactionId, input.reference, input.amountMzn, input.idempotencyKey, input.sourceId, input.localTransactionId, input.title, input.method, input.payerPhone],
  );
  const body = {
    reference: input.reference,
    title: input.title,
    description: input.description,
    amountMzn: input.amountMzn,
    method: input.method,
    payerPhone: input.payerPhone,
  };
  try {
    const data = await request("POST", "/payments", body, input.idempotencyKey);
    const operation = (data.payment || data) as Record<string, unknown>;
    const updated = await pool.query(
      "UPDATE pagar_operations SET pagar_operation_id = $1, status = $2 WHERE internal_id = $3 RETURNING *",
      [String(operation.id || ""), String(operation.status || "PENDING"), input.localTransactionId],
    );
    return updated.rows[0] || inserted.rows[0];
  } catch (error) {
    await pool.query("UPDATE pagar_operations SET status = 'FAILED' WHERE internal_id = $1", [input.localTransactionId]);
    throw error;
  }
}

export async function getPagarPayment(identifier: { id?: string; reference?: string }) {
  const endpoint = identifier.id
    ? `/payments/${encodeURIComponent(identifier.id)}`
    : `/payments/by-reference/${encodeURIComponent(identifier.reference || "")}`;
  return request("GET", endpoint);
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

export async function processPagarWebhook(eventId: string, eventType: string, rawBody: Buffer) {
  const payload = JSON.parse(rawBody.toString("utf8")) as { data?: Record<string, unknown> };
  const data = payload.data || {};
  const operationId = typeof data.id === "string" ? data.id : undefined;
  const reference = typeof data.reference === "string" ? data.reference : undefined;
  const status = typeof data.status === "string" ? data.status : undefined;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventInsert = await client.query(
      "INSERT INTO pagar_webhook_events (event_id, event_type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [eventId, eventType],
    );
    if (!eventInsert.rowCount) {
      await client.query("COMMIT");
      return { duplicate: true };
    }
    if (eventType === "payment.succeeded" || eventType === "payment.failed") {
      const current = await client.query(
        "SELECT * FROM pagar_operations WHERE pagar_operation_id = $1 OR pagar_reference = $2 FOR UPDATE",
        [operationId || "", reference || ""],
      );
      const local = current.rows[0];
      if (local && status && ["PAID", "FAILED", "CANCELLED", "REFUNDED", "PENDING", "PROCESSING", "RECONCILIATION_REQUIRED"].includes(status)) {
        const nextStatus = eventType === "payment.succeeded" ? "PAID" : status;
        const receipt = (data.receipt || {}) as Record<string, unknown>;
        await client.query(
          "UPDATE pagar_operations SET status = $1, pagar_operation_id = COALESCE($2,pagar_operation_id), receipt_number = COALESCE($3,receipt_number), receipt_url = COALESCE($4,receipt_url), confirmed_at = CASE WHEN $1 = 'PAID' THEN now() ELSE confirmed_at END WHERE internal_id = $5",
          [nextStatus, operationId || null, typeof receipt.number === "string" ? receipt.number : null, typeof receipt.url === "string" ? receipt.url : null, local.internal_id],
        );
      }
    }
    await client.query("COMMIT");
    return { duplicate: false, operationId, reference, status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function isTerminalPagarStatus(status: string) {
  return terminalStates.has(status);
}