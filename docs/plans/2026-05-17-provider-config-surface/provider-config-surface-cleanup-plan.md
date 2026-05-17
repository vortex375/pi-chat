# Provider Config Surface Cleanup Plan

## Goal

Make the backend Pi configuration surface honest, provider-aware, and aligned with the Pi SDK.

The current surface implies generic multi-provider support, but the implementation actually assumes a single OpenAI-compatible registration flow. The cleanup should:

- expose only the app-level knobs the backend truly owns
- let provider-specific auth and transport details follow SDK-native conventions
- validate configuration conditionally instead of requiring irrelevant variables for every provider
- make the built-in provider path the only supported path for now

## Problem Statement

Today the backend requires:

- `PI_PROVIDER`
- `PI_MODEL_ID`
- `PI_OPENAI_BASE_URL`
- `PI_OPENAI_API_KEY`

That surface is misleading for two reasons.

First, `PI_PROVIDER` suggests the backend can select between materially different provider types, but `apps/api/src/env.ts` currently validates `PI_OPENAI_BASE_URL` and `PI_OPENAI_API_KEY` unconditionally and only accepts `openrouter` as a provider.

Second, `apps/api/src/services/pi-agent-service.ts` registers the configured provider as `openai-completions` with a manual base URL, manual API key, and a single manually declared model. That means the backend is not using the Pi SDK's built-in provider catalog and auth conventions as intended.

The result is a config surface that is broader in name than in behavior and narrower in implementation than the SDK can support.

## Evidence

### Current backend behavior

- `apps/api/src/env.ts`
  - requires `PI_MODEL_ID`, `PI_OPENAI_BASE_URL`, and `PI_OPENAI_API_KEY` for every startup
  - accepts `PI_PROVIDER` but only allows `openrouter`
- `apps/api/src/services/pi-agent-service.ts`
  - calls `authStorage.setRuntimeApiKey(this.config.piProvider, providerApiKey)`
  - manually registers the provider with `api: "openai-completions"`
  - manually injects `baseUrl`, `apiKey`, and one model definition

### Pi SDK behavior

The SDK already separates three concerns:

1. provider selection and model selection
2. provider-native auth lookup
3. explicit custom-provider registration when needed

Relevant references from the Pi SDK workspace:

- `docs/providers.md`
  - built-in providers use provider-native env vars such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and others
- `src/core/auth-storage.ts`
  - API key resolution order already includes environment variables for built-in providers
- `docs/sdk.md`
  - `AuthStorage` is intended to resolve runtime overrides, stored auth, and provider-native env vars
- `docs/custom-provider.md`
  - custom providers are an explicit advanced path that requires provider config such as `baseUrl`, `apiKey`, `api`, and `models`
- `src/core/model-registry.ts`
  - built-in providers and custom providers are modeled differently and validated differently

## Best-Practice Basis

This plan is based on two sources of guidance.

### 1. Twelve-Factor config discipline

The Twelve-Factor App recommends storing deploy-varying configuration in environment variables and keeping those variables orthogonal.

Applied here, that means:

- keep app-owned config small and explicit
- avoid env vars that claim to be generic but only apply to one transport family
- do not require variables that are irrelevant for the selected provider

### 2. Pi SDK ownership boundaries

The Pi SDK already knows:

- built-in provider IDs
- built-in model catalogs
- provider-native credential env vars
- provider-specific request semantics
- when a custom provider needs explicit `baseUrl`, `api`, `apiKey`, and model definitions

The backend should not duplicate that logic unless it is intentionally creating a custom provider.

## Recommended Direction

Adopt a single built-in-provider configuration model.

This should be the only supported path for now.

App-level env surface:

- required: `PI_PROVIDER`
- required: `PI_MODEL_ID`
- optional: existing non-model backend env vars such as `PORT`, `PI_CHAT_DATA_ROOT`, and related app settings

Credential and provider-specific configuration:

- use Pi SDK native env vars for the chosen provider
- examples:
  - `OPENROUTER_API_KEY` for `PI_PROVIDER=openrouter`
  - `OPENAI_API_KEY` for `PI_PROVIDER=openai`
  - `ANTHROPIC_API_KEY` for `PI_PROVIDER=anthropic`
  - provider-specific auxiliary vars where the SDK already defines them, such as Azure OpenAI settings
- optionally allow credentials in the backend-owned auth store under `data/system/auth.json` for deployments that prefer mounted files over env vars

Behavioral rules:

- do not require any `PI_OPENAI_*` variables
- do not manually register built-in providers just to pass through credentials or default base URLs
- rely on `AuthStorage` and `ModelRegistry` to resolve auth and built-in models
- fail startup with a provider-specific error when the selected provider lacks configured auth

