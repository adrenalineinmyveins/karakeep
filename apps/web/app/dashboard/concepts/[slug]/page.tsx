import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ConceptPageView from "@/components/dashboard/concepts/ConceptPageView";
import { api } from "@/server/api/client";
import { TRPCError } from "@trpc/server";

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  try {
    const { concept } = await api.concepts.get({ slug: params.slug });
    return { title: `${concept.title} | Saiye` };
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") {
      notFound();
    }
    throw e;
  }
}

export default async function ConceptDetailPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  return <ConceptPageView slug={params.slug} />;
}
