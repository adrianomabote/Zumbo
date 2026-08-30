---
name: Reconciliação de pagamentos Pagar
description: Regra para evitar falsos falhanços quando a confirmação do Pagar atrasa ou a resposta de criação se perde
---

Uma falha de comunicação durante a criação ou após o PIN não é prova de pagamento recusado. A cobrança deve permanecer recuperável e ser consultada novamente por ID ou referência; só um estado terminal explícito do Pagar pode marcar o pagamento como falhado.

**Why:** o Pagar pode aceitar a cobrança e actualizar o saldo mesmo quando a resposta HTTP ou o webhook chega atrasado, o que anteriormente deixava o painel local em aguardando e depois falhado.

**How to apply:** manter PAID monotónico contra eventos tardios inconsistentes, reconciliar operações pendentes após reinícios e manter a entrega USSD idempotente; nunca transformar timeout local em crédito ou em falha terminal.