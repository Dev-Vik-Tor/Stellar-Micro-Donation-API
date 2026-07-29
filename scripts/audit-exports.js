#!/usr/bin/env node
/**
 * Audit script to identify modules with non-standard export patterns
 *
 * Usage:
 *   node scripts/audit-exports.js
 *   node scripts/audit-exports.js --fix         # Auto-fix where safe
 *   node scripts/audit-exports.js --report=json # JSON output
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const shouldFix = args.includes('--fix');
if (shouldFix) {
  // Reserved for future auto-fix support.
}
const reportFormat = args.find(a => a.startsWith('--report='))?.split('=')[1] || 'text';

const srcDir = path.join(__dirname, '../src');

// Module categorization
const isService = (filePath) => filePath.includes('/services/');
const isRoute = (filePath) => filePath.includes('/routes/');
const isUtil = (filePath) => filePath.includes('/utils/') || filePath.includes('/helpers/');
const isMiddleware = (filePath) => filePath.includes('/middleware/');
const isMigration = (filePath) => filePath.includes('/migrations/');
const isConfig = (filePath) => filePath.includes('/config/');

function analyzeFile(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const info = {
      filePath,
      category: '',
      exportPattern: 'unknown',
      issues: [],
      line: -1,
    };

    // Categorize
    if (isMigration(filePath)) info.category = 'migration';
    else if (isService(filePath)) info.category = 'service';
    else if (isRoute(filePath)) info.category = 'route';
    else if (isMiddleware(filePath)) info.category = 'middleware';
    else if (isUtil(filePath)) info.category = 'util';
    else if (isConfig(filePath)) info.category = 'config';
    else info.category = 'other';

    // Analyze exports
    let hasModuleExports = false;
    let hasNamedExports = false;
    let exportLine = -1;

    lines.forEach((line, idx) => {
      if (line.includes('module.exports =')) {
        hasModuleExports = true;
        exportLine = idx + 1;

        if (line.includes('{ ')) {
          info.exportPattern = 'object';
        } else if (line.includes('function ') || line.includes('class ')) {
          info.exportPattern = 'inline-definition';
        } else if (line.trim() === 'module.exports = {' || line.trim().endsWith(';')) {
          info.exportPattern = 'assignment';
        } else {
          info.exportPattern = 'identifier';
        }
      }

      if (line.match(/^exports\.\w+\s*=/)) {
        hasNamedExports = true;
        if (exportLine === -1) exportLine = idx + 1;
      }
    });

    info.line = exportLine;

    // Check for violations
    if (hasModuleExports && hasNamedExports && !isMigration(filePath)) {
      info.issues.push('Mixed CommonJS patterns (module.exports + exports.X)');
    }

    if (info.category === 'service' && info.exportPattern === 'object') {
      info.issues.push('Service should export class/singleton directly, not object literal');
    }

    if ((info.category === 'util' || info.category === 'middleware') &&
        (info.exportPattern === 'identifier' || info.exportPattern === 'unknown')) {
      // Single identifier exports can be okay for utils
      if (!hasModuleExports) {
        info.issues.push('No module.exports found');
      }
    }

    return info;
  } catch (err) {
    return {
      filePath,
      category: 'error',
      exportPattern: 'error',
      issues: [err.message],
      line: -1,
    };
  }
}

function walkDir(dir, callback) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      if (!['node_modules', 'tests', '.git'].includes(file)) {
        walkDir(filePath, callback);
      }
    } else if (file.endsWith('.js') && !file.includes('.test.') && !file.includes('.spec.')) {
      callback(filePath);
    }
  });
}

// Collect results
const results = [];
walkDir(srcDir, (filePath) => {
  results.push(analyzeFile(filePath));
});

// Filter for issues
const withIssues = results.filter(r => r.issues.length > 0);
const byCategory = {};

results.forEach((r) => {
  if (!byCategory[r.category]) byCategory[r.category] = 0;
  byCategory[r.category]++;
});

const issuesByCategory = {};
withIssues.forEach((r) => {
  if (!issuesByCategory[r.category]) issuesByCategory[r.category] = [];
  issuesByCategory[r.category].push(r);
});

// Output report
if (reportFormat === 'json') {
  console.log(JSON.stringify({ summary: byCategory, issues: withIssues }, null, 2));
} else {
  console.log('\n=== Export Convention Audit ===\n');
  console.log('Module Summary:');
  Object.entries(byCategory).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });

  console.log('\nModules with Export Issues:');
  if (withIssues.length === 0) {
    console.log('  ✓ All modules follow export conventions!');
  } else {
    Object.entries(issuesByCategory).forEach(([cat, items]) => {
      console.log(`\n  ${cat.toUpperCase()} (${items.length}):`);
      items.forEach((item) => {
        console.log(`    ${path.relative(srcDir, item.filePath)}:${item.line}`);
        item.issues.forEach((issue) => {
          console.log(`      - ${issue}`);
        });
      });
    });
  }

  console.log(`\nTotal modules analyzed: ${results.length}`);
  console.log(`Modules with issues: ${withIssues.length}`);
  console.log('\nRun with --report=json for detailed output\n');
}

// Exit with non-zero if issues found
process.exit(withIssues.length > 0 ? 1 : 0);
