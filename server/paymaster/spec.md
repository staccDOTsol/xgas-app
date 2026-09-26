# XgasDevPaymaster wire format (server side)

Source of truth: contracts/src/aa/XgasDevPaymaster.sol. This file restates it for the server;
server/paymaster/sign.mjs implements it and server/paymaster/test/*.test.mjs pins it (including a check
against the compiled contract's getHash on anvil when contracts/out is built).

EntryPoint v0.7 (PackedUserOperation). Chain 466302.

## paymasterAndData

```
offset  size  field
0       20    paymaster address                        (EntryPoint layout)
20      16    paymasterVerificationGasLimit uint128    (EntryPoint layout)
36      16    paymasterPostOpGasLimit uint128          (contract requires >= 25,000; the server signs >= 30,000, default 40,000)
52       6    validUntil        uint48 (unix seconds, big endian)
58       6    validAfter        uint48
64      32    maxXgasDevCharge  uint256 (XGAS.DEV wei, 18 dp, on Robinhood 4663)
96      20    robinhoodPayer    address (the EOA whose XGAS.DEV on Robinhood pays)
116     65    signature         r(32) | s(32) | v(1)
```

paymasterData (what ERC-7677 `pm_getPaymasterData` returns) is bytes [52:181]:
`abi.encodePacked(uint48 validUntil, uint48 validAfter, uint256 maxXgasDevCharge, address robinhoodPayer, bytes signature)`, 129 bytes.

## hash

```
opPart = keccak256(abi.encode(sender, nonce, keccak256(initCode), keccak256(callData), accountGasLimits,
                              uint256(bytes32(paymasterAndData[20:52])), preVerificationGas, gasFees))
hash   = keccak256(abi.encode(opPart, block.chainid, address(paymaster), uint48 validUntil, uint48 validAfter,
                              uint256 maxXgasDevCharge, address robinhoodPayer))
```

Signed as an EIP-191 personal message of the 32-byte hash (`toEthSignedMessageHash`); viem:
`account.signMessage({ message: { raw: hash } })`. A bad signature returns SIG_VALIDATION_FAILED (no revert), so the
stub signature below estimates like a real one:
`0x` + `f`x31 + `0` + `0`x32 + `7` + `a`x63 + `1c` (r = 0xff..f0 00..00, low s = 0x7aa..a, v = 28; 65 bytes)

## events the debit worker reads

```
XgasDevPaymaster:  XgasDevGasCharged(bytes32 indexed userOpHash, address indexed sender, address indexed robinhoodPayer,
                                     uint256 actualGasCost, uint256 actualUserOpFeePerGas, uint256 maxXgasDevCharge, bool succeeded)
EntryPoint v0.7:   UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster,
                                      uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)
```

Only logs emitted by the configured paymaster address count. The final xMoney cost is the EntryPoint's
UserOperationEvent.actualGasCost for the same userOpHash (it includes postOp gas and the unused-gas penalty);
XgasDevGasCharged.actualGasCost (measured before postOp) is the fallback.

## charge

```
charge = min(maxXgasDevCharge, ceil(actualGasCost * rateWad / 1e18))
```

`rateWad` = XGAS.DEV wei per xMoney wei (WAD, 10% buffer included) recorded in the ledger when the server signed
that userOpHash. `maxXgasDevCharge = ceil(maxCost * rateWad / 1e18)` where `maxCost` is EntryPoint's
requiredPrefund `(verificationGasLimit + callGasLimit + pmVerificationGasLimit + pmPostOpGasLimit + preVerificationGas) * maxFeePerGas`.
If a quote is missing from the ledger the current rate is used, still capped by the signed maximum.

Then `XGAS.DEV.transferFrom(robinhoodPayer, 0x000000000000000000000000000000000000dEaD, charge)` on Robinhood from the
debit wallet (DESK_RELAYER_KEY, or PAYMASTER_DEBIT_KEY), once per userOpHash.
