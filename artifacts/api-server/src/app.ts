import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { proxyLegacyBridge } from "./legacy-bridge";
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
