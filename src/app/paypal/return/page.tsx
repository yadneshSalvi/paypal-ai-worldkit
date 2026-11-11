import { PaymentReturn } from "@/components/payment-return";
import { RepairPaymentReturn } from "@/components/repair-payment-return";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; const single = (value: string | string[] | undefined) => typeof value === "string" && value.length < 129 ? value : null;
  const amendmentId = single(query.repair);
  if (amendmentId) return <RepairPaymentReturn amendmentId={amendmentId} orderId={single(query.order)} compensationId={single(query.compensation)} cancelled={query.cancelled === "1"}/>;
  return <PaymentReturn orderId={single(query.order)} walletId={single(query.wallet)} cancelled={query.cancelled === "1"}/>;
}
