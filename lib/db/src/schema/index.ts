import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const pagarOperations = pgTable("pagar_operations", {
  internalId: text("internal_id").primaryKey(),
  pagarOperationId: text("pagar_operation_id").unique(),
  pagarReference: text("pagar_reference").notNull().unique(),
  type: text("type").notNull(),
  amountMzn: integer("amount_mzn").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  sourceId: text("source_id").notNull().unique(),
  localTransactionId: text("local_transaction_id").notNull().unique(),
  title: text("title").notNull(),
  method: text("method").notNull(),
  payerPhone: text("payer_phone").notNull(),
  receiptNumber: text("receipt_number"),
  receiptUrl: text("receipt_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export const pagarWebhookEvents = pgTable("pagar_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});