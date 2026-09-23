---
name: Persistência dos saldos dos clientes
description: Regra para preservar contas e saldo de crédito entre deploys
---

As contas dos clientes, incluindo `balance` e o histórico de créditos aplicados, devem sobreviver a reinícios e deploys através do PostgreSQL. Os ficheiros locais podem servir de migração inicial ou fallback quando não existe base de dados.

**Why:** o armazenamento local de plataformas como Render pode ser efémero; perder o ficheiro de utilizadores faz o cliente perder a conta e o saldo apresentado.

**How to apply:** carregar utilizadores da tabela persistente no arranque, importar o JSON apenas quando a tabela ainda estiver vazia e guardar cada alteração de saldo na base de dados.