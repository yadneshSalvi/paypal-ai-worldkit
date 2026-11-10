import { PaymentReturn } from "@/components/payment-return";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; const single = (value: string | string[] | undefined) => typeof value === "string" && value.length < 129 ? value : null;
  return <PaymentReturn orderId={single(query.order)} walletId={single(query.wallet)} cancelled={query.cancelled === "1"}/>;
}
