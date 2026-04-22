/**
 * PEI-003 Test Fixture: Enforcement engine parser that fails open
 *
 * Intentionally vulnerable: error paths default to ALLOW instead of DENY.
 * HMA PEI-003 should detect missing DENY on error paths.
 */

function evaluatePolicy(policy, request) {
  try {
    const rules = JSON.parse(policy);

    for (const rule of rules) {
      if (rule.action === 'DENY' && matchesResource(rule, request)) {
        return 'DENY';
      }
      if (rule.action === 'ALLOW' && matchesResource(rule, request)) {
        return 'ALLOW';
      }
    }

    // VULNERABLE: unknown action types fall through to implicit allow
    return 'ALLOW';

  } catch (error) {
    // VULNERABLE: parse error fails open
    console.error('Policy parse error, proceeding without enforcement:', error.message);
    return 'ALLOW';
  }
}

function matchesResource(rule, request) {
  if (!rule.condition) {
    // VULNERABLE: missing condition = match all, but doesn't terminate in DENY
    return true;
  }

  try {
    return new RegExp(rule.condition).test(request.resource);
  } catch (e) {
    // VULNERABLE: invalid regex fails open
    console.warn('Invalid rule condition, skipping rule');
    return false;
  }
}

module.exports = { evaluatePolicy, matchesResource };
