# Explain the Ghidorah demonstration

## The short pitch

“We built a simulated operational-intelligence platform for oilfield water disposal. It connects equipment readings to the wells they affect, estimates when a tank could reach its shutdown threshold, compares response costs, and shows operators the evidence behind a recommendation.”

## What each piece means

| Piece | Plain-language explanation |
|---|---|
| Wells | Produce oil and gas, along with water that must be handled. |
| Tank | Temporary water storage. Its capacity limits how long production can continue when water removal is constrained. |
| Pump and pipeline | Move water toward disposal. A stopped pump is not automatically a failure; the backend distinguishes normal cycling from explicit fault status. |
| Warning at 85% | Draws attention while storage remains below the configured shutdown threshold. |
| Shutdown threshold at 92% | A fictional/demo protection setting loaded from the network configuration. |
| Time until shutdown | A conditional estimate using remaining storage and observed net inflow, or the tabletop sensor's level trend. It is withheld when evidence is insufficient, stale or draining. |
| ML | Classifies running-pump observations as normal, possible leak, or possible degradation using current and recent flow/pressure features. It can withhold a label. It does not predict an exact mechanical failure time or operate shutdowns. |
| Cost planner | Compares modeled production loss and feasible responses, including shared truck availability and delayed well shut-ins. |
| Complete field shutdown | A software-only latch that sets effective modeled production to zero while preserving observations and continuing sensor monitoring. |
| Audit log | Records which condition or policy caused a decision and which operator actions were reviewed. Acknowledgement does not resolve a fault. |

## A three-minute presentation

1. **Explain the problem.** “When water cannot be removed quickly enough, tank storage becomes a production constraint. Operators need to know the affected wells, the time available, and the cost of possible responses.”
2. **Open the recorded snapshot.** Run `npm.cmd start` and open http://127.0.0.1:5173. Identify the S2 pump faults and connected facilities. Explain that this is supplied synthetic challenge data, viewed at its recorded time.
3. **Show the economics.** “For this S2 snapshot, our model selects trucks for facilities A and B and a delayed shut-in of well C1. The response costs about $3,120.94, versus $12,214.94 for accepting shutdowns—a modeled saving of about $9,094.” These are simulated results under the supplied rates/prices and expected repair times.
4. **Show live updates.** Use **Start water mock**, or a manually calibrated Arduino setup. Explain “The reading enters through a receive-only Node bridge. SpacetimeDB updates the shared state, and the dashboard receives subscriptions.” The mock is a synthetic water-level sequence; a real board is a tabletop ingestion demonstration, not real oilfield equipment.
5. **Explain the warning countdown.** “At 85%, we show an estimated time to 92% when enough fresh evidence exists. Tabletop time is seconds; field time is hours/minutes. A paused recording does not count down against today's wall clock.”
6. **Show complete simulated protection.** **Demo: all at risk** loads an explicitly generated counterfactual scenario. All 45 network wells go to zero effective modeled production. Explain that this is a protective policy when all producing facilities are forecast affected. It can fire even if selective mitigation is cheaper. The separate economic rule fires only when a full stop wins the completed modeled comparison under explicit cost assumptions.
7. **Close with trust boundaries.** “We preserve the original observations, label unknown data, expose cost assumptions, record decisions, and reject a restart while the trigger remains. No equipment commands are sent.”

## Describe the technology

“TypeScript and Node.js handle data loading and the USB bridge. A TypeScript SpacetimeDB module stores shared state and runs the decision logic. React, Vite, Blueprint and GoldenLayout provide the connected dashboard. Our trained model runs locally, and the Arduino UNO R4 is supported through USB serial. Gotham inspired the linked asset context, evidence and operator workflow; we do not use Palantir services.”

## Be precise about results

- The improved classifier achieved macro F1 0.99386 versus 0.97374 for the frozen original model on the same final synthetic test period. This is one synthetic network, not independent field validation or a real-world failure-probability claim.
- The training pipeline fits weights on the first 30% of time, uses the next 15% for selection/temperature, and evaluates the final 55%. Runtime inference never reads practice answer keys.
- ML supplies inspection evidence. Threshold/flow forecasts and explicit economic/protection policy control simulated decisions.
- Avoidable operating cost and shutdown/restart costs are explicit demo assumptions, defaulting to zero because the challenge files do not supply them. Do not present hypothetical inputs as EOG's actual costs.
- The planner returns a feasible best-found result within a bounded search, with its scope/truncation disclosed. Do not claim unrestricted global optimality.
- The physical Arduino setup still requires calibration, wiring verification and bench testing. Mock tests validate the software path only.

See [ARCHITECTURE.md](ARCHITECTURE.md) for every component's file location and [SETUP.md](SETUP.md) for startup commands.
