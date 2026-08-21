# Guia de Instalação na VPS (MozServe)

Este guia cobre tudo: instalar o projecto na VPS, mantê-lo a correr, e configurar o telefone Android.

---

## O que vai correr onde

| Componente | Onde |
|---|---|
| **Site Net Serviços** (loja) | VPS → Nginx serve as páginas |
| **Servidor API** (pagamentos, fila USSD) | VPS → PM2 mantém o processo activo |
| **App Android** (agente USSD) | Telefone Vodacom → instalar APK |

---

## Passo 1 — Ligar à VPS via SSH

```bash
ssh root@SEU_IP_DA_VPS
```

Se a MozServe lhe deu um utilizador diferente de `root`, use esse.

---

## Passo 2 — Instalar Node.js, pnpm, PM2 e Nginx (só uma vez)

Copie e cole este bloco inteiro no terminal da VPS:

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# pnpm
npm install -g pnpm@9

# PM2 (mantém o servidor sempre activo)
npm install -g pm2

# Nginx (servidor web)
apt-get install -y nginx

echo "✅ Instalação concluída"
node --version && pnpm --version && pm2 --version && nginx -v
```

---

## Passo 3 — Copiar o projecto para a VPS

**No seu computador** (ou no Replit com o shell), comprima o projecto:

```bash
# No Replit shell:
cd /home/runner/workspace
tar --exclude='node_modules' --exclude='.git' --exclude='*/node_modules' \
    --exclude='*/dist' --exclude='deploy/nginx.conf' \
    -czf /tmp/net-servicos.tar.gz .
```

Depois envie para a VPS:
```bash
scp /tmp/net-servicos.tar.gz root@SEU_IP:/opt/
```

**Na VPS**, extraia:
```bash
mkdir -p /opt/net-servicos
tar -xzf /opt/net-servicos.tar.gz -C /opt/net-servicos
cd /opt/net-servicos
```

---

## Passo 4 — Configurar variáveis de ambiente

Na VPS, crie o ficheiro `.env`:

```bash
nano /opt/net-servicos/.env
```

Cole o seguinte, substituindo os valores:

```env
# Porta interna do servidor API (não mude)
PORT=3001
NODE_ENV=production

# Segredo de sessão — crie uma senha longa e aleatória (mínimo 32 caracteres)
SESSION_SECRET=SUBSTITUA_POR_UMA_SENHA_LONGA_E_ALEATORIA

# Código de emparelhamento do telefone Android (já definido no código)
NET_SERVICOS_AGENT_PAIRING_CODE=00220022a1
```

Guarde com `Ctrl+X` → `Y` → `Enter`.

---

## Passo 5 — Instalar dependências e compilar

```bash
cd /opt/net-servicos
bash deploy/build-prod.sh
```

Este script instala todos os pacotes e compila o site e o servidor. Demora 2–5 minutos.

---

## Passo 6 — Iniciar o servidor com PM2

```bash
cd /opt/net-servicos
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup  # siga as instruções que aparecem para iniciar no boot
```

Verificar que está a correr:
```bash
pm2 status
pm2 logs net-servicos-api --lines 20
```

---

## Passo 7 — Configurar o Nginx

Edite o ficheiro de configuração Nginx:
```bash
nano /opt/net-servicos/deploy/nginx.conf
```

Substitua `SEU_DOMINIO` pelo seu domínio real (ex: `netservicos.co.mz`) ou pelo IP da VPS.

Depois active a configuração:
```bash
cp /opt/net-servicos/deploy/nginx.conf /etc/nginx/sites-available/net-servicos
ln -sf /etc/nginx/sites-available/net-servicos /etc/nginx/sites-enabled/net-servicos
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

O site deve estar acessível em `http://SEU_DOMINIO`.

---

## Passo 8 — Configurar o telefone Android (agente USSD)

### 8.1 — Actualizar o domínio na app

**No Replit**, edite `artifacts/net-servicos-ussd-agent/.env`:

```env
EXPO_PUBLIC_DOMAIN=SEU_DOMINIO  # ex: netservicos.co.mz
```

### 8.2 — Gerar o APK (build para Android)

No Replit shell:
```bash
cd /home/runner/workspace/artifacts/net-servicos-ussd-agent
npx eas-cli build --platform android --profile preview --non-interactive
```

Isto gera um APK para instalar no telefone. Precisa de uma conta Expo (gratuita) em https://expo.dev.

### 8.3 — Instalar no telefone

1. Descarregar o APK gerado para o telefone
2. Activar "Instalar de fontes desconhecidas" nas Definições Android
3. Instalar o APK
4. Na app: inserir um nome (ex: "Vodacom USSD") e o código **`00220022a1`**
5. Carregar **Emparelhar** → o telefone está pronto

---

## Comandos úteis no dia-a-dia

```bash
# Ver estado do servidor
pm2 status

# Ver logs em tempo real
pm2 logs net-servicos-api

# Reiniciar após actualizações
cd /opt/net-servicos && bash deploy/build-prod.sh && pm2 restart net-servicos-api

# Testar se a API está a responder
curl http://localhost:3001/api/health
```

---

## Problemas comuns

| Problema | Solução |
|---|---|
| Site não abre | Verificar `pm2 status` e `nginx -t` |
| App não liga ao servidor | Confirmar `EXPO_PUBLIC_DOMAIN` correcto e sem `http://` |
| Emparelhamento recusado | Confirmar código `00220022a1` e que o servidor está activo |
| Servidor cai | `pm2 resurrect` ou `pm2 restart net-servicos-api` |
