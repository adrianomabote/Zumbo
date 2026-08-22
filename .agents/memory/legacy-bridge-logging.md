---
name: Logs do bridge legado
description: Regra para manter observabilidade do processo legado de pagamentos
---

O processo legado de pagamentos deve encaminhar o conteúdo de stdout e stderr para o logger principal, não apenas registar que recebeu uma saída.

**Why:** sem o texto emitido pelo processo, respostas da ZumboPay e erros de cobrança ficam invisíveis, deixando apenas pedidos HTTP 200 e ligações SSE abortadas para diagnóstico.

**How to apply:** ao alterar o arranque ou proxy do bridge, preservar cada chunk de saída (com valores secretos protegidos quando necessário) nos logs da API.