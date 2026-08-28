import { spawn, type ChildProcess } from "node:child_process";
import { request as requestToLegacy } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Request, Response } from "express";
import { logger } from "./lib/logger";

const configuredLegacyPort = process.env.LEGACY_BRIDGE_PORT || "8099";
const legacyPort = Number(configuredLegacyPort);

if (!Number.isInteger(legacyPort) || legacyPort <= 0 || legacyPort > 65_535) {
  throw new Error(`Invalid LEGACY_BRIDGE_PORT value: "${configuredLegacyPort}"`);
}
let legacyProcess: ChildProcess | undefined;

function legacyDirectory() {
  const bundledEntry = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(bundledEntry), "../legacy");
}

function rewriteLegacyHtml(html: string) {
  return html
    .replace(
      /(["'])\/(api|events|admin|gateway|static)(?=\/)/g,
      "$1/api/legacy/$2",
    )
    .replace(
      /(["'])\/(pacotes-diarios|pacotes-semanais|pacotes-mensais|pacotes-diamante|pacotes-internet-vodacom|comprar-megas-online|comprar-megas-para-outra-pessoa|pagar-megas-mpesa-emola|megas-baratos-vodacom)(?=["'#?])/g,
      "$1/api/legacy/$2",
    )
    .replace(/(["'])\/(megas)(?=["'])/g, "$1/api/legacy/$2")
    .replace(/(["'])\/(manifest\.json|sw\.js)(?=["'])/g, "$1/api/legacy/$2");
}

function rewriteResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const nextHeaders = { ...headers };
  const location = nextHeaders.location;

  if (typeof location === "string" && location.startsWith("/")) {
    nextHeaders.location = `/api/legacy${location}`;
  }

  const setCookie = nextHeaders["set-cookie"];
  if (Array.isArray(setCookie)) {
    nextHeaders["set-cookie"] = setCookie.map((cookie) =>
      cookie.replace(/;\s*Path=\//i, "; Path=/api/legacy"),
    );
  }

  return nextHeaders;
}

export function startLegacyBridge() {
  if (legacyProcess && !legacyProcess.killed) {
    return;
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(legacyPort),
    MAIN_API_PORT: process.env["PORT"] ?? "",
  };
  delete childEnv.DATABASE_URL;

  legacyProcess = spawn(process.execPath, ["zumbopay-bridge.js"], {
    cwd: legacyDirectory(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  legacyProcess.stdout?.on("data", (chunk: Buffer) => {
    const output = chunk.toString().trim();
    if (output) {
      logger.info({ legacyOutput: output }, "Legacy bridge output");
    }
  });
  legacyProcess.stderr?.on("data", (chunk: Buffer) => {
    const output = chunk.toString().trim();
    if (output) {
      logger.error({ legacyError: output }, "Legacy bridge error");
    }
  });
  legacyProcess.on("exit", (code, signal) => {
    logger.warn({ code, signal }, "Legacy bridge stopped");
    legacyProcess = undefined;
  });
}

export function stopLegacyBridge() {
  const processToStop = legacyProcess;
  legacyProcess = undefined;
  processToStop?.kill("SIGTERM");
}

export async function waitForLegacyBridge(timeoutMs = 10_000) {
  const startedAt = Date.now();

  return new Promise<void>((resolve, reject) => {
    const check = () => {
      const probe = requestToLegacy(
        {
          hostname: "127.0.0.1",
          port: legacyPort,
          path: "/ping",
          method: "GET",
        },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            resolve();
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error("Legacy bridge did not become ready in time."));
            return;
          }
          setTimeout(check, 100);
        },
      );

      probe.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Legacy bridge did not become ready in time."));
          return;
        }
        setTimeout(check, 100);
      });
      probe.end();
    };

    check();
  });
}

export function proxyLegacyBridge(req: Request, res: Response) {
  const upstream = requestToLegacy(
    {
      hostname: "127.0.0.1",
      port: legacyPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${legacyPort}`,
      },
    },
    (upstreamResponse) => {
      const headers = rewriteResponseHeaders(upstreamResponse.headers);
      const contentType = String(headers["content-type"] || "");

      if (!contentType.includes("text/html")) {
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const body = rewriteLegacyHtml(Buffer.concat(chunks).toString("utf8"));
        delete headers["content-length"];
        res.writeHead(upstreamResponse.statusCode ?? 502, headers);
        res.end(body);
      });
    },
  );

  upstream.on("error", (error) => {
    req.log.error({ err: error }, "Legacy bridge is unavailable");
    res.status(502).json({ error: "O serviço Megabyte está a iniciar." });
  });

  req.pipe(upstream);
}