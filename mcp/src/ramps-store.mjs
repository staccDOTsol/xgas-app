import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.XGAS_MCP_DATA
  || (fs.existsSync('/data') ? '/data' : path.join(process.env.HOME || '.', '.xgas-muse'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'ramps.json');

let ramps = {};
try { if (fs.existsSync(FILE)) ramps = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { ramps = {}; }
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(ramps, null, 2)); } catch { /* best effort */ } };

export function createRamp(pathId, params, steps) {
  const id = `ramp_${crypto.randomBytes(6).toString('hex')}`;
  ramps[id] = { ramp_id: id, path_id: pathId, params, steps, state: steps[0].id, created_at: new Date().toISOString() };
  save();
  return ramps[id];
}

export function getRamp(id) { return ramps[id] || null; }
export function listRamps() { return Object.values(ramps).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export function updateRamp(id, patch) {
  if (!ramps[id]) return null;
  ramps[id] = { ...ramps[id], ...patch, updated_at: new Date().toISOString() };
  save();
  return ramps[id];
}
