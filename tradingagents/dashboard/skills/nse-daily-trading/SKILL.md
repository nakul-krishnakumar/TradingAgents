---
name: nse-daily-trading
description: Prepare the Market Desk pre-market briefing for liquid NSE cash equities using dated exchange disclosures, the supplied watchlist, and the desk's intraday research rules. Use for the 09:00 IST brief and for explaining a saved daily setup.
---

# NSE daily trading research

Write a concise morning brief using only supplied evidence. Open with the exchange session date and the latest observation time. Give a short watchlist with the relevant catalyst, source, and why it is worth monitoring. Mention a known restriction, event, or missing input where it changes the interpretation. Close with the first condition the scanner will check after the market opens.

Prefer NSE corporate announcements, board-meeting notices, and corporate actions. A company release can give context if supplied. Include the filing timestamp or date and original source link with any material claim. Distinguish an announced result from a scheduled event, and an old report from a fresh catalyst. Use an exchange symbol for every company. Avoid attaching a market direction to a filing without price and volume evidence. Treat a social mention as an attention signal and require independent confirmation for any factual claim.

At 09:00 IST use the previous completed regular session for prices and liquidity. Pre-open indicative values can change. An opening range, gap based on the continuous-session open, or same-session VWAP requires regular-session candles. If the brief has no current filing or live observation, say so plainly and describe the watch condition that could change the view.

The desk supplies candidate status, entry conditions, levels, and sizing from its cash-equity rules. Explain supplied values without revising them. The three experimental setups are a 15-minute opening range break confirmed by relative volume, a VWAP reclaim after a pullback, and continuation of a moderate positive opening gap. Confirmation uses completed five-minute bars. Replay models the next opening price within the entry range. A broker-confirmed indication also requires a current quoted ask within that range. An exit is the invalidation level, target, or time cutoff for a simulated long setup. The desk stops proposing new entries at 14:45 IST and uses 15:00 IST as its planned time exit.

The daily capital defaults to ₹5,000. Report the supplied estimated stop scenario and cash commitment if relevant. Stop risk as a share of daily capital is an estimate using the modelled stop, charges, and slippage. An illiquid exit or gap through the stop can cost more. The Low, Medium, High, and Very High labels describe stop distance and supply no probability of profit or loss. Avoid treating separate setups as a combined allocation unless a shared budget has been modelled.

Supply a conditional research brief. Use only numbers, timestamps, and evidence in the input. Leave order instructions, price forecasts, modelled profits, win rates, and catalysts unsupported by the input out of the brief. Read [strategy evidence and validation](references/evidence.md) when auditing a setup, checking an exchange rule, or translating an external research result to NSE cash equities.
