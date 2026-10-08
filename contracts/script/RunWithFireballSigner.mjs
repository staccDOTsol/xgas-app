#!/usr/bin/env node
// Keep guarded signer keys out of shell arguments, history and command output.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';

const profiles = {
  owner: {
    file: '/Users/stacc/staccoverflow.eth',
    address: '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158',
  },
  isolated: {
    file: '/Users/stacc/hoodagents.eth',
    address: '0x3CacEA9579D61e6BE8C4c75C0537564761A6f8ea',
  },
};
const profile = profiles[process.env.FIREBALL_SIGNER_PROFILE];
if (!profile) throw new Error('Set FIREBALL_SIGNER_PROFILE to owner or isolated');
const args = process.argv.slice(2);
if (args[0] !== 'script') throw new Error('Only Forge script is supported');
const scriptName = args[1]?.split(':')[0]?.split('/').at(-1);
if (!['ActivateFireballXMoney.s.sol', 'DeployFireballBridgeForwarder.s.sol', 'DeployOrbitL4Fireball.s.sol'].includes(scriptName)) {
  throw new Error('Unreviewed Fireball deployment script');
}
if (args.some(a => ['--private-key', '--mnemonic', '--keystore'].includes(a))) {
  throw new Error('Signer credentials must stay in the guarded file');
}
if (!args.includes('--rpc-url')) throw new Error('Explicit --rpc-url required');
const senderIndex = args.indexOf('--sender');
if (senderIndex === -1 || args[senderIndex + 1]?.toLowerCase() !== profile.address.toLowerCase()) {
  throw new Error('Selected signer --sender is required');
}
if (args.includes('--broadcast') && (process.env.FIREBALL_RUN_BROADCAST !== 'YES' || !args.includes('--slow'))) {
  throw new Error('Broadcast requires FIREBALL_RUN_BROADCAST=YES and --slow');
}
const stat = fs.statSync(profile.file);
if ((stat.mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(profile.file, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const privateKey = `0x${raw.replace(/^0x/, '')}`;
if (privateKeyToAccount(privateKey).address.toLowerCase() !== profile.address.toLowerCase()) {
  throw new Error('Signer file does not control the selected deployer');
}
const result = spawnSync('/Users/stacc/.foundry/versions/foundry-rs/foundry/v1.8.3/forge', args, {
  stdio: 'inherit',
  env: { ...process.env, PRIVATE_KEY: BigInt(privateKey).toString(), EXPECTED_DEPLOYER: profile.address },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
