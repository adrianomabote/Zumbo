---
name: Encaminhamento de webhooks Pagar
description: Regra de confiabilidade para confirmações Pagar encaminhadas ao bridge legado
---

O recebimento idempotente de um webhook e a entrega ao bridge são estados diferentes: o evento pode ser reconhecido uma única vez e continuar pendente de encaminhamento até ser entregue.

**Why:** confirmar o webhook antes de o bridge aceitar a mensagem pode deixar uma compra confirmada sem entrar no fluxo de entrega.

**How to apply:** alterações no processamento Pagar devem conservar o estado do encaminhamento, a próxima tentativa e o erro; repetições do mesmo evento devem reabrir apenas o encaminhamento pendente, nunca criar uma nova entrega USSD.