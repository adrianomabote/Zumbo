# ZumboPay Bridge

Servidor autónomo que recebe webhooks do ZumboPay e os reenvia (relay) para o MolaBet.

## Como correr

```
npm start
```

O servidor inicia na porta 5000. O dashboard está disponível na URL pública do Replit.

## Variáveis de ambiente (Secrets)

| Variável | Descrição | Default |
|---|---|---|
| `ZUMBO_WEBHOOK_SECRET` | Secret HMAC do ZumboPay | `teste.com` |
| `ZUMBO_API_KEY` | API Key do ZumboPay | valor hardcoded |
| `ZUMBO_MERCHANT_ID` | Merchant ID do ZumboPay | `MCH_B29C53549C` |
| `MOLABET_URL` | URL base do MolaBet (ex: `https://molabet.replit.app`) | vazio — relay desactivado |
| `BRIDGE_PASSWORD` | Senha para aceder ao dashboard | `admin` |
| `PORT` | Porta do servidor | `5000` |

## URL do webhook a registar no ZumboPay

```
https://<domínio-deste-repl>/webhook
```

Painel ZumboPay → Programadores → Webhooks → adicionar esta URL.

## Endpoints

- `GET /` — Dashboard em tempo real
- `POST /webhook` — Recebe webhooks do ZumboPay (registar este URL no ZumboPay)
- `GET /events` — SSE para actualizações em tempo real
- `GET /api/webhooks?password=<senha>` — API JSON com histórico
- `GET /ping` — Health check
