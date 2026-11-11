import { seedAdmin, SEED_ADMIN_EMAIL } from "@/lib/allowlist/service";
import { getDb } from "./index";

await seedAdmin(getDb());
console.log(`Seeded ${SEED_ADMIN_EMAIL}`);
