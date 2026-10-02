---
name: Contrato MozPayment C2B
description: Limites documentados da API de recebimento e tratamento de resultados incertos.
---

Usar apenas os endpoints C2B documentados para receber M-Pesa/e-Mola. O corpo leva `carteira`, `numero`, `cliente` e `valor` em MZN como texto, sem autenticação. A documentação oficial em https://mozpayment.co.mz/documentacao diz que a API devolve HTTP 200 mesmo em falhas; interpretar `cod` no JSON, não o estado HTTP. A confirmação documentada usa `cod: 200`, `status: "success"` e `transacao`; `cod: 409` ou `401` são falhas.

A documentação não apresenta consulta de estado C2B, callback/webhook nem chave de idempotência. A “Área de Testes” envia pedidos ao servidor real; nunca a usar para testes. Sem meio de confirmar uma resposta perdida, não repetir cobranças automaticamente nem entregar o produto; deixar o caso para verificação manual. Não activar MozPayment sem configuração da carteira e autorização explícita para trocar o provedor activo.

**Why:** um timeout pode acontecer depois de a carteira do cliente ser debitada, e uma repetição pode cobrar duas vezes.

**How to apply:** manter respostas ambíguas em revisão manual, sem marcar como pagas ou falhadas; usar apenas respostas terminais explícitas para alterar o estado da encomenda.