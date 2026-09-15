# Project State: Binary Options Quant

**Current Phase:** Commit 045 Complete (Single-Session Multi-Stream Recorder Live; XAU/USD 60s+5s Accumulation Started; H008 SPEC_DRAFT Eliciting — NOT FROZEN)

## Completed Milestones
1. **Commit 001 - Core Types:** MarketObservation, BinaryOutcome, Signal, ProbabilitySnapshot.
2. **Commit 002 - Mathematical Core:** TargetEngine, EVEngine, DatasetValidator, DecisionGate.
3. **Commit 003 - Signal Research Core:** SignalCore, FeatureEngine, RegimeEngine, SignalEngine.
4. **Commit 004 - Quantitative Evidence Laboratory:** Dataset, ReplayEngine, BaselineModel, CalibrationEngine, MetricsEngine, WalkForward.
5. **Commit 005 - Post-Audit Fixes:** Immutability, strict causality, pure market baseline, Wilson CI.
6. **Commit 006A - Synthetic Null Validation:** Mulberry32 PRNG null/edge detection tests. **[FROZEN]**
7. **Commit 006B - Real Market Baseline OOS:** BTCUSDT 1m Jan-24. Win rate 50.43% vs P_BE 55.56%. EDGE NOT DETECTED. **[FROZEN]**
8. **Commit 007 - Robustness / Adversarial Validation:** 100 tests / 28 suites. Temporal boundary, label permutation, data corruption, PUSH stress, Wilson CI math, Architecture A (cadence-agnostic Dataset). **[FROZEN]**
9. **Commit 008 - Strategy Hypothesis 001 (Short-Horizon Momentum / DisplacementModel):**
   - Ingested & Audited `DATASET_002` (BTCUSDT 1m Feb-May 2024, 174,240 rows). **[FROZEN]**
   - Implemented Causal `FeatureEngine` (Wilder's RMA ATR(14), Volume SMA(20)) & `DisplacementModel`.
   - Executed Blind Walk-Forward OOS Replay (114 rolling windows, 12,808 resolved signals).
   - Result: Win Rate 47.88% (95% Wilson CI [47.01%, 48.74%]), EV -0.1382 vs P_BE 55.56%. `EDGE NOT DETECTED`.
   - **CRO Tri-Proof Deliberation:** Sovereign **`VETO`** issued (`RISK_DECISION.json`).
   - **Classification:** **`FALSIFIED & ARCHIVED`**. No parameter rescue, no curve-fitting. **[FROZEN]**
10. **Commit 009 - Research Post-Mortem & Multiple Testing Governance:**
    - Formalized `008_POST_MORTEM.md` & `POST_MORTEM.json` with epistemic boundaries.
    - Fixed cryptographic hash lineage in `PROVENANCE_RECEIPT.json` and `EXP_008_MANIFEST.json`.
    - Established `research/governance/HYPOTHESIS_REGISTRY.json` for Family-Wise Error Rate control.
    - Instituted Research Information Barrier between research cycles. **[FROZEN]**
11. **Commit 010 - HYPOTHESIS-002 Formulation & Formal Freeze:**
    - Conceived `HYPOTHESIS_002` (Short-Horizon Mean-Reversion / Exhaustion Anomaly, v1.0.0).
    - 15 Mandatory Dimensions audited and validated via Quant-Grill.
    - Defined 3-candle expiry target ($180\text{s}$), fail-closed training probability, and 115 OOS windows.
    - Cryptographically hashed and registered in `HYPOTHESIS_REGISTRY.json` (`parent_hypothesis: HYPOTHESIS_001`). **[FROZEN]**
12. **Commit 011 - DATASET_003 Ingest & Audit + BASELINE_003_CONTROL Execution:**
    - Downloaded, validated and canonicalized `DATASET_003` (BTCUSDT Spot 1m Jun–Sep 2024, 175,680 rows, 0 gaps, hash: `3ed2064690b63516a559d10c4d8e7d8de60795f380668bc9c2d1544ad5c53638`). **[FROZEN]**
    - Implemented `src/governance/` OrchestratorGate, AuditLogger, Constants, with 43 passing test suites (147 tests).
    - Executed `BASELINE_003_CONTROL` on `DATASET_003` across 115 OOS windows with 3-candle expiry ($180\text{s}$).
    - Empirical Baseline Result: 163,675 resolved predictions, Win Rate 49.8922% (95% Wilson CI [49.65%, 50.13%]), EV -0.1019 vs P_BE 55.56%. `EDGE NOT DETECTED`. **[FROZEN]**
13. **Commit 012 - FeatureEngine Extension (`closeLocation`) & ExhaustionModel Implementation:**
    - Implemented `closeLocation` with zero-range division check (`high === low \implies null \implies \text{NO SIGNAL}`).
    - Implemented Wilder's RMA ATR(14) with bootstrap and Volume SMA(20) lookback ($[t-20 \dots t-1]$ excluding $t$).
    - Implemented `ExhaustionModel` with direction-specific train probability estimation ($\hat{P}_{\text{CALL}}$, $\hat{P}_{\text{PUT}}$).
    - Enforced fail-closed sample size ($N_{\text{Train, dir}} < 30 \implies \text{prob} = \text{null} \implies \text{NO SIGNAL}$) and overlap coexistence.
    - 49 test suites / 162 unit & adversarial tests passing (100%). **[FROZEN]**
14. **Commit 013 - Adversarial Validation Suite (HYPOTHESIS_002 Certification):**
    - Implemented `ReversedExhaustionModel` (Negative Directional Control).
    - Executed 1,000 label permutations with Mulberry32 PRNG (0 false positives).
    - Executed Synthetic Null Random Walk (Win Rate 51.88%, `EDGE NOT DETECTED`).
    - Executed Numerical Fuzzing & Chinese Wall Immutability verification.
    - Generated `ADVERSARIAL_AUDIT_002.json` with status `CLEAR_FOR_BLIND_OOS`.
    - 55 test suites / 170 tests passing (100%). **[FROZEN]**
15. **Commit 014 - Blind Walk-Forward OOS Replay (115 Windows) & Tri-Proof CRO Deliberation:**
    - Replayed H002 and Reversed Control across 115 rolling windows of `DATASET_003`.
    - Results: N = 2,049 trades, Win Rate = 52.2206% (95% Wilson CI [50.0556%, 54.3773%]), EV = -0.0600 vs P_BE = 55.5556%.
    - Comparative: Outperformed Baseline 003 Control (49.8922%, +2.33 pp) and Reversed Control (47.3787%, +4.84 pp).
    - **CRO Tri-Proof Deliberation:** Sovereign **`VETO`** issued (`RISK_DECISION.json`, `CRO_VERDICT.md`).
    - **Classification:** **`FALSIFIED & ARCHIVED`**. No parameter rescue, no curve-fitting. **[FROZEN]**
16. **Commit 015 - H002 Formal Scientific Post-Mortem & Research Family Ledger:**
    - Emitted `H002_POST_MORTEM.md`, `H002_POST_MORTEM.json`, `FAILURE_ANALYSIS.json`, `RESEARCH_LIMITS.md`.
    - Formulated Core Axiom: *Predictive Information != Economic Edge*.
    - Established Research Family Ledger (`SHORT_HORIZON_BTCUSDT_1M`) in `HYPOTHESIS_REGISTRY.json`. **[FROZEN]**
17. **Commit 016 - Cross-Hypothesis Meta-Analysis (H001 vs H002 Synthesis):**
    - Emitted full META_016 dossier (`META_ANALYSIS.md`, `META_ANALYSIS.json`, `H001_SYNTHESIS.json`, `H002_SYNTHESIS.json`, `DEPENDENCY_ANALYSIS.json`, `CALIBRATION_SYNTHESIS.json`, `GOVERNANCE_DECISION.md`).
    - Executed 10,000 paired block bootstrap resamples across 115 OOS windows (Difference vs Baseline: +1.35 pp, p = 0.2434; Difference vs Reversed: +2.73 pp, p = 0.2443).
    - Verified Expected Calibration Error (ECE = 0.0215) and directional symmetry.
    - Established dedicated `RESEARCH_FAMILY_LEDGER.json` and formally archived `SHORT_HORIZON_BTCUSDT_1M`. **[FROZEN]**

65. **Commit 017 - MTF Liquidity Microstructure Conception (H003 Pre-Registration):**
    - Established new Research Family `MTF_LIQUIDITY_MICROSTRUCTURE`.
    - Frozen pre-registration of `HYPOTHESIS_003` v1.0.1 (Multi-Timeframe Liquidity Microstructure Sweep).
    - Enforced rigorous `HTF_CANDLE_CLOSED_BEFORE(t)` strict causality matrix.
    - Specified dataset zero-contamination period: `2024-10-01` to `2025-03-31`. **[FROZEN]**
66. **Commit 018 - DATASET_004 Ingest & Audit + BASELINE_004_CONTROL Execution:**
    - Ingested and canonicalized `DATASET_004` (BTCUSDT Spot 1m, 262,080 candles, 0 gaps). **[FROZEN]**
    - Executed `BASELINE_004_CONTROL` against 152 OOS windows (Win Rate: 49.90%). **[FROZEN]**
67. **Commit 019 - MTF Feature Engine & Strategy Implementation:**
    - Developed `MTFFeatureEngine` with strictly accurate evaluation timing (`signalTimeMs = targetTimeMs + 60000`) for precise boundary logic.
    - Passed comprehensive tests ensuring MTF Historical Invariance and Exclusion of the structural forming candle. **[FROZEN]**
68. **Commit 020 - MTF Adversarial Validation Suite (H003):**
    - Executed 020-A (Future Injection), 020-B (Boundary Fuzzing), 020-C (Current-Candle Contamination).
    - Executed 020-D (Aggregate Determinism) and 020-E (H003 vs Reversed Identity logic check).
    - Verified 020-G (Synthetic Null) and 020-H (Immutability Hash). **[FROZEN]**
69. **Commit 021 - Genuine Blind OOS Execution (H003):**
    - `021` Synthetic test invalidated by CRO; executed `021-R Genuine Data Acquisition` direct from Binance Archive.
    - Verified `DATASET_004` Provenance Gate (Canonical Hash `12683...230d`, 262,080 rows, 0 gaps).
    - Normalization of microseconds to milliseconds formalized in `021-R_PROVENANCE_REPORT.json`.
    - 152 Walk-Forward windows executed cleanly. Total Candidates over 152 days: 15 Sweep-Up, 9 Sweep-Down.
    - $N_{train} \ge 30$ failed in all windows $\implies$ Fail-Closed $\implies$ 0 OOS Signals.
    - CRO Classification: **`INCONCLUSIVE - INOPERABLE UNDER PRE-REGISTERED SAMPLE FLOOR`**. **[FROZEN]**
70. **Commit 022 - H003 Formal Scientific Post-Mortem:**
    - Emitted `POST_MORTEM_H003.md` detailing catastrophic structural rarity (Hit Rate 0.01096%).
    - Formally audited Train/Test boundary resolution (leak identified for `t_setup + expiry > t_trainEnd`).
    - Enforced rule: Parameter relaxation (e.g., $N=10$, SMA=20h) is prohibited as it constitutes curve-fitting.
    - H003 is formally archived as inconclusive. **[FROZEN]**
71. **Commit 023 - H003 Feasibility & Structural Frequency Analysis:**
    - Performed purely diagnostic conditional funnel breakdown on `DATASET_004`.
    - Finding: Liquidity Sweeps of 24h extremes are common (~4,000+ occurrences in 6 months).
    - Finding: The geometric intersection of `Sweep` + `Counter-Trend SMA50h Bias` annihilates >98% of candidates.
    - Conclusion: H003 is mathematically and geometrically too strict to exist in sufficient frequencies. **[FROZEN]**
    - `MTF_LIQUIDITY_MICROSTRUCTURE` family archived as `CLOSED / INCONCLUSIVE` (No tuning allowed).
72. **Commit 024 - Research Mandate Review (Informational Capacity):**
    - Epistemic pivot: Evaluating dataset informational capacity prior to strict structural geometry.
    - Implemented Tri-Level Metric Framework: 1. Detectability, 2. Predictability, 3. Economics.
    - Issued `RESEARCH_MANDATE_024.md` selecting Family C (Relative State) for empirical testing. **[FROZEN]**
73. **Commit 025 - HYPOTHESIS-004 Pre-Registration (Family 03):**
    - Quant-Grill closed with exact deterministic rules for Relative State Mean Reversion.
    - Feature: Empirical Percentile Rank ($Q_t$) over $L=240$ avoiding normality assumptions.
    - Setup: $Q \le 0.025 \implies \text{CALL}$, $Q \ge 0.975 \implies \text{PUT}$. No secondary filters.
    - Expiry 3m. Train deduzido para $4.320$ candles (3 dias) gerando margem teórica de $\sim 108$ eventos, prevenindo Frequency Starvation.
    - Adversarial additions: Quantile Future Injection, Rank Contamination, Boundary Precision, e Calibration Test. **[FROZEN]**
74. **Commit 026 - DATASET_005 Ingestion & Baseline 005 Control Execution:**
    - `DATASET_005` created from Binance Public Data (April-Sept 2025). 263,520 rows, 0 gaps.
75. **Commit 027 - Quantile State Engine Implementation (H004):**
    - `QuantileStateEngine.js` deployed.
    - $Q_t = \text{count}(H_i < r_t) / 240$. Strict inequality, discrete thresholds.
    - $r_t$ strictly excluded from the reference array $H$.
    - `027_quantile_state_engine.test.js` executed. QS-001 to QS-010 passed. Perfect causal flow verified. **[FROZEN]**
76. **Commit 028 - Adversarial OOS Harness (H004):**
    - `H004Runner.js` created with strict `predict` $\to$ `signal` $\to$ `update` pipeline.
    - Test Suite 028-A to 028-H executed. ALL PASS.
    - Output: `ADVERSARIAL_AUDIT_H004.json` recorded. No sequence inversion detected. **[FROZEN]**
77. **Commit 029 - Blind OOS Execution (H004):**
    - **[INVALID / HOLD]** - OOS windows were selected retroactively based on $P_{train} > P_{BE}$. Violates structural integrity.
78. **Commit 029R - Full-Sample Blind OOS Re-run (H004):**
    - Protocol: ALL 180 Walk-Forward windows on `DATASET_005`. Train=3d, Test=1d, Expiry=3m, Payout=0.8. NO selective exclusion.
    - Result: 16,003 OOS signals emitted across 180 windows. (Signal Rate: 6.17%). Frequency Starvation cured.
    - OOS Win Rate (Primary): $50.63\%$ (Wilson Lower: $49.85\%$).
    - Baseline Win Rate: $49.75\%$. Reversed Win Rate: $49.36\%$ (perfect symmetry).
    - Diagnostic: Windows with $P_{train} > P_{BE}$ showed $51.27\%$ WR; windows $\le P_{BE}$ showed $50.50\%$ WR.
    - Conclusion: **FALSIFIED** economically (EV = -0.088). **[FROZEN]**
79. **Commit 030 - H004 Post-Mortem & Formalization:**
    - `H004_POST_MORTEM.md` and related JSONs generated.
    - Note on Predictability: Observed relative advantage of +0.88pp does not constitute statistical confirmation absent formal tests.
    - The core distinction is proven: Predictability $\neq$ Monetization.
    - H004 is **FALSIFIED_ARCHIVED**. **[FROZEN]**
80. **Commit 031 - Family 03 Decision & Statistical Association Audit:**
    - Inverse-Variance Weighted Paired t-test over 180 windows.
    - Result initially indicated $p=0.021$, but placed on **[AUDIT HOLD]** due to temporal dependence and asymmetric sampling.
    - Status: Observed advantage of +0.94pp, pending temporal validation.
81. **Commit 031A - Temporal Association Audit (Block Bootstrap):**
    - Protocol: Temporal Block Bootstrap across the 180 contiguous TEST windows ($B=10,000$). Resamples non-overlapping 1-day OOS blocks.
    - Result: Observed $\Delta = +0.88\%$. 95% CI: [+0.07%, +1.71%]. Empirical p-value = 0.016.
    - Conclusion: The directional edge survives temporal blocking. It is statistically robust, though economically unviable in binary options.
    - Status: Family 03 is **CLOSED_ARCHIVED**. **[FROZEN]**
82. **Commit 032 - Venue Alignment Mandate:**
    - Major epistemic pivot: $Market\ Signal \neq Venue\ Signal \neq Contract\ Outcome \neq Economic\ Edge$.
    - Laboratory divided into **Reference Market Research** (Binance) and **Venue-Specific Execution Research** (IQ Option).
    - Established the 10-Point Checklist for IQ Option Reconciliation.
    - Status: **[FROZEN]**
83. **Commit 033 - IQ Option Venue & Contract Acquisition:**
    - Directory structure (`data_acquisition`) established.
    - Protocol defined in 4 Phases: A (Recorder), B (Reconstruction), C (Reconciliation), D (Contract Formalization).
    - **033-A (Recorder Skeleton)**: `iqoption_adapter.py` and `recorder.py` created. Adapter is observation-only, shielding execution logic from the core.
    - Status: **[PENDING 033-B - Local Execution]**
84. **Commit 034 - Operational Contract Discovery:**
    - Operational target locked: **IQ Option BTC/USD, Binary, 15m Expiry, 87% Payout**.
    - Breakeven threshold drops to **$53.48\%$**.
    - Mandate created to study $\Delta P_t = P_{IQO} - P_{Binance}$ before opening Family 04.
    - Status: **[FROZEN]**
85. **Commit 035 - XAU/XAG Data Infrastructure (Phases 1–5):**
    - **Phase 1 (Active Discovery):** Probed IQ Option API. Discovered `active_id=2071` (XAU/XAG, payout 88%, regular) and `active_id=2086` (XAU/XAG-OTC, payout 86%, OTC). Live M1 candle retrieval confirmed.
    - **Phase 2 (Recorder Upgrade + Smoke Capture):** Fixed recorder deduplication, captured initial 99 closed candles, upgraded to resilient v2.0 daemon currently running in background accumulating live stream data.
    - **Phase 3 (External Ratio Reconstruction):** Installed `dukascopy-node`. Built ratio pipeline `R_t = XAU/USD \div XAG/USD`. Downloaded 89,312 aligned M1 candles (Jun–Aug 2025) from Dukascopy. Alignment rate 99.88%. Emitted raw CSV, components JSONL, quarantine log, and manifest.
    - **Phase 4 (Fidelity Audit Pipeline):** Implemented full Fidelity Protocol ($\Delta P$, $\rho_h$, $\text{DAR}_h$, $\text{BSIR}_h$ across 1m/2m/3m/5m/15m horizons) in `scripts/data_acquisition/fidelity_audit_xauxag.js`. Infrastructure operational, awaiting contemporaneous live dataset span for Level 2 certification.
    - **Phase 5 (Canonical Dataset Ingestion):** Executed `scripts/data_acquisition/canonicalize_xauxag.js`. Ingested and validated `DATASET_XAUXAG_001` (89,312 rows, 0 duplicates, 100% monotonic, valid OHLC). Published to `research/datasets/XAUXAG/1m/2025-06_08/canonical/` and emitted `DATASET_XAUXAG_001_MANIFEST.json`. Certified as **LEVEL 1: RESEARCH-GRADE**.
    - **Test Coverage:** Added `tests/unit/XAUXAG_canonical_dataset.test.js`. 61 test suites / 202 tests passing (100%). **[DATA INFRASTRUCTURE COMPLETE]**
86. **Commit 036 - HYPOTHESIS-005 Formulation, Freeze, Blind OOS Replay & CRO Deliberation:**
    - **Hypothesis Formulation & Freeze:** Pre-registered `HYPOTHESIS_005` v1.0.0 (Intraday Extreme Deviation Mean-Reversion on XAU/XAG, $L=120$, $|Z_t| \ge 2.0$, $15\text{m}$ contract expiry, payout 88%, $P_{\text{BE}} = 53.1915\%$). Spec frozen at hash `c61231eb8...`.
    - **Implementation:** Built causal `RatioZScoreModel.js`, `ReversedRatioZScoreModel.js`, and `H005Runner.js`.
    - **Adversarial Red Team Suite:** 5 suites executed in `035_adversarial_h005.test.js` (lookahead fuzzer, zero variance guard, reversed control, Mulberry32 synthetic null). Emitted `ADVERSARIAL_AUDIT_005.json` (`CLEAR_FOR_BLIND_OOS`).
    - **Blind Walk-Forward OOS Replay:** Executed against 38,912 candles of locked OOS partition on `DATASET_XAUXAG_001`.
    - **Empirical Results:** $N = 6,210$ resolved trades. Realized Win Rate: **54.3639%** (Wins: 3,376, Losses: 2,834, Pushes: 1). Nominally profitable with $EV = +0.0220$ vs $P_{\text{BE}} = 53.1915\%$. Reversed control win rate: $45.6361\%$.
    - **Statistical Gate Audit:** 95% Wilson Score CI = $[53.1228\%, 55.5997\%]$. $W_{\text{low}} = 53.1228\% \le P_{\text{BE}} = 53.1915\%$ (deficit of 6.87 bps).
    - **CRO Tri-Proof Deliberation:** Sovereign **`VETO`** issued (`RISK_DECISION_005.json`). Promotion blocked under Constitutional Invariant 4 ($W_{\text{low}} > P_{\text{BE}}$). No parameter post-tuning allowed.
    - **Classification:** **`FALSIFIED_FOR_PRODUCTION_ARCHIVED`**. Provenance cryptographically locked (`PROVENANCE_RECEIPT_005.json`).
    - **Test Coverage:** 62 test suites / 207 tests passing (100%). **[FROZEN & ARCHIVED]**
87. **Commit 037 - HYPOTHESIS-006 Formulation, Freeze, Blind OOS Replay & CRO Promotion:**
    - **Hypothesis Formulation & Freeze:** Pre-registered `HYPOTHESIS_006` v1.0.0 (Macro-Trend Conditioned Intraday Ratio Mean Reversion on XAU/XAG, $L_{\text{intraday}}=120$, $M_{\text{macro}}=1440$, $|Z_t| \ge 2.0$, $15\text{m}$ contract expiry, payout 88%, $P_{\text{BE}} = 53.1915\%$). Spec frozen at hash `ee38053ea...`.
    - **Implementation:** Built causal `TrendConditionedRatioZScoreModel.js`, `ReversedTrendConditionedModel.js`, and `H006Runner.js`.
    - **Adversarial Red Team Suite:** 4 suites executed in `036_adversarial_h006.test.js` (multi-horizon causality, macro trend mechanics, reversed control, lookback guards). Emitted `ADVERSARIAL_AUDIT_006.json` (`CLEAR_FOR_BLIND_OOS`).
    - **Blind Walk-Forward OOS Replay:** Executed against 38,912 candles of locked OOS partition on `DATASET_XAUXAG_001`.
    - **Empirical Results:** $N = 1,672$ resolved trades (Wins: 994, Losses: 678, Pushes: 1). Realized Win Rate: **59.4498%** ($EV = +0.1177$). CALL WR: 60.71%, PUT WR: 58.53% ($\Delta = 2.18\text{ pp}$). Reversed control win rate: $40.5502\%$.
    - **Statistical Gate Audit:** 95% Wilson Score CI = $[57.0773\%, 61.7789\%]$. **$W_{\text{low}} = 57.0773\% > P_{\text{BE}} = 53.1915\%$ (+388.58 bps surplus). ALL GATES PASSED!**
    - **CRO Tri-Proof Deliberation:** Sovereign **`PASS_RESEARCH_REGISTRY_GATE`** issued (`RISK_DECISION_006.json`). Promoted to **Candidate Model Registry** on Level 1 Research-Grade data. Live capital deployment gated pending Level 2 Fidelity Audit.
    - **Classification:** **`PROMOTED_TO_CANDIDATE_REGISTRY`**. Provenance cryptographically locked (`PROVENANCE_RECEIPT_006.json`).
    - **Test Coverage:** 63 test suites / 211 tests passing (100%). **[CANDIDATE CERTIFIED]**
88. **Commit 038 - Model Registry Governance Activation (`MODEL_H006_MANIFEST.json`):**
    - **Registry Manifest Emission:** Generated `artifacts/model_registry/MODEL_H006_MANIFEST.json` per the `quant-model-registry-governance` charter. State: `03_APPROVED_CANDIDATE`.
    - **4-Way Consensus Quorum:** Formalized unanimous signatures from CRO (`RISK_DECISION_006.json`), CTO (architectural determinism & adversarial audit), Experiment Controller (`PROVENANCE_RECEIPT_006.json`), and CEO (mandate authorization for paper/shadow execution).
    - **Cryptographic Hash Lineage:** Bound implementation source SHA-256 (`105b1d1...`), spec hash (`ee38053...`), and canonical dataset hash (`5e9018f...`).
    - **Automated Governance Audit:** Added `tests/unit/ModelRegistry_H006.test.js` (6 unit tests verifying manifest schema, hash integrity, 4-way quorum, and Constitutional Invariant 4 $W_{\text{low}} > P_{\text{BE}}$).
    - **Test Coverage:** 64 test suites / 217 tests passing (100%). **[REGISTRY ACTIVATED]**
89. **Commit 039 - Paper Execution Bridge & Trade Ledger Architecture:**
    - **Execution Core Implementation:** Built `src/execution/TradeLedger.js` (append-only JSONL immutable ledger) and `src/execution/PaperExecutionBridge.js`.
    - **Constitutional Invariants Enforced:** Zero Logic Inversion (immutable direction & stake), Latency Budget ($< 250\text{ms}$, hard rejection if exceeded), Disconnect Fail-Safe (immediate freeze if connection drops), Full Lifecycle Settlement (WIN, LOSS, PUSH).
    - **Test Verification:** Added `tests/unit/PaperExecutionBridge.test.js` (5/5 unit tests passing).
    - **Model Registry Lifecycle:** Transitioned from `[03. APPROVED]` to `[04. PAPER / DEMO]`.
    - **Test Coverage:** 65 test suites / 222 tests passing (100%). **[EXECUTION BRIDGE VERIFIED]**
90. **Commit 040 - Monte Carlo Martingale Risk Audit & HYPOTHESIS-007 (Rejection Wick) Replay:**
    - **Monte Carlo Martingale Stress Test:** Simulated 10,000 empirical paths in `scripts/research/monte_carlo_martingale_audit.js`. Demonstrated that a 6-step progressive Martingale (1%, 3%, 6%, 13%, 26%, 51%) carries a **33.36% probability of 100% account liquidation** on a single 100% profit run ($>55\%$ on 2 runs), whereas Fractional Kelly (2% stake) yields **100.00% success and 0.00% ruin**. Formally audited and recorded in `research/reports/MONTE_CARLO_MARTINGALE_AUDIT.json`.
    - **HYPOTHESIS_007 Formulation & Freeze:** Pre-registered `HYPOTHESIS_007` v1.0.0 (Exhaustion Wick-Confirmed Trend-Aligned Ratio Mean-Reversion on XAU/XAG, $L=120$, $M=1440$, $|Z_t| \ge 2.0$, lower/upper wick ratio $\ge 0.35$ with candle polarity confirmation, $15\text{m}$ expiry). Spec frozen at hash `df4181a5a...`.
    - **Implementation:** Built causal `WickConfirmedRatioModel.js`, `ReversedWickConfirmedModel.js`, and `H007Runner.js`.
    - **Adversarial Red Team Suite:** 4 suites executed in `tests/adversarial/037_adversarial_h007.test.js` (zero lookahead, wick geometry, reversed control symmetry, lookback guards). Emitted `ADVERSARIAL_AUDIT_007.json` (`CLEAR_FOR_BLIND_OOS`).
    - **Blind Walk-Forward OOS Replay:** Executed `scripts/run_experiment_037.js` against 38,912 candles of locked OOS partition on `DATASET_XAUXAG_001`.
    - **Empirical Results:** $N = 149$ resolved trades (Wins: 81, Losses: 68, Pushes: 0). Realized Win Rate: **54.3624%** ($EV = +0.0220$). Reversed control win rate: $45.6376\%$.
    - **Statistical Gate Audit:** 95% Wilson Score CI = $[46.3555\%, 62.1501\%]$. $W_{\text{low}} = 46.3555\% \le P_{\text{BE}} = 53.1915\%$ (deficit of 683.60 bps). Rejection wick requirement induced catastrophic signal starvation ($N=149$ vs $N=1,672$ in H006) and lowered alpha from 59.45% to 54.36%.
    - **CRO Tri-Proof Deliberation:** Sovereign **`VETO`** issued (`RISK_DECISION_007.json`). Formally archived in `HYPOTHESIS_REGISTRY.json` and locked with `PROVENANCE_RECEIPT_007.json`.
    - **Model Registry Champion:** Model `H006` remains the sole validated champion in Candidate Registry (`MODEL_H006_MANIFEST.json`).
    - **Test Coverage:** 66 test suites / 226 tests passing (100%). **[HYPOTHESIS_007 FALSIFIED & ARCHIVED]**
91. **Commit 041 - Live Shadow Forward Test Daemon (MODEL_H006):**
    - **Live Shadow Executor:** Built `scripts/execution/live_shadow_executor.js` — a continuous tail-following daemon that:
      - **Pre-warms** H006 model on all 89,312 canonical bars from `DATASET_XAUXAG_001` (intraday 120/120, macro 1440/1440 at startup).
      - **Tail-follows** the live recorder's raw JSONL file, processing each new CLOSED candle in real-time.
      - Runs **Predict → Dispatch → Settle** lifecycle through `PaperExecutionBridge` with full `TradeLedger` immutable logging.
      - Emits periodic `SHADOW_FORWARD_TEST_STATUS.json` status reports (60s interval) with Win Rate, Wilson CI, Paper PnL, and pending trades.
    - **Daemon Status:** Running in background (Task 922) alongside recorder daemon (Task 473). Both healthy and producing data.
    - **Architectural Test Suite:** Added `tests/unit/LiveShadowExecutor.test.js` (5/5 tests passing): pre-warming capacity, signal validity, dispatch→settle lifecycle, LOSS accounting, latency budget rejection.
    - **Test Coverage:** 67 test suites / 231 tests passing (100%). **[SHADOW FORWARD TEST ACTIVE]**

92. **Commit 042 - XAU/XAG Instrument Identity & Execution Fidelity Audit:**
    - **Quant-Grill Frozen:** Locked `FROZEN_SPEC_XAUXAG_FIDELITY_AUDIT.json` (SHA-256: `8bd0d6fe1a0...`) satisfying all 15 mandatory dimensions ex-ante.
    - **10-Link Chain of Evidence Audit:** Audited Data Source, Instrument Identity, Timestamp, Price Series, Candle Construction, Entry Price, Expiry Price, Outcome, Payout, and Replay Evidence in `XAUXAG_CHAIN_OF_EVIDENCE_AUDIT.json`.
    - **20 Scientific Questions Answered:** Documented origin (Dukascopy ECN spot), synthetic reconstruction ($R_t = XAU \div XAG$), calendar divergence (June–August 2025 vs September 2026), and spread characteristics.
    - **Epistemic Classification:** Confirmed `DATASET_XAUXAG_001` is strictly **LEVEL 1: RESEARCH-GRADE**. Live capital deployment for `MODEL_H006` remains **`BLOCKED`** until Level 2 Fidelity is achieved. Zero strategy code modified, zero parameters tuned. **[AUDIT DOSSIER FROZEN]**
93. **Commit 043 - Railway 24/7 Cloud Recorder Deployment Infrastructure:**
    - **Container Architecture:** Created `Dockerfile` (Python 3.11-slim) and `.dockerignore` for cloud continuous execution.
    - **Persistent Volume Support:** Configured flexible `RAW_DIR` mounting to Railway Volume (`/data`) to prevent data loss on container restarts.
    - **Cloud Entrypoint & Web Dashboard:** Implemented `cloud_entrypoint.py` serving `/health` (Railway healthcheck), `/metrics`, `/` (HTML progress dashboard towards 10,000 candles), and `/download` (direct one-click `.jsonl` download).
    - **Railway Configuration & Guide:** Authored `railway.json` and comprehensive user guide `docs/RAILWAY_DEPLOYMENT_GUIDE.md`.
    - **Test Coverage:** 100% existing test suites passing without regressions. **[CLOUD DEPLOY INFRASTRUCTURE READY]**
94. **Commit 044 - Railway Deploy Build Fix, Venue Handshake Diagnosis & First Light:**
    - **Docker build fix:** `pip install -r requirements.txt` failed with `ResolutionImpossible` (`websocket-client==1.8.0` vs iqoptionapi's `==0.56`); interim two-step install, then root-cause alignment to `websocket-client==0.56` with Dockerfile reverted to single-line install (dry-run proven).
    - **Connect watchdog:** `iqoption_adapter.connect()` wrapped in worker-thread `join(timeout=IQO_CONNECT_TIMEOUT, 90s)` + `CONNECTION_STATE` telemetry surfaced in `/health`, `/metrics` and dashboard badge (also fixed the dead `connected` indicator).
    - **Root-cause isolation:** venue reachable; deterministic failure `WebsocketClient.on_message() takes 2 positional arguments but 3 were given` under 1.8.0 — resolved by the 0.56 alignment.
    - **First light 2026-09-14T23:04:32Z:** `Connection successful. Practice mode asserted.` + `Candle stream started` (XAU/XAG M1), backfill burst #1–#99 + live cadence. **[DEPLOY OPERATIONAL]**
95. **Commit 045 - Single-Session Multi-Stream Recorder (`IQO_STREAMS`) & XAU/USD Accumulation Start:**
    - One IQO session multiplexes `XAU/XAG:60` (untouched, same file layout) + `XAUUSD:60` + `XAUUSD:5`; per-stream files, dedup, counters and failure isolation; default env preserves legacy single-stream behavior.
    - Cloud entrypoint serves per-stream `/health`, `/metrics`, dashboard cards and `/download?stream=ASSET:INTERVAL`.
    - **Test battery:** `recorder/tests/test_recorder_multistream.py`, 11/11 passing (stdlib unittest, mocked venue, no network).
    - **Live 2026-09-15:** all three streams nominal (5s cadence exact, cross-granularity closes consistent, XAU/XAG numbering continuous across redeploy via volume + dedup). Two isolated 5s gaps quarantined for canonicalization (#383/TS …140, #468/TS …565).
    - **Provenance note:** XAU/XAG closed count regressed 108 → 103 across one restart (file reset + venue backfill ≈100); loss bounded, series monotonic since. Volume must not be recreated. **[MULTI-STREAM LIVE]**
96. **H008 SPEC_DRAFT — Elicitation in Progress (NOT FROZEN, no code, no dispatch):**
    - Candidate: symmetric M1-stretch fade (`range ≥ 1.5×ATR(14)` Wilder) into 2-pivot HH/HL–LH/LL trendlines (pivot confirmed after 5 M1 bars) or OTE 0.62–0.79 of last impulse if zero valid lines in 120 M1 bars; micro filter on last closed 5s (line-side wick ≥0.35 + pro-fade close); first-touch entry at line price ±0.1×ATR; 1m expiry at next M1 clock close; no breakout filter; no metric tuning (Via A).
    - Open: XAU/USD 1m payout (→ P_BE), live `active_id` confirmation (library prior: XAUUSD=74), IS/OOS boundaries, adversarial battery, seeds, stopping/promotion rules. Freeze ceremony only after data coverage.

**Next Objective:** Keep the Railway recorder accumulating on all three streams (`IQO_STREAMS=XAU/XAG:60,XAUUSD:60,XAUUSD:5`, volume `/data`). XAU/XAG continues toward N ≥ 10,000 closed M1 for the Level 2 fidelity gate; XAU/USD 60s+5s accumulates toward ~30 business days for the H008 IS/OOS design. Then: download via per-stream `/download`, concurrent Dukascopy for the exact span, `fidelity_audit_xauxag.js` (ρ_15m ≥ 0.98, BSIR_15m ≤ 2.0%), and H008 freeze ceremony (payout-confirmed P_BE, blind boundary, battery, seeds).