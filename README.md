# Open Brain Local

A local-first, self-owned memory layer that any AI tool can plug into — one database, one gateway, running entirely on your own machine.

## Relationship & license

Open Brain Local is an **independent, local-first implementation of the "Open Brain" concept introduced by Nate B. Jones**. Nate's reference implementation, **OB1**, lives at <https://github.com/NateBJones-Projects/OB1>.

This project is **not affiliated with, endorsed by, or officially connected to** Nate B. Jones or OB1. It is a clean-room reimplementation of the *concept* — a single, user-owned knowledge/memory store that multiple AI tools share (for example, over the Model Context Protocol) — and it does **not** fork or redistribute OB1's source code. Where OB1 targets free-tier cloud services, Open Brain Local targets a fully local stack: a local database, a local AI gateway, and no SaaS dependency.

"Open Brain" and "OB1" remain the work of their author. The code in this repository is licensed under the [MIT License](LICENSE); refer to the OB1 repository for its own license terms.

## Concept

Every AI tool keeps its own siloed memory, so each new chat or tool starts from zero. Open Brain flips that around: **you** own one memory store, and every AI plugs into it. Open Brain Local pursues the same goal without any cloud service — your data and the gateway stay on your machine.

## Status

Early scaffold — repository initialized. Implementation to follow.
