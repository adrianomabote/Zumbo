---
name: Produção no Render
description: Plataforma actual de produção e cuidados ao actualizar o domínio personalizado
---

# Produção actual

O utilizador confirmou que o domínio personalizado `megabyte.live` está alojado
no Render, não na VPS descrita pelos antigos guias de deployment.

**Why:** actualizar a VPS ou seguir instruções de PM2/Nginx não altera o serviço
de produção no Render.

**How to apply:** verificar o serviço e as variáveis no painel do Render; usar
`render.yaml` e `deploy/RENDER.md` como referências do projecto. Não assumir que
os valores versionados correspondem aos valores actualmente activos no serviço.
