---
name: Agente externo de encomendas
description: A entrega de encomendas usa o sistema externo de agente do utilizador, não o APK interno do projecto.
---

# Entrega das encomendas

O utilizador já usa APIs para fazer as encomendas chegarem ao seu próprio sistema externo de agente. O aplicativo Android/Expo de agente que existia neste projecto não é utilizado.

**Why:** o utilizador confirmou que o agente externo próprio já recebe as encomendas pelas APIs existentes e pediu a remoção da aplicação APK interna.

**How to apply:** manter as APIs e a lógica de entrega do servidor; não reintroduzir nem compilar o APK interno sem pedido explícito.
