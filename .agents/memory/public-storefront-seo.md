---
name: SEO da loja pública
description: Convenção para páginas públicas indexáveis na loja Megabyte
---

Páginas públicas da loja devem ser servidas pelo bridge legado com metadados completos e também mapeadas pelo proxy HTML e pelo shell React; os preços visíveis devem vir do catálogo usado pelo checkout.

**Why:** A loja é carregada dentro de um iframe/container, por isso uma rota adicionada apenas no React não chega ao HTML da loja nem mantém os caminhos relativos funcionais.

**How to apply:** Ao criar uma nova landing page, adicionar a configuração de SEO e a rota pública no bridge, incluir o slug na reescrita de caminhos do proxy, fazer o App carregar esse slug e actualizar o sitemap. Reutilizar o catálogo de compra em vez de criar preços SEO separados, e usar “a partir de” ou “opções acessíveis” em vez de afirmar que são os mais baratos sem comparação de mercado.