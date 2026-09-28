---
name: Protecção do livro de encomendas
description: Cuidados com o ficheiro local de encomendas quando o workflow da API está activo
---

Trate o livro local de encomendas como dados potencialmente reais. Ao testar o bridge, use um `NET_SERVICOS_DATA_DIR` temporário e não restaure nem limpe o `orders.json` partilhado no fim dos testes.

**Why:** o workflow da API pode continuar a receber encomendas reais enquanto os testes decorrem; alterações no ficheiro local podem representar pagamentos pendentes, não dados descartáveis de teste.

**How to apply:** antes de executar testes que iniciam o bridge, confirme que cada processo usa armazenamento isolado. Se o ficheiro partilhado mudar durante a validação, preserve-o e verifique a origem antes de qualquer limpeza.