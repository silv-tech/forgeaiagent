const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');
const fs = require('fs');
const path = require('path');
// dotenv already loaded by index.js, no need to reload here

function isConfigured() {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

function slugify(businessName) {
  return 'demo-' + businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/g, '');
}

async function ensureProject(accountId, projectName) {
  const check = await cfRequest('GET', `/accounts/${accountId}/pages/projects/${projectName}`);
  if (check.success) return;
  const create = await cfRequest(
    'POST',
    `/accounts/${accountId}/pages/projects`,
    JSON.stringify({ name: projectName, production_branch: 'main' }),
    'application/json'
  );
  if (!create.success) {
    const msg = create.errors?.[0]?.message || 'Unknown error';
    throw new Error(`Could not create Cloudflare Pages project: ${msg}`);
  }
}

async function cfRequest(method, endpoint, body, contentType) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const headers = { 'Authorization': `Bearer ${token}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, { method, headers, body });
  return res.json();
}

async function deployDemoSite(businessName, htmlContent, onProgress) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const projectName = slugify(businessName);
  const tmpDir = path.join(os.tmpdir(), 'cf-' + crypto.randomBytes(4).toString('hex'));

  if (onProgress) onProgress({ status: 'deploying', message: `☁️  Creating Cloudflare Pages project...` });
  await ensureProject(accountId, projectName);

  if (onProgress) onProgress({ status: 'deploying', message: `☁️  Uploading site via Wrangler...` });

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'index.html'), htmlContent, 'utf8');

  try {
    const cmd = `npx --yes wrangler pages deploy "${tmpDir}" --project-name "${projectName}" --branch main`;
    const { stdout, stderr } = await execAsync(cmd, {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        CI: 'true',
        FORCE_COLOR: '0'
      },
      timeout: 120000,
      windowsHide: true
    });

    const output = (stdout + stderr).trim();
    console.log('[CF Wrangler]', output);

    const url = `https://${projectName}.pages.dev`;
    if (onProgress) onProgress({ status: 'deployed', message: `🌐 Live at ${url}` });
    return url;

  } catch (e) {
    console.error('[CF Wrangler error]', e.message);
    throw new Error(`Cloudflare deploy failed: ${e.message}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { deployDemoSite, isConfigured };
