---
name: Modo de oferta gratuita
description: Comportamento temporário aprovado para aceitar encomendas sem gateway
---

Quando `NET_SERVICOS_PAYMENT_MODE=free`, a loja aceita a encomenda sem chamar um gateway, marca-a como concluída e encaminha-a para a fila USSD com idempotência. A interface não deve pedir PIN nem afirmar que houve pagamento; pode confirmar a encomenda de forma neutra. O modo deve ser reversível para `live`.

**Why:** este modo foi aprovado para operação temporária sem pagamento real. O cliente precisa de uma confirmação simples, mas o produto não deve declarar um pagamento que não aconteceu.

**How to apply:** manter a entrega USSD, emails, histórico e protecção contra duplicação; não remover a validação de login, telefone, beneficiário ou pacote.

## Regra de experiência

No modo gratuito, a experiência deve manter todas as telas e transições do pagamento normal: abrir a tela de processamento, aguardar brevemente e mostrar a tela normal de conclusão. A única diferença é que a etapa de confirmação por PIN é concluída automaticamente. A conclusão visual não deve depender exclusivamente de SSE, porque o proxy pode não entregar o evento mesmo quando o backend já concluiu a encomenda.

**Why:** o utilizador precisa de ver exactamente o fluxo conhecido, sem ficar preso em “A processar” quando a encomenda gratuita já foi aceite.

**How to apply:** preservar os estados HTML/CSS de compra e recarga; em `free`, avançar automaticamente depois da resposta aceite do servidor e continuar a usar SSE para pagamentos reais.