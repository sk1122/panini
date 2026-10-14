import { createPaniniCore } from "../runtime/core.js";
import { ReplayVerifier } from "./verifier.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

const apply = process.argv.includes("--apply");
const confirmedOrganizationId = argument("--organization-id");
const { store } = await createPaniniCore({ runMigrations: false });

try {
  const organization = await store.getOrganization();
  if (apply) {
    if (process.env.PANINI_MAINTENANCE_MODE !== "true") {
      throw new Error("Set PANINI_MAINTENANCE_MODE=true before applying a projection rebuild.");
    }
    if (confirmedOrganizationId !== organization.id) {
      throw new Error(`Pass --organization-id ${organization.id} to confirm the exact rebuild target.`);
    }
  }
  const result = await new ReplayVerifier(store).rebuild({
    apply,
    actor: apply ? "operator:replay-rebuild" : "operator:replay-preview",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.eligible || (apply && !result.after.ok)) process.exitCode = 1;
} finally {
  await store.close();
}
