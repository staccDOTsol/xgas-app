# Sovereign Chain Kit: self-serve L3/L4s, deflationary units, and the funds that list them

Date: 2026-10-18
Audience: a finance ministry, treasury or monetary authority of any state, including one whose currency does not exist yet; and the operator of the kit.
Reference implementation: xgas (Arbitrum Orbit chain 466302 on Robinhood Chain, native unit $xMoney).
Status: design brief. Not legal advice. Ranges are practitioner estimates; regulatory facts are as of mid-2026.

## 1. What you get

A self-serve kit. A state signs in, sets the dials, and gets its own settlement chain and its own unit. Then, when the unit has a holder base, the kit spawns the investment vehicles that let the rest of the world buy it through a brokerage account, up to an exchange-listed ticker.

- A rollup you own. An Arbitrum Orbit chain, L3 or L4 depending on the parent you choose. Your sequencer, your validators, your upgrade key.
- A native unit. The chain's gas token is your currency. Every transaction on it is quoted and settled in that unit.
- A mint authority that is yours. You issue more when you decide. We mint more, we go further.
- A burn on every transfer, at a rate you set. xgas runs 1 basis point. Economic activity retires supply on its own, with no committee.
- A levy router. A share of every fee path goes, by contract, to accounts you name: a pension account, an education line, a stabilization fund.
- A bridge to the outside. Parent-chain liquidity, USDG, ETH, and a canonical ERC-20 of the unit on Ethereum mainnet so custodians and funds can hold it.
- Public read endpoints. Supply, reserve, mint log, burn total, reserve ratio, validator set. Anyone can verify, any time.
- A fund spawner. One button per tier: a private fund for the unit in weeks, a tokenized share class, a European exchange-listed product in a couple of months, a US Nasdaq listing once the unit has a futures market. Section 6.

The unit can be a currency that exists today, or one nobody has seen before. The kit does not care. A new unit starts from a genesis mint and earns demand the same way any money does: by what it can be used for and what backs the rules.

## 2. Issuance: mint and burn as one machine

Two levers, both yours.

- Mint, M: new units per year, issued by the authority you define.
- Burn, b: the fraction of each transfer destroyed. With velocity v (how many times a unit moves per year) and supply S, the burn retires b × v × S per year.

Supply changes by M minus b × v × S. It stops growing where mint equals burn:

    S* = M / (b × v)

Read it this way. You can run a permanent mint of M per year and supply does not grow without bound, because use retires it. The more the unit is used, the more you can mint at constant supply. Mint more, go further, is literally true as long as use grows with it.

Steady-state supply per one unit minted each year:

| Burn rate | Velocity | Steady-state supply |
|---|---|---|
| 1 bp | 12 | 833 |
| 1 bp | 50 | 200 |
| 10 bp | 50 | 20 |
| 50 bp | 50 | 4 |
| 50 bp | 200 | 1 |

At xgas's 1 bp the brake is gentle and supply settles high. A sovereign that wants supply to track use tightly picks a higher burn. The dial is yours.

Price is the other side. What a unit is worth is demand to hold it divided by supply. Minting past demand depreciates the unit; that is the inflation tax, paid by whoever holds it, and the burn does not change that. What the burn changes is how fast supply answers to use. What the public ledger changes is whether outsiders will hold the unit at all. A legible, rule-bound mint is what gets them to hold it, and their holding is what makes each minted unit worth something. The funds in section 6 are how that holder base gets large: they turn the unit into something a pension fund in Ohio can own.

## 3. What a treasury gets

Four channels. They add.

1. Seigniorage. Every unit minted and spent by the state is revenue, worth whatever the market pays for the unit that day. Bounded by demand to hold, which is what the fund layer grows.
2. Levy. The fanout on private volume. Rate times volume, to the account you name. Exempt your own flows; taxing yourself is a wash.
3. Borrowing cost. A verifiable, rule-bound unit is a currency board anyone can check from a phone. Credibility lowers the sovereign curve. For a large debtor this is the biggest channel by an order of magnitude, and the slowest, because it arrives as debt rolls over.
4. Repatriation. A domestic savings unit that appreciates with activity, because the burn accrues to holders, pulls savings out of foreign stablecoins and back into your unit. That is a captive buyer base and lower funding cost, achieved without capital controls.

## 4. The dials

