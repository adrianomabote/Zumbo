import app from "./app";
import {
  startLegacyBridge,
  stopLegacyBridge,
  waitForLegacyBridge,
} from "./legacy-bridge";
import { logger } from "./lib/logger";
import { ensurePagarTables } from "./services/pagar";
import { hasDatabase } from "@workspace/db";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

process.on("SIGTERM", stopLegacyBridge);
process.on("SIGINT", stopLegacyBridge);
