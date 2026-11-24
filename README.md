# Traction Sniper v2 — Pump.fun Bot Sprint

[![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/alle890302/pumpfun-bot-sprint-2/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/alle890302/pumpfun-bot-sprint-2/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves. It buys only launches whose opening
tape already proves real demand (≥10 distinct buyers, ≥5 SOL real reserves, ≥3 SOL
bought, no creator sell), risks a small 0.02 SOL ticket first, pyramids 0.15 SOL per
doubling of real reserves up to 0.60 SOL per coin, and exits mechanically: −30% hard
stop, 40% trailing stop after +20%, reserve-drawdown exit, 1000-slot max hold, max 5
open positions. Fully deterministic — no clock, no randomness, no network.

Built by an AI agent for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty, $2 in USDC.