| Parameter | xgas today | Your choice | What it does |
|---|---|---|---|
| Unit name, decimals | $xMoney, 18 | Anything | Identity |
| Genesis supply | 0; minted only against USDG deposits | 0 or N | A new currency starts from N |
| Mint authority | Vault only, no discretionary mint | Single key, multisig, timelock, legislature-held key; per-period cap or none | Discretion up, outside demand down. Rule-bound mint is what gets held |
| Transfer burn | 1 bp, constant | 1 to 100 bp | Higher burn = tighter supply, lower velocity |
| Levy rate and destinations | 1 bp fanout + 2 bp buyback on trade paths | Any split to any accounts | Direct fiscal line, by contract |
| Exemptions | Bridge-bound transfers (required) | Add state flows (recommended) | The Orbit bridge mints exactly what it receives, so bridge transfers must be tax-exempt; xgas already handles this |
| Reserve policy | Full: 1 USDG per unit, published as r/s | None (pure fiat), partial, full | Full reserve = currency board credibility; none = pure seigniorage |
| Reserve asset | USDG | USDG, EUR stablecoin, tokenized gold, your own bonds | What the ratio is measured against |
| Parent chain | Robinhood Chain (settles to Ethereum) | Ethereum, Arbitrum One, Robinhood, your own | A neutral parent buys credibility |
| Data availability | Rollup, all data on parent | Rollup or AnyTrust committee | Cost versus verifiability |
| Validation | Permissionless, 3-of-3 fast-confirm Safe | Open or whitelisted | Who can challenge the state |
| Upgrade key | Chain-owner key, instant, no delay | Retained, timelocked, multi-party, or burned | The single biggest credibility dial. Surrendered key = currency board. Retained key = discretion, priced in |
| Transparency | r/s, supply, fee schedule via public tools | Add mint log, burn total, validator set | What the world can verify |
| Fund tier | None | Private, tokenized, EU-listed, US-listed | Who outside can buy, and through what account |

## 5. Sizing guidance

So the dials are set for the problem, not for the slogan. France is the worked example because the numbers are public.

Levy alone, to raise €2 billion a year (the CAS Pensions deficit):

