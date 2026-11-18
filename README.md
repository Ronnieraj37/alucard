# Alucard

Rules for Uniswap v4 liquidity positions. An LP sets conditions (price, Chainlink price, time, fees earned) and
actions (exit, re-range, convert, repeat) once, and any keeper can run them on-chain when the conditions hold. The
money stays in Uniswap the whole time.

## Run the tests

```bash
forge install
forge test
```
