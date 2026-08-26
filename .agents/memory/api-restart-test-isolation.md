---
name: Isolamento do teste de restart
description: Restrição de portas ao testar subprocessos da API no workspace
---

Testes que iniciam uma segunda API devem usar portas dinâmicas para os servidores sob teste e nunca esperar que a porta legada padrão esteja livre.

**Why:** o workflow normal da API mantém o bridge legado ativo na porta fixa, mesmo enquanto o teste inicia e encerra subprocessos independentes.

**How to apply:** isolar o bridge usado pelo teste em uma porta livre e validar a recuperação pelo banco e pela API de controle, não por uma suposição sobre a porta padrão.