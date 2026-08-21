import { Feather } from "@expo/vector-icons";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import type { Delivery, DeliveryStatus } from "@/context/agent-context";

const statusMeta: Record<DeliveryStatus, { label: string; color: "primary" | "success" | "warning" | "muted" }> = {
  queued: { label: "Aguardando envio", color: "muted" },
  leased: { label: "Em processamento", color: "primary" },
  manual_intervention: { label: "Intervenção necessária", color: "warning" },
  completed: { label: "Concluído", color: "success" },
  failed: { label: "Falhou", color: "primary" },
};

export function BrandHeader({ status }: { status: "Pronto" | "Por emparelhar" }) {
  const colors = useColors();
  return (
    <View style={styles.header}>
      <View style={styles.brandRow}>
        <Image source={require("../assets/images/icon.png")} style={styles.logo} />
        <View>
          <Text style={[styles.brand, { color: colors.foreground }]}>Net <Text style={{ color: colors.primary }}>Serviços</Text></Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Agente Vodacom</Text>
        </View>
      </View>
      <View style={[styles.readyPill, { backgroundColor: status === "Pronto" ? "#ecfdf5" : colors.accent }]}>
        <View style={[styles.dot, { backgroundColor: status === "Pronto" ? "#16a34a" : colors.primary }]} />
        <Text style={[styles.readyText, { color: status === "Pronto" ? "#065f46" : colors.primary }]}>{status}</Text>
      </View>
    </View>
  );
}

export function DeliveryStatusPill({ status }: { status: DeliveryStatus }) {
  const colors = useColors();
  const meta = statusMeta[status];
  const background = meta.color === "success" ? "#ecfdf5" : meta.color === "warning" ? "#fff3cd" : meta.color === "primary" ? colors.accent : colors.muted;
  const foreground = meta.color === "success" ? "#065f46" : meta.color === "warning" ? "#856404" : meta.color === "primary" ? colors.primary : colors.mutedForeground;
  return (
    <View style={[styles.statusPill, { backgroundColor: background }]}>
      <Text style={[styles.statusText, { color: foreground }]}>{meta.label}</Text>
    </View>
  );
}

export function DeliverySummary({ delivery }: { delivery: Delivery }) {
  const colors = useColors();
  return (
    <View style={[styles.summary, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <View style={styles.summaryTop}>
        <View>
          <Text style={[styles.package, { color: colors.foreground }]}>{delivery.packageLabel}</Text>
          <Text style={[styles.phone, { color: colors.mutedForeground }]}>{delivery.beneficiaryPhone}</Text>
        </View>
        <DeliveryStatusPill status={delivery.status} />
      </View>
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <View style={styles.infoRow}>
        <Feather name="hash" size={14} color={colors.mutedForeground} />
        <Text style={[styles.infoText, { color: colors.mutedForeground }]}>Pedido {delivery.paymentId}</Text>
      </View>
    </View>
  );
}

export function IconButton({
  label,
  icon,
  onPress,
  disabled,
  primary = false,
}: {
  label: string;
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      testID={`button-${label.toLowerCase().replace(/\s+/g, "-")}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: colors.primary } : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Feather name={icon} size={18} color={primary ? colors.primaryForeground : colors.foreground} />
      <Text style={[styles.buttonText, { color: primary ? colors.primaryForeground : colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 22 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 38, height: 38, borderRadius: 10 },
  brand: { fontFamily: "Inter_700Bold", fontSize: 18, letterSpacing: -0.4 },
  subtitle: { fontFamily: "Inter_500Medium", fontSize: 12, marginTop: 1 },
  readyPill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 20, paddingVertical: 6, paddingHorizontal: 9 },
  dot: { width: 7, height: 7, borderRadius: 7 },
  readyText: { fontFamily: "Inter_700Bold", fontSize: 11 },
  statusPill: { borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5 },
  statusText: { fontFamily: "Inter_700Bold", fontSize: 11 },
  summary: { borderWidth: 1, borderRadius: 16, padding: 15 },
  summaryTop: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  package: { fontFamily: "Inter_700Bold", fontSize: 17 },
  phone: { fontFamily: "Inter_500Medium", fontSize: 13, marginTop: 3 },
  divider: { height: 1, marginVertical: 12 },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  infoText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  button: { minHeight: 48, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 14 },
  buttonText: { fontFamily: "Inter_700Bold", fontSize: 14 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});