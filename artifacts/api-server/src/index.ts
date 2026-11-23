import { randomBytes } from "node:crypto";
import app from "./app";
import {
  startLegacyBridge,
  stopLegacyBridge,
  waitForLegacyBridge,
} from "./legacy-bridge";
import { logger } from "./lib/logger";
import {
  ensurePagarTables,
  startPagarWebhookRetryWorker,
  stopPagarWebhookRetryWorker,
} from "./services/pagar";
import { hasDatabase, pool } from "@workspace/db";

const rawPort = process.env["PORT"] || "3000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (!process.env.SESSION_SECRET?.trim()) {
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  logger.warn("SESSION_SECRET não definido no ambiente; a usar segredo interno gerado para esta execução.");
}

startLegacyBridge();
await waitForLegacyBridge();
await ensurePagarTables();
if (!hasDatabase) {
  logger.warn("PostgreSQL não configurado; a usar armazenamento local para pagamentos.");
}
startPagarWebhookRetryWorker();

const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Cancels an in-flight bridge request before closing the remaining services.
  stopPagarWebhookRetryWorker();
  stopLegacyBridge();
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error closing server");
    }
    void pool?.end().catch((poolError) => {
      logger.error({ err: poolError }, "Error closing database pool");
    });
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
