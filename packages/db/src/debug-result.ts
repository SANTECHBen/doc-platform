import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL ?? '', { ssl: 'require' });

const orgs = await sql<
  { id: string; name: string; type: string; oem_code: string | null; created_at: Date }[]
>`SELECT id, name, type, oem_code, created_at FROM organizations ORDER BY created_at DESC LIMIT 10`;
console.log('--- Latest 10 organizations (newest first) ---');
for (const o of orgs) {
  console.log(`  ${o.created_at.toISOString()} | ${o.id} | ${o.type} | "${o.name}" | oemCode=${o.oem_code ?? '-'}`);
}

const fts = orgs.filter((o) => /flow|turn/i.test(o.name) || /FLOW/i.test(o.oem_code ?? ''));
console.log(`\n--- Flow/Turn matches: ${fts.length} ---`);
for (const o of fts) {
  console.log(`  ${o.id} "${o.name}" oemCode=${o.oem_code}`);
}

console.log('\n--- Steps for org_node from latest exec on the patched run ---');
const [run] = await sql<{ id: string }[]>`
  SELECT id FROM agent_runs WHERE id = '05028b97-333f-4a0d-abc7-4df6144bbaf5'
`;
if (run) {
  const [exec] = await sql<{ id: string; status: string }[]>`
    SELECT e.id, e.status FROM agent_executions e
    JOIN agent_proposals p ON e.proposal_id = p.id
    WHERE p.run_id = ${run.id}
    ORDER BY e.started_at DESC LIMIT 1
  `;
  if (exec) {
    const orgSteps = await sql<{ status: string; target_id: string | null; notes: string | null }[]>`
      SELECT status, target_id, notes FROM agent_execution_steps
      WHERE execution_id = ${exec.id} AND step_type = 'organization'
    `;
    for (const s of orgSteps) {
      console.log(`  status=${s.status} target_id=${s.target_id} notes="${s.notes}"`);
    }
  }
}

await sql.end();
