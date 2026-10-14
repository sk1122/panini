import { loadConfig } from "../config.js";
import { IdentityService } from "../security/identity.js";
const config = await loadConfig();
if (!config.databaseUrl || !config.publicUrl) throw new Error("A configured database and public URL are required.");
const email = process.argv[2];
if (!email || !email.includes("@")) throw new Error("Provide the existing account email.");
const identity = new IdentityService(config.databaseUrl);
try {
  const reset = await identity.operatorReset(email);
  console.log(`Single-use recovery link (expires in one hour). Keep private:\n${config.publicUrl}/reset-password#${encodeURIComponent(reset.token)}`);
} finally { await identity.close(); }
