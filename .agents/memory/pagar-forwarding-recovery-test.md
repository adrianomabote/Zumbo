---
name: Teste de recuperação Pagar
description: Princípio para testar a recuperação de encaminhamentos Pagar quando o bridge legado fica indisponível
---

Um teste de recuperação deve derrubar o bridge real durante um webhook confirmado, verificar a falha persistida com próxima tentativa e depois repetir o mesmo evento após o restart.

**Why:** o reconhecimento idempotente do webhook e a entrega ao bridge são etapas independentes; só uma repetição bem-sucedida prova que a confirmação não foi perdida nem duplicada.

**How to apply:** manter a asserção de uma única entrega USSD pelo `paymentId` após o encaminhamento recuperado, além dos campos de tentativa e erro do evento.