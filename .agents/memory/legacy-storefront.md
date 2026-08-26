---
name: Storefront legado
description: Regra arquitectural para alterações na loja pública Megabyte
---

A loja pública é gerada pelo processo legado, enquanto o frontend React funciona como um iframe/container. Chamadas relativas e cookies precisam continuar compatíveis com a reescrita de caminhos feita pelo proxy da API.

**Why:** Alterar apenas componentes React não muda o checkout que o utilizador vê; o bridge também é o ponto que concentra autenticação e compra.

**How to apply:** Para mudanças na loja pública, verificar o HTML/JavaScript gerado no bridge e confirmar o resultado através da rota proxied do artefacto web.