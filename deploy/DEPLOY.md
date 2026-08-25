# Guia de Instalação na VPS (multi-projecto)

## Portas usadas por este projecto

| Serviço | Porta | Quem acede |
|---|---|---|
| Nginx (site público) | **80/443/3003** | Internet |
| API Node.js | **3004** | Só interno — o Nginx encaminha para cá |
| Legacy bridge | **8099** | Só interno — iniciado automaticamente pela API |

A porta 3004 **não fica exposta** — o Nginx nas portas 80, 443 e 3003 encaminha
as requisições para ela.

---

## Pré-requisitos (verificar se já estão instalados)

```bash
node --version     # precisa de v18 ou superior
pnpm --version     # precisa de v8 ou superior
pm2 --version      # process manager
nginx -v           # servidor web
```

Se algum faltar:
```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# pnpm
npm install -g pnpm@9

# PM2
npm install -g pm2

# Nginx
apt-get install -y nginx
```

---

## Passo 1 — Copiar o projecto para a VPS

**Opção A — via Git (recomendado se tiver repositório):**
```bash
cd /opt
git clone URL_DO_SEU_REPO net-servicos
cd net-servicos
```

**Opção B — via compressão (do Replit para a VPS):**

No terminal do Replit:
```bash
cd /home/runner/workspace
tar --exclude='node_modules' --exclude='.git' \
    --exclude='*/node_modules' --exclude='*/dist' \
    -czf /tmp/net-servicos.tar.gz .
```

Enviar para a VPS:
```bash
scp /tmp/net-servicos.tar.gz utilizador@IP_DA_VPS:/opt/
```

Na VPS:
```bash
mkdir -p /opt/net-servicos
tar -xzf /opt/net-servicos.tar.gz -C /opt/net-servicos
cd /opt/net-servicos
```

---

## Passo 2 — Criar o ficheiro de variáveis de ambiente

```bash
nano /opt/net-servicos/.env
```

Colar isto (substituir `SESSION_SECRET` por uma senha longa):

```env
PORT=3004
NODE_ENV=production
NET_SERVICOS_PAYMENT_MODE=live
SITE_URL=https://net-servicos.online
SESSION_SECRET=COLOQUE_AQUI_UMA_SENHA_LONGA_E_ALEATORIA_MINIMO_32_CHARS
NET_SERVICOS_AGENT_PAIRING_CODE=00220022a1
PAGAR_API_BASE_URL=https://api.pagar.co.mz/api/v1
PAGAR_WEBHOOK_URL=https://net-servicos.online/api/pagar/webhook
PAGAR_API_KEY=sk_live_xxx
PAGAR_SIGNING_SECRET=sig_live_xxx
PAGAR_WEBHOOK_SECRET=whsec_live_xxx
```

Guardar: `Ctrl+X` → `Y` → `Enter`

> Na preview da Replit, o servidor usa automaticamente `mock` quando
> `NODE_ENV` não é `production`; os pagamentos são simulados e não movimentam
> dinheiro. Na VPS, mantenha `NET_SERVICOS_PAYMENT_MODE=live` e configure as
> credenciais reais apenas no `.env`.

O `.env` fica no VPS e não deve ser adicionado ao Git. O ficheiro `.env.example`
na raiz do projeto serve apenas como modelo sem credenciais.

---

## Passo 3 — Compilar o projecto

```bash
cd /opt/net-servicos
bash deploy/build-prod.sh
```

Demora 2–5 minutos. No final deve ver:
```
✅ Build concluído.
   API:  artifacts/api-server/dist/index.mjs
   Site: artifacts/net-servicos/dist/public/
```

---

## Passo 4 — Iniciar o servidor com PM2

```bash
cd /opt/net-servicos
pm2 start deploy/ecosystem.config.cjs
```

Verificar que está activo:
```bash
pm2 status
# Deve aparecer: net-servicos-api | online
```

Ver logs:
```bash
pm2 logs net-servicos-api --lines 30
```

Activar arranque automático com o sistema:
```bash
pm2 save
pm2 startup
# Copiar e correr o comando que aparecer no ecrã
```

---

## Passo 5 — Configurar o Nginx

**5.1 — Activar a configuração deste projecto:**
```bash
cp /opt/net-servicos/deploy/nginx.conf /etc/nginx/sites-available/net-servicos
ln -sf /etc/nginx/sites-available/net-servicos /etc/nginx/sites-enabled/net-servicos
```

**5.2 — Verificar e recarregar:**
```bash
nginx -t
# Deve dizer: syntax is ok / test is successful

systemctl reload nginx
```

**5.3 — Testar:**
```bash
# Testar API internamente
curl http://localhost:3004/api/healthz

# Testar site pela porta pública usada pelo projeto
curl http://localhost:3003
```

O site fica acessível em: `http://IP_DA_VPS:3003`

---

## Passo 6 — Configurar o telefone Android (agente USSD)

### 6.1 — Definir o endereço do servidor na app

No Replit, edite `artifacts/net-servicos-ussd-agent/.env`:
```env
EXPO_PUBLIC_DOMAIN=IP_DA_VPS:7000
```
Exemplo: `EXPO_PUBLIC_DOMAIN=196.28.1.100:7000`

### 6.2 — Gerar o APK

No terminal do Replit:
```bash
cd artifacts/net-servicos-ussd-agent

# Instalar EAS CLI (uma vez)
npm install -g eas-cli

# Login na conta Expo (gratuita em https://expo.dev)
eas login

# Gerar APK
eas build --platform android --profile preview --non-interactive
```

### 6.3 — Instalar no telefone

1. Descarregar o APK para o telefone
2. No Android: **Definições → Segurança → Instalar apps desconhecidas** → activar
3. Instalar o APK
4. Na app: nome do dispositivo (ex: "Vodacom USSD") + código **`00220022a1`**
5. Carregar **Emparelhar**

---

## Comandos do dia-a-dia

```bash
# Ver estado
pm2 status

# Logs em tempo real
pm2 logs net-servicos-api

# Actualizar depois de mudanças no código
cd /opt/net-servicos
git pull                          # se usar Git
bash deploy/build-prod.sh
pm2 reload deploy/ecosystem.config.cjs --update-env

# Reiniciar Nginx
systemctl reload nginx
```

---

## Verificação final

```bash
# 1. PM2 está online?
pm2 status | grep net-servicos-api

# 2. API responde?
curl -s http://localhost:3004/api/healthz

# 3. Site abre?
curl -s http://localhost:3003 | head -5

# 4. Porta 3003 está aberta no firewall?
ufw status | grep 3003
# Se não estiver: ufw allow 3003/tcp
```
