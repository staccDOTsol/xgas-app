#!/usr/bin/env node
// Guarded forge runner for the staccpad-fleet scripts in /Users/stacc/nft-range, same rules as
// contracts/script/RunWithFireballSigner.mjs: the owner key never touches argv or the shell.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';

const NFT_RANGE = '/Users/stacc/nft-range';
const FORGE = '/Users/stacc/.foundry/versions/foundry-rs/foundry/v1.8.3/forge';
const profile = { file: '/Users/stacc/staccoverflow.eth', address: '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158' };
if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('Set FIREBALL_SIGNER_PROFILE=owner');
const args = process.argv.slice(2);
if (args[0] !== 'script') throw new Error('Only Forge script is supported');
const scriptName = args[1]?.split(':')[0]?.split('/').at(-1);
if (!['DeployXgasFleet.s.sol'].includes(scriptName)) throw new Error('Unreviewed fleet script');
if (args.some(a => ['--private-key', '--mnemonic', '--keystore'].includes(a))) throw new Error('Signer credentials must stay in the guarded file');
if (!args.includes('--rpc-url')) throw new Error('Explicit --rpc-url required');
const senderIndex = args.indexOf('--sender');
if (senderIndex === -1 || args[senderIndex + 1]?.toLowerCase() !== profile.address.toLowerCase()) throw new Error('--sender must be the owner');
if (args.includes('--broadcast') && (process.env.FIREBALL_RUN_BROADCAST !== 'YES' || !args.includes('--slow'))) throw new Error('Broadcast requires FIREBALL_RUN_BROADCAST=YES and --slow');
const stat = fs.statSync(profile.file);
if ((stat.mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(profile.file, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const privateKey = `0x${raw.replace(/^0x/, '')}`;
if (privateKeyToAccount(privateKey).address.toLowerCase() !== profile.address.toLowerCase()) throw new Error('Signer file does not control the owner');
const result = spawnSync(FORGE, args, { cwd: NFT_RANGE, stdio: 'inherit', env: { ...process.env, PRIVATE_KEY: BigInt(privateKey).toString() } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
