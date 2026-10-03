---
name: Contrato MozPayment C2B e reconciliação
description: Regras para cobrança directa ao cliente e operações ambíguas sem consulta de estado.
---

## Fluxo confirmado

O utilizador confirmou C2B: o cliente paga directamente à loja através da API, sem checkout hospedado. Usar apenas os endpoints C2B documentados para receber M-Pesa/e-Mola. O corpo leva `carteira`, `numero`, `cliente` e `valor` em MZN como texto, sem autenticação. A documentação oficial em https://mozpayment.co.mz/documentacao diz que a API devolve HTTP 200 mesmo em falhas; interpretar `cod` no JSON, não o estado HTTP. A confirmação documentada usa `cod: 200`, `status: "success"` e `transacao`; `cod: 409` ou `401` são falhas.

**Why:** o utilizador quer receber pagamentos dos clientes directamente, não enviar dinheiro para eles nem encaminhá-los para checkout externo.

**How to apply:** manter o fluxo C2B, interpretar o JSON mesmo quando a resposta HTTP é 200 e nunca substituir por um fluxo B2C.

## Respostas ambíguas

A documentação não apresenta consulta de estado C2B, callback/webhook nem chave de idempotência. A “Área de Testes” envia pedidos ao servidor real; nunca a usar para testes. Um timeout ou resposta incompleta pode acontecer depois de a carteira do cliente ser debitada; não repetir cobranças automaticamente nem entregar o produto. Manter a encomenda pendente para confirmação manual. Só respostas terminais explícitas podem marcar a cobrança como paga ou falhada.

**Why:** repetir uma cobrança de resultado desconhecido pode debitar o cliente duas vezes.

**How to apply:** quando houver timeout, falha de comunicação ou resposta sem confirmação inequívoca, marcar revisão manual e não agendar novas tentativas.

## Reconciliação por provedor

Cada operação guarda o provedor que a criou; reconciliações têm de usar esse valor, não `PAYMENT_PROVIDER` actual. Uma operação Vpay antiga só pode ser inferida com segurança quando tem `checkout_url` guardado. Outros registos antigos sem provedor identificado exigem confirmação manual.

**Why:** mudar a configuração global não pode desviar cobranças pendentes para outro provedor, e classificações presumidas podem fazer uma consulta errada.

**How to apply:** persistir o provedor na criação, inferir Vpay legado apenas a partir de `checkout_url`, consultar por operação durante reconciliação e manter provedor desconhecido ou transacções MozPayment ambíguas fora de polling automático.