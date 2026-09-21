import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import { proxyLegacyBridge, proxyLegacyBridgeWithPrefix } from "./legacy-bridge";
import pagarRouter from "./routes/pagar";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use("/api", (req, res, next) => {
  if (req.path === "/pagar/webhook") {
    return express.raw({ type: "application/json", limit: "256kb" })(req, res, next);
  }
  return next();
});
app.use("/api", (req, res, next) => {
  if (req.path === "/pagar/webhook") return pagarRouter(req, res, next);
  return next();
});
app.use("/api/legacy", proxyLegacyBridge);
// Keep the public gateway proxy before body parsers. The legacy bridge reads
// the raw request stream; parsing it here would leave the upstream request
// waiting forever for a body that was already consumed.
app.use("/gateway", proxyLegacyBridgeWithPrefix("/gateway"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Render can run the API and storefront as one web service. On the VPS Nginx
// still serves these files directly, so this is also safe there.
const frontendPublicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../net-servicos/dist/public");
app.use(express.static(frontendPublicDir, { index: false, redirect: false }));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/gateway/")) return next();
  res.sendFile(path.join(frontendPublicDir, "index.html"), (error) => {
    if (error) next();
  });
});

export default app;
