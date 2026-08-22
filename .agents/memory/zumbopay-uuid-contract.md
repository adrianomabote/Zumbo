---
name: Contrato ZumboPay
description: Formato dos identificadores exigidos pelo endpoint público de cobranças
---

O endpoint público de charges exige UUIDs válidos tanto para `wallet_id` como para `source_id`. Os números curtos exibidos no painel podem não ser os identificadores aceites pela API.

**Why:** A ZumboPay rejeitou pedidos com `Invalid uuid` até o bridge usar os UUIDs legados do fluxo que funcionava no Render.

**How to apply:** Antes de testar pagamentos, validar os dois campos como UUID sem expor os seus valores; preservar `source_id` UUID único por transacção e manter o mapeamento dos Wallet IDs no ambiente seguro.