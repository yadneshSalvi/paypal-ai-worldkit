import { notFound } from "next/navigation";
import { RecordReader } from "@/components/record-reader";
import { readPublicRecord } from "@/server/public-records";
import { PublicEditionSchema, PublicSlugSchema } from "../../../../../packages/public-record";
import type { RecordMode } from "@/components/record-content";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page({ params }: { params: Promise<{ slug: string; view?: string[] }> }) {
  const { slug, view = [] } = await params;
  if (!PublicSlugSchema.safeParse(slug).success) notFound();
  let edition: number | undefined, mode: RecordMode = "certificate";
  if (view[0] === "e") {
    const parsed = PublicEditionSchema.safeParse(view[1]);
    if (!parsed.success || view.length > 3) notFound();
    edition = parsed.data;
    if (view[2]) { if (!["guide", "print"].includes(view[2])) notFound(); mode = view[2] as RecordMode; }
  } else if (view.length) {
    if (view.length !== 1 || !["guide", "print"].includes(view[0]!)) notFound();
    mode = view[0] as RecordMode;
  }
  const initialView = await readPublicRecord(slug, edition);
  if (initialView.state === "unavailable") notFound();
  return <RecordReader initialView={initialView} slug={slug} edition={edition} mode={mode}/>;
}
