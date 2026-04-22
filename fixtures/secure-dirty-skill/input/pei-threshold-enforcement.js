/**
 * PEI-001 Test Fixture: Threshold-based enforcement fallback
 *
 * Intentionally vulnerable pattern: enforcement degrades after N violations.
 * HMA PEI-001 should detect this anti-pattern.
 */

let violationCount = 0;
const THRESHOLD = 3;

function enforcePolicy(request) {
  violationCount++;

  // VULNERABLE: threshold-based fallback
  if (violationCount > THRESHOLD) {
    console.warn('Warning: repeated violation, escalating to user review');
    return { action: 'ask_user', reason: 'threshold exceeded' };
  }

  if (violationCount > THRESHOLD * 2) {
    console.warn('Too many violations, passing with warning');
    return { action: 'pass', reason: 'fatigue fallback' };
  }

  return { action: 'deny', reason: 'policy violation' };
}

function handleRequest(req) {
  const result = enforcePolicy(req);
  if (result.action === 'deny') {
    throw new Error('Request denied: ' + result.reason);
  }
  // action is 'ask_user' or 'pass' -- proceeds
  return processRequest(req);
}

module.exports = { enforcePolicy, handleRequest };
