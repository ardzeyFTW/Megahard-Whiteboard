const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const versionTsPath = path.join(rootDir, 'src/version.ts');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const shouldPush = process.argv.includes('--push');
const bumpType = args[0] || 'patch';

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

let newVersion = '';
const parts = currentVersion.split('.').map(Number);

if (bumpType === 'patch') {
  newVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
} else if (bumpType === 'minor') {
  newVersion = `${parts[0]}.${parts[1] + 1}.0`;
} else if (bumpType === 'major') {
  newVersion = `${parts[0] + 1}.0.0`;
} else if (/^\d+\.\d+\.\d+$/.test(bumpType)) {
  newVersion = bumpType;
} else {
  console.error(`Invalid version bump type: "${bumpType}". Use "patch", "minor", "major", or a specific version like "0.2.0".`);
  process.exit(1);
}

console.log(`\nPreparing release: v${currentVersion} -> v${newVersion}\n`);

// 1. Run tests and typecheck
console.log('Step 1/4: Running tests and typecheck...');
execSync('npm.cmd run test', { stdio: 'inherit', cwd: rootDir });
execSync('npm.cmd run typecheck', { stdio: 'inherit', cwd: rootDir });

// 2. Update files
console.log('Step 2/4: Updating package.json and src/version.ts...');
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

let versionTs = fs.readFileSync(versionTsPath, 'utf8');
versionTs = versionTs.replace(/export const APP_VERSION = '.*?';/, `export const APP_VERSION = '${newVersion}';`);
fs.writeFileSync(versionTsPath, versionTs, 'utf8');

// 3. Git commit and tag
console.log('Step 3/4: Creating git commit and tag...');
execSync('git add package.json src/version.ts', { stdio: 'inherit', cwd: rootDir });
execSync(`git commit -m "Release v${newVersion}"`, { stdio: 'inherit', cwd: rootDir });
execSync(`git tag v${newVersion}`, { stdio: 'inherit', cwd: rootDir });

// 4. Push if requested
if (shouldPush) {
  console.log('Step 4/4: Pushing main and tag to GitHub...');
  execSync('git push origin main', { stdio: 'inherit', cwd: rootDir });
  execSync(`git push origin v${newVersion}`, { stdio: 'inherit', cwd: rootDir });
  console.log(`\n🎉 Released v${newVersion}! GitHub Actions is now building the .exe.`);
} else {
  console.log(`\nStep 4/4: Release v${newVersion} is prepared locally!`);
  console.log(`To publish to GitHub and build the .exe, run:\n`);
  console.log(`  git push origin main; git push origin v${newVersion}\n`);
}
