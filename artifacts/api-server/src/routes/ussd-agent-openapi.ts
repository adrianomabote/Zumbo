export const ussdAgentOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Megabyte USSD Agent API",
    version: "1.1.0",
    description:
      "API pública para um APK Android receber pedidos de activação pagos, executar USSD no SIM Vodacom e devolver o resultado ao servidor Megabyte. Este fluxo não exige token, código de emparelhamento ou cabeçalho Authorization. O APK deve usar apenas os endpoints descritos neste documento. As chaves Pagar e SESSION_SECRET nunca devem ser colocadas no APK.",
  },
  servers: [
    {
      url: "https://megabyte.live/api",
      description:
        "Produção na VPS Megabyte. Não use o preview da Replit nem um domínio .replit.dev.",
    },
  ],
  "x-authentication": "none",
  "x-client-flow": [
    "Repetir POST /ussd-agent/deliveries/lease até receber um pedido.",
    "Executar localmente a ussdSequence no telefone Vodacom.",
    "Enviar POST /ussd-agent/deliveries/{id}/report com o resultado confirmado.",
  ],
  "x-security-warning":
    "Este modo público foi escolhido pelo proprietário do projecto. Qualquer pessoa que conheça o endereço pode consultar a fila, reservar pedidos e enviar reportes. Não coloque este endereço em aplicações não autorizadas.",
  tags: [
    {
      name: "Informação",
      description: "Verificação e documentação da API.",
    },
    {
      name: "Entrega",
      description: "Reserva, execução local do USSD e confirmação.",
    },
  ],
  paths: {
    "/ussd-agent": {
      get: {
        tags: ["Informação"],
        summary: "Verificar a API do agente",
        operationId: "getAgentInfo",
        responses: {
          "200": {
            description: "API disponível.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentInfo" },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/openapi.json": {
      get: {
        tags: ["Informação"],
        summary: "Obter esta documentação",
        operationId: "getOpenApiDocument",
        responses: {
          "200": {
            description: "Especificação OpenAPI da integração.",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries": {
      get: {
        tags: ["Entrega"],
        summary: "Listar pedidos deste agente público",
        description:
          "Devolve os pedidos que já foram reservados pelo agente público. Não é necessário enviar Authorization.",
        operationId: "listPublicAgentDeliveries",
        responses: {
          "200": {
            description: "Pedidos reservados.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["deliveries"],
                  properties: {
                    deliveries: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Delivery" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries/lease": {
      post: {
        tags: ["Entrega"],
        summary: "Reservar o próximo pedido",
        description:
          "Reserva exclusivamente o próximo pedido queued para este agente público. A reserva dura 3 minutos. Se não houver confirmação, pode voltar à fila; cada pedido permite no máximo duas tentativas.",
        operationId: "leaseNextPublicDelivery",
        responses: {
          "200": {
            description: "Pedido reservado ou fila vazia.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["delivery"],
                  properties: {
                    delivery: {
                      oneOf: [
                        { $ref: "#/components/schemas/Delivery" },
                        { type: "null" },
                      ],
                      description: "null quando não existem pedidos disponíveis.",
                    },
                  },
                },
                examples: {
                  pedido: {
                    value: {
                      delivery: {
                        id: "delivery_abc123",
                        paymentId: "payment_123",
                        beneficiaryPhone: "841234567",
                        packageLabel: "1 GB",
                        ussdSequence: [
                          "*111#",
                          "Escolher Internet",
                          "Escolher 1 GB",
                          "Enviar para 841234567",
                          "Confirmar",
                        ],
                        status: "leased",
                        attempts: 1,
                        maxAttempts: 2,
                        leaseExpiresAt: "2026-08-27T20:03:00.000Z",
                        updatedAt: "2026-08-27T20:00:00.000Z",
                      },
                    },
                  },
                  vazio: { value: { delivery: null } },
                },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries/{id}/report": {
      post: {
        tags: ["Entrega"],
        summary: "Reportar o resultado do envio USSD",
        description:
          "Confirma o resultado de uma entrega reservada. Só envie completed depois de a operadora confirmar o envio e devolva a referência recebida. Se a confirmação não for segura, use manual_intervention.",
        operationId: "reportPublicDelivery",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "ID devolvido pelo endpoint lease.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeliveryReport" },
              examples: {
                completed: {
                  value: {
                    status: "completed",
                    confirmationReference: "CONF-20260827-12345",
                  },
                },
                failed: {
                  value: {
                    status: "failed",
                    reason: "A operadora recusou a operação.",
                  },
                },
                manual: {
                  value: {
                    status: "manual_intervention",
                    reason: "Não foi possível confirmar a resposta USSD.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Resultado guardado no servidor.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["delivery"],
                  properties: {
                    delivery: { $ref: "#/components/schemas/Delivery" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Reporte inválido ou entrega indisponível.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      AgentInfo: {
        type: "object",
        required: ["ok", "service", "docs", "authentication"],
        properties: {
          ok: { type: "boolean", example: true },
          service: { type: "string", example: "Net Serviços USSD Agent" },
          docs: {
            type: "string",
            example: "/api/ussd-agent/openapi.json",
          },
          authentication: { type: "string", enum: ["none"], example: "none" },
          lease: {
            type: "string",
            example: "POST /api/ussd-agent/deliveries/lease",
          },
          report: {
            type: "string",
            example: "POST /api/ussd-agent/deliveries/{id}/report",
          },
        },
      },
      Delivery: {
        type: "object",
        required: [
          "id",
          "paymentId",
          "beneficiaryPhone",
          "packageLabel",
          "ussdSequence",
          "status",
          "attempts",
          "maxAttempts",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", example: "delivery_abc123" },
          paymentId: { type: "string", example: "payment_123" },
          beneficiaryPhone: {
            type: "string",
            description: "Número Vodacom que receberá os megas.",
            pattern: "^(84|85)[0-9]{7}$",
            example: "841234567",
          },
          packageLabel: { type: "string", example: "1 GB" },
          ussdSequence: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description:
              "Passos ordenados para o módulo Android executar. O primeiro passo é o código USSD; os restantes são opções/respostas do menu. A sequência real da Vodacom deve ser validada antes de produção.",
            example: [
              "*111#",
              "Escolher Internet",
              "Escolher 1 GB",
              "Enviar para 841234567",
              "Confirmar",
            ],
          },
          status: {
            $ref: "#/components/schemas/DeliveryStatus",
          },
          attempts: { type: "integer", minimum: 0, example: 1 },
          maxAttempts: { type: "integer", minimum: 1, example: 2 },
          deviceId: { type: "string", example: "public-agent" },
          leaseExpiresAt: { type: "string", format: "date-time" },
          confirmationReference: { type: "string", example: "CONF-20260827-12345" },
          failureReason: { type: "string" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      DeliveryStatus: {
        type: "string",
        enum: ["queued", "leased", "manual_intervention", "completed", "failed"],
        description:
          "queued aguarda execução; leased foi reservado; manual_intervention precisa de intervenção; completed foi confirmado; failed falhou.",
      },
      DeliveryReport: {
        oneOf: [
          {
            type: "object",
            required: ["status", "confirmationReference"],
            additionalProperties: false,
            properties: {
              status: { const: "completed" },
              confirmationReference: {
                type: "string",
                minLength: 1,
                example: "CONF-20260827-12345",
              },
            },
          },
          {
            type: "object",
            required: ["status"],
            additionalProperties: false,
            properties: {
              status: { enum: ["failed", "manual_intervention"] },
              reason: {
                type: "string",
                example: "Não foi possível confirmar a resposta USSD.",
              },
            },
          },
        ],
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", example: "Entrega não encontrada." },
        },
      },
    },
  },
} as const;