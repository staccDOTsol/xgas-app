# Run your own xgas Orbit L4 node (chain 466301)

The xgas Orbit L4 is an Arbitrum Orbit (Nitro, AnyTrust) chain whose parent is Robinhood Chain (#4663).
Anyone can run a full node and verify state independently of xgas.dev, as long as the node can fetch batch data.

> **Status, 26 Sep 2026: the batch-data endpoint is down.** The rest-aggregator URL below
> (https://xgas.dev/das) does not answer, because the DAS port is not exposed on the node host.
> Until it is restored, a third-party node cannot fetch batch data and cannot sync past the
> batches it already has. This note will be removed when the endpoint is back.

    docker run --rm -it -v $PWD/xgas-node:/home/user/.arbitrum -p 8547:8547 \
      offchainlabs/nitro-node:v3.11.4-7d5ac27 \
      --chain.info-json="$(curl -s https://xgas.dev/chain-info.json)" \
      --chain.name="xgas Orbit L4" \
      --parent-chain.connection.url=https://rpc.mainnet.chain.robinhood.com \
      --node.da.anytrust.enable=true \
      --node.da.anytrust.rest-aggregator.enable=true \
      --node.da.anytrust.rest-aggregator.urls=https://xgas.dev/das \
      --execution.forwarding-target=https://xgas.dev/rpc \
      --http.api=net,web3,eth,arb --http.corsdomain=* --http.addr=0.0.0.0 --http.vhosts=*

Sequencer (writes) is operated by xgas.dev; reads and state verification need no trust in it.
Batches: SequencerInbox 0x16Daa2551d41243C82366c8b94Dc11418Ac0AeD7 on Robinhood.
Assertions: Rollup 0x5Ba539b34b9F33036CC4788225149ce07Ba183a8 on Robinhood.
Gas token: XMoney 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E on Robinhood (owner: 24h timelock 0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B).
Source: https://xgas.dev/source/
