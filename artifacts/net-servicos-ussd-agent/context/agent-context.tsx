import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import React, { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

export type DeliveryStatus = "queued" | "leased" | "manual_intervention" | "completed" | "failed";

export interface Delivery {
  id: string;
  paymentId: string;
  beneficiaryPhone: string;
  packageLabel: string;
  ussdSequence: string[];
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  createdAt?: string;
  leaseExpiresAt?: string;
  confirmationReference?: string;
  failureReason?: string;
  updatedAt: string;
}

interface Device {
  id: string;
  name: string;
  pairedAt: string;
}

interface AgentContextValue {
  device: Device | null;
  deliveries: Delivery[];
  activeDelivery: Delivery | null;
  manualDeliveries: Delivery[];
  loading: boolean;
  error: string | null;
  pair: (name: string, code: string) => Promise<void>;
  refresh: () => Promise<void>;
  leaseDelivery: () => Promise<Delivery | null>;
  report: (delivery: Delivery, status: "completed" | "failed" | "manual_intervention", detail?: string) => Promise<void>;
  simulate: () => Promise<void>;
}

const AgentContext = createContext<AgentContextValue | null>(null);
const deviceKey = "net-servicos-device";
const tokenKey = "net-servicos-device-token";
const apiBase =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "") ??
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/ussd-agent`
    : "https://megabyte.live/api/ussd-agent");

async function secureGet(key: string) {
  if (Platform.OS === "web") return AsyncStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string) {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  if (!apiBase) throw new Error("Servidor do agente indisponível nesta compilação.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("O servidor demorou demasiado a responder. Verifique a internet do telefone.");
    }
    throw new Error("Não foi possível contactar o servidor. Verifique a internet do telefone.");
  } finally {
    clearTimeout(timeout);
  }
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Não foi possível contactar o servidor.");
  return json;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      const response = await request<{ deliveries: Delivery[] }>("/deliveries", token);
      setDeliveries(response.deliveries);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao actualizar a fila.");
    }
  }, [token]);

  useEffect(() => {
    const restore = async () => {
      const [storedDevice, storedToken] = await Promise.all([
        AsyncStorage.getItem(deviceKey),
        secureGet(tokenKey),
      ]);
      if (storedDevice && storedToken) {
        setDevice(JSON.parse(storedDevice) as Device);
        setToken(storedToken);
      }
      setLoading(false);
    };
    void restore();
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pair = useCallback(async (name: string, code: string) => {
    setLoading(true);
    try {
      const response = await request<{ device: Device; token: string }>("/pair", undefined, {
        method: "POST",
        body: JSON.stringify({ name, pairingCode: code }),
      });
      await Promise.all([
        AsyncStorage.setItem(deviceKey, JSON.stringify(response.device)),
        secureSet(tokenKey, response.token),
      ]);
      setDevice(response.device);
      setToken(response.token);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const leaseDelivery = useCallback(async () => {
    if (!token) return null;
    const response = await request<{ delivery: Delivery | null }>("/deliveries/lease", token, { method: "POST" });
    if (response.delivery) setDeliveries((current) => [response.delivery!, ...current.filter((item) => item.id !== response.delivery?.id)]);
    return response.delivery;
  }, [token]);

  const report = useCallback(async (
    delivery: Delivery,
    status: "completed" | "failed" | "manual_intervention",
    detail?: string,
  ) => {
    if (!token) throw new Error("Emparelhe este dispositivo antes de reportar.");
    const body = status === "completed"
      ? { status, confirmationReference: detail }
      : { status, reason: detail };
    const response = await request<{ delivery: Delivery }>(
      `/deliveries/${delivery.id}/report`,
      token,
      { method: "POST", body: JSON.stringify(body) },
    );
    setDeliveries((current) => current.map((item) => item.id === response.delivery.id ? response.delivery : item));
  }, [token]);

  const simulate = useCallback(async () => {
    await request<{ delivery: Delivery }>("/simulations", undefined, { method: "POST" });
    await refresh();
  }, [refresh]);

  const activeDelivery = deliveries.find((delivery) => delivery.status === "leased") ?? null;
  const manualDeliveries = deliveries.filter((delivery) => delivery.status === "manual_intervention");
  const value = useMemo(() => ({
    device, deliveries, activeDelivery, manualDeliveries, loading, error, pair, refresh, leaseDelivery, report, simulate,
  }), [device, deliveries, activeDelivery, manualDeliveries, loading, error, pair, refresh, leaseDelivery, report, simulate]);

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgent deve ser usado dentro de AgentProvider.");
  return context;
}