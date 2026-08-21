import { Image, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandHeader } from "@/components/agent-ui";
import { useAgent } from "@/context/agent-context";
import { useColors } from "@/hooks/useColors";

export default function DeviceScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { device } = useAgent();
  return (
    <ScrollView contentContainerStyle={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === "web" ? 67 : insets.top + 14, paddingBottom: 112 }]}>
      <BrandHeader status={device ? "Pronto" : "Por emparelhar"} />
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Image source={require("../../assets/images/vodafone-logo.jpg")} style={styles.logo} />
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>Telefone dedicado</Text>
        <Text style={[styles.cardText, { color: colors.mutedForeground }]}>{device ? device.name : "Emparelhe um telefone com SIM Vodacom autorizado para começar."}</Text>
      </View>
      <View style={styles.list}>
        <SettingLine label="Canal do servidor" value={device ? "Protegido e activo" : "Aguardando emparelhamento"} />
        <SettingLine label="Chave do dispositivo" value={device ? "Guardada neste telefone" : "Não criada"} />
        <SettingLine label="Automação USSD" value="Requer build Android personalizado" />
        <SettingLine label="Resultado multi-etapa" value="Sempre pede confirmação manual" last />
      </View>
      <View style={[styles.warning, { backgroundColor: colors.accent }]}>
        <Text style={[styles.warningTitle, { color: colors.primary }]}>Limite de segurança</Text>
        <Text style={[styles.warningText, { color: colors.primary }]}>Este agente não contorna menus, PINs ou restrições da operadora. Se o aparelho não puder avançar, a entrega fica em intervenção manual.</Text>
      </View>
    </ScrollView>
  );
}

function SettingLine({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const colors = useColors();
  return <View style={[styles.setting, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}><Text style={[styles.settingLabel, { color: colors.foreground }]}>{label}</Text><Text style={[styles.settingValue, { color: colors.mutedForeground }]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: 18 },
  card: { borderWidth: 1, borderRadius: 18, padding: 18, overflow: "hidden" },
  logo: { height: 84, width: "100%", borderRadius: 12, resizeMode: "cover", marginBottom: 17 },
  cardTitle: { fontFamily: "Inter_700Bold", fontSize: 20 },
  cardText: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20, marginTop: 5 },
  list: { marginTop: 22 },
  setting: { paddingVertical: 14 },
  settingLabel: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  settingValue: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 4 },
  warning: { borderRadius: 14, padding: 15, marginTop: 24 },
  warningTitle: { fontFamily: "Inter_700Bold", fontSize: 13, marginBottom: 5 },
  warningText: { fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18 },
});