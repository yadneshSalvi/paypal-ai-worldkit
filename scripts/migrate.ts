import { SqlPaymentStore } from "@fracture/paypal-core";
import { closeDatabase } from "../src/server/db";
import { paymentDatabase } from "../src/server/commerce-db";
import { initializeLivingRepair } from "../src/server/living-repair-db";
await initializeLivingRepair();
await new SqlPaymentStore(paymentDatabase).initialize();
console.log(JSON.stringify({ database: "worldkit", schema: "ready", workflows: ["workspace", "studio", "living-kit", "living-repair"], credentials: "not displayed" }));
await closeDatabase();
