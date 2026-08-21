import { FlatList, Platform, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandHeader, DeliverySummary } from "@/components/agent-ui";
import { useAgent } from "@/context/agent-context";
import { useColors } from "@/hooks/useColors";

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { device, deliveries, loading, refresh } = useAgent();
  return (
    <FlatList
      data={deliveries.filter((delivery) => delivery.status !== "leased")}
      keyExtractor={(delivery) => delivery.id}
      renderItem={({ item }) => <DeliverySummary delivery={item} />}
      contentContainerStyle={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === "web" ? 67 : insets.top + 14, paddingBottom: 112, gap: 10, flexGrow: 1 }]}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.primary} />}
      ListHeaderComponent={<><BrandHeader status={device ? "Pronto" : "Por emparelhar"} /><Text style={[styles.title, { color: colors.foreground }]}>Histórico de entregas</Text><Text style={[styles.description, { color: colors.mutedForeground }]}>Cada transição é registada no servidor do Net Serviços.</Text></>}
      ListEmptyComponent={<View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={[styles.emptyTitle, { color: colors.foreground }]}>Ainda sem entregas</Text><Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Quando este dispositivo receber e reportar uma entrega, ela ficará disponível aqui.</Text></View>}
    />
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 18 },
  title: { fontFamily: "Inter_700Bold", fontSize: 24, letterSpacing: -0.5, marginTop: 4 },
  description: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 19, marginTop: 5, marginBottom: 18 },
  empty: { borderWidth: 1, borderRadius: 16, padding: 18 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  emptyText: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 19, marginTop: 5 },
});