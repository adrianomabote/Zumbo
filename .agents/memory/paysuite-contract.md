---
name: Contrato Paysuite
description: Regras externas da API Paysuite usadas para cobranças M-Pesa e e-Mola
---

A Paysuite usa `https://paysuite.tech/api/v1`, Bearer token, pagamentos em MZN e `POST /contacts` antes de `POST /payments` quando o telefone precisa de ser associado ao pedido via `contact_id`. O estado é consultado com `GET /payments/{id}`. Webhooks usam HMAC-SHA256 do corpo bruto no header `X-Signature`, com eventos `payment.success` e `payment.failed`.

**Why:** o endpoint de pagamentos não aceita o telefone directamente; ignorar o contacto produz pedidos incompletos ou checkout sem beneficiário.

**How to apply:** manter o telefone em formato E.164 no contacto, preservar o `payment_id` devolvido pela criação e deduplicar webhooks por evento e pagamento antes de entregar os megas.