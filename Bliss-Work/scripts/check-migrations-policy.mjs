/**
 * Pure decision logic for check-migrations.mjs's inline-org_isolation check,
 * split out (same reason as audit-gate-policy.mjs) so it can be unit tested
 * without touching the filesystem or the real services/*\/migrations tree.
 */

/** The table name out of a literal `CREATE POLICY org_isolation ON <table>`,
 *  or null if the text doesn't contain that exact form. A templated/
 *  EXECUTE-format CREATE POLICY (table passed as a runtime variable, as in
 *  messaging-svc's 0029_call_transcript.sql) has no static table name to
 *  check remediation for and is intentionally not matched here — it is a
 *  DIFFERENT policy name (not `org_isolation`) in every such case in this
 *  repo today, so it never reaches this function in practice. */
export function inlineOrgIsolationTable(body) {
  const m = /CREATE\s+POLICY\s+org_isolation\s+ON\s+(\w+)/i.exec(body);
  return m ? m[1] : null;
}

/** Does `laterBody` remediate an inline org_isolation violation on `table` by
 *  calling the canonical apply_org_isolation() helper for that SAME table?
 *
 * This is how a historical violation that already shipped — and so can never
 * be edited, see check-migrations.mjs's header — gets to stop failing: a
 * LATER migration in the same directory re-applies the canonical, correctly
 * schema-qualified policy on top of it. A brand-new inline copy that nothing
 * ever corrects still has no later file calling apply_org_isolation() for its
 * table, so it is unaffected and still fails.
 */
export function remediatesInlinePolicy(laterBody, table) {
  return new RegExp(`apply_org_isolation\\(\\s*'${table}'\\s*[,)]`).test(laterBody);
}
