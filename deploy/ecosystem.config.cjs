// Configuração PM2 para o servidor Net Serviços
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
        PORT: process.env.PORT ?? "3001",
        SESSION_SECRET: process.env.SESSION_SECRET ?? "",
        NET_SERVICOS_AGENT_PAIRING_CODE:
          process.env.NET_SERVICOS_AGENT_PAIRING_CODE ?? "00220022a1",
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
