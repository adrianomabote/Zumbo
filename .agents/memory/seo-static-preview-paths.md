---
name: Páginas SEO no preview
description: Caminhos de assets em páginas estáticas e fallbacks SPA dentro de artefactos com routing por caminho
---

Páginas HTML estáticas dentro de subpastas de um artefacto web devem referenciar folhas de estilo e outros assets partilhados com caminhos relativos à página, não com caminhos absolutos a partir da raiz.

**Why:** O preview com routing por caminho pode acrescentar um prefixo ao artefacto; um caminho absoluto como `/seo-page.css` pode escapar desse prefixo e deixar a página sem estilo, mesmo que o mesmo caminho funcione no domínio publicado.

**How to apply:** Para páginas como `/categoria/`, usar `../asset.css` e testar a rota no preview. Se houver fallback SPA, manter também o estilo importado no bundle React para que a rota continue apresentável quando `index.html` for servido.