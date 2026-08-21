import * as Haptics from "expo-haptics";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandHeader, DeliverySummary, IconButton } from "@/components/agent-ui";
import { useAgent } from "@/context/agent-context";
import { executeVodacomSequence, openFirstUssdStep } from "@/services/ussd";
import { useColors } from "@/hooks/useColors";

export default function OperationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { device, activeDelivery, manualDeliveries, loading, error, pair, leaseDelivery, report, simulate } = useAgent();
  const [pairingCode, setPairingCode] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>("Telefone Vodacom");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [manualRef, setManualRef] = useState<string>("");

  const pairDevice = async () => {
    setBusy(true);
    try {
      await pair(deviceName, pairingCode);
      setNotice("Dispositivo emparelhado e pronto para receber pedidos.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (pairError) {
      setNotice(pairError instanceof Error ? pairError.message : "Não foi possível emparelhar.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  const takeDelivery = async () => {
    setBusy(true);
    try {
      const delivery = await leaseDelivery();
      setNotice(delivery ? "Pedido reservado para este telefone." : "Não há pedidos pagos aguardando envio.");
    } catch (leaseError) {
      setNotice(leaseError instanceof Error ? leaseError.message : "Não foi possível obter um pedido.");
    } finally {
      setBusy(false);
    }
  };

  const runDelivery = async () => {
    if (!activeDelivery) return;
    setBusy(true);
    const outcome = await executeVodacomSequence(activeDelivery.ussdSequence);
    if (outcome.kind === "completed") {
      await report(activeDelivery, "completed", outcome.confirmationReference);
      setNotice("Entrega concluída após confirmação da operadora.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await report(activeDelivery, outcome.kind, outcome.reason);
      setNotice(outcome.reason);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    setBusy(false);
  };

  const createSimulation = async () => {
    setBusy(true);
    try {
      await simulate();
      setNotice("Pedido de teste criado. Reserve-o antes de executar.");
    } catch (simulationError) {
      setNotice(simulationError instanceof Error ? simulationError.message : "A simulação não está disponível.");
    } finally {
      setBusy(false);
    }
  };

  const confirmManual = async (delivery: Parameters<typeof report>[0]) => {
    if (!manualRef.trim()) { setNotice("Introduza a referência de confirmação da operadora antes de confirmar."); return; }
    setBusy(true);
    try {
      await report(delivery, "completed", manualRef.trim());
      setManualRef("");
      setNotice("Entrega confirmada manualmente com referência registada.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Não foi possível registar a confirmação.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  const failManual = async (delivery: Parameters<typeof report>[0]) => {
    setBusy(true);
    try {
      await report(delivery, "failed", "Falha confirmada pelo operador após intervenção manual.");
      setNotice("Entrega marcada como falhada.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Não foi possível registar a falha.");
    } finally {
      setBusy(false);
    }
  };

  if (!device) {
    return (
      <ScrollView contentContainerStyle={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === "web" ? 67 : insets.top + 14, paddingBottom: 34 }]}>
        <BrandHeader status="Por emparelhar" />
        <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Image source={require("../../assets/images/vodacom.webp")} style={styles.vodacomMark} />
          <Text style={[styles.heroTitle, { color: colors.foreground }]}>Ligue este telefone ao Net Serviços</Text>
          <Text style={[styles.heroBody, { color: colors.mutedForeground }]}>
            O código é emitido pelo painel para um SIM Vodacom autorizado. A chave do dispositivo fica protegida neste telefone.
          </Text>
        </View>
        <View style={styles.form}>
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Nome do dispositivo</Text>
          <TextInput value={deviceName} onChangeText={setDeviceName} style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]} />
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Código de emparelhamento</Text>
          <TextInput value={pairingCode} onChangeText={setPairingCode} autoCapitalize="characters" autoCorrect={false} placeholder="Introduza o código do painel" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]} />
          <IconButton label={loading || busy ? "A emparelhar" : "Emparelhar telefone"} icon="shield" onPress={() => void pairDevice()} disabled={!pairingCode.trim() || loading || busy} primary />
        </View>
        <View style={[styles.safetyNote, { backgroundColor: colors.accent }]}>
          <Text style={[styles.safetyTitle, { color: colors.primary }]}>Segurança da entrega</Text>
          <Text style={[styles.safetyText, { color: colors.primary }]}>Nenhum PIN é guardado ou enviado. A entrega só é marcada como concluída após confirmação explícita.</Text>
        </View>
        {notice ? <Text style={[styles.notice, { color: colors.mutedForeground }]}>{notice}</Text> : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === "web" ? 67 : insets.top + 14, paddingBottom: 112 }]}>
      <BrandHeader status="Pronto" />
      <View style={[styles.deviceBand, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.signalIcon, { backgroundColor: colors.accent }]}><Text style={[styles.signalText, { color: colors.primary }]}>V</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.deviceName, { color: colors.foreground }]}>{device.name}</Text>
          <Text style={[styles.deviceDetail, { color: colors.mutedForeground }]}>SIM Vodacom autorizado · ligação protegida</Text>
        </View>
      </View>
      {manualDeliveries.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.kicker, { color: "#b45309" }]}>INTERVENÇÃO MANUAL NECESSÁRIA</Text>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Confirmar no telefone</Text>
          {manualDeliveries.map((md) => (
            <View key={md.id} style={[styles.manualCard, { backgroundColor: "#fffbeb", borderColor: "#fcd34d" }]}>
              <DeliverySummary delivery={md} />
              <Text style={[styles.manualInstruction, { color: "#92400e" }]}>
                1. Abra o menu USSD manualmente{"\n"}
                2. Execute a sequência para {md.beneficiaryPhone}{"\n"}
                3. Copie a referência de confirmação da operadora{"\n"}
                4. Introduza-a abaixo e confirme
              </Text>
              <View style={[styles.sequence, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {md.ussdSequence.map((step, i) => <Text key={step} style={[styles.sequenceLine, { color: colors.mutedForeground }]}>{i + 1}. {step}</Text>)}
              </View>
              <Pressable onPress={() => void openFirstUssdStep(md.ussdSequence)} style={styles.linkButton}>
                <Text style={[styles.linkText, { color: colors.primary }]}>Abrir menu USSD no telefone</Text>
              </Pressable>
              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Referência de confirmação da operadora</Text>
              <TextInput
                value={manualRef}
                onChangeText={setManualRef}
                placeholder="Ex: CONF-20260821-XXXXX"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="characters"
                autoCorrect={false}
                style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
              />
              <IconButton
                label={busy ? "A registar" : "Confirmar entrega manualmente"}
                icon="check-circle"
                onPress={() => void confirmManual(md)}
                disabled={busy || !manualRef.trim()}
                primary
              />
              <IconButton
                label="Reportar falha definitiva"
                icon="x-circle"
                onPress={() => void failManual(md)}
                disabled={busy}
              />
            </View>
          ))}
        </View>
      )}
      {activeDelivery ? (
        <View style={styles.section}>
          <Text style={[styles.kicker, { color: colors.primary }]}>EM PROCESSAMENTO</Text>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Confirme a entrega</Text>
          <DeliverySummary delivery={activeDelivery} />
          <View style={[styles.sequence, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sequenceTitle, { color: colors.foreground }]}>Sequência configurada</Text>
            {activeDelivery.ussdSequence.map((step, index) => <Text key={step} style={[styles.sequenceLine, { color: colors.mutedForeground }]}>{index + 1}. {step}</Text>)}
          </View>
          <IconButton label={busy ? "A validar" : "Executar USSD"} icon="phone-call" onPress={() => void runDelivery()} disabled={busy} primary />
          <Pressable onPress={() => void openFirstUssdStep(activeDelivery.ussdSequence)} style={styles.linkButton}>
            <Text style={[styles.linkText, { color: colors.primary }]}>Abrir menu inicial manualmente</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={[styles.kicker, { color: colors.primary }]}>FILA DE ENTREGA</Text>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Pronto para o próximo pedido</Text>
          <View style={[styles.emptyPanel, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Nenhum pedido reservado</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Os pedidos aparecem aqui somente depois da confirmação do pagamento.</Text>
          </View>
          <IconButton label={busy ? "A procurar" : "Procurar pedido"} icon="refresh-cw" onPress={() => void takeDelivery()} disabled={busy} primary />
          <IconButton label="Criar pedido de teste" icon="coffee" onPress={() => void createSimulation()} disabled={busy} />
        </View>
      )}
      {notice || error ? <Text style={[styles.notice, { color: error ? colors.destructive : colors.mutedForeground }]}>{error ?? notice}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: 18 },
  hero: { borderRadius: 18, borderWidth: 1, padding: 20, alignItems: "flex-start" },
  vodacomMark: { width: 54, height: 54, borderRadius: 14, marginBottom: 18 },
  heroTitle: { fontFamily: "Inter_700Bold", fontSize: 25, letterSpacing: -0.6, maxWidth: 290 },
  heroBody: { fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 21, marginTop: 9 },
  form: { gap: 9, marginTop: 22 },
  fieldLabel: { fontFamily: "Inter_600SemiBold", fontSize: 13, marginTop: 5 },
  input: { height: 50, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: "Inter_500Medium", fontSize: 15, marginBottom: 6 },
  safetyNote: { borderRadius: 12, padding: 14, marginTop: 18 },
  safetyTitle: { fontFamily: "Inter_700Bold", fontSize: 13, marginBottom: 4 },
  safetyText: { fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18 },
  notice: { fontFamily: "Inter_500Medium", fontSize: 13, lineHeight: 19, marginTop: 16, textAlign: "center" },
  deviceBand: { borderWidth: 1, borderRadius: 14, padding: 13, flexDirection: "row", alignItems: "center", gap: 11 },
  signalIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  signalText: { fontFamily: "Inter_700Bold", fontSize: 20 },
  deviceName: { fontFamily: "Inter_700Bold", fontSize: 14 },
  deviceDetail: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  section: { marginTop: 25, gap: 12 },
  kicker: { fontFamily: "Inter_700Bold", fontSize: 11, letterSpacing: 1.1 },
  sectionTitle: { fontFamily: "Inter_700Bold", fontSize: 24, letterSpacing: -0.5 },
  emptyPanel: { borderWidth: 1, borderRadius: 16, padding: 18 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  emptyText: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 19, marginTop: 5 },
  sequence: { borderWidth: 1, borderRadius: 14, padding: 15 },
  sequenceTitle: { fontFamily: "Inter_700Bold", fontSize: 14, marginBottom: 8 },
  sequenceLine: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20 },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  linkText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  manualCard: { borderWidth: 1.5, borderRadius: 16, padding: 16, gap: 11 },
  manualInstruction: { fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 20 },
});