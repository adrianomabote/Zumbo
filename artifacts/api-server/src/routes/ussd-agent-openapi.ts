export const ussdAgentOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Megabyte USSD Agent API",
    version: "1.0.0",
    description:
      "API pública para um telefone Android autorizado receber pedidos de activação pagos, executar USSD no SIM Vodacom e devolver o resultado confirmado ao servidor Megabyte. O APK deve usar apenas os endpoints documentados aqui. Nunca inclua PAGAR_API_KEY, PAGAR_SIGNING_SECRET, PAGAR_WEBHOOK_SECRET ou SESSION_SECRET no APK.",
  },
  servers: [
    {
      url: "https://megabyte.live/api",
      description:
        "Produção na VPS Megabyte. Não use o preview da Replit nem um domínio .replit.dev.",
    },
  ],
  tags: [
    {
      name: "Dispositivo",
      description: "Emparelhamento e consulta dos pedidos atribuídos ao telefone.",
    },
    {
      name: "Entrega",
      description: "Reserva, execução local do USSD e confirmação da entrega.",
    },
  ],
  paths: {
    "/ussd-agent": {
      get: {
        tags: ["Dispositivo"],
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
        tags: ["Dispositivo"],
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
    "/ussd-agent/pair": {
      post: {
        tags: ["Dispositivo"],
        summary: "Emparelhar o APK com um telefone autorizado",
        description:
          "O código de emparelhamento deve ser obtido no painel Megabyte por um administrador autorizado. O token devolvido é apresentado uma única vez e deve ser guardado no armazenamento seguro do Android.",
        operationId: "pairDevice",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PairRequest" },
              example: {
                name: "Telefone Vodacom 1",
                pairingCode: "codigo-gerado-no-painel",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Telefone emparelhado.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PairResponse" },
              },
            },
          },
          "401": {
            description: "Código de emparelhamento inválido.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries": {
      get: {
        tags: ["Entrega"],
        summary: "Listar pedidos atribuídos a este dispositivo",
        description:
          "Devolve os pedidos que já foram atribuídos ao dispositivo autenticado. Para descobrir se existe um pedido novo, use também o endpoint lease.",
        operationId: "listDeviceDeliveries",
        security: [{ DeviceBearer: [] }],
        responses: {
          "200": {
            description: "Pedidos do dispositivo.",
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
          "401": {
            description: "Token ausente ou inválido.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries/lease": {
      post: {
        tags: ["Entrega"],
        summary: "Reservar o próximo pedido para execução",
        description:
          "Reserva exclusivamente um pedido queued para este dispositivo. A reserva dura 3 minutos; se não houver confirmação, o pedido pode voltar à fila. Cada pedido permite no máximo duas tentativas.",
        operationId: "leaseNextDelivery",
        security: [{ DeviceBearer: [] }],
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
          "401": {
            description: "Token ausente ou inválido.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/ussd-agent/deliveries/{id}/report": {
      post: {
        tags: ["Entrega"],
        summary: "Reportar o resultado da execução USSD",
        description:
          "Só o dispositivo que reservou a entrega pode reportá-la. O estado completed exige uma referência devolvida pela operadora. Se o APK não conseguir confirmar com segurança, use manual_intervention; não reporte sucesso sem confirmação.",
        operationId: "reportDelivery",
        security: [{ DeviceBearer: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "ID da entrega devolvido pelo endpoint lease.",
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
          "401": {
            description: "Token ausente ou inválido.",
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
    securitySchemes: {
      DeviceBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "device-token",
        description:
          "Token devolvido pelo endpoint pair. Guardar no Android Keystore/SecureStore e enviar como Authorization: Bearer <token>.",
      },
    },
    schemas: {
      AgentInfo: {
        type: "object",
        required: ["ok", "service", "pairing", "docs"],
        properties: {
          ok: { type: "boolean", example: true },
          service: { type: "string", example: "Net Serviços USSD Agent" },
          pairing: { type: "string", example: "POST /api/ussd-agent/pair" },
          docs: {
            type: "string",
            example: "/api/ussd-agent/openapi.json",
          },
        },
      },
      PairRequest: {
        type: "object",
        required: ["name", "pairingCode"],
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            example: "Telefone Vodacom 1",
          },
          pairingCode: {
            type: "string",
            minLength: 1,
            example: "codigo-gerado-no-painel",
          },
        },
      },
      PairResponse: {
        type: "object",
        required: ["device", "token"],
        properties: {
          device: { $ref: "#/components/schemas/Device" },
          token: {
            type: "string",
            description:
              "Token secreto do dispositivo. Guardar apenas no armazenamento seguro; nunca enviar ao painel ou ao cliente.",
          },
        },
      },
      Device: {
        type: "object",
        required: ["id", "name", "pairedAt"],
        properties: {
          id: { type: "string", example: "device_abc123" },
          name: { type: "string", example: "Telefone Vodacom 1" },
          pairedAt: { type: "string", format: "date-time" },
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
              "Passos ordenados para o módulo Android executar. O primeiro passo é o código de discagem USSD; os restantes representam respostas/opções do menu. A sequência real da Vodacom deve ser validada antes de produção.",
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
          deviceId: { type: "string", example: "device_abc123" },
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
          "queued aguarda um telefone; leased foi reservado; manual_intervention precisa de intervenção; completed foi confirmado; failed falhou.",
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
          error: { type: "string", example: "Dispositivo não autorizado." },
        },
      },
    },
  },
} as const;