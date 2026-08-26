import app from "./app";
import {
  startLegacyBridge,
  stopLegacyBridge,
  waitForLegacyBridge,
} from "./legacy-bridge";
import { logger } from "./lib/logger";
import { ensurePagarTables, startPagarWebhookRetryWorker } from "./services/pagar";
import { hasDatabase, pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

startLegacyBridge();
await waitForLegacyBridge();
if (hasDatabase) {
  await ensurePagarTables();
} else {
  logger.warn("PostgreSQL não configurado; pagamentos desactivados.");
}
const stopPagarWebhookRetryWorker = hasDatabase ? startPagarWebhookRetryWorker() : undefined;

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPagarWebhookRetryWorker?.();
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
