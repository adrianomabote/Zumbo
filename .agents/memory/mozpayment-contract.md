---
name: Contrato MozPayment C2B e reconciliação
description: Regras para cobrança directa ao cliente e operações ambíguas sem consulta de estado.
---

## Fluxo confirmado

O utilizador confirmou C2B: o cliente paga directamente à loja através da API, sem checkout hospedado. Usar apenas os endpoints C2B documentados para receber M-Pesa/e-Mola. O corpo leva `carteira`, `numero`, `cliente` e `valor` em MZN como texto, sem autenticação. A documentação oficial em https://mozpayment.co.mz/documentacao diz que a API devolve HTTP 200 mesmo em falhas; interpretar `cod` no JSON, não o estado HTTP. A confirmação documentada usa `cod: 200`, `status: "success"` e `transacao`; `cod: 409` ou `401` são falhas.

**Why:** o utilizador quer receber pagamentos dos clientes directamente, não enviar dinheiro para eles nem encaminhá-los para checkout externo.

**How to apply:** manter o fluxo C2B, interpretar o JSON mesmo quando a resposta HTTP é 200 e nunca substituir por um fluxo B2C.

## Resultados e estado pendente

A documentação pública não descreve consulta de estado C2B, payload/autenticação de callback nem chave de idempotência. O utilizador confirmou que o painel MozPayment permite registar webhook e seleccionar `PAID`, `FAILED` e `EXPIRED`; isso confirma a configuração, não o contrato de entrega. A resposta explícita `cod: 200`, `status: "success"` e `transacao` é processada automaticamente; códigos documentados de falha também. Um timeout ou resposta incompleta não prova que a carteira ficou intacta. Não transformar uma resposta ambígua em `PAID` sem confirmação do provedor. A “Área de Testes” envia pedidos ao servidor real; nunca a usar para testes.

**Why:** o painel confirma que webhooks existem, mas payload e autenticação continuam sem documentação pública; aceitar campos ou callbacks não verificados pode entregar megas sem pagamento confirmado.

**How to apply:** manter a mensagem PIN original no ecrã do cliente; só processar callbacks com autenticação válida, uma cobrança MozPayment correspondente e valor exacto. Confirmar o payload e a autenticação por uma entrega de teste/histórico do painel antes de depender do webhook em produção. Nunca marcar como pago nem criar nova cobrança para respostas ambíguas.

## Valor mínimo e mensagem do PIN

As ofertas da loja começam em 10 MT, por isso a validação MozPayment tem de aceitar esse valor. O checkout mantém a mensagem antiga: “Confirme a ativação da oferta introduzindo o PIN ... no seu telemóvel”. Não a substituir por uma mensagem de notificação diferente.

**Why:** o utilizador pediu manter a mensagem anterior; um mínimo genérico de 20 MT rejeitava os pacotes de 10, 13 e 17 MT antes da chamada ao provedor.

**How to apply:** manter o mínimo C2B alinhado ao preço mais baixo publicado e preservar a mensagem PIN acordada.

## Identificação da cobrança

O nome/descrição visível no painel MozPayment deve ser exactamente `Recarga [valor] MT`, nunca `Cliente Megabyte`. O valor apresentado tem de ser o mesmo montante exacto cobrado pelo pacote ou recarga.

**Why:** o utilizador pediu que cada cobrança seja identificável pelo montante realmente pago.

**How to apply:** gerar o rótulo a partir do valor validado da cobrança em todos os fluxos MozPayment, incluindo compras do Gateway.

## Carteira C2B versus credencial B2C

O utilizador esclareceu que o valor anteriormente configurado como `MOZPAYMENT_WALLET_ID` era uma secret key B2C, não o ID de carteira C2B. Não reutilizar credenciais B2C no campo `carteira` dos pedidos C2B. O ID C2B correcto deve ser substituído através do fluxo seguro de Secrets, em todos os ambientes usados.

**Why:** C2B e B2C têm credenciais e funções distintas; a cobrança directa C2B exige o identificador da carteira C2B.

**How to apply:** confirmar que `MOZPAYMENT_WALLET_ID` contém o ID de carteira C2B e nunca ler, copiar ou registar a secret key B2C em memória ou no chat.

## Reconciliação por provedor

Cada operação guarda o provedor que a criou; reconciliações têm de usar esse valor, não `PAYMENT_PROVIDER` actual. Uma operação Vpay antiga só pode ser inferida com segurança quando tem `checkout_url` guardado. Outros registos antigos sem provedor identificado exigem confirmação manual.

**Why:** mudar a configuração global não pode desviar cobranças pendentes para outro provedor, e classificações presumidas podem fazer uma consulta errada.

**How to apply:** persistir o provedor na criação, inferir Vpay legado apenas a partir de `checkout_url`, consultar por operação durante reconciliação e manter provedor desconhecido ou transacções MozPayment ambíguas fora de polling automático.