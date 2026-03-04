# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
