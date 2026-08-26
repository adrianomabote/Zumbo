---
name: Isolamento do teste de restart
description: Restrição de portas ao testar subprocessos da API no workspace
---

Testes que iniciam uma segunda API devem usar portas dinâmicas para os servidores sob teste e nunca esperar que a porta legada padrão esteja livre.

**Why:** o workflow normal da API mantém o bridge legado ativo na porta fixa, e um restart pode deixar temporariamente um processo-filho antigo nessa porta mesmo depois de o processo principal mudar.

**How to apply:** isolar o bridge usado pelo teste em uma porta livre; se um restart reportar EADDRINUSE, localizar e encerrar apenas o bridge legado órfão antes de reiniciar o workflow. Validar a recuperação pelo banco e pela API de controle, não por uma suposição sobre a porta padrão.