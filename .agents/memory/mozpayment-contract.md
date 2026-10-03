---
name: Escopo MozPayment e contrato C2B
description: O pedido actual é B2C, mas os endpoints públicos verificados são C2B.
---

## Requisito actual

O utilizador esclareceu que pretende B2C — a empresa envia dinheiro para a carteira do cliente — e não C2B. Não activar nem usar os endpoints `pagamentorotativo...` como solução, porque esse fluxo cobra o cliente. A documentação pública consultada não descreve um endpoint B2C. Para avançar, exigir o contrato oficial de pagamentos de saída: endpoint, autenticação, payload, significado dos estados, consulta/reconciliação e protecção contra duplicados. O `MOZPAYMENT_WALLET_ID` guardado para C2B não deve ser presumido como credencial B2C.

**Why:** trocar o sentido do fluxo pode cobrar clientes quando a intenção era pagar-lhes.

**How to apply:** manter o provedor actual e não enviar chamadas B2C até a MozPayment fornecer o contrato oficial; nunca usar credenciais sem saber se são IDs públicos ou segredos.

Usar apenas os endpoints C2B documentados para receber M-Pesa/e-Mola. O corpo leva `carteira`, `numero`, `cliente` e `valor` em MZN como texto, sem autenticação. A documentação oficial em https://mozpayment.co.mz/documentacao diz que a API devolve HTTP 200 mesmo em falhas; interpretar `cod` no JSON, não o estado HTTP. A confirmação documentada usa `cod: 200`, `status: "success"` e `transacao`; `cod: 409` ou `401` são falhas.

A documentação não apresenta consulta de estado C2B, callback/webhook nem chave de idempotência. A “Área de Testes” envia pedidos ao servidor real; nunca a usar para testes. Sem meio de confirmar uma resposta perdida, não repetir cobranças automaticamente nem entregar o produto; deixar o caso para verificação manual. Só considerar estes endpoints se o utilizador mudar explicitamente o requisito para C2B.

**Why:** um timeout pode acontecer depois de a carteira do cliente ser debitada, e uma repetição pode cobrar duas vezes.

**How to apply:** manter respostas ambíguas em revisão manual, sem marcar como pagas ou falhadas; usar apenas respostas terminais explícitas para alterar o estado da encomenda.