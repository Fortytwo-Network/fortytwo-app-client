# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Node Tier model (Challenger / Capable) and Capability rank (0–42)
- Capability Challenge worker — Challengers auto-answer Foundation Pool rounds
- `challenge_locked` wallet, tier badge, capability progress bar, dead-lock banner
- CLI: `capability [history]`, `reset --yes`, `challenge list|answer`
- TUI: `/capability [history]`, `/challenge list`

### Changed
- Registration: 2-step challenge quiz → 1-step; no LLM key needed to onboard
- `reset` is one-shot, requires `--yes`
- `min_balance` gates Capable only; Challengers stake from `challenge_locked`

### Removed
- Reactivation flow, 2-step register, challenge-based reset endpoints
- `compareForRegistration` LLM helper
- Auto-reset on `InsufficientFundsError`

## [0.1.6] - 13.04.2026

### Features
- Added Node Vision — real-time web dashboard for monitoring bot activity
- Added multi-profile support — run and manage several accounts from a single CLI
- Added automatic version check — CLI notifies when a newer release is available

### Reliability
- Improved CLI stability on Windows

## [0.1.5] - 03.03.2026

### Error handling
- Actionable error messages for local inference failures (server not running, model not loaded, timeout)

## [0.1.4] - 02.03.2026

### CLI
- `--version` flag to print version and exit

### Onboarding
- Model autocomplete with arrow-key navigation (type to filter, arrows to browse, Enter to select)
- Fetch available models from provider before model selection step
- Connection/auth validation when entering API key or local URL
- Animated loader (Figma-based `∷ ◯ □ ‖ ■ ●` sequence) during registration and validation steps

### Reliability
- Account reactivation on "inactive/deactivated" errors (preserves balance and rank)
- Account reset on insufficient funds (automatic challenge solving)
- Model validation at bot startup — fail fast if model is unavailable
- Per-challenge timeout (2 min) to prevent hangs during registration

### LLM
- Reduced concurrency for local inference (1/5 of default)
- Exposed `getLlmConcurrency()` for progress reporting

### Progress reporting
- Two-phase progress: `Comparing: X/Y (Z settled)` then `Solving: X/Y`
- Live LLM concurrency display: `[LLM active/max]`

### Error handling
- Fixed double "Error:" prefix in task failure logs
- Capitalized task labels in error messages

## [0.1.3] - 27.02.2026

- Initial commit
