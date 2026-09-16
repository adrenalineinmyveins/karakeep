import type { Metadata } from "next";
import ConceptsOverview from "@/components/dashboard/concepts/ConceptsOverview";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return { title: `${t("concepts.title")} | Saiye` };
}

export default function ConceptsPage() {
  return <ConceptsOverview />;
}
