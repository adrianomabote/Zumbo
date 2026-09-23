---
name: Modo de oferta gratuita
description: Comportamento temporário aprovado para aceitar encomendas sem gateway
---

Quando `NET_SERVICOS_PAYMENT_MODE=free`, a loja aceita a encomenda sem chamar um gateway, marca-a como concluída e encaminha-a para a fila USSD com idempotência. A interface deve identificar claramente a oferta como gratuita e o modo deve ser reversível para `live`.

**Why:** este modo foi aprovado para operação temporária sem pagamento real, mas não deve representar uma confirmação de pagamento que não aconteceu.

**How to apply:** manter a entrega USSD, emails, histórico e protecção contra duplicação; não remover a validação de login, telefone, beneficiário ou pacote.