---
name: Persistência do Gateway
description: Regra de armazenamento para chaves e transacções de integrações externas
---

As chaves e transacções do Gateway devem ter PostgreSQL como fonte persistente; os ficheiros JSON servem para migração inicial e fallback local.

**Why:** deployments autoscale e bridges copiados para directórios temporários podem não conservar ficheiros locais nem ter acesso aos módulos do workspace. A persistência crítica não pode depender apenas do filesystem da instância.

**How to apply:** ao alterar o Gateway, preserve a importação dos JSON existentes, sincronize novos registos com PostgreSQL e carregue o driver de base de forma opcional para que bridges isolados continuem a funcionar sem `node_modules`.