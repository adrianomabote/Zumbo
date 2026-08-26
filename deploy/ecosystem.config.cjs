// Configuração PM2 para o servidor Megabyte
// Correr: pm2 start deploy/ecosystem.config.cjs

const path = require("path");
const root = path.resolve(__dirname, "..");
const envFile = path.resolve(root, ".env");

// Carregar variáveis do ficheiro .env se existir
try {
  require("fs")
    .readFileSync(envFile, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    });
} catch {
  // .env não encontrado — usar apenas variáveis de ambiente do sistema
}

module.exports = {
  apps: [
    {
      name: "net-servicos-api",
      script: path.resolve(root, "artifacts/api-server/dist/index.mjs"),
      cwd: path.resolve(root, "artifacts/api-server"),
      interpreter: "node",
      interpreter_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT ?? "3004",
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        // Este ecosystem só é usado na VPS. O preview local mantém o modo mock
        // através do seu próprio comando, mas produção deve sempre chamar o Pagar live.
        NET_SERVICOS_PAYMENT_MODE: "live",
        PAGAR_API_BASE_URL:
          process.env.PAGAR_API_BASE_URL ?? "https://api.pagar.co.mz/api/v1",
        PAGAR_API_KEY: process.env.PAGAR_API_KEY ?? "",
        PAGAR_SIGNING_SECRET: process.env.PAGAR_SIGNING_SECRET ?? "",
        PAGAR_WEBHOOK_SECRET: process.env.PAGAR_WEBHOOK_SECRET ?? "",
        PAGAR_WEBHOOK_URL:
          process.env.PAGAR_WEBHOOK_URL ?? "https://megabyte.live/api/pagar/webhook",
        SESSION_SECRET: process.env.SESSION_SECRET ?? "",
        NET_SERVICOS_AGENT_PAIRING_CODE:
          process.env.NET_SERVICOS_AGENT_PAIRING_CODE ?? "00220022a1",
        SITE_URL: process.env.SITE_URL ?? "https://megabyte.live",
        ZUMBO_API_KEY: process.env.ZUMBO_API_KEY ?? "",
        ZUMBO_MERCHANT_ID: process.env.ZUMBO_MERCHANT_ID ?? "",
        ZUMBO_WEBHOOK_SECRET: process.env.ZUMBO_WEBHOOK_SECRET ?? "",
        WALLET_MPESA: process.env.WALLET_MPESA ?? "",
        WALLET_EMOLA: process.env.WALLET_EMOLA ?? "",
        ADMIN_PASS: process.env.ADMIN_PASS ?? "",
        GW_MASTER_KEY: process.env.GW_MASTER_KEY ?? "",
        GW_MASTER_SECRET: process.env.GW_MASTER_SECRET ?? "",
      },
      // Reiniciar automaticamente se o processo cair
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Logs
      out_file: path.resolve(root, "logs/api-out.log"),
      error_file: path.resolve(root, "logs/api-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
