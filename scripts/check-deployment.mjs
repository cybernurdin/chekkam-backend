import { loadEnv } from "./lib/load-env.mjs";
import pg from "pg";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createPrivateKey, createPublicKey } from "node:crypto";

loadEnv();
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: institutions, error } = await admin.from("institutions").select("id, signing_public_key").eq("status", "active");
if (error) {
  console.log(JSON.stringify({ database: "unavailable", code: error.code, message: error.message }));
  process.exitCode = 1;
} else {
  const keys = institutions.filter(i => i.signing_public_key).map(i => {
    const name = `DOCUMENT_SIGNING_KEY_${i.id.replaceAll("-", "_").toUpperCase()}`;
    const pem = process.env[name];
    let matches = false;
    try {
      matches = createPublicKey(createPrivateKey(pem.replaceAll("\\n", "\n"))).export({ type: "spki", format: "pem" }).trim() === createPublicKey(i.signing_public_key).export({ type: "spki", format: "pem" }).trim();
    } catch { /* Report only status, never keys. */ }
    return { institution: i.id, configured: Boolean(pem), matches };
  });
  console.log(JSON.stringify({ database: "ok", signingKeys: keys }));
  if (keys.some(k => !k.matches)) process.exitCode = 1;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  const { rows } = await client.query("select name from schema_migrations order by name");
  const applied = new Set(rows.map(r => r.name));
  const pending = fs.readdirSync("supabase/migrations").filter(n => n.endsWith(".sql") && !applied.has(n));
  console.log(JSON.stringify({ appliedMigrations: rows.length, pending }));
  if (pending.length) process.exitCode = 1;
} catch (e) {
  console.log(JSON.stringify({ migrationAudit: "unavailable", code: e.code ?? e.name, message: e.message }));
  process.exitCode = 1;
} finally {
  await client.end();
}
