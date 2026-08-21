import { Linking, NativeModules, Platform } from "react-native";

export type UssdResult =
  | { kind: "completed"; confirmationReference: string }
  | { kind: "manual_intervention"; reason: string }
  | { kind: "failed"; reason: string };

interface UssdNativeModule {
  executeSequence?: (steps: string[]) => Promise<{
    outcome: "completed" | "manual_intervention" | "failed";
    confirmationReference?: string;
    reason?: string;
  }>;
}

export async function executeVodacomSequence(steps: string[]): Promise<UssdResult> {
  const nativeModule = NativeModules.NetServicosUssd as UssdNativeModule | undefined;
  if (Platform.OS !== "android" || !nativeModule?.executeSequence) {
    return {
      kind: "manual_intervention",
      reason:
        "Este ambiente não inclui o módulo Android USSD. Abra o menu no telefone dedicado e confirme o resultado antes de concluir.",
    };
  }

  try {
    const result = await nativeModule.executeSequence(steps);
    if (result.outcome === "completed" && result.confirmationReference) {
      return { kind: "completed", confirmationReference: result.confirmationReference };
    }
    if (result.outcome === "failed") {
      return { kind: "failed", reason: result.reason ?? "A operadora não confirmou a operação." };
    }
    return {
      kind: "manual_intervention",
      reason: result.reason ?? "O menu USSD requer uma confirmação manual no telefone.",
    };
  } catch (error) {
    return {
      kind: "manual_intervention",
      reason: error instanceof Error ? error.message : "Não foi possível confirmar a sequência USSD.",
    };
  }
}

export async function openFirstUssdStep(steps: string[]) {
  const firstStep = steps[0];
  if (!firstStep) return;
  const dial = firstStep.replace(/#/g, "%23");
  await Linking.openURL(`tel:${dial}`);
}