---
name: performance-profiling
description: Use when latency, throughput, memory, startup, bundle, or resource budgets need measurement before optimization.
---

# Performance Profiling

## Procedure

1. Define the user-visible budget and a reproducible workload before changing code.
2. Measure a baseline with the narrowest profiler that can distinguish CPU, I/O, memory, network, or rendering cost.
3. Identify the hot path from evidence, then change one causal bottleneck at a time.
4. Re-measure the same workload and run correctness tests; reject optimizations that change the contract or hide errors.
5. Record variance, machine/runtime versions, and whether the result is representative.

## Ready when

The bottleneck is evidenced, the optimization meets a stated budget, correctness is unchanged, and the benchmark is repeatable.

## Evidence

Report baseline, optimized result, workload, environment, and the command or profiler artifact used.

## Tools

Use `begin_task`, `run_quality_gate`, `checkpoint_task`, and project-native benchmark/profiling tools.
