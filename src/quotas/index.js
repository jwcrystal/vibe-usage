import { discoverQuotaProducts, fetchQuotaProducts } from './registry.js';
import { loadConfig, saveConfig } from '../config.js';
import { QUOTA_SYNC_PRODUCT_IDS } from './schema.js';

function fail(message) {
  throw new Error(message);
}

function parseFetchArguments(args) {
  const products = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') continue;
    if (argument !== '--product') fail(`Unknown quota fetch option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail('Option --product requires a value.');
    products.push(value);
    index += 1;
  }
  if (!products.length) fail('quota fetch requires at least one --product.');
  return products;
}

const DEFAULT_API_URL = 'https://vibecafe.ai';

function currentApiUrl(config = loadConfig()) {
  const url = new URL(config?.apiUrl || DEFAULT_API_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('Configured API URL is invalid for quota sync.');
  }
  return url.href.replace(/\/+$/, '');
}

function parseSyncArguments(args) {
  const products = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--product') fail(`Unknown quota sync option: ${args[index]}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail('Option --product requires a value.');
    if (!QUOTA_SYNC_PRODUCT_IDS.includes(value)) fail(`Unsupported quota sync product: ${value}`);
    products.push(value);
    index += 1;
  }
  if (args.length && !products.length) fail('Use --product <id>.');
  return [...new Set(products)];
}

function runQuotaSync(subcommand, args) {
  const products = parseSyncArguments(args);
  const config = loadConfig() || {};
  const apiTarget = currentApiUrl(config);
  const boundTarget = config.quotaSyncApiUrl || null;
  let enabled = Array.isArray(config.quotaSyncProducts)
    ? config.quotaSyncProducts.filter(id => QUOTA_SYNC_PRODUCT_IDS.includes(id))
    : [];

  if (subcommand === 'list') {
    if (!args.length) {
      console.log(JSON.stringify({
        products: boundTarget === apiTarget ? [...new Set(enabled)] : [],
        boundToCurrentServer: boundTarget === apiTarget,
      }));
      return;
    }
    fail('quota sync list takes no options.');
  }
  if (!products.length) fail(`quota sync ${subcommand} requires at least one --product.`);

  if (subcommand === 'enable') {
    if (!config.apiKey) fail('Configure an API key before enabling quota sync.');
    if (boundTarget !== apiTarget) enabled = [];
    config.quotaSyncApiUrl = apiTarget;
    config.quotaSyncProducts = [...new Set([...enabled, ...products])];
  } else if (subcommand === 'disable') {
    enabled = enabled.filter(id => !products.includes(id));
    if (enabled.length) config.quotaSyncProducts = enabled;
    else delete config.quotaSyncProducts;
    if (!config.quotaSyncProducts) delete config.quotaSyncApiUrl;
  } else {
    fail(`Unknown quota sync action: ${subcommand || '(none)'}`);
  }
  saveConfig(config);
  console.log(JSON.stringify({
    products: config.quotaSyncProducts || [],
    boundToCurrentServer: config.quotaSyncApiUrl === apiTarget,
  }));
}

export async function runQuota(args) {
  const subcommand = args[0];
  if (subcommand === 'discover') {
    const unknown = args.slice(1).filter(argument => argument !== '--json');
    if (unknown.length) fail(`Unknown quota discover option: ${unknown[0]}`);
    console.log(JSON.stringify(discoverQuotaProducts()));
    return;
  }
  if (subcommand === 'fetch') {
    console.log(JSON.stringify(await fetchQuotaProducts(parseFetchArguments(args.slice(1)))));
    return;
  }
  if (subcommand === 'sync') {
    const [action, ...options] = args.slice(1);
    runQuotaSync(action, options);
    return;
  }
  fail(`Unknown quota subcommand: ${subcommand || '(none)'}`);
}
