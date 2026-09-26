# Run a validator on xgas #466302

xgas #466302 is an Arbitrum Orbit rollup on Robinhood Chain (#4663). Every batch is posted to Robinhood, so any node can rebuild the chain from Robinhood alone. Validation is permissionless: the validator whitelist is off on-chain (`validatorWhitelistDisabled()` on the rollup returns `true`). You don't need permission from anyone.

## Addresses (Robinhood Chain #4663)

| | |
|---|---|
| Rollup | `0x5868266C0c0663f4bc39329B525884f137BAD93E` |
| Inbox | `0xa7087693676F2Ca8e5e9563A6859952258688146` |
| Bridge | `0x2290f4505484f055B710e7Df37e2482c90B8B6fb` |
| Sequencer inbox | `0xCA038a032154d0091b019A9104b369F94FD5c75F` |
| Fast-confirm Safe (2 of 3) | `0x17fC7585A3c99ACC2A7CFC1842C119d7FBB12cBC` |
| Gas token (XMoney) | `0xa924C725B64cC346f275269EFA4Bd0538cfBa97E` |
| Base stake | 0.01 WETH |

Public RPC of the sequencer: `https://xgas-l4.fly.dev`

## Files

- Chain info: [`/chain-info-466302.json`](/chain-info-466302.json)
- Validator node config template: [`/validator-node-config-466302.json`](/validator-node-config-466302.json). Replace `__YOUR_ROBINHOOD_RPC_URL__` and `__YOUR_VALIDATOR_PRIVATE_KEY_WITHOUT_0x__`, and keep `node.staker.strategy` at `ResolveNodes` (confirms and challenges; this is the mode that can actually defend) or use `MakeNodes` to also post assertions.

## Run it

```sh
mkdir -p xgas-validator && cd xgas-validator
curl -sO https://xgas.dev/validator-node-config-466302.json
# edit the two placeholders in the file, then:
docker run -d --name xgas-validator --restart unless-stopped \
  -v "$PWD":/home/user/.arbitrum \
  offchainlabs/nitro-node:v3.11.4-7d5ac27 \
  --conf.file /home/user/.arbitrum/validator-node-config-466302.json
```

Fund the validator address on Robinhood Chain with a little ETH for gas (~0.015 ETH covers the 0.01 WETH bond, which the node wraps itself, plus gas). Keep the key file private.

## Watchtower (no bond, no gas)

Set `node.staker.strategy` to `Watchtower` and leave the key out. It syncs the chain and logs loudly if a bad assertion ever appears.

## Costs

About 0.00006 ETH per assertion, at most one every 15 minutes: roughly 0.006 ETH a day when the chain is busy and about zero when it's quiet. Rollup validators are not paid by the protocol.
