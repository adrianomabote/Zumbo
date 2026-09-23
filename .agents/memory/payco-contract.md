---
name: Contrato Pay.co.mz
description: Contrato público do gateway Pay.co.mz e limites observados durante a validação sem guardar credenciais ou dados de clientes.
---

O Pay.co.mz usa `https://pay.co.mz/api/public/v1`, autenticação Bearer, `X-Merchant-Id`, `X-Wallet-Id` e `Idempotency-Key`. A cobrança é `POST /charges` com apenas os campos documentados (`amount`, `method`, `customer_name`, `customer_contact` e opcionalmente `wallet_id`). O método M-Pesa é `mpesa`; e-Mola ainda não está activo.

**Why:** A API não oferece sandbox; qualquer pedido de cobrança é potencialmente real. A leitura de cobranças sem dados pode responder 200 mesmo quando uma tentativa de cobrança responde `invalid_wallet`, por isso a carteira deve ser confirmada no painel e não inferida apenas do endpoint de leitura.

**How to apply:** Nunca testar `POST /charges` sem autorização explícita, chave de idempotência fixa e confirmação dos identificadores da conta. Webhooks usam `X-Pay-Event`, `X-Pay-Event-Id`, `X-Pay-Signature` e HMAC-SHA256 de `timestamp.raw_body`, com janela de cinco minutos.