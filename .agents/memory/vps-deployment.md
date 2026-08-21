---
name: VPS e deployment Net Serviços
description: Configuração da VPS MozServe, portas, domínio e outros projectos co-hospedados
---

# VPS e deployment

## Servidor
- **IP:** 169.58.173.16
- **Fornecedor:** MozServe
- **OS:** Ubuntu

## Portas
- **80/443:** Nginx (site público net-servicos.online com SSL)
- **3004:** API Node.js (interna, PM2, nome: net-servicos-api)
- **3003:** porta alternativa Nginx (ainda activa no nginx.conf)

## Domínio
- **net-servicos.online** — SSL Let's Encrypt activo, renovação automática
- Certbot configurado com email mabotechando@gmail.com

## Outros projectos co-hospedados (não tocar)
- **molabet** (PM2) — porta 3001, domínio molabet.online, pasta /var/www/molabet
- **rainbet** (PM2) — porta 5000, domínio rainbet.co.mz, pasta /var/www/rainbet

**Why:** `pm2 delete all` matou estes processos durante o setup — usar sempre `pm2 restart net-servicos-api` e nunca `pm2 delete all`.

## Ficheiros de deployment
- `deploy/nginx.conf` — configuração Nginx
- `deploy/ecosystem.config.cjs` — configuração PM2
- `deploy/build-prod.sh` — script de build (usar NODE_ENV=development no install)

## Android APK
- Conta Expo: adrianomabote (mabotechando@gmail.com)
- Projecto EAS: net-servicos-ussd-agent (ID: 8160f9f3-1b3b-4b05-ab3c-a776f8246acf)
- API URL no app: https://net-servicos.online/api/ussd-agent
- Código de emparelhamento: 00220022a1 (hardcoded em delivery-queue.ts)
