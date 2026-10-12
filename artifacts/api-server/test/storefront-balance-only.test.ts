import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridgeScript = fileURLToPath(new URL("../legacy/zumbopay-bridge.js", import.meta.url));

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

test("storefront package checkout rejects direct mobile payments but keeps balance recharge", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "megabyte-balance-policy-"));
  const port = await availablePort();
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: dataDir,
    env: {
      ...process.env,
      PORT: String(port),
      NET_SERVICOS_DATA_DIR: dataDir,
      NET_SERVICOS_PAYMENT_MODE: "test",
      NODE_ENV: "development",
      DATABASE_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let started = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/ping`);
      if (response.ok) {
        started = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(started, true, `legacy bridge did not start: ${stderr}`);

  const order = await fetch(`${baseUrl}/api/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bundleId: "n01",
      phone: "841234567",
      paymentMethod: "mpesa",
    }),
  });
  assert.equal(order.status, 410);
  assert.match((await order.json()).error, /apenas com saldo/i);

  const recharge = await fetch(`${baseUrl}/api/recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: 25 }),
  });
  assert.equal(recharge.status, 401, "balance recharge route should remain available to authenticated users");
});
