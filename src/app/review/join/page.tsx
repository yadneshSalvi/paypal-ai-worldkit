import type { Metadata } from "next";
import { EngineeringInvitation } from "@/components/engineering-review-invitation";
import "../../engineering-review.css";
export const metadata: Metadata = { title: "Scoped review invitation · WorldKit", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function JoinReviewPage() { return <EngineeringInvitation/>; }