Custom providers are out of scope for this cleanup. If they become necessary later, they should be designed as a separate explicit feature rather than carried implicitly in the normal backend env surface.

## Locked Recommendation

The cleanup should remove the misleading generic OpenAI-compatible surface from the backend entirely and standardize on built-in Pi providers only.

Concretely:

- keep `PI_PROVIDER`
- keep `PI_MODEL_ID`
- remove `PI_OPENAI_BASE_URL`
- remove `PI_OPENAI_API_KEY`
- stop requiring any OpenAI-specific env vars for built-in providers
- do not add any new custom-provider env vars in this change

This is the smallest change that makes the surface honest and aligns the app with the SDK.

## Proposed Implementation

### 1. Simplify env parsing

Update `apps/api/src/env.ts` so that:

- `PI_PROVIDER` and `PI_MODEL_ID` remain the only Pi-specific required env vars in the common path
- provider validation is based on built-in Pi provider IDs that the backend intends to support, not on an OpenAI-compatible assumption
- `PI_OPENAI_BASE_URL` and `PI_OPENAI_API_KEY` are removed from the configuration contract
- startup errors are conditional and provider-aware

Because this is still an early prototype, make this as a direct breaking cleanup rather than carrying compatibility aliases or warnings.

### 2. Stop manually recreating built-in providers

Update `apps/api/src/services/pi-agent-service.ts` so that built-in providers use the SDK directly:

- create `AuthStorage` with the backend-owned auth file path as today
- create `ModelRegistry` without manually registering the selected built-in provider
- stop calling `setRuntimeApiKey()` for the normal built-in path
- resolve the configured model from the SDK's built-in registry
- continue using `SettingsManager` for default provider and default model selection

This removes duplicated provider metadata and stops the backend from hardcoding `openai-completions` for all providers.

### 3. Improve startup diagnostics

When auth is missing or the model is invalid, fail with messages that match the selected provider.

Examples:

- missing auth for `openrouter` should point to `OPENROUTER_API_KEY` or the backend auth store
- missing auth for `anthropic` should point to `ANTHROPIC_API_KEY` or the backend auth store
- invalid model should mention the selected provider and model ID, not OpenAI-specific transport settings

Prefer using SDK-derived metadata where possible so the error messages stay aligned with provider behavior.

### 4. Narrow README and operator docs

Update docs so that the main setup path becomes:

1. choose `PI_PROVIDER`
2. choose `PI_MODEL_ID`
3. provide the provider's SDK-native credentials

Do not describe OpenAI-compatible base URLs as part of the normal setup path.

Document only the supported built-in-provider path.

## Files Likely To Change

- `apps/api/src/env.ts`
  - simplify required Pi env validation
  - remove the OpenAI-compatible env contract entirely

- `apps/api/src/env.test.ts`
  - replace unconditional OpenAI-specific requirements with provider-aware tests
  - remove any tests that encode the old OpenAI-compatible contract

- `apps/api/src/services/pi-agent-service.ts`
  - stop manual built-in provider registration
  - use SDK-native built-in provider resolution

- `README.md`
  - document the new recommended setup path

- optional follow-up docs under `docs/plans/` or operator docs
  - record deprecation timing and custom-provider non-goals

## Testing Plan

Add focused tests around the new configuration contract.

### Env tests

- `PI_PROVIDER` plus `PI_MODEL_ID` succeeds when the selected provider's SDK-native auth env var is present
- startup fails with a provider-specific message when auth is missing
- provider validation rejects unsupported or misspelled provider IDs

### Service tests

- built-in provider selection resolves a built-in model from `ModelRegistry`
- request auth resolves from provider-native env vars without `setRuntimeApiKey()`
- invalid provider/model combinations fail before request handling begins

### Documentation checks

- README examples no longer instruct users to set `PI_OPENAI_BASE_URL`
- README examples use provider-native credential names for the documented providers

## Non-Goals

- do not design a large generic provider DSL in environment variables
- do not expose every `registerProvider()` capability through backend env vars
- do not add custom-provider registration in this cleanup

## Decision Summary

The backend should own provider selection and default model selection.

The Pi SDK should own provider-specific auth names, built-in model catalogs, and provider-specific transport behavior.

That split produces the cleanest surface:

- `PI_PROVIDER`
- `PI_MODEL_ID`
- provider-native SDK credentials and optional provider-native auxiliary env vars

Everything else should be removed from the current backend config surface until there is a concrete requirement to add it back.