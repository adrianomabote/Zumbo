---
name: Proxy público do Gateway
description: Ordem necessária entre o proxy do bridge e os parsers Express
---

O alias público `/gateway` deve ser registado antes de `express.json()` e `express.urlencoded()`.

**Why:** o bridge legado lê o stream bruto do pedido. Se o parser Express consumir o corpo primeiro, o upstream fica à espera indefinidamente e os clientes externos não recebem resposta nem iniciam a cobrança.

**How to apply:** ao adicionar ou reorganizar middleware no API Server, mantenha os proxies que encaminham corpos brutos antes dos parsers; valide um POST com chave inválida para confirmar que responde imediatamente sem gerar uma cobrança.