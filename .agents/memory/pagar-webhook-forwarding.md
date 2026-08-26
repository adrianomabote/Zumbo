---
name: Encaminhamento de webhooks Pagar
description: Regra de confiabilidade para confirmações Pagar encaminhadas ao bridge legado
---

O recebimento idempotente de um webhook e a entrega ao bridge são estados diferentes: o evento pode ser reconhecido uma única vez e continuar pendente de encaminhamento até ser entregue.

**Why:** confirmar o webhook antes de o bridge aceitar a mensagem pode deixar uma compra confirmada sem entrar no fluxo de entrega.

**How to apply:** alterações no processamento Pagar devem conservar o estado do encaminhamento, a próxima tentativa e o erro; repetições do mesmo evento devem reabrir apenas o encaminhamento pendente, nunca criar uma nova entrega USSD.

Para encaminhamentos Pagar, a reivindicação deve usar uma trava consultiva distribuída por `eventId` durante toda a chamada ao bridge; a recuperação de claims antigos deve passar pela mesma trava.

**Why:** dois workers podem observar um encaminhamento antigo enquanto a chamada original ainda está ativa; proteger apenas o UPDATE de claim permite duas chamadas ao bridge.

**How to apply:** não reabrir claims stale com um UPDATE separado da trava; selecionar esses eventos para o mesmo caminho de encaminhamento e revalidar o estado depois de adquirir a trava.