/**
 * Test Runner — runs all formula engine tests
 *
 * Usage: node --experimental-vm-modules tests/formulas/run-all.js
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tests = [
  'test-parser.js',
  'test-compiler.js',
  'test-eo-ir.js',
  'test-registry.js',
];

let allPassed = true;

for (const test of tests) {
  const testPath = join(__dirname, test);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running ${test}...`);
  console.log('='.repeat(60));

  try {
    const output = execSync(`node --experimental-vm-modules "${testPath}"`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    console.log(output);
  } catch (e) {
    allPassed = false;
    console.log(e.stdout || '');
    console.error(e.stderr || '');
    console.error(`\n${test} FAILED with exit code ${e.status}`);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (allPassed) {
  console.log('ALL TESTS PASSED');
} else {
  console.log('SOME TESTS FAILED');
  process.exit(1);
}
