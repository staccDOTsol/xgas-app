# Run your own xgas Orbit L4 node (chain 466302)

The xgas Orbit L4 is an Arbitrum Orbit rollup whose parent is Robinhood Chain (#4663).
Every batch is posted in full as calldata to the SequencerInbox on Robinhood, so a node needs nothing
but a Robinhood RPC to rebuild the chain and verify its state. There is no data availability committee
and no batch-data endpoint to depend on.

    docker run --rm -it -v $PWD/xgas-node:/home/user/.arbitrum -p 8547:8547 \
      offchainlabs/nitro-node:v3.11.4-7d5ac27 \
      --chain.info-json="$(curl -s https://xgas.dev/chain-info.json)" \
      --chain.name=xgas \
      --parent-chain.connection.url=https://rpc.mainnet.chain.robinhood.com \
      --execution.forwarding-target=https://xgas.dev/rpc \
      --http.api=net,web3,eth,arb --http.corsdomain=* --http.addr=0.0.0.0 --http.vhosts=*

`--chain.name` must match `chain-name` in chain-info.json, which is `xgas`.
Any Robinhood RPC works; use your own provider if you can. The public one prunes old state, which only
matters while the node catches up.

Without a sequencer feed, your node sees new blocks when their batch lands on Robinhood (at most about
5 minutes behind the sequencer). Transactions you send to it are forwarded to the sequencer.

Sequencer (ordering and liveness) is operated by xgas.dev; reads and state verification need no trust in it.
Validation is permissionless: to post or challenge assertions, see https://xgas.dev/run-a-validator.md.

Batches: SequencerInbox 0xCA038a032154d0091b019A9104b369F94FD5c75F on Robinhood.
Assertions: Rollup 0x5868266C0c0663f4bc39329B525884f137BAD93E on Robinhood (validator whitelist disabled).
Deposits: Inbox 0xa7087693676F2Ca8e5e9563A6859952258688146. Withdrawals: Outbox 0xA6f07dd42CFE78EC8D88484b238b3B05149Eb2b3.
Fast confirmation: 2-of-3 Safe 0x17fC7585A3c99ACC2A7CFC1842C119d7FBB12cBC, owned by the three validator keys.
Chain owner: 0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F (UpgradeExecutor 0x43E881A831Ec5680aa6f63d2b48913050038b9F9; can upgrade the core contracts and force-confirm).
Gas token: XMoney 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E on Robinhood (owner: 24h timelock 0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B).
Source: https://xgas.dev/source/

The previous chain, 466301, is retired. It was an AnyTrust chain whose batch data lived only on its
committee, so a new node cannot sync it.
