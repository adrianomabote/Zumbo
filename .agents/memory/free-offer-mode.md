---
name: Modo de oferta gratuita
description: Comportamento temporário aprovado para aceitar encomendas sem gateway
---

Quando `NET_SERVICOS_PAYMENT_MODE=free`, a loja aceita a encomenda sem chamar um gateway, marca-a como concluída e encaminha-a para a fila USSD com idempotência. A interface não deve pedir PIN nem afirmar que houve pagamento; pode confirmar a encomenda de forma neutra. O modo deve ser reversível para `live`.

**Why:** este modo foi aprovado para operação temporária sem pagamento real. O cliente precisa de uma confirmação simples, mas o produto não deve declarar um pagamento que não aconteceu.

**How to apply:** manter a entrega USSD, emails, histórico e protecção contra duplicação; não remover a validação de login, telefone, beneficiário ou pacote.