| Levy rate | Annual volume required | Reference |
|---|---|---|
| 1 bp | €20T | ~27× all French card payments (~€750B/yr) |
| 4 bp | €5T | ~7× French card payments |
| 0.4% (France's existing financial transaction tax) | €500B | ~2/3 of French card payments |

Channels at France scale, generous assumptions (all €3T of public flows and €1T of private payments on-chain, state holds half the float):

| Channel | Yearly result | Against the €2B hole |
|---|---|---|
| 1 bp burn, all flows, state's holder share | €200M | 10% |
| 4 bp levy, private volume only | €400M | 20% |
| 4 bp levy on the state's own flows | €1.2B, state paying itself | 0% net |
| Holder yield, burn × velocity, velocity 12 | 0.12% a year | No fundamental premium |
| 10 bp off a €3.4T debt stock | ~€3.4B after full rollover, ~€300M in year one | The line that reaches the hole |

What this says for setting the dials:

- Levies need volume. Set them at rates the state already charges elsewhere, on private flows, and exempt your own.
- Mint needs demand. Seigniorage is real revenue and it is paid by holders; the bigger the holder base, the more you can mint. The holder base follows the rules you publish, the key you surrender, and the wrappers that let outsiders buy.
- The burn is a brake, not a revenue line. A unit that appreciates when others spend it gets hoarded, which lowers velocity, which weakens the burn. Price the burn as a supply rule, not as income.
- One-time capital does not close a recurring deficit. An endowment covering €2 billion a year at 4% real is €50 billion. Recurring channels are what close recurring gaps.

Eurozone members cannot mint euros. For them the unit is a parallel one: a tax-anticipation unit accepted at par for taxes and fees. California's 2009 registered warrants traded near par on exactly that acceptance. Italy's 2019 mini-BOT and Greece's 2015 parallel-unit plans were never launched. Tax acceptance by statute is the demand source a eurozone state controls.

## 6. Spawning funds: the capital-markets layer

The chain is software and spawns in minutes. A fund is a legal person with a custodian, an auditor and a regulator, and it spawns on a pipeline. Self-serve means the state presses one button and the pipeline runs on templates the kit operator already owns. Four tiers, each a button, each with a real clock.

### 6.1 The tiers

| Tier | What it is | Who can buy | Time per spawn | Marginal cost per spawn | Self-serve? |
|---|---|---|---|---|---|
| 0. On-chain wrapper | The unit itself, plus its Ethereum ERC-20 and vault receipts | Anyone with a wallet | Minutes | Gas | Yes |
| 1. Private fund | One series of a Delaware series LP; the operator is the adviser; Reg D 506(c), Form D within 15 days of first sale, exempt reporting adviser under $150M aggregate | Accredited investors worldwide, Reg S for non-US | 1 to 3 weeks | $10k to $30k legal and setup, then admin and audit | Yes, the AngelList model |
| 2. Tokenized share class | Tier 1's LP interests issued as tokens on the unit's own chain; transfer-restricted; secondary trading on a registered ATS | Same as Tier 1, with on-chain settlement | +1 to 2 weeks | +$20k to $50k | Yes |
| 3. EU exchange-listed ETP | A note from an issuer SPV under one approved base prospectus; each new unit is a final-terms supplement; listed on Nasdaq Stockholm, SIX, Xetra or Euronext; collateralized with the unit at a custodian; market maker quotes it | Any European retail or institutional brokerage account | 4 to 8 weeks once the base prospectus exists | $50k to $150k | Templated, operator-run |
| 4. US Nasdaq-listed ETP | A grantor trust under the Securities Act, one series of the operator's Delaware statutory trust; S-1, Form 8-A, listed under the 2025 generic listing standards for commodity-based trust shares; custodian, administrator, authorized participants, benchmark provider | Any US brokerage account | 9 to 15 months, of which 6 is futures seasoning | $300k to $700k, then $200k to $500k a year | Templated, operator-run, gated by liquidity |

### 6.2 The Nasdaq paths

There are three ways to a Nasdaq ticker, and they are not the same Nasdaq.

Nasdaq Stockholm first. It already lists crypto exchange-traded products from CoinShares and Virtune. European ETPs run on a base prospectus approved by one regulator, commonly Sweden's, and passported across the EU; each new product is a final-terms filing. Issuers like 21Shares and Valour launch dozens of products this way, including assets with no futures market. The product is a transferable security under MiFID, so MiCA does not govern it. This is the fastest listed ticker a sovereign unit can get: weeks per product once the operator's shelf exists.

Nasdaq US second. Since September 2025 the exchanges can list a commodity-based trust without a bespoke rule change when the asset meets a generic standard: six months of futures trading on a CFTC-regulated designated contract market with surveillance sharing, or trading on a market in the Intermarket Surveillance Group, or an existing listed fund with at least 40% exposure. In-kind creations and redemptions are allowed since July 2025. The pipeline for a new unit is therefore: spot liquidity on venues a benchmark provider recognizes, a futures listing on a designated contract market (Coinbase Derivatives, Bitnomial, CME) which the market self-certifies to the CFTC in a day but will only do for an asset with real spot volume, six months of seasoning, then the S-1 off the operator's template. No futures market, no generic listing, and the bespoke 19b-4 route is a year of its own.

Treasury company third. A Nasdaq-listed shell that holds the unit on its balance sheet, funded by a PIPE, the model dozens of companies copied in 2025. It is the fastest way to a US ticker tied to an asset, it costs a reverse merger plus $2M to $5M, it trades at a premium or discount to net asset value rather than tracking it, and Nasdaq now applies its 20% shareholder-approval rule to share issuance that funds crypto purchases. Use it when you want a stock, not a fund.

One open question worth a counsel memo. The exchanges have separate, older generic standards for Currency Trust Shares, the Invesco CurrencyShares model, where a grantor trust holds a foreign currency on deposit. A unit that is a sovereign's legal tender might be argued into that category rather than the crypto one. Nobody has tested it. If it holds, the futures seasoning requirement falls away for the state's own money.

### 6.3 What the operator has to be

To make the buttons real, the kit operator owns a shelf at each tier.

| Shelf | What it is | One-time cost | Time to stand up |
|---|---|---|---|
| Fund formation stack | Series LP, template PPM and subscription docs, Form ADV as exempt reporting adviser, then registered investment adviser past $150M; fund administrator and auditor on contract | $150k to $300k | 2 to 3 months |
| Tokenization rail | Transfer-restricted share tokens, a registered ATS partner for secondary trading | $50k to $150k | 1 to 2 months |
| EU ETP shelf | Issuer SPV (Jersey, Switzerland or Sweden), base prospectus approved and passported, listing agreements, market maker, custodian, collateral agent, paying agent | $750k to $1.5M | 6 to 9 months |
| US ETP shelf | Delaware statutory series trust, trustee, administrator, custodian, authorized-participant agreements, benchmark provider agreement, S-1 template with staff comments already absorbed by product one | $1M to $2M | 9 to 12 months, carried by the first product |
| Distribution | A FINRA broker-dealer, owned or partnered, for marketing listed products in the US | $250k to $500k, or a partner's fee | 6 to 9 months |

All shelves: roughly $2M to $4M and a year. After that each spawn is the marginal cost in 6.1. Revenue to the operator is the sponsor fee on every product, 0.25% to 2.5% of assets a year, plus the chain's own levy. That is the business: the kit is a sponsor platform whose products happen to be sovereign units.

### 6.4 Gates on every spawn

A button can run a pipeline. It cannot waive these.

- Custody. Custodians support chains, not promises. Every unit gets a canonical ERC-20 on Ethereum mainnet through the kit's bridge, and that is what funds hold.
- Benchmark. A US ETP needs a reference price from a provider like CF Benchmarks or CoinDesk Indices, which needs the unit trading on several recognized spot venues. A unit that trades only on its own chain has no benchmark.
- Assets. A listed product needs an authorized participant and a market maker willing to quote it. Below roughly $50M of expected assets a US ETP does not pay for itself; a European ETP clears at a few million.
- Classification. Under the GENIUS Act a token pegged to a national currency and redeemable near par is a payment stablecoin and needs a permitted issuer or a Treasury comparability finding. A floating sovereign unit is not, and is analyzed as a foreign currency or foreign-government instrument. The state picks which one it is before any US product.
- Sanctions and identity. The operator screens every issuing state and every fund investor. A self-serve kit with no gate makes the operator liable the first time a sanctioned government uses it. Nation-state friendly means the door is open to every state the operator is permitted to serve, and verifiably closed to the rest.
- Disclosure. Every offering document states the mechanics plainly: holder return equals burn times velocity times share, under 1% a year at plausible numbers; mint authority and its cap; upgrade-key powers; reserve policy. True statements are cheap. Untrue ones are Section 11 liability.

### 6.5 The pipeline behind the button

| Step | Who | Clock |
|---|---|---|
| State sets dials, chain and unit deploy, Ethereum ERC-20 and bridge live | Kit, automated | Minutes |
| Tier 1 private fund series opens, Form D filed after first close | Operator's adviser entity, templated | 1 to 3 weeks |
| Tier 2 tokenized class issued on the unit's chain | Kit | +1 to 2 weeks |
| Unit listed on recognized spot venues; benchmark provider adds it | State and operator, market work | 1 to 6 months |
| Tier 3 final terms filed, EU listing | Operator's issuer SPV | 4 to 8 weeks |
| Futures self-certified on a designated contract market | DCM partner, needs spot volume | 1 day to list, 6 months to season |
| Tier 4 S-1 filed off the template, Form 8-A, Nasdaq generic listing | Operator's trust | 3 to 6 months after seasoning |

From first click to a US Nasdaq ticker: about a year for a unit that earns real volume, never for one that does not. From first click to a European listed ticker: about two months once the shelf exists.

## 7. Deployment path from xgas today

What already exists and has been run twice on mainnet (chains 466301 and 466302):

- Orbit rollup creation through the canonical RollupCreator with a custom ERC-20 gas token.
- A tax-token gas asset whose bridge-bound transfers are exempt, which solves the Orbit exact-mint constraint (XMoney.sol).
- A reserve vault with enter and exit, entry burn, a permanent bridge solvency buffer, and a 24-hour timelocked owner.
- A fanout sink and buyback, fee paths on the chain (escrow, FOMO, router, NGU), a fleet of launch primitives (drops, CLMM, pawn).
- Auto-executed withdrawals through the Outbox, a 3-validator fast-confirm Safe, node images for rollup and AnyTrust modes, a public RPC, an MCP tool surface, a site.

What the self-serve kit adds on-chain:

- A chain factory: one flow that deploys the gas token, creates the rollup, deploys vault, fanout and fleet, and provisions nodes from the dials.
- A mint function on the gas token behind the authority the state chooses, with an optional per-period cap. Today xgas mints only against vault deposits and its fee constants cannot change.
- Burn rate, levy split and destinations as deploy-time parameters.
- Reserve policy modes in the vault: none, partial, full.
- A canonical Ethereum-mainnet ERC-20 of every unit, for custodians.
- A public mint log and burn counter.
- The upgrade key behind the same delay or multi-party control the state picks for mint. Today the chain-owner key upgrades the bridge, inbox and outbox instantly.
- An onboarding gate: identity and sanctions screening of the issuing authority before the factory runs.
- Node operations the state runs or rents: sequencer, batch poster, validators, parent-chain gas funding, a deploy pipeline that replays forge plans with node gas estimates.
- An audit. xgas is unaudited alpha software; a sovereign deployment is audited before genesis.

Off-chain, the operator builds the shelves in 6.3. A reference chain deployment on a test parent takes weeks. A mainnet deployment with the state's own operators and an audit is a quarter or more. The fund shelves are a year.

## 8. Legal position by audience

- Your own residents: your law. A unit accepted for taxes has demand by statute, and a sovereign issuer regulates itself.
- EU residents: MiCA excludes central banks and other public authorities of Member States acting in that capacity, so a unit issued by the state itself sits outside it. A unit issued by a private vehicle on the state's behalf and referencing a single fiat is an e-money token, which only a credit institution or EMI may issue. Issue it as the state, or through a licensed EMI partner. The listed ETP on top is a MiFID security either way. Verify the exclusion with counsel for the specific issuing entity.
- US persons: the GENIUS classification in 6.4, then the fund tiers in 6.1.
- The operator: an investment adviser from the first Tier 1 fund, a securities issuer from the first ETP, a broker-dealer or a partner for US distribution, and a sanctions-screening obligation from day one.

## 9. Precedents

| Attempt | Outcome | Why |
|---|---|---|
| Venezuela Petro, 2018 | Dead by 2024 | Discretionary issuer, unverifiable reserve, no tax acceptance |
| Marshall Islands SOV | Never launched | No rail, no demand source |
| Central African Republic Sango | Dead | Same |
| El Salvador volcano bond | Never issued at scale; 2024 IMF program rolled bitcoin back | Fiscal side overrode it |
| Currency boards: Hong Kong, Bulgaria | Work | Rule-bound issuance, verifiable reserve, surrendered discretion |
| Argentina convertibility, 1991 to 2001 | Broke | Board held; fiscal deficit did not |
| California registered warrants, 2009 | Traded near par | Tax acceptance by statute |
| Tokenized sovereign debt: Hong Kong, Slovenia, EIB | Work, small | Distribution upgrade for bonds |
| AngelList rolling funds and syndicates | Work at scale | Self-serve private funds on one adviser and one template set |
| 21Shares, CoinShares, Valour on SIX, Xetra, Nasdaq Stockholm | Work, dozens of products | One base prospectus, a final-terms filing per product |
| Invesco CurrencyShares | Work for two decades | Grantor trusts holding foreign currency, listed on an exchange |
| 2025 crypto treasury companies | Mixed, many below asset value by year end | Fast ticker, no tracking, now needs shareholder approval for issuance |

The pattern: demand comes from tax acceptance and verifiable rules. Discretion is priced in by everyone who might hold the unit. Listed wrappers multiply the holder base only for units that already have one.

## 10. Decision checklist

For the state:

1. Which unit: an existing currency, or a new one from genesis?
2. Who holds the mint key, with what cap and what delay?
3. Burn rate. Levy rate and destinations. State flows exempt?
4. Reserve policy: none, partial, full. Reserve asset.
5. Parent chain and data availability.
6. Upgrade key: retained, delayed, multi-party, or burned.
7. Tax acceptance by statute?
8. Pegged or floating, for US classification.
9. Which fund tier now, and what volume target unlocks the next.

For the operator:

1. Which shelves to build first. Formation stack and EU ETP shelf give listed tickers within a year for under $2M; the US shelf is the second year.
2. Adviser registration path and the fund administrator.
3. Custodian and benchmark partners that will add new units on request.
4. A designated contract market partner for futures.
5. The sanctions and identity gate in front of the factory.
6. Audit of the factory contracts before the first sovereign genesis.

## 11. Bottom line

Your chain, your unit, your mint, from a button. Mint more and go further, exactly as far as the demand to hold the unit reaches. The burn ties supply to use. The public ledger and the key you surrender are what make the mint worth something. The fund spawner is how the holder base gets large: a private fund in weeks, a European listed ticker in two months, a US Nasdaq ticker in about a year for any unit that earns real volume. Levies need volume, so set them at rates you already charge and only on private flows. For a large debtor the biggest line is borrowing cost, earned slowly by being checkable.

## Appendix: xgas live facts, 2026-10-18

| Metric | Value |
|---|---|
| Vault USDG reserve | $265.72 |
| Circulating $xMoney | 265.61 |
| Reserve ratio r/s | $1.00042 per unit |
| Lifetime USDG deposited | $307.80 |
| Lifetime USDG raked to the fanout | $0.034 |
| Lifetime $xMoney burned | 0.0597 |
| Fee rates | 1 bp enter rake, 1 bp entry burn, 1 bp transfer burn, 1 bp exit rake; 4 bp on OTC and NGU trades |
| Chain owner key | Instant upgrade power over bridge, inbox, outbox; vault owner is a 24h timelock |
| L4 public RPC | Sequencer unreachable at time of writing; operators have the fix in hand |
