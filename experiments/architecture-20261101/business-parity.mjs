import assert from 'node:assert/strict';

// Source contributions change floating-point addition order; all other fields stay exact.
export function assertBusinessEqual(actual, expected, path = '$', diagnostics = { moneyDifferences: 0, maxMoneyDifference: 0 }) {
  if (typeof actual === 'number' && typeof expected === 'number' && actual !== expected && /(?:Usd|Cny)$/.test(path)) {
    const error = Math.abs(actual - expected);
    assert.ok(error <= 1e-8, `${path}: ${actual} != ${expected} (money delta ${error})`);
    diagnostics.moneyDifferences++; diagnostics.maxMoneyDifference = Math.max(diagnostics.maxMoneyDifference, error);
    return diagnostics;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path); assert.equal(actual.length, expected.length, path + '.length');
    expected.forEach((value, i) => assertBusinessEqual(actual[i], value, `${path}[${i}]`, diagnostics));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', path);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path + '.keys');
    for (const key of Object.keys(expected)) assertBusinessEqual(actual[key], expected[key], `${path}.${key}`, diagnostics);
  } else assert.deepEqual(actual, expected, path);
  return diagnostics;
}
