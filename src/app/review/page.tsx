import type { Metadata } from "next";
import { EngineeringReviewRoom } from "@/components/engineering-review-room";
import "../engineering-review.css";
export const metadata: Metadata = { title: "Engineering reading room · WorldKit", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function ReviewPage() { return <EngineeringReviewRoom/>; }